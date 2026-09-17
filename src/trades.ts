import type { BacktestTrade, OptimizationMetrics } from './types';

export function parseCSVTrades(csvContent: string): BacktestTrade[] {
  const trades: BacktestTrade[] = [];
  const lines = csvContent.split('\n');

  if (lines.length < 2) return trades;

  // Parse header to get column indices.
  // Normalize each header so column resolution survives TradingView's periodic
  // renames. Two changes seen in the wild (June 2026 export):
  //   - "P&L"  -> "PnL"      (e.g. "Net P&L USD" became "Net PnL USD")
  //   - "Position size (qty)" -> "Size (qty)"
  //   - "MFE"/"MAE"          -> "Favorable/Adverse excursion"
  //   - "Net PnL %"          -> "Return %" (September 2026 export)
  // normalize() collapses "p&l"->"pnl", strips a leading BOM, and lowercases so
  // both old and new label spellings (and any currency suffix) match the same base.
  const normalize = (s: string): string =>
    s.replace(/^﻿/, '').toLowerCase().replace(/p&l/g, 'pnl').replace(/\s+/g, ' ').trim();

  const header = parseCSVLine(lines[0]);
  const normCols = header.map((col, idx) => ({ norm: normalize(col), idx }));

  // Find a column by normalized base name (currency-agnostic: "net pnl" matches
  // "Net PnL USD"/"Net PnL EUR"/...). `percent` disambiguates the absolute value
  // column ("Net PnL USD") from its percentage sibling ("Net PnL %").
  const findColumn = (bases: string[], percent = false): number => {
    for (const base of bases) {
      const b = normalize(base);
      const hit = normCols.find((c) => {
        const isPct = c.norm.includes('%');
        if (percent !== isPct) return false;
        return c.norm === b || c.norm.startsWith(b + ' ') || c.norm.startsWith(b);
      });
      if (hit) return hit.idx;
    }
    return -1;
  };

  // Map columns flexibly — list new spellings first, keep old ones as fallback.
  const cols = {
    tradeNum: findColumn(['trade number', 'trade #', 'trade']),
    type: findColumn(['type']),
    dateTime: findColumn(['date and time', 'date/time', 'datetime']),
    signal: findColumn(['signal']),
    price: findColumn(['price']),
    positionSize: findColumn(['size (qty)', 'position size (qty)', 'qty', 'size']),
    netPL: findColumn(['net pnl', 'net p&l', 'profit']),
    netPLPct: findColumn(['return', 'net pnl', 'net p&l'], true),
    mfe: findColumn(['favorable excursion', 'mfe', 'run-up', 'runup']),
    mae: findColumn(['adverse excursion', 'mae', 'drawdown']),
    cumulativePL: findColumn(['cumulative pnl', 'cumulative p&l']),
    cumulativePLPct: findColumn(['cumulative pnl', 'cumulative p&l'], true),
  };

  // Diagnostic: if the P&L columns can't be found, every computed metric would
  // silently come out 0 (the exact symptom of TradingView's header rename). Log
  // loudly so the next rename is obvious instead of mysterious zeros.
  if (cols.netPL < 0 || cols.netPLPct < 0 || cols.cumulativePL < 0) {
    console.warn(
      '[RQ Extension] CSV P&L columns not found — some metrics will be 0. Headers:',
      header,
    );
  }

  // Tolerant numeric parse: handle a unicode minus (−, U+2212) and thousands
  // separators so a future locale/format tweak doesn't zero out the value.
  const parseNum = (s: string): number => {
    if (!s) return 0;
    const n = parseFloat(s.replace(/−/g, '-').replace(/,(?=\d{3}\b)/g, ''));
    return Number.isFinite(n) ? n : 0;
  };

  // Helper to safely get column value
  const getVal = (row: string[], colIdx: number): string => {
    return colIdx >= 0 && row[colIdx] ? row[colIdx] : '';
  };

  // Group rows by trade number (each trade has Entry and Exit rows)
  const tradeMap = new Map<number, { entry?: string[]; exit?: string[] }>();

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const row = parseCSVLine(line);
    const tradeNum = parseInt(getVal(row, cols.tradeNum) || '0', 10);
    const type = getVal(row, cols.type);

    if (!tradeNum) continue;

    if (!tradeMap.has(tradeNum)) {
      tradeMap.set(tradeNum, {});
    }

    const trade = tradeMap.get(tradeNum)!;
    if (type.toLowerCase().includes('entry')) {
      trade.entry = row;
    } else if (type.toLowerCase().includes('exit')) {
      trade.exit = row;
    }
  }

  // Convert grouped rows to BacktestTrade objects
  tradeMap.forEach((data, tradeNum) => {
    // Use exit row for P&L data (it has the final values), entry row for entry details
    const exitRow = data.exit || data.entry;
    const entryRow = data.entry || data.exit;

    if (!exitRow) return;

    const typeStr = entryRow ? getVal(entryRow, cols.type) : getVal(exitRow, cols.type);
    const isLong = typeStr.toLowerCase().includes('long');

    const trade: BacktestTrade = {
      tradeNumber: tradeNum,
      type: isLong ? 'Long' : 'Short',
      signal: entryRow ? getVal(entryRow, cols.signal) : '',
      entryDate: entryRow ? getVal(entryRow, cols.dateTime) : '',
      entryPrice: parseNum(entryRow ? getVal(entryRow, cols.price) : '0'),
      exitDate: getVal(exitRow, cols.dateTime) || null,
      exitPrice: parseNum(getVal(exitRow, cols.price)) || null,
      contracts: parseNum(getVal(exitRow, cols.positionSize)) || 1,
      profitLoss: parseNum(getVal(exitRow, cols.netPL)),
      profitLossPercent: parseNum(getVal(exitRow, cols.netPLPct)),
      cumulativeProfit: parseNum(getVal(exitRow, cols.cumulativePL)),
      cumulativeProfitPercent: parseNum(getVal(exitRow, cols.cumulativePLPct)),
      runUp: parseNum(getVal(exitRow, cols.mfe)),
      drawdown: Math.abs(parseNum(getVal(exitRow, cols.mae))),
    };

    trades.push(trade);
  });

  // Sort by trade number
  trades.sort((a, b) => a.tradeNumber - b.tradeNumber);

  return trades;
}

function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }

  result.push(current.trim());
  return result;
}

/**
 * Calculate all metrics from trade data (replaces TV UI scraping)
 */
/**
 * Recover the strategy's initial capital from TradingView's cumulative P&L
 * columns (USD / %). Uses the trade with the largest cumulative percentage to
 * minimise the error from the 2-decimal rounding of the % column.
 */
export function inferInitialCapital(trades: BacktestTrade[]): number | null {
  let best: BacktestTrade | null = null;
  for (const trade of trades) {
    if (!trade.cumulativeProfitPercent || !trade.cumulativeProfit) continue;
    if (!best || Math.abs(trade.cumulativeProfitPercent) > Math.abs(best.cumulativeProfitPercent)) {
      best = trade;
    }
  }
  if (!best) return null;
  const capital = best.cumulativeProfit / (best.cumulativeProfitPercent / 100);
  return Number.isFinite(capital) && capital > 0 ? capital : null;
}

export function calculateMetricsFromTrades(
  trades: BacktestTrade[],
  initialCapital: number = inferInitialCapital(trades) ?? 100000,
): OptimizationMetrics {
  if (trades.length === 0) {
    return {
      netProfit: 0,
      netProfitPercent: 0,
      grossProfit: 0,
      grossLoss: 0,
      maxDrawdown: 0,
      maxDrawdownPercent: 0,
      sharpeRatio: 0,
      sortinoRatio: 0,
      profitFactor: 0,
      totalTrades: 0,
      winningTrades: 0,
      losingTrades: 0,
      winRate: 0,
      avgTrade: 0,
      avgTradePercent: 0,
      largestWin: 0,
      largestLoss: 0,
    };
  }

  // Basic P&L calculations
  let grossProfit = 0;
  let grossLoss = 0;
  let winningTrades = 0;
  let losingTrades = 0;
  let largestWin = 0;
  let largestLoss = 0;
  const returns: number[] = [];

  for (const trade of trades) {
    const pl = trade.profitLoss ?? 0;
    const plPercent = trade.profitLossPercent ?? 0;

    if (pl > 0) {
      grossProfit += pl;
      winningTrades++;
      if (pl > largestWin) {
        largestWin = pl;
      }
    } else if (pl < 0) {
      grossLoss += Math.abs(pl);
      losingTrades++;
      if (pl < largestLoss) {
        largestLoss = pl;
      }
    }
    if (Number.isFinite(plPercent)) {
      returns.push(plPercent);
    }
  }

  const netProfit = grossProfit - grossLoss;
  const totalTrades = trades.length;
  const winRate = totalTrades > 0 ? (winningTrades / totalTrades) * 100 : 0;
  // Cap profit factor at 999 to avoid Infinity display issues
  const profitFactor = grossLoss > 0 ? Math.min(grossProfit / grossLoss, 999) : grossProfit > 0 ? 999 : 0;
  const avgTrade = totalTrades > 0 ? netProfit / totalTrades : 0;

  // Calculate net profit percentage from cumulative profit
  // Use the last trade's cumulative profit if available
  const lastTrade = trades[trades.length - 1];
  const finalEquity = lastTrade?.cumulativeProfit ?? netProfit;
  const netProfitPercent = initialCapital > 0 ? (finalEquity / initialCapital) * 100 : 0;
  const avgTradePercent = totalTrades > 0 ? netProfitPercent / totalTrades : 0;

  // Calculate max drawdown from equity curve
  let peak = initialCapital;
  let maxDrawdown = 0;
  let maxDrawdownPercent = 0;
  let equity = initialCapital;

  for (const trade of trades) {
    equity = initialCapital + (trade.cumulativeProfit ?? 0);
    if (equity > peak) {
      peak = equity;
    }
    const dd = peak - equity;
    const ddPercent = peak > 0 ? (dd / peak) * 100 : 0;
    if (dd > maxDrawdown) {
      maxDrawdown = dd;
      maxDrawdownPercent = ddPercent;
    }
  }

  // Calculate Sharpe Ratio (assuming ~252 trading days/year)
  const avgReturn = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
  const variance = returns.length > 1
    ? returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / (returns.length - 1)
    : 0;
  const stdDev = Math.sqrt(variance);
  // Annualize: multiply by sqrt(252) for daily returns, or estimate based on trade frequency
  const annualizationFactor = Math.sqrt(Math.min(252, trades.length));
  const sharpeRatio = stdDev > 0 ? (avgReturn / stdDev) * annualizationFactor : 0;

  // Calculate Sortino Ratio (only downside deviation)
  const negativeReturns = returns.filter(r => r < 0);
  const downsideVariance = negativeReturns.length > 1
    ? negativeReturns.reduce((sum, r) => sum + Math.pow(r, 2), 0) / (negativeReturns.length - 1)
    : 0;
  const downsideDeviation = Math.sqrt(downsideVariance);
  const sortinoRatio = downsideDeviation > 0 ? (avgReturn / downsideDeviation) * annualizationFactor : 0;

  // Helper to sanitize numbers (convert NaN/Infinity to 0)
  const sanitize = (n: number): number => (Number.isFinite(n) ? n : 0);

  return {
    netProfit: sanitize(netProfit),
    netProfitPercent: sanitize(netProfitPercent),
    grossProfit: sanitize(grossProfit),
    grossLoss: sanitize(grossLoss),
    maxDrawdown: sanitize(maxDrawdown),
    maxDrawdownPercent: sanitize(maxDrawdownPercent),
    sharpeRatio: sanitize(sharpeRatio),
    sortinoRatio: sanitize(sortinoRatio),
    profitFactor: sanitize(profitFactor),
    totalTrades,
    winningTrades,
    losingTrades,
    winRate: sanitize(winRate),
    avgTrade: sanitize(avgTrade),
    avgTradePercent: sanitize(avgTradePercent),
    largestWin: sanitize(largestWin),
    largestLoss: sanitize(largestLoss),
  };
}

/**
 * Optimizer UI - Injected into TradingView Strategy Tester
 *
 * This module creates and manages the optimization UI overlay
 * that appears when the user clicks the "Optimize" button.
 */

import type {
  StrategyInput,
  OptimizationParameter,
  NumericOptimizationParameter,
  DropdownOptimizationParameter,
  OptimizationConfig,
  OptimizationGoal,
  OptimizationMode,
  OptimizationRun,
  OptimizationProgress,
  OptimizationResult,
  OptimizationMetrics,
  WalkForwardConfig,
  WalkForwardResult,
  WalkForwardWindow,
  WalkForwardMode,
  RollingWalkForwardResult,
} from './types';

import { roboquantLink } from './config';

// Import Plotly for 3D heatmap - using the minified distribution
import Plotly from 'plotly.js-dist-min';

// ============================================================================
// History Storage Types
// ============================================================================

interface SavedResult {
  id: string;
  savedAt: string;
  strategyName: string;
  symbol: string;
  timeframe: string;
  mode: string;
  runsCount: number;
  bestProfit: number;
  result: OptimizationResult;
}

const HISTORY_STORAGE_KEY = 'rq_optimizer_history';
const MAX_HISTORY_ENTRIES = 10;

function estimateJsonSizeBytes(value: unknown): number {
  try {
    return new Blob([JSON.stringify(value)]).size;
  } catch {
    return -1;
  }
}

async function getLocalStorageBytesInUse(key: string | null = null): Promise<number | null> {
  try {
    return await chrome.storage.local.getBytesInUse(key);
  } catch {
    return null;
  }
}

// ============================================================================
// State
// ============================================================================

interface OptimizerUIState {
  isOpen: boolean;
  inputs: StrategyInput[];
  selectedParams: Map<string, OptimizationParameter>;
  optimizationGoal: OptimizationGoal;
  delayBetweenRuns: number;
  isRunning: boolean;
  progress: OptimizationProgress | null;
  result: OptimizationResult | null;
  runs: OptimizationRun[];
  // Optimization mode
  optimizationMode: OptimizationMode;
  // Multi-symbol state
  symbols: string[];
  symbolInput: string;
  // Multi-timeframe state
  selectedTimeframes: string[];
  // Walk-Forward (IS/OOS) state
  walkForwardEnabled: boolean;
  walkForwardMode: 'single' | 'rolling';
  inSampleStart: string;
  inSampleEnd: string;
  outOfSampleStart: string;
  outOfSampleEnd: string;
  // Rolling walk-forward config
  rollingTotalStart: string;
  rollingTotalEnd: string;
  rollingISWindowMonths: number;
  rollingOOSWindowMonths: number;
  rollingStepMonths: number;
  // History state
  showHistory: boolean;
  historyEntries: SavedResult[];
  currentHistoryId: string | null;
  viewingFromHistory: boolean;
}

// Calculate default dates for IS/OOS periods
function getDefaultDates(): { isStart: string; isEnd: string; oosStart: string; oosEnd: string } {
  const today = new Date();
  const oneYearAgo = new Date(today);
  oneYearAgo.setFullYear(today.getFullYear() - 1);
  const twoYearsAgo = new Date(today);
  twoYearsAgo.setFullYear(today.getFullYear() - 2);
  const threeYearsAgo = new Date(today);
  threeYearsAgo.setFullYear(today.getFullYear() - 3);

  const formatDate = (d: Date) => d.toISOString().split('T')[0];

  return {
    isStart: formatDate(threeYearsAgo),
    isEnd: formatDate(oneYearAgo),
    oosStart: formatDate(oneYearAgo),
    oosEnd: formatDate(today),
  };
}

const defaultDates = getDefaultDates();

// Calculate default rolling WF dates
function getRollingDefaults(): { totalStart: string; totalEnd: string } {
  const today = new Date();
  const fiveYearsAgo = new Date(today);
  fiveYearsAgo.setFullYear(today.getFullYear() - 5);
  const formatD = (d: Date) => d.toISOString().split('T')[0];
  return { totalStart: formatD(fiveYearsAgo), totalEnd: formatD(today) };
}

const rollingDefaults = getRollingDefaults();

const PROP_FIRM_DEFAULTS = {
  accountSize: 100000,
  profitTargetPct: 8,
  maxDailyLossPct: 5,
  maxTotalLossPct: 10,
  timeLimitDays: 30,
};

const state: OptimizerUIState & {
  heatmapExpanded: boolean;
  heatmapMode: '2d' | '3d';
  heatmapXParam: string;
  heatmapYParam: string;
  heatmapMetric: keyof OptimizationMetrics;
  propFirmExpanded: boolean;
} = {
  isOpen: false,
  inputs: [],
  selectedParams: new Map(),
  optimizationGoal: 'sharpeRatio',
  delayBetweenRuns: 3000,
  isRunning: false,
  progress: null,
  result: null,
  runs: [],
  // Optimization mode
  optimizationMode: 'params',
  // Multi-symbol
  symbols: [],
  symbolInput: '',
  // Multi-timeframe
  selectedTimeframes: [],
  // Walk-Forward defaults
  walkForwardEnabled: false,
  walkForwardMode: 'single',
  inSampleStart: defaultDates.isStart,
  inSampleEnd: defaultDates.isEnd,
  outOfSampleStart: defaultDates.oosStart,
  outOfSampleEnd: defaultDates.oosEnd,
  // Rolling walk-forward defaults
  rollingTotalStart: rollingDefaults.totalStart,
  rollingTotalEnd: rollingDefaults.totalEnd,
  rollingISWindowMonths: 24,
  rollingOOSWindowMonths: 6,
  rollingStepMonths: 6,
  // Heatmap defaults
  heatmapExpanded: false,
  heatmapMode: '2d',
  heatmapXParam: '',
  heatmapYParam: '',
  heatmapMetric: 'sharpeRatio',
  // Prop Firm
  propFirmExpanded: false,
  // History defaults
  showHistory: false,
  historyEntries: [],
  currentHistoryId: null,
  viewingFromHistory: false,
};

/** Get parameter names from the result data (works for both live and history results) */
function getResultParamNames(): string[] {
  if (state.result?.config?.parameters?.length) {
    return state.result.config.parameters.map(p => p.name);
  }
  if (state.result?.runs?.[0]?.parameters) {
    return Object.keys(state.result.runs[0].parameters);
  }
  return Array.from(state.selectedParams.keys());
}

// ============================================================================
// History Storage Functions
// ============================================================================

/**
 * Versions before 3.0.0 saved rolling walk-forward windows with snake_case
 * metrics, which the results view cannot render. Such entries are removed.
 */
function hasLegacyRollingMetrics(entry: SavedResult): boolean {
  const windows = entry.result.rollingWalkForwardResult?.windowResults ?? [];
  return windows.some(w => typeof w.isMetrics?.sharpeRatio !== 'number');
}

async function loadHistory(): Promise<SavedResult[]> {
  try {
    const data = await chrome.storage.local.get(HISTORY_STORAGE_KEY);
    const entries = (data[HISTORY_STORAGE_KEY] as SavedResult[]) || [];
    const valid = entries.filter(entry => !hasLegacyRollingMetrics(entry));
    if (valid.length !== entries.length) {
      console.log('[RQ Optimizer] Removing', entries.length - valid.length, 'legacy rolling walk-forward history entries');
      await chrome.storage.local.set({ [HISTORY_STORAGE_KEY]: valid });
    }
    return valid;
  } catch (err) {
    console.warn('[RQ Optimizer] Failed to load history:', err);
    return [];
  }
}

async function saveToHistory(result: OptimizationResult): Promise<string> {
  const id = `opt-${Date.now()}`;
  const bestProfit = result.bestRun?.metrics.netProfitPercent ?? 0;

  const entry: SavedResult = {
    id,
    savedAt: new Date().toISOString(),
    strategyName: result.strategyName,
    symbol: result.symbol,
    timeframe: result.timeframe,
    mode: result.config.mode || 'params',
    runsCount: result.runs.length,
    bestProfit,
    result,
  };

  const entries = await loadHistory();
  entries.unshift(entry);

  // Prune oldest when over limit
  while (entries.length > MAX_HISTORY_ENTRIES) {
    entries.pop();
  }

  try {
    await chrome.storage.local.set({ [HISTORY_STORAGE_KEY]: entries });
    console.log('[RQ Optimizer] Saved to history:', id);
    return id;
  } catch (err) {
    const [resultBytes, historyBytes, totalBytes] = await Promise.all([
      Promise.resolve(estimateJsonSizeBytes(result)),
      getLocalStorageBytesInUse(HISTORY_STORAGE_KEY),
      getLocalStorageBytesInUse(null),
    ]);
    console.error('[RQ Optimizer] Failed to save history entry:', err);
    console.error('[RQ Optimizer] History diagnostics:', {
      resultBytes,
      historyBytes,
      totalBytes,
      entriesCount: entries.length,
      maxEntries: MAX_HISTORY_ENTRIES,
    });
    throw err;
  }
}

async function deleteFromHistory(id: string): Promise<void> {
  const entries = await loadHistory();
  const filtered = entries.filter(e => e.id !== id);
  await chrome.storage.local.set({ [HISTORY_STORAGE_KEY]: filtered });
  state.historyEntries = filtered;
}

async function clearHistory(): Promise<void> {
  await chrome.storage.local.set({ [HISTORY_STORAGE_KEY]: [] });
  state.historyEntries = [];
}

// ============================================================================
// Styles
// ============================================================================

const STYLES = `
  /* Strategy Optimizer - Roboquant design system */

  .rq-optimizer-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    align-self: center;
    gap: 4px;
    padding: 4px 10px;
    margin: 0 12px;
    background: linear-gradient(180deg, #24c6ff 0%, #026dff 100%);
    color: #fff;
    border: none;
    border-radius: 4px;
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
    transition: opacity 150ms ease-out, transform 150ms ease-out;
    font-family: Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    height: 24px;
    white-space: nowrap;
    flex-shrink: 0;
  }

  .rq-optimizer-btn:hover {
    opacity: 0.9;
    transform: translateY(-1px);
  }

  .rq-optimizer-btn:active {
    transform: translateY(0);
  }

  .rq-optimizer-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .rq-optimizer-btn svg {
    width: 14px;
    height: 14px;
    flex-shrink: 0;
  }

  .rq-optimizer-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.8);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 999999;
    font-family: Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  }

  .rq-optimizer-modal {
    background: #0a0a0a;
    border-radius: 12px;
    width: 720px;
    max-width: 95vw;
    max-height: 90vh;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.8);
    border: 1px solid rgba(255, 255, 255, 0.08);
  }

  .rq-optimizer-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 20px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    background: #0a0a0a;
  }

  .rq-optimizer-title {
    font-size: 15px;
    font-weight: 600;
    color: #fafafa;
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .rq-optimizer-logo {
    width: 24px;
    height: 24px;
  }

  .rq-optimizer-close {
    background: transparent;
    border: 1px solid rgba(255, 255, 255, 0.1);
    color: #71717a;
    width: 28px;
    height: 28px;
    border-radius: 6px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: background 150ms ease-out, color 150ms ease-out;
  }

  .rq-optimizer-close:hover {
    background: rgba(255, 255, 255, 0.05);
    color: #fafafa;
  }

  .rq-optimizer-body {
    padding: 20px;
    overflow-y: auto;
    flex: 1;
    background: #0a0a0a;
  }

  .rq-optimizer-section {
    margin-bottom: 24px;
  }

  .rq-optimizer-section:last-child {
    margin-bottom: 0;
  }

  .rq-optimizer-section-title {
    font-size: 11px;
    font-weight: 500;
    color: #52525b;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 12px;
  }

  .rq-optimizer-params-scroll {
    max-height: 340px;
    overflow-y: auto;
    scrollbar-width: thin;
    scrollbar-color: rgba(255,255,255,0.1) transparent;
  }

  .rq-optimizer-params-scroll::-webkit-scrollbar {
    width: 4px;
  }

  .rq-optimizer-params-scroll::-webkit-scrollbar-track {
    background: transparent;
  }

  .rq-optimizer-params-scroll::-webkit-scrollbar-thumb {
    background: rgba(255,255,255,0.1);
    border-radius: 2px;
  }

  .rq-optimizer-params {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .rq-optimizer-param {
    display: grid;
    grid-template-columns: 18px 1fr 60px 60px 60px;
    gap: 8px;
    align-items: center;
    padding: 7px 10px;
    background: rgba(255, 255, 255, 0.02);
    border-radius: 6px;
    border: 1px solid rgba(255, 255, 255, 0.06);
    transition: border-color 150ms ease-out, background 150ms ease-out;
    overflow: hidden;
  }

  .rq-optimizer-param > div {
    min-width: 0;
  }

  .rq-optimizer-param:hover {
    border-color: rgba(255, 255, 255, 0.1);
  }

  .rq-optimizer-param.selected {
    border-color: rgba(36, 198, 255, 0.4);
    background: rgba(36, 198, 255, 0.05);
  }

  .rq-optimizer-param-check {
    width: 14px;
    height: 14px;
    accent-color: #24c6ff;
    cursor: pointer;
  }

  .rq-optimizer-param-info {
    display: flex;
    align-items: baseline;
    gap: 8px;
    min-width: 0;
  }

  .rq-optimizer-param-name {
    font-size: 12px;
    color: #e4e4e7;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .rq-optimizer-param-current {
    font-size: 10px;
    color: #52525b;
    font-variant-numeric: tabular-nums;
    flex-shrink: 0;
  }

  .rq-optimizer-param-input {
    width: 100%;
    max-width: 100%;
    min-width: 0;
    box-sizing: border-box;
    padding: 4px 4px;
    background: rgba(0, 0, 0, 0.3);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 4px;
    color: #e4e4e7;
    font-size: 11px;
    font-variant-numeric: tabular-nums;
    text-align: center;
    transition: border-color 150ms ease-out;
    -moz-appearance: textfield;
  }

  .rq-optimizer-param-input::-webkit-outer-spin-button,
  .rq-optimizer-param-input::-webkit-inner-spin-button {
    -webkit-appearance: none;
    margin: 0;
  }

  .rq-optimizer-param-input:focus {
    outline: none;
    border-color: rgba(36, 198, 255, 0.5);
  }

  .rq-optimizer-param-input:disabled {
    opacity: 0.3;
    cursor: not-allowed;
  }

  .rq-optimizer-param-label {
    font-size: 9px;
    color: #52525b;
    text-align: center;
    margin-top: 2px;
  }

  .rq-optimizer-section-title-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 10px;
  }

  .rq-optimizer-param-count {
    font-size: 11px;
    color: #52525b;
    font-variant-numeric: tabular-nums;
  }

  .rq-optimizer-param-count .count-num {
    color: #24c6ff;
    font-weight: 500;
  }

  .rq-optimizer-settings {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px;
  }

  .rq-optimizer-setting {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .rq-optimizer-setting label {
    font-size: 12px;
    color: #71717a;
  }

  .rq-optimizer-setting select,
  .rq-optimizer-setting input {
    padding: 10px 12px;
    background: #18181b !important;
    background-color: #18181b !important;
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 8px;
    color: #e4e4e7 !important;
    font-size: 13px;
    transition: border-color 150ms ease-out;
    color-scheme: dark;
    -webkit-appearance: none;
    -moz-appearance: none;
    appearance: none;
  }

  .rq-optimizer-setting select {
    cursor: pointer;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23a1a1aa' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 12px center;
    padding-right: 36px;
  }

  .rq-optimizer-setting select option {
    background: #18181b !important;
    background-color: #18181b !important;
    color: #e4e4e7 !important;
    padding: 8px;
  }

  .rq-optimizer-setting select:focus,
  .rq-optimizer-setting input:focus {
    outline: none;
    border-color: rgba(36, 198, 255, 0.5);
  }

  .rq-optimizer-info {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    background: rgba(36, 198, 255, 0.05);
    border: 1px solid rgba(36, 198, 255, 0.15);
    border-radius: 6px;
    margin-top: 12px;
  }

  .rq-optimizer-info-icon {
    color: #24c6ff;
    flex-shrink: 0;
  }

  .rq-optimizer-info-text {
    font-size: 12px;
    color: #a1a1aa;
    font-variant-numeric: tabular-nums;
  }

  .rq-optimizer-info-text strong {
    color: #e4e4e7;
    font-weight: 500;
  }

  .rq-optimizer-warning {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    background: rgba(245, 158, 11, 0.05);
    border: 1px solid rgba(245, 158, 11, 0.15);
    border-radius: 6px;
    margin-top: 12px;
  }

  .rq-optimizer-warning-icon {
    color: #f59e0b;
    flex-shrink: 0;
  }

  .rq-optimizer-warning-text {
    font-size: 11px;
    color: #71717a;
    line-height: 1.3;
  }

  .rq-optimizer-warning-text strong {
    color: #f59e0b;
  }

  .rq-optimizer-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 20px;
    border-top: 1px solid rgba(255, 255, 255, 0.08);
    background: rgba(255, 255, 255, 0.02);
  }

  .rq-optimizer-footer-left {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .rq-optimizer-footer-right {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .rq-optimizer-btn-secondary {
    padding: 10px 16px;
    background: transparent;
    color: #a1a1aa;
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 8px;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    transition: background 150ms ease-out, color 150ms ease-out;
  }

  .rq-optimizer-btn-secondary:hover {
    background: rgba(255, 255, 255, 0.05);
    color: #e4e4e7;
  }

  .rq-optimizer-btn-primary {
    padding: 10px 20px;
    background: #fafafa;
    color: #0a0a0a;
    border: none;
    border-radius: 8px;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    transition: opacity 150ms ease-out;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .rq-optimizer-btn-primary:hover {
    opacity: 0.9;
  }

  .rq-optimizer-btn-primary:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .rq-optimizer-btn-danger {
    background: #dc2626;
    color: white;
  }

  .rq-optimizer-btn-danger:hover {
    opacity: 0.9;
  }

  /* Progress View */
  .rq-optimizer-progress {
    text-align: center;
    padding: 24px 0;
  }

  .rq-optimizer-progress-bar-container {
    width: 100%;
    height: 4px;
    background: rgba(255, 255, 255, 0.1);
    border-radius: 2px;
    overflow: hidden;
    margin: 20px 0;
  }

  .rq-optimizer-progress-bar {
    height: 100%;
    background: linear-gradient(90deg, #24c6ff, #026dff);
    border-radius: 2px;
    transition: width 200ms ease-out;
  }

  .rq-optimizer-progress-text {
    font-size: 15px;
    color: #e4e4e7;
    margin-bottom: 8px;
    font-variant-numeric: tabular-nums;
  }

  .rq-optimizer-progress-detail {
    font-size: 12px;
    color: #71717a;
    font-family: 'JetBrains Mono', monospace;
  }

  .rq-optimizer-best {
    margin-top: 24px;
    padding: 16px;
    background: rgba(36, 198, 255, 0.05);
    border: 1px solid rgba(36, 198, 255, 0.2);
    border-radius: 8px;
  }

  .rq-optimizer-best-title {
    font-size: 11px;
    font-weight: 500;
    color: #24c6ff;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 8px;
  }

  .rq-optimizer-best-value {
    font-size: 24px;
    font-weight: 600;
    color: #24c6ff;
    font-variant-numeric: tabular-nums;
  }

  .rq-optimizer-best-params {
    font-size: 12px;
    color: #71717a;
    margin-top: 8px;
    font-family: 'JetBrains Mono', monospace;
  }

  /* Results View */
  .rq-optimizer-results {
    max-height: 400px;
    overflow-y: auto;
    border-radius: 8px;
    border: 1px solid rgba(255, 255, 255, 0.06);
  }

  .rq-optimizer-results-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }

  .rq-optimizer-results-table th {
    position: sticky;
    top: 0;
    background: #18181b;
    padding: 10px 12px;
    text-align: left;
    color: #71717a;
    font-weight: 500;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    border-bottom: 1px solid rgba(255, 255, 255, 0.06);
    cursor: pointer;
    user-select: none;
    transition: color 150ms ease-out;
  }

  .rq-optimizer-results-table th:hover {
    color: #e4e4e7;
  }

  .rq-optimizer-results-table td {
    padding: 10px 12px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.04);
    color: #e4e4e7;
  }

  .rq-optimizer-results-table tbody tr:hover td {
    background: rgba(255, 255, 255, 0.03);
  }

  .rq-optimizer-apply-row-btn {
    padding: 4px 10px;
    background: rgba(36, 198, 255, 0.1);
    border: 1px solid rgba(36, 198, 255, 0.3);
    border-radius: 4px;
    color: #24c6ff;
    font-size: 11px;
    cursor: pointer;
    transition: all 150ms ease-out;
    white-space: nowrap;
  }

  .rq-optimizer-apply-row-btn:hover {
    background: rgba(36, 198, 255, 0.2);
    border-color: rgba(36, 198, 255, 0.5);
  }

  .rq-optimizer-apply-row-btn.applied {
    background: rgba(36, 198, 255, 0.15);
    border-color: rgba(36, 198, 255, 0.4);
    color: #24c6ff;
  }

  .rq-optimizer-results-table td:last-child {
    text-align: center;
  }

  .rq-optimizer-results-table tr:hover td {
    background: rgba(255, 255, 255, 0.02);
  }

  .rq-optimizer-results-table tr.best td {
    background: rgba(36, 198, 255, 0.08);
  }

  .rq-optimizer-positive {
    color: #24c6ff;
  }

  .rq-optimizer-negative {
    color: #ef4444;
  }

  .rq-optimizer-warning {
    color: #f59e0b;
  }

  .rq-optimizer-export-btns {
    display: flex;
    gap: 8px;
    margin-top: 16px;
  }

  .rq-optimizer-spinner {
    width: 18px;
    height: 18px;
    border: 2px solid rgba(36, 198, 255, 0.2);
    border-top-color: #24c6ff;
    border-radius: 50%;
    animation: rq-spin 0.8s linear infinite;
  }

  @keyframes rq-spin {
    to { transform: rotate(360deg); }
  }

  .rq-optimizer-empty {
    text-align: center;
    padding: 48px 24px;
    color: #52525b;
  }

  .rq-optimizer-empty-icon {
    font-size: 40px;
    margin-bottom: 16px;
    opacity: 0.5;
  }

  .rq-optimizer-empty-text {
    font-size: 13px;
    margin-bottom: 8px;
    color: #71717a;
  }

  .rq-optimizer-empty-hint {
    font-size: 12px;
    color: #52525b;
  }

  /* Walk-Forward (IS/OOS) Styles */
  .rq-optimizer-walkforward {
    margin-top: 16px;
    padding: 16px;
    background: rgba(255, 255, 255, 0.02);
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 8px;
  }

  .rq-optimizer-walkforward.enabled {
    border-color: rgba(36, 198, 255, 0.3);
    background: rgba(36, 198, 255, 0.03);
  }

  .rq-optimizer-walkforward-header {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 12px;
  }

  .rq-optimizer-walkforward-toggle {
    display: flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;
    font-size: 13px;
    color: #e4e4e7;
    user-select: none;
  }

  .rq-optimizer-walkforward-toggle input {
    width: 16px;
    height: 16px;
    accent-color: #24c6ff;
    cursor: pointer;
  }

  .rq-optimizer-walkforward-badge {
    font-size: 10px;
    font-weight: 500;
    padding: 2px 6px;
    background: rgba(36, 198, 255, 0.2);
    color: #24c6ff;
    border-radius: 4px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .rq-optimizer-walkforward-dates {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px;
    margin-top: 12px;
  }

  .rq-optimizer-walkforward-period {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .rq-optimizer-walkforward-period-label {
    font-size: 11px;
    font-weight: 500;
    color: #71717a;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .rq-optimizer-walkforward-period.is .rq-optimizer-walkforward-period-label {
    color: #24c6ff;
  }

  .rq-optimizer-walkforward-period.oos .rq-optimizer-walkforward-period-label {
    color: #f59e0b;
  }

  .rq-optimizer-walkforward-inputs {
    display: flex;
    gap: 8px;
    align-items: center;
  }

  .rq-optimizer-walkforward-inputs span {
    font-size: 12px;
    color: #52525b;
  }

  .rq-optimizer-date-input {
    flex: 1;
    padding: 8px 10px;
    background: rgba(0, 0, 0, 0.3);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 6px;
    color: #e4e4e7;
    font-size: 12px;
    font-family: 'JetBrains Mono', monospace;
    transition: border-color 150ms ease-out;
  }

  .rq-optimizer-date-input:focus {
    outline: none;
    border-color: rgba(36, 198, 255, 0.5);
  }

  .rq-optimizer-date-input:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  /* Walk-Forward Results Comparison */
  .rq-optimizer-wf-comparison {
    margin-bottom: 20px;
  }

  .rq-optimizer-wf-comparison-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
    background: rgba(255, 255, 255, 0.02);
    border-radius: 8px;
    overflow: hidden;
  }

  .rq-optimizer-wf-comparison-table th,
  .rq-optimizer-wf-comparison-table td {
    padding: 10px 12px;
    text-align: center;
    border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  }

  .rq-optimizer-wf-comparison-table th {
    background: #18181b;
    color: #71717a;
    font-weight: 500;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .rq-optimizer-wf-comparison-table th:first-child {
    text-align: left;
  }

  .rq-optimizer-wf-comparison-table td:first-child {
    text-align: left;
    color: #a1a1aa;
  }

  .rq-optimizer-wf-comparison-table .is-col {
    background: rgba(36, 198, 255, 0.05);
    color: #24c6ff;
  }

  .rq-optimizer-wf-comparison-table .oos-col {
    background: rgba(245, 158, 11, 0.05);
    color: #f59e0b;
  }

  .rq-optimizer-wf-comparison-table .ratio-col {
    font-weight: 500;
  }

  .rq-optimizer-wf-comparison-table .ratio-good {
    color: #24c6ff;
  }

  .rq-optimizer-wf-comparison-table .ratio-warning {
    color: #f59e0b;
  }

  .rq-optimizer-wf-comparison-table .ratio-bad {
    color: #ef4444;
  }

  .rq-optimizer-overfitting-score {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 12px;
    padding: 16px;
    background: rgba(255, 255, 255, 0.02);
    border-radius: 8px;
    margin-top: 16px;
  }

  .rq-optimizer-overfitting-label {
    font-size: 13px;
    color: #71717a;
  }

  .rq-optimizer-overfitting-value {
    font-size: 18px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }

  .rq-optimizer-overfitting-value.robust {
    color: #24c6ff;
  }

  .rq-optimizer-overfitting-value.moderate {
    color: #f59e0b;
  }

  .rq-optimizer-overfitting-value.overfit {
    color: #ef4444;
  }

  .rq-optimizer-overfitting-badge {
    font-size: 11px;
    font-weight: 500;
    padding: 4px 8px;
    border-radius: 4px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .rq-optimizer-overfitting-badge.robust {
    background: rgba(36, 198, 255, 0.15);
    color: #24c6ff;
  }

  .rq-optimizer-overfitting-badge.moderate {
    background: rgba(245, 158, 11, 0.15);
    color: #f59e0b;
  }

  .rq-optimizer-overfitting-badge.overfit {
    background: rgba(239, 68, 68, 0.15);
    color: #ef4444;
  }

  .rq-optimizer-wf-phase {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    background: rgba(255, 255, 255, 0.02);
    border-radius: 6px;
    margin-bottom: 16px;
  }

  .rq-optimizer-wf-phase-indicator {
    width: 8px;
    height: 8px;
    border-radius: 50%;
  }

  .rq-optimizer-wf-phase-indicator.is {
    background: #24c6ff;
  }

  .rq-optimizer-wf-phase-indicator.oos {
    background: #f59e0b;
  }

  .rq-optimizer-wf-phase-text {
    font-size: 12px;
    color: #a1a1aa;
  }

  .rq-optimizer-wf-phase-text strong {
    color: #e4e4e7;
  }

  /* Heatmap Styles */
  .rq-optimizer-heatmap-section {
    margin-top: 20px;
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 8px;
    overflow: hidden;
  }

  .rq-optimizer-heatmap-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    background: rgba(255, 255, 255, 0.02);
    cursor: pointer;
    user-select: none;
    transition: background 150ms ease-out;
  }

  .rq-optimizer-heatmap-header:hover {
    background: rgba(255, 255, 255, 0.04);
  }

  .rq-optimizer-heatmap-header-left {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .rq-optimizer-heatmap-header-title {
    font-size: 13px;
    font-weight: 500;
    color: #e4e4e7;
  }

  .rq-optimizer-heatmap-header-badge {
    font-size: 10px;
    padding: 2px 6px;
    background: rgba(36, 198, 255, 0.15);
    color: #24c6ff;
    border-radius: 4px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .rq-optimizer-heatmap-chevron {
    color: #71717a;
    transition: transform 200ms ease-out;
  }

  .rq-optimizer-heatmap-chevron.expanded {
    transform: rotate(180deg);
  }

  .rq-optimizer-heatmap-content {
    padding: 16px;
    border-top: 1px solid rgba(255, 255, 255, 0.06);
  }

  .rq-optimizer-heatmap-controls {
    display: flex;
    align-items: center;
    gap: 16px;
    margin-bottom: 16px;
    flex-wrap: wrap;
  }

  .rq-optimizer-heatmap-control {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .rq-optimizer-heatmap-control label {
    font-size: 12px;
    color: #71717a;
  }

  .rq-optimizer-heatmap-control select {
    padding: 6px 10px;
    background: #18181b;
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 6px;
    color: #e4e4e7;
    font-size: 12px;
    cursor: pointer;
  }

  .rq-optimizer-heatmap-toggle {
    display: flex;
    background: rgba(255, 255, 255, 0.05);
    border-radius: 6px;
    padding: 2px;
  }

  .rq-optimizer-heatmap-toggle-btn {
    padding: 6px 12px;
    background: transparent;
    border: none;
    border-radius: 4px;
    color: #71717a;
    font-size: 12px;
    cursor: pointer;
    transition: background 150ms ease-out, color 150ms ease-out;
  }

  .rq-optimizer-heatmap-toggle-btn.active {
    background: rgba(36, 198, 255, 0.2);
    color: #24c6ff;
  }

  .rq-optimizer-heatmap-toggle-btn:hover:not(.active) {
    color: #a1a1aa;
  }

  .rq-optimizer-heatmap-container {
    position: relative;
    background: #0a0a0a;
    border-radius: 8px;
    min-height: 300px;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .rq-optimizer-heatmap-canvas {
    display: block;
  }

  .rq-optimizer-heatmap-3d {
    width: 100%;
    height: 400px;
  }

  .rq-optimizer-heatmap-legend {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    margin-top: 12px;
    font-size: 11px;
    color: #71717a;
  }

  .rq-optimizer-heatmap-gradient {
    width: 150px;
    height: 12px;
    border-radius: 2px;
    background: linear-gradient(to right, #ef4444, #f59e0b, #24c6ff);
  }

  .rq-optimizer-heatmap-empty {
    text-align: center;
    padding: 40px 20px;
    color: #52525b;
  }

  .rq-optimizer-heatmap-empty-text {
    font-size: 13px;
    margin-bottom: 8px;
  }

  .rq-optimizer-heatmap-loading {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
    color: #71717a;
    font-size: 12px;
  }

  .rq-optimizer-heatmap-tooltip {
    position: absolute;
    padding: 8px 12px;
    background: #18181b;
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 6px;
    font-size: 11px;
    color: #e4e4e7;
    pointer-events: none;
    z-index: 10;
    white-space: nowrap;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
  }

  .rq-optimizer-heatmap-tooltip-row {
    display: flex;
    justify-content: space-between;
    gap: 16px;
  }

  .rq-optimizer-heatmap-tooltip-label {
    color: #71717a;
  }

  .rq-optimizer-heatmap-tooltip-value {
    font-weight: 500;
    font-variant-numeric: tabular-nums;
  }

  /* Mode Tabs */
  .rq-optimizer-mode-tabs {
    display: flex;
    gap: 4px;
    padding: 4px;
    background: rgba(255, 255, 255, 0.03);
    border-radius: 8px;
    border: 1px solid rgba(255, 255, 255, 0.06);
    margin-bottom: 20px;
  }

  .rq-optimizer-mode-tab {
    flex: 1;
    padding: 8px 12px;
    background: transparent;
    border: none;
    border-radius: 6px;
    color: #71717a;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    transition: background 150ms ease-out, color 150ms ease-out;
    white-space: nowrap;
  }

  .rq-optimizer-mode-tab:hover {
    color: #a1a1aa;
  }

  .rq-optimizer-mode-tab.active {
    background: rgba(36, 198, 255, 0.15);
    color: #24c6ff;
  }

  /* Multi-Symbol Section */
  .rq-optimizer-symbols {
    margin-top: 16px;
    padding: 16px;
    background: rgba(255, 255, 255, 0.02);
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 8px;
  }

  .rq-optimizer-symbol-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-bottom: 10px;
    min-height: 28px;
  }

  .rq-optimizer-symbol-tag {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 4px 8px;
    background: rgba(36, 198, 255, 0.1);
    border: 1px solid rgba(36, 198, 255, 0.3);
    border-radius: 4px;
    color: #24c6ff;
    font-size: 11px;
    font-weight: 600;
    font-family: 'JetBrains Mono', monospace;
    letter-spacing: 0.02em;
  }

  .rq-optimizer-symbol-tag-remove {
    background: none;
    border: none;
    color: #24c6ff;
    cursor: pointer;
    font-size: 14px;
    line-height: 1;
    padding: 0 2px;
    opacity: 0.6;
    transition: opacity 150ms ease-out;
  }

  .rq-optimizer-symbol-tag-remove:hover {
    opacity: 1;
  }

  .rq-optimizer-symbol-input-row {
    display: flex;
    gap: 8px;
  }

  .rq-optimizer-symbol-input-row input {
    flex: 1;
    padding: 8px 10px;
    background: rgba(0, 0, 0, 0.3);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 6px;
    color: #e4e4e7;
    font-size: 12px;
    font-family: 'JetBrains Mono', monospace;
    text-transform: uppercase;
  }

  .rq-optimizer-symbol-input-row input:focus {
    outline: none;
    border-color: rgba(36, 198, 255, 0.5);
  }

  .rq-optimizer-symbol-input-row input::placeholder {
    text-transform: none;
  }

  .rq-optimizer-symbol-add-btn {
    padding: 8px 14px;
    background: rgba(36, 198, 255, 0.1);
    border: 1px solid rgba(36, 198, 255, 0.3);
    border-radius: 6px;
    color: #24c6ff;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    transition: background 150ms ease-out;
  }

  .rq-optimizer-symbol-add-btn:hover {
    background: rgba(36, 198, 255, 0.2);
  }

  /* Multi-Timeframe Section */
  .rq-optimizer-timeframes {
    margin-top: 16px;
    padding: 16px;
    background: rgba(255, 255, 255, 0.02);
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 8px;
  }

  .rq-optimizer-tf-grid {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .rq-optimizer-tf-btn {
    padding: 6px 12px;
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 6px;
    color: #71717a;
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    transition: all 150ms ease-out;
  }

  .rq-optimizer-tf-btn:hover {
    border-color: rgba(255, 255, 255, 0.2);
    color: #a1a1aa;
  }

  .rq-optimizer-tf-btn.active {
    background: rgba(36, 198, 255, 0.15);
    border-color: rgba(36, 198, 255, 0.4);
    color: #24c6ff;
  }

  /* Rolling Walk-Forward Config */
  .rq-optimizer-rolling-config {
    margin-top: 12px;
    padding: 12px;
    background: rgba(255, 255, 255, 0.02);
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 6px;
  }

  .rq-optimizer-rolling-config-grid {
    display: grid;
    grid-template-columns: 1fr 1fr 1fr;
    gap: 12px;
    margin-top: 12px;
  }

  .rq-optimizer-rolling-config-field {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .rq-optimizer-rolling-config-field label {
    font-size: 11px;
    color: #71717a;
  }

  .rq-optimizer-rolling-config-field input {
    padding: 8px 10px;
    background: rgba(0, 0, 0, 0.3);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 6px;
    color: #e4e4e7;
    font-size: 12px;
    text-align: center;
    font-variant-numeric: tabular-nums;
  }

  .rq-optimizer-rolling-config-field input:focus {
    outline: none;
    border-color: rgba(36, 198, 255, 0.5);
  }

  .rq-optimizer-window-preview {
    margin-top: 12px;
    padding: 10px 12px;
    background: rgba(36, 198, 255, 0.05);
    border: 1px solid rgba(36, 198, 255, 0.15);
    border-radius: 6px;
    font-size: 12px;
    color: #a1a1aa;
  }

  .rq-optimizer-window-preview strong {
    color: #24c6ff;
  }

  .rq-optimizer-wf-mode-toggle {
    display: flex;
    gap: 4px;
    padding: 3px;
    background: rgba(255, 255, 255, 0.03);
    border-radius: 6px;
    margin-left: auto;
  }

  .rq-optimizer-wf-mode-btn {
    padding: 4px 10px;
    background: transparent;
    border: none;
    border-radius: 4px;
    color: #71717a;
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
    transition: all 150ms ease-out;
  }

  .rq-optimizer-wf-mode-btn.active {
    background: rgba(36, 198, 255, 0.2);
    color: #24c6ff;
  }

  .rq-optimizer-wf-mode-btn:hover:not(.active) {
    color: #a1a1aa;
  }

  /* Best-by-dimension summary cards */
  .rq-optimizer-dimension-bests {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: 10px;
    margin-bottom: 16px;
  }

  .rq-optimizer-dimension-card {
    padding: 12px;
    background: rgba(255, 255, 255, 0.02);
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 8px;
  }

  .rq-optimizer-dimension-card-label {
    font-size: 10px;
    font-weight: 500;
    color: #52525b;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 6px;
  }

  .rq-optimizer-dimension-card-value {
    font-size: 16px;
    font-weight: 600;
    color: #24c6ff;
    font-variant-numeric: tabular-nums;
  }

  .rq-optimizer-dimension-card-params {
    font-size: 11px;
    color: #71717a;
    margin-top: 4px;
    font-family: 'JetBrains Mono', monospace;
  }

  /* Primary gradient button */
  .rq-optimizer-btn-send {
    padding: 10px 16px;
    background: linear-gradient(180deg, #24c6ff 0%, #026dff 100%);
    color: #fff;
    border: none;
    border-radius: 8px;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    transition: opacity 150ms ease-out;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .rq-optimizer-btn-send:hover {
    opacity: 0.9;
  }

  /* Roboquant links (never overlay results) */
  .rq-optimizer-promo {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-top: 20px;
    padding: 12px 14px;
    border-radius: 10px;
    border: 1px solid rgba(36, 198, 255, 0.2);
    background: rgba(36, 198, 255, 0.04);
    color: #a1a1aa;
    text-decoration: none;
    transition: border-color 150ms ease-out;
  }

  .rq-optimizer-promo:hover {
    border-color: rgba(36, 198, 255, 0.45);
    color: #e4e4e7;
  }

  .rq-optimizer-promo-text {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .rq-optimizer-promo-title {
    font-size: 13px;
    font-weight: 500;
    color: #e4e4e7;
  }

  .rq-optimizer-promo-sub {
    font-size: 11px;
    color: #71717a;
  }

  .rq-optimizer-byline {
    font-size: 11px;
    color: #52525b;
    text-decoration: none;
  }

  .rq-optimizer-byline:hover {
    color: #a1a1aa;
  }

  /* Rolling WF Results */
  .rq-optimizer-rolling-summary {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 10px;
    margin-bottom: 16px;
  }

  .rq-optimizer-rolling-stat {
    padding: 12px;
    background: rgba(255, 255, 255, 0.02);
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 8px;
    text-align: center;
  }

  .rq-optimizer-rolling-stat-label {
    font-size: 10px;
    color: #52525b;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 4px;
  }

  .rq-optimizer-rolling-stat-value {
    font-size: 18px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }

  /* History View */
  .rq-optimizer-history-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 16px 20px;
    overflow-y: auto;
    max-height: 60vh;
  }

  .rq-optimizer-history-card {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 8px;
    transition: border-color 150ms ease-out;
  }

  .rq-optimizer-history-card:hover {
    border-color: rgba(255, 255, 255, 0.15);
  }

  .rq-optimizer-history-info {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
    flex: 1;
  }

  .rq-optimizer-history-title {
    font-size: 13px;
    font-weight: 500;
    color: #e4e4e7;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .rq-optimizer-history-meta {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 11px;
    color: #71717a;
    flex-wrap: wrap;
  }

  .rq-optimizer-history-badge {
    display: inline-flex;
    align-items: center;
    padding: 2px 6px;
    border-radius: 4px;
    font-size: 10px;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }

  .rq-optimizer-history-badge-mode {
    background: rgba(99, 102, 241, 0.1);
    color: #818cf8;
    border: 1px solid rgba(99, 102, 241, 0.2);
  }

  .rq-optimizer-history-actions {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-left: 12px;
    flex-shrink: 0;
  }

  .rq-optimizer-history-action-btn {
    padding: 6px 10px;
    background: transparent;
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 6px;
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
    transition: background 150ms ease-out, color 150ms ease-out;
    color: #a1a1aa;
  }

  .rq-optimizer-history-action-btn:hover {
    background: rgba(255, 255, 255, 0.05);
    color: #e4e4e7;
  }

  .rq-optimizer-history-action-btn-primary {
    background: rgba(255, 255, 255, 0.05);
    color: #e4e4e7;
  }

  .rq-optimizer-history-action-btn-danger:hover {
    background: rgba(220, 38, 38, 0.1);
    color: #ef4444;
    border-color: rgba(220, 38, 38, 0.3);
  }

  .rq-optimizer-history-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 48px 20px;
    text-align: center;
    gap: 8px;
  }

  .rq-optimizer-history-empty-icon {
    font-size: 32px;
    opacity: 0.5;
  }

  .rq-optimizer-history-empty-text {
    font-size: 14px;
    color: #a1a1aa;
    font-weight: 500;
  }

  .rq-optimizer-history-empty-hint {
    font-size: 12px;
    color: #52525b;
  }

  .rq-optimizer-history-profit {
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }

  .rq-optimizer-history-profit-positive {
    color: #24c6ff;
  }

  .rq-optimizer-history-profit-negative {
    color: #ef4444;
  }
`;

// ============================================================================
// Rolling Walk-Forward Window Generation (ported from walk-forward.ts)
// ============================================================================

function wfAddMonths(date: Date, months: number): Date {
  const result = new Date(date);
  result.setMonth(result.getMonth() + months);
  return result;
}

function wfFormatDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function generateRollingWindows(config: {
  totalStart: string;
  totalEnd: string;
  isWindowMonths: number;
  oosWindowMonths: number;
  stepMonths: number;
  mode: WalkForwardMode;
}): WalkForwardWindow[] {
  const windows: WalkForwardWindow[] = [];
  let windowNum = 1;

  let isStart = new Date(config.totalStart);
  const totalEnd = new Date(config.totalEnd);
  const anchoredStart = new Date(config.totalStart);
  const MAX_WINDOWS = 20;

  while (windowNum <= MAX_WINDOWS) {
    let isEnd: Date;
    if (config.mode === 'anchored') {
      isEnd = wfAddMonths(anchoredStart, config.isWindowMonths + (windowNum - 1) * config.stepMonths);
    } else {
      isEnd = wfAddMonths(isStart, config.isWindowMonths);
    }

    const oosStart = new Date(isEnd);
    const oosEnd = wfAddMonths(oosStart, config.oosWindowMonths);

    if (oosEnd > totalEnd) break;

    windows.push({
      windowNumber: windowNum,
      isStart: wfFormatDate(config.mode === 'anchored' ? anchoredStart : isStart),
      isEnd: wfFormatDate(isEnd),
      oosStart: wfFormatDate(oosStart),
      oosEnd: wfFormatDate(oosEnd),
    });

    windowNum++;

    if (config.mode === 'rolling') {
      isStart = wfAddMonths(isStart, config.stepMonths);
    }
  }

  return windows;
}

// ============================================================================
// UI Components
// ============================================================================

function injectStyles(): void {
  if (document.getElementById('rq-optimizer-styles')) return;

  const styleEl = document.createElement('style');
  styleEl.id = 'rq-optimizer-styles';
  styleEl.textContent = STYLES;
  document.head.appendChild(styleEl);
}

function createOptimizeButton(): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.className = 'rq-optimizer-btn';
  btn.id = 'rq-optimize-btn';
  btn.title = 'Strategy Optimizer';
  btn.innerHTML = `
    <svg viewBox="0 0 327.31 305.26" width="14" height="14" xmlns="http://www.w3.org/2000/svg">
      <path fill="#fff" d="M128.49,199.91c-13.72,0-24.86,11.13-24.86,24.86s11.13,24.86,24.86,24.86,24.86-11.13,24.86-24.86-11.13-24.86-24.86-24.86ZM327.31,142.42h-120.6l85.28-85.28-25.32-25.32-85.29,85.29V0h-35.81v120.6L60.63,35.66l-25.32,25.32,85.28,85.28H0v35.81h36.67c-9.11,13.25-14.44,29.28-14.44,46.53,0,45.41,36.94,82.35,82.35,82.35h118.59c45.41,0,82.35-36.94,82.35-82.35,0-17.25-5.34-33.28-14.44-46.53h36.68v-35.81h-.44ZM223.17,269.67h-118.59c-25.66,0-46.54-20.87-46.54-46.54s20.87-46.54,46.54-46.54h41.37v.01h17.91l13.44-.01h45.84c25.66,0,46.54,20.87,46.54,46.54s-20.87,46.54-46.54,46.54h.04ZM199.25,199.91c-13.72,0-24.86,11.13-24.86,24.86s11.13,24.86,24.86,24.86,24.86-11.13,24.86-24.86-11.13-24.86-24.86-24.86Z"/>
    </svg>
    Optimizer
  `;
  btn.addEventListener('click', openOptimizer);
  return btn;
}

function createOverlay(): HTMLDivElement {
  const overlay = document.createElement('div');
  overlay.className = 'rq-optimizer-overlay';
  overlay.id = 'rq-optimizer-overlay';
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay && !state.isRunning) {
      closeOptimizer();
    }
  });
  return overlay;
}

/**
 * Attach event listeners to the modal after rendering
 * This avoids CSP issues with inline onclick handlers
 */
function attachEventListeners(): void {
  const overlay = document.getElementById('rq-optimizer-overlay');
  if (!overlay) return;

  // Close button
  const closeBtn = overlay.querySelector('.rq-optimizer-close');
  closeBtn?.addEventListener('click', () => {
    if (state.isRunning) {
      stopOptimization();
    } else {
      closeOptimizer();
    }
  });

  // Cancel button
  const cancelBtn = overlay.querySelector('[data-action="cancel"]');
  cancelBtn?.addEventListener('click', closeOptimizer);

  // Start button
  const startBtn = overlay.querySelector('[data-action="start"]');
  startBtn?.addEventListener('click', startOptimization);

  // Stop button
  const stopBtn = overlay.querySelector('[data-action="stop"]');
  stopBtn?.addEventListener('click', stopOptimization);

  // Refresh inputs button
  const refreshBtn = overlay.querySelector('[data-action="refresh"]');
  refreshBtn?.addEventListener('click', refreshInputs);

  // New optimization button
  const resetBtn = overlay.querySelector('[data-action="reset"]');
  resetBtn?.addEventListener('click', reset);

  // Export JSON button
  const exportBtn = overlay.querySelector('[data-action="export"]');
  exportBtn?.addEventListener('click', downloadResultAsJson);

  // Apply best button (legacy, keeping for backwards compatibility)
  const applyBtn = overlay.querySelector('[data-action="apply"]');
  applyBtn?.addEventListener('click', applyBest);

  // Apply row buttons (apply any row's parameters)
  const applyRowBtns = overlay.querySelectorAll('[data-action="apply-row"]');
  applyRowBtns.forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const runNumber = parseInt(btn.getAttribute('data-run-number') || '0', 10);
      applyRunParameters(runNumber);
    });
  });

  // Goal select
  const goalSelect = overlay.querySelector('[data-action="goal"]') as HTMLSelectElement;
  goalSelect?.addEventListener('change', () => setGoal(goalSelect.value));

  // Delay input
  const delayInput = overlay.querySelector('[data-action="delay"]') as HTMLInputElement;
  delayInput?.addEventListener('change', () => setDelay(delayInput.value));

  // Parameter checkboxes (only checkboxes, not min/max/step inputs)
  const checkboxes = overlay.querySelectorAll('.rq-optimizer-param-check');
  checkboxes.forEach((checkbox) => {
    const idx = parseInt(checkbox.getAttribute('data-param-idx') || '0', 10);
    checkbox.addEventListener('change', () => toggleParamByIndex(idx));
  });

  // Parameter min/max/step inputs
  const paramInputs = overlay.querySelectorAll('[data-param-field]');
  paramInputs.forEach((input) => {
    const idx = parseInt(input.getAttribute('data-param-idx') || '0', 10);
    const field = input.getAttribute('data-param-field') as 'min' | 'max' | 'step';
    input.addEventListener('change', () => {
      updateParamByIndex(idx, field, (input as HTMLInputElement).value);
    });
  });

  // Dropdown menu toggle buttons
  const dropdownTriggers = overlay.querySelectorAll('[data-action="toggle-dropdown-menu"]');
  dropdownTriggers.forEach(trigger => {
    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      const paramName = trigger.getAttribute('data-param-name');
      if (!paramName) return;
      const menu = overlay.querySelector(`[data-dropdown-menu="${paramName}"]`) as HTMLElement;
      if (!menu) return;

      // Close all other dropdown menus first
      overlay.querySelectorAll('.rq-optimizer-dropdown-menu').forEach(m => {
        if (m !== menu) (m as HTMLElement).style.display = 'none';
      });

      const isOpen = menu.style.display !== 'none';
      if (isOpen) {
        menu.style.display = 'none';
      } else {
        // Position the menu below the trigger using fixed positioning
        const rect = (trigger as HTMLElement).getBoundingClientRect();
        menu.style.display = 'block';
        menu.style.top = `${rect.bottom + 4}px`;
        menu.style.left = `${Math.max(8, rect.right - menu.offsetWidth)}px`;
      }
    });
  });

  // Dropdown option checkbox toggles
  const optionCheckboxes = overlay.querySelectorAll('[data-action="toggle-dropdown-option"]');
  optionCheckboxes.forEach(cb => {
    cb.addEventListener('change', (e) => {
      e.stopPropagation();
      const paramName = cb.getAttribute('data-param-name');
      const optionValue = cb.getAttribute('data-option');
      if (!paramName || !optionValue) return;
      toggleDropdownOption(paramName, optionValue);
    });
  });

  // Dropdown item hover effects (CSP-safe)
  const dropdownItems = overlay.querySelectorAll('.rq-optimizer-dropdown-item');
  dropdownItems.forEach(item => {
    item.addEventListener('mouseenter', () => { (item as HTMLElement).style.background = '#27272a'; });
    item.addEventListener('mouseleave', () => { (item as HTMLElement).style.background = 'transparent'; });
  });

  // Close dropdown menus when clicking outside
  overlay.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (!target.closest('.rq-optimizer-dropdown-select') && !target.closest('.rq-optimizer-dropdown-menu')) {
      overlay.querySelectorAll('.rq-optimizer-dropdown-menu').forEach(m => {
        (m as HTMLElement).style.display = 'none';
      });
    }
  });

  // Sort buttons in results table
  const sortBtns = overlay.querySelectorAll('[data-sort]');
  sortBtns.forEach((btn) => {
    const column = btn.getAttribute('data-sort') || '';
    btn.addEventListener('click', () => sortResults(column));
  });

  // Mode tab clicks
  const modeTabs = overlay.querySelectorAll('[data-action="mode-tab"]');
  modeTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const mode = tab.getAttribute('data-mode') as OptimizationMode;
      if (!mode) return;
      state.optimizationMode = mode;
      updateUI();
    });
  });

  // Symbol input (Enter key + Add button)
  const symbolInput = overlay.querySelector('[data-action="symbol-input"]') as HTMLInputElement;
  const symbolAddBtn = overlay.querySelector('[data-action="add-symbol"]');
  const addSymbol = () => {
    if (!symbolInput) return;
    const sym = symbolInput.value.trim().toUpperCase();
    if (sym && !state.symbols.includes(sym)) {
      state.symbols.push(sym);
      symbolInput.value = '';
      updateUI();
    }
  };
  symbolInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addSymbol(); }
  });
  symbolAddBtn?.addEventListener('click', addSymbol);

  // Symbol remove buttons
  const symbolRemoveBtns = overlay.querySelectorAll('[data-action="remove-symbol"]');
  symbolRemoveBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const sym = btn.getAttribute('data-symbol');
      if (sym) {
        state.symbols = state.symbols.filter(s => s !== sym);
        updateUI();
      }
    });
  });

  // Timeframe toggle buttons
  const tfBtns = overlay.querySelectorAll('[data-action="toggle-tf"]');
  tfBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const tf = btn.getAttribute('data-tf');
      if (!tf) return;
      const idx = state.selectedTimeframes.indexOf(tf);
      if (idx >= 0) {
        state.selectedTimeframes.splice(idx, 1);
      } else {
        state.selectedTimeframes.push(tf);
      }
      updateUI();
    });
  });

  // Walk-Forward toggle
  const wfToggle = overlay.querySelector('[data-action="toggle-walkforward"]');
  wfToggle?.addEventListener('change', toggleWalkForward);

  // Walk-Forward mode toggle (single/rolling)
  const wfModeBtns = overlay.querySelectorAll('[data-action="wf-mode"]');
  wfModeBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.getAttribute('data-wf-mode') as 'single' | 'rolling';
      if (mode) {
        state.walkForwardMode = mode;
        updateUI();
      }
    });
  });

  // Walk-Forward date inputs (single mode)
  const isStartInput = overlay.querySelector('[data-action="is-start"]') as HTMLInputElement;
  const isEndInput = overlay.querySelector('[data-action="is-end"]') as HTMLInputElement;
  const oosStartInput = overlay.querySelector('[data-action="oos-start"]') as HTMLInputElement;
  const oosEndInput = overlay.querySelector('[data-action="oos-end"]') as HTMLInputElement;

  isStartInput?.addEventListener('change', () => setWalkForwardDate('inSampleStart', isStartInput.value));
  isEndInput?.addEventListener('change', () => setWalkForwardDate('inSampleEnd', isEndInput.value));
  oosStartInput?.addEventListener('change', () => setWalkForwardDate('outOfSampleStart', oosStartInput.value));
  oosEndInput?.addEventListener('change', () => setWalkForwardDate('outOfSampleEnd', oosEndInput.value));

  // Rolling WF config inputs
  const rollingTotalStart = overlay.querySelector('[data-action="rolling-total-start"]') as HTMLInputElement;
  const rollingTotalEnd = overlay.querySelector('[data-action="rolling-total-end"]') as HTMLInputElement;
  const rollingISMonths = overlay.querySelector('[data-action="rolling-is-months"]') as HTMLInputElement;
  const rollingOOSMonths = overlay.querySelector('[data-action="rolling-oos-months"]') as HTMLInputElement;
  const rollingStepMonths = overlay.querySelector('[data-action="rolling-step-months"]') as HTMLInputElement;

  rollingTotalStart?.addEventListener('change', () => { state.rollingTotalStart = rollingTotalStart.value; updateUI(); });
  rollingTotalEnd?.addEventListener('change', () => { state.rollingTotalEnd = rollingTotalEnd.value; updateUI(); });
  rollingISMonths?.addEventListener('change', () => { state.rollingISWindowMonths = Number(rollingISMonths.value) || 24; updateUI(); });
  rollingOOSMonths?.addEventListener('change', () => { state.rollingOOSWindowMonths = Number(rollingOOSMonths.value) || 6; updateUI(); });
  rollingStepMonths?.addEventListener('change', () => { state.rollingStepMonths = Number(rollingStepMonths.value) || 6; updateUI(); });

  // Heatmap controls
  const heatmapHeader = overlay.querySelector('[data-action="toggle-heatmap"]');
  heatmapHeader?.addEventListener('click', toggleHeatmapExpanded);

  const heatmapXSelect = overlay.querySelector('[data-action="heatmap-x"]') as HTMLSelectElement;
  const heatmapYSelect = overlay.querySelector('[data-action="heatmap-y"]') as HTMLSelectElement;
  const heatmapMetricSelect = overlay.querySelector('[data-action="heatmap-metric"]') as HTMLSelectElement;

  heatmapXSelect?.addEventListener('change', () => {
    state.heatmapXParam = heatmapXSelect.value;
    renderHeatmap();
  });
  heatmapYSelect?.addEventListener('change', () => {
    state.heatmapYParam = heatmapYSelect.value;
    renderHeatmap();
  });
  heatmapMetricSelect?.addEventListener('change', () => {
    state.heatmapMetric = heatmapMetricSelect.value as keyof OptimizationMetrics;
    renderHeatmap();
  });

  const heatmap2dBtn = overlay.querySelector('[data-action="heatmap-2d"]');
  const heatmap3dBtn = overlay.querySelector('[data-action="heatmap-3d"]');

  heatmap2dBtn?.addEventListener('click', () => {
    console.log('[RQ Optimizer] Switching to 2D heatmap');
    state.heatmapMode = '2d';
    // Need to re-render the section to switch container type (canvas vs div)
    updateUI();
  });
  heatmap3dBtn?.addEventListener('click', () => {
    console.log('[RQ Optimizer] Switching to 3D heatmap');
    state.heatmapMode = '3d';
    // Need to re-render the section to switch container type (canvas vs div)
    updateUI();
  });

  // Prop Firm Challenge toggle
  const propFirmHeader = overlay.querySelector('[data-action="toggle-propfirm"]');
  propFirmHeader?.addEventListener('click', () => {
    state.propFirmExpanded = !state.propFirmExpanded;
    updateUI();
  });

  // Prop Firm CTA
  const propFirmCta = overlay.querySelector('[data-action="propfirm-cta"]');
  propFirmCta?.addEventListener('click', () => {
    window.open(roboquantLink('/', 'prop-firm'), '_blank', 'noopener,noreferrer');
  });

  // Render heatmap if section is expanded
  if (state.heatmapExpanded && state.result) {
    setTimeout(() => renderHeatmap(), 100);
  }

  // History: show history button
  const showHistoryBtn = overlay.querySelector('[data-action="show-history"]');
  showHistoryBtn?.addEventListener('click', async () => {
    state.historyEntries = await loadHistory();
    state.showHistory = true;
    updateUI();
  });

  // History: back button
  const historyBackBtn = overlay.querySelector('[data-action="history-back"]');
  historyBackBtn?.addEventListener('click', () => {
    state.showHistory = false;
    updateUI();
  });

  // History: view entry
  const historyViewBtns = overlay.querySelectorAll('[data-action="history-view"]');
  historyViewBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-history-id');
      const entry = state.historyEntries.find(e => e.id === id);
      if (entry) {
        state.result = entry.result;
        state.runs = entry.result.runs;
        state.currentHistoryId = entry.id;
        state.viewingFromHistory = true;
        state.showHistory = false;
        updateUI();
      }
    });
  });

  // History: delete entry
  const historyDeleteBtns = overlay.querySelectorAll('[data-action="history-delete"]');
  historyDeleteBtns.forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-history-id');
      if (id) {
        await deleteFromHistory(id);
        updateUI();
      }
    });
  });

  // History: clear all
  const historyClearBtn = overlay.querySelector('[data-action="history-clear"]');
  historyClearBtn?.addEventListener('click', async () => {
    await clearHistory();
    updateUI();
  });

  // Back to history from result view
  const backToHistoryBtn = overlay.querySelector('[data-action="back-to-history"]');
  backToHistoryBtn?.addEventListener('click', async () => {
    state.result = null;
    state.runs = [];
    state.currentHistoryId = null;
    state.viewingFromHistory = false;
    state.historyEntries = await loadHistory();
    state.showHistory = true;
    updateUI();
  });
}

function formatRelativeTime(isoDate: string): string {
  const now = Date.now();
  const then = new Date(isoDate).getTime();
  const diffMs = now - then;
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return new Date(isoDate).toLocaleDateString();
}

function getModeLabel(mode: string): string {
  switch (mode) {
    case 'params': return 'Standard';
    case 'timeframes': return 'Multi-TF';
    case 'symbols': return 'Multi-Symbol';
    case 'full_grid': return 'Full Grid';
    default: return mode;
  }
}

function renderHistoryView(): string {
  const entries = state.historyEntries;

  const cardsHtml = entries.length === 0 ? `
    <div class="rq-optimizer-history-empty">
      <div class="rq-optimizer-history-empty-icon">📋</div>
      <div class="rq-optimizer-history-empty-text">No saved results</div>
      <div class="rq-optimizer-history-empty-hint">Completed optimizations will appear here automatically</div>
    </div>
  ` : entries.map(entry => {
    const profitClass = entry.bestProfit >= 0 ? 'rq-optimizer-history-profit-positive' : 'rq-optimizer-history-profit-negative';
    return `
      <div class="rq-optimizer-history-card" data-history-id="${entry.id}">
        <div class="rq-optimizer-history-info">
          <div class="rq-optimizer-history-title">${escapeAttr(entry.strategyName)}</div>
          <div class="rq-optimizer-history-meta">
            <span>${entry.symbol} · ${entry.timeframe}</span>
            <span class="rq-optimizer-history-badge rq-optimizer-history-badge-mode">${getModeLabel(entry.mode)}</span>
            <span>${entry.runsCount} runs</span>
            <span class="rq-optimizer-history-profit ${profitClass}">${entry.bestProfit >= 0 ? '+' : ''}${entry.bestProfit.toFixed(1)}%</span>
            <span>${formatRelativeTime(entry.savedAt)}</span>
          </div>
        </div>
        <div class="rq-optimizer-history-actions">
          <button class="rq-optimizer-history-action-btn rq-optimizer-history-action-btn-primary" data-action="history-view" data-history-id="${entry.id}">View</button>
          <button class="rq-optimizer-history-action-btn rq-optimizer-history-action-btn-danger" data-action="history-delete" data-history-id="${entry.id}">Delete</button>
        </div>
      </div>
    `;
  }).join('');

  return `
    <div class="rq-optimizer-modal">
      <div class="rq-optimizer-header">
        <div class="rq-optimizer-title">
          <div class="rq-optimizer-logo">${RQ_LOGO_SVG}</div>
          Optimization History
        </div>
        <button class="rq-optimizer-close" aria-label="Close">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M18 6L6 18M6 6l12 12"/>
          </svg>
        </button>
      </div>

      <div class="rq-optimizer-history-list">
        ${cardsHtml}
      </div>

      <div class="rq-optimizer-footer">
        <div class="rq-optimizer-footer-left">
          ${entries.length > 0 ? `
            <button class="rq-optimizer-btn-secondary" data-action="history-clear" style="color: #ef4444;">
              Clear All
            </button>
          ` : ''}
        </div>
        <div class="rq-optimizer-footer-right">
          <button class="rq-optimizer-btn-secondary" data-action="history-back">
            ← Back
          </button>
        </div>
      </div>
    </div>
  `;
}

function renderModal(): string {
  if (state.showHistory) {
    return renderHistoryView();
  }

  if (state.isRunning && state.progress) {
    return renderProgressView();
  }

  if (state.result && !state.isRunning) {
    return renderResultsView();
  }

  return renderConfigView();
}

// Escape string for use in HTML attribute
function escapeAttr(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/'/g, '&#39;').replace(/"/g, '&quot;');
}

// Roboquant logo SVG (cyan-blue gradient)
const RQ_LOGO_SVG = `<svg viewBox="0 0 327.31 305.26" fill="none" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="rq-grad" x1="163.65" y1="0" x2="163.65" y2="305.26" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#24c6ff"/>
      <stop offset="1" stop-color="#026dff"/>
    </linearGradient>
  </defs>
  <path fill="url(#rq-grad)" d="M128.34,203.18c-13.72,0-24.84,11.12-24.84,24.84s11.12,24.83,24.84,24.83,24.83-11.12,24.83-24.83-11.12-24.84-24.83-24.84ZM327.31,145.77h-120.47l85.19-85.19-25.29-25.29-85.2,85.2V0h-35.77v120.47L60.58,35.28l-25.29,25.29,85.19,85.19H0v35.77h36.63c-9.1,13.23-14.44,29.24-14.44,46.48,0,45.35,36.9,82.25,82.25,82.25h118.42c45.35,0,82.25-36.9,82.25-82.25,0-17.24-5.34-33.25-14.44-46.48h36.64v-35.77ZM222.86,274.5h-118.42c-25.63,0-46.48-20.85-46.48-46.48s20.85-46.48,46.48-46.48h41.33s17.9,0,17.9,0h13.51s45.69,0,45.69,0c25.63,0,46.48,20.85,46.48,46.48s-20.85,46.48-46.48,46.48ZM198.96,203.18c-13.72,0-24.83,11.12-24.83,24.84s11.12,24.83,24.83,24.83,24.83-11.12,24.83-24.83-11.12-24.84-24.83-24.84Z"/>
</svg>`;

function renderConfigView(): string {
  const optimizableInputs = state.inputs.filter(i => i.type === 'numeric' || i.type === 'dropdown' || i.type === 'checkbox');
  const totalCombinations = calculateTotalCombinations();
  const estimatedTime = Math.ceil((totalCombinations * state.delayBetweenRuns) / 60000);

  console.log('[RQ Optimizer] Rendering config view with', optimizableInputs.length, 'optimizable inputs:', optimizableInputs);

  return `
    <div class="rq-optimizer-modal">
      <div class="rq-optimizer-header">
        <div class="rq-optimizer-title">
          <div class="rq-optimizer-logo">${RQ_LOGO_SVG}</div>
          Strategy Optimizer
        </div>
        <button class="rq-optimizer-close" aria-label="Close">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M18 6L6 18M6 6l12 12"/>
          </svg>
        </button>
      </div>

      <div class="rq-optimizer-body">
        <!-- Mode Selection Tabs -->
        <div class="rq-optimizer-mode-tabs">
          <button class="rq-optimizer-mode-tab ${state.optimizationMode === 'params' ? 'active' : ''}" data-action="mode-tab" data-mode="params">Standard</button>
          <button class="rq-optimizer-mode-tab ${state.optimizationMode === 'timeframes' ? 'active' : ''}" data-action="mode-tab" data-mode="timeframes">Multi-Timeframe</button>
          <button class="rq-optimizer-mode-tab ${state.optimizationMode === 'symbols' ? 'active' : ''}" data-action="mode-tab" data-mode="symbols">Multi-Symbol</button>
          <button class="rq-optimizer-mode-tab ${state.optimizationMode === 'full_grid' ? 'active' : ''}" data-action="mode-tab" data-mode="full_grid">Full Grid</button>
        </div>

        <div class="rq-optimizer-section">
          <div class="rq-optimizer-section-title-row">
            <div class="rq-optimizer-section-title" style="margin-bottom:0;">Parameters to Optimize</div>
            <div class="rq-optimizer-param-count">
              ${state.selectedParams.size > 0
                ? `<span class="count-num">${state.selectedParams.size}</span> selected${totalCombinations > 0 ? ` · ${totalCombinations} combinations` : ''}`
                : `${optimizableInputs.length} available`}
            </div>
          </div>
          <div class="rq-optimizer-params-scroll">
          <div class="rq-optimizer-params">
            ${optimizableInputs.length === 0 ? `
              <div class="rq-optimizer-empty">
                <div class="rq-optimizer-empty-icon">📊</div>
                <div class="rq-optimizer-empty-text">No optimizable parameters found</div>
                <div class="rq-optimizer-empty-hint">Open strategy settings, go to Inputs tab, then click Refresh</div>
              </div>
            ` : optimizableInputs.map((input, idx) => {
              const param = state.selectedParams.get(input.name);
              const isSelected = !!param;
              const escapedName = escapeAttr(input.name);

              if (input.type === 'numeric') {
                const currentVal = Number(input.value) || 0;
                const numParam = param as NumericOptimizationParameter | undefined;
                return `
                  <div class="rq-optimizer-param ${isSelected ? 'selected' : ''}" data-param-name="${escapedName}" data-param-index="${idx}">
                    <input
                      type="checkbox"
                      class="rq-optimizer-param-check"
                      data-param-idx="${idx}"
                      ${isSelected ? 'checked' : ''}
                    />
                    <div class="rq-optimizer-param-info">
                      <div class="rq-optimizer-param-name">${escapedName}</div>
                      <div class="rq-optimizer-param-current">${input.value}</div>
                    </div>
                    <div>
                      <input
                        type="number"
                        class="rq-optimizer-param-input"
                        data-param-idx="${idx}"
                        data-param-field="min"
                        value="${numParam?.min ?? Math.max(1, Math.floor(currentVal * 0.5))}"
                        ${!isSelected ? 'disabled' : ''}
                      />
                      <div class="rq-optimizer-param-label">Min</div>
                    </div>
                    <div>
                      <input
                        type="number"
                        class="rq-optimizer-param-input"
                        data-param-idx="${idx}"
                        data-param-field="max"
                        value="${numParam?.max ?? Math.ceil(currentVal * 1.5)}"
                        ${!isSelected ? 'disabled' : ''}
                      />
                      <div class="rq-optimizer-param-label">Max</div>
                    </div>
                    <div>
                      <input
                        type="number"
                        class="rq-optimizer-param-input"
                        data-param-idx="${idx}"
                        data-param-field="step"
                        value="${numParam?.step ?? 1}"
                        ${!isSelected ? 'disabled' : ''}
                      />
                      <div class="rq-optimizer-param-label">Step</div>
                    </div>
                  </div>
                `;
              } else if (input.type === 'dropdown') {
                const ddParam = param as DropdownOptimizationParameter | undefined;
                const allOptions = ddParam?.options || input.options || [];
                const selectedCount = ddParam?.selectedOptions?.length || 0;
                const totalCount = allOptions.length;
                return `
                  <div class="rq-optimizer-param ${isSelected ? 'selected' : ''}" data-param-name="${escapedName}" data-param-index="${idx}">
                    <input
                      type="checkbox"
                      class="rq-optimizer-param-check"
                      data-param-idx="${idx}"
                      ${isSelected ? 'checked' : ''}
                    />
                    <div class="rq-optimizer-param-info">
                      <div class="rq-optimizer-param-name">${escapedName}</div>
                      <div class="rq-optimizer-param-current" style="font-size:11px;color:#a1a1aa;">${isSelected ? `${selectedCount}/${totalCount} values` : escapeAttr(String(input.value))}</div>
                    </div>
                    ${isSelected && ddParam ? `
                      <div class="rq-optimizer-dropdown-select" style="position:relative;" data-param-name="${escapedName}">
                        <button class="rq-optimizer-dropdown-trigger" data-action="toggle-dropdown-menu" data-param-name="${escapedName}"
                          style="font-size:11px;padding:4px 10px;border-radius:6px;border:1px solid #3f3f46;background:#18181b;color:#e4e4e7;cursor:pointer;display:flex;align-items:center;gap:4px;">
                          Select values
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M6 9l6 6 6-6"/></svg>
                        </button>
                        <div class="rq-optimizer-dropdown-menu" data-dropdown-menu="${escapedName}"
                          style="display:none;position:fixed;background:#1c1c1e;border:1px solid #3f3f46;border-radius:8px;padding:4px 0;z-index:10000;min-width:200px;max-height:240px;overflow-y:auto;box-shadow:0 8px 24px rgba(0,0,0,0.5);">
                          ${allOptions.map(opt => {
                            const isOptSelected = ddParam.selectedOptions.includes(opt);
                            return `<label class="rq-optimizer-dropdown-item"
                              style="display:flex;align-items:center;gap:8px;padding:6px 12px;cursor:pointer;font-size:12px;color:${isOptSelected ? '#e4e4e7' : '#71717a'};">
                              <input type="checkbox" ${isOptSelected ? 'checked' : ''}
                                data-action="toggle-dropdown-option"
                                data-param-name="${escapedName}"
                                data-option="${escapeAttr(opt)}"
                                style="accent-color:#f59e0b;width:14px;height:14px;cursor:pointer;" />
                              <span>${escapeAttr(opt)}</span>
                            </label>`;
                          }).join('')}
                        </div>
                      </div>
                    ` : `<div style="font-size:10px;color:#71717a;background:#27272a;padding:2px 6px;border-radius:4px;white-space:nowrap;">Dropdown · ${totalCount}</div>`}
                  </div>
                `;
              } else {
                // checkbox/boolean
                return `
                  <div class="rq-optimizer-param ${isSelected ? 'selected' : ''}" data-param-name="${escapedName}" data-param-index="${idx}">
                    <input
                      type="checkbox"
                      class="rq-optimizer-param-check"
                      data-param-idx="${idx}"
                      ${isSelected ? 'checked' : ''}
                    />
                    <div class="rq-optimizer-param-info">
                      <div class="rq-optimizer-param-name">${escapedName}</div>
                      <div class="rq-optimizer-param-current" style="font-size:11px;color:#a1a1aa;">Currently: ${input.value ? 'On' : 'Off'}</div>
                    </div>
                    <div style="font-size:10px;color:#71717a;background:#27272a;padding:2px 6px;border-radius:4px;white-space:nowrap;">Boolean</div>
                    ${isSelected ? '<div style="grid-column:1/-1;padding:2px 0 0 28px;font-size:11px;color:#a1a1aa;">Tests: On / Off</div>' : ''}
                  </div>
                `;
              }
            }).join('')}
          </div>
          </div>
        </div>

        ${(state.optimizationMode === 'symbols' || state.optimizationMode === 'full_grid') ? renderSymbolsSection() : ''}

        ${(state.optimizationMode === 'timeframes' || state.optimizationMode === 'full_grid') ? renderTimeframesSection() : ''}

        <div class="rq-optimizer-section">
          <div class="rq-optimizer-section-title">Optimization Settings</div>
          <div class="rq-optimizer-settings">
            <div class="rq-optimizer-setting">
              <label>Optimization Goal</label>
              <select data-action="goal">
                <option value="sharpeRatio" ${state.optimizationGoal === 'sharpeRatio' ? 'selected' : ''}>Sharpe Ratio</option>
                <option value="netProfitPercent" ${state.optimizationGoal === 'netProfitPercent' ? 'selected' : ''}>Net Profit %</option>
                <option value="profitFactor" ${state.optimizationGoal === 'profitFactor' ? 'selected' : ''}>Profit Factor</option>
                <option value="sortinoRatio" ${state.optimizationGoal === 'sortinoRatio' ? 'selected' : ''}>Sortino Ratio</option>
                <option value="winRate" ${state.optimizationGoal === 'winRate' ? 'selected' : ''}>Win Rate</option>
                <option value="maxDrawdownPercent" ${state.optimizationGoal === 'maxDrawdownPercent' ? 'selected' : ''}>Min Drawdown</option>
              </select>
            </div>
            <div class="rq-optimizer-setting">
              <label>Delay Between Runs (seconds)</label>
              <input
                type="number"
                min="1"
                max="30"
                data-action="delay"
                value="${state.delayBetweenRuns / 1000}"
              />
            </div>
          </div>

          <!-- Walk-Forward (IS/OOS) Configuration -->
          <div class="rq-optimizer-walkforward ${state.walkForwardEnabled ? 'enabled' : ''}">
            <div class="rq-optimizer-walkforward-header">
              <label class="rq-optimizer-walkforward-toggle">
                <input
                  type="checkbox"
                  data-action="toggle-walkforward"
                  ${state.walkForwardEnabled ? 'checked' : ''}
                />
                Enable Walk-Forward (IS/OOS)
              </label>
              ${state.walkForwardEnabled ? `
                <div class="rq-optimizer-wf-mode-toggle">
                  <button class="rq-optimizer-wf-mode-btn ${state.walkForwardMode === 'single' ? 'active' : ''}" data-action="wf-mode" data-wf-mode="single">Single</button>
                  <button class="rq-optimizer-wf-mode-btn ${state.walkForwardMode === 'rolling' ? 'active' : ''}" data-action="wf-mode" data-wf-mode="rolling">Rolling</button>
                </div>
              ` : '<span class="rq-optimizer-walkforward-badge">Beta</span>'}
            </div>

            ${state.walkForwardEnabled ? (state.walkForwardMode === 'single' ? `
              <div class="rq-optimizer-walkforward-dates">
                <div class="rq-optimizer-walkforward-period is">
                  <div class="rq-optimizer-walkforward-period-label">In-Sample Period</div>
                  <div class="rq-optimizer-walkforward-inputs">
                    <input
                      type="date"
                      class="rq-optimizer-date-input"
                      data-action="is-start"
                      value="${state.inSampleStart}"
                    />
                    <span>to</span>
                    <input
                      type="date"
                      class="rq-optimizer-date-input"
                      data-action="is-end"
                      value="${state.inSampleEnd}"
                    />
                  </div>
                </div>
                <div class="rq-optimizer-walkforward-period oos">
                  <div class="rq-optimizer-walkforward-period-label">Out-of-Sample Period</div>
                  <div class="rq-optimizer-walkforward-inputs">
                    <input
                      type="date"
                      class="rq-optimizer-date-input"
                      data-action="oos-start"
                      value="${state.outOfSampleStart}"
                    />
                    <span>to</span>
                    <input
                      type="date"
                      class="rq-optimizer-date-input"
                      data-action="oos-end"
                      value="${state.outOfSampleEnd}"
                    />
                  </div>
                </div>
              </div>
            ` : renderRollingWalkForwardConfig()) : `
              <div style="font-size: 12px; color: #52525b; margin-top: 4px;">
                Optimize on historical data (IS), validate on recent data (OOS) to detect overfitting
              </div>
            `}
          </div>

          ${totalCombinations > 0 ? `
            <div class="rq-optimizer-info">
              <svg class="rq-optimizer-info-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="10"/>
                <path d="M12 16v-4M12 8h.01"/>
              </svg>
              <div class="rq-optimizer-info-text">
                <strong>${totalCombinations}</strong> combinations ·
                ~<strong>${state.walkForwardEnabled ? (state.walkForwardMode === 'rolling' ? estimatedTime * getPreviewWindowCount() : estimatedTime * 1.5) : estimatedTime}</strong> min estimated
                ${state.walkForwardEnabled ? ' · <span style="color: #24c6ff;">Walk-Forward enabled</span>' : ''}
                ${state.symbols.length > 0 ? ` · <span style="color: #24c6ff;">${state.symbols.length} symbols</span>` : ''}
                ${state.selectedTimeframes.length > 0 ? ` · <span style="color: #24c6ff;">${state.selectedTimeframes.length} timeframes</span>` : ''}
              </div>
            </div>
          ` : ''}

          <div class="rq-optimizer-warning">
            <svg class="rq-optimizer-warning-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
              <line x1="12" y1="9" x2="12" y2="13"/>
              <line x1="12" y1="17" x2="12.01" y2="17"/>
            </svg>
            <div class="rq-optimizer-warning-text">
              <strong>Use at your own risk.</strong> Not affiliated with TradingView. May violate their ToS.
            </div>
          </div>
        </div>
      </div>

      <div class="rq-optimizer-footer">
        <div class="rq-optimizer-footer-left">
          <button class="rq-optimizer-btn-secondary" data-action="refresh">
            ↻ Refresh Inputs
          </button>
          <button class="rq-optimizer-btn-secondary" data-action="show-history">
            History
          </button>
          <a class="rq-optimizer-byline" href="${roboquantLink('/', 'optimizer-footer')}" target="_blank" rel="noopener noreferrer">by Roboquant</a>
        </div>
        <div class="rq-optimizer-footer-right">
          <button class="rq-optimizer-btn-secondary" data-action="cancel">
            Cancel
          </button>
          <button
            class="rq-optimizer-btn-primary"
            data-action="start"
            ${state.selectedParams.size === 0 ? 'disabled' : ''}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <path d="M8 5v14l11-7z"/>
            </svg>
            Start Optimization
          </button>
        </div>
      </div>
    </div>
  `;
}

// ============================================================================
// Timeframe mapping
// ============================================================================

const TIMEFRAME_OPTIONS: { label: string; value: string }[] = [
  { label: '1m', value: '1' },
  { label: '3m', value: '3' },
  { label: '5m', value: '5' },
  { label: '15m', value: '15' },
  { label: '30m', value: '30' },
  { label: '1H', value: '60' },
  { label: '2H', value: '120' },
  { label: '4H', value: '240' },
  { label: '1D', value: 'D' },
  { label: '1W', value: 'W' },
  { label: '1M', value: 'M' },
];

function getTimeframeLabel(value: string): string {
  return TIMEFRAME_OPTIONS.find(t => t.value === value)?.label || value;
}

// ============================================================================
// Section Renderers for Config View
// ============================================================================

function renderSymbolsSection(): string {
  return `
    <div class="rq-optimizer-section">
      <div class="rq-optimizer-section-title">Symbols to Test</div>
      <div class="rq-optimizer-symbols">
        <div class="rq-optimizer-symbol-tags">
          ${state.symbols.length === 0 ? '<span style="color: #52525b; font-size: 12px;">No symbols added — will use current chart symbol</span>' : ''}
          ${state.symbols.map(sym => `
            <span class="rq-optimizer-symbol-tag">
              ${escapeAttr(sym)}
              <button class="rq-optimizer-symbol-tag-remove" data-action="remove-symbol" data-symbol="${escapeAttr(sym)}">×</button>
            </span>
          `).join('')}
        </div>
        <div class="rq-optimizer-symbol-input-row">
          <input
            type="text"
            data-action="symbol-input"
            placeholder="e.g. AAPL, BTCUSD, EURUSD"
            value=""
          />
          <button class="rq-optimizer-symbol-add-btn" data-action="add-symbol">Add</button>
        </div>
      </div>
    </div>
  `;
}

function renderTimeframesSection(): string {
  return `
    <div class="rq-optimizer-section">
      <div class="rq-optimizer-section-title">Timeframes to Test</div>
      <div class="rq-optimizer-timeframes">
        <div class="rq-optimizer-tf-grid">
          ${TIMEFRAME_OPTIONS.map(tf => `
            <button
              class="rq-optimizer-tf-btn ${state.selectedTimeframes.includes(tf.value) ? 'active' : ''}"
              data-action="toggle-tf"
              data-tf="${tf.value}"
            >${tf.label}</button>
          `).join('')}
        </div>
        ${state.selectedTimeframes.length === 0 ? '<div style="font-size: 12px; color: #52525b; margin-top: 8px;">Select timeframes to test — will use current if none selected</div>' : ''}
      </div>
    </div>
  `;
}

function renderRollingWalkForwardConfig(): string {
  const windows = generateRollingWindows({
    totalStart: state.rollingTotalStart,
    totalEnd: state.rollingTotalEnd,
    isWindowMonths: state.rollingISWindowMonths,
    oosWindowMonths: state.rollingOOSWindowMonths,
    stepMonths: state.rollingStepMonths,
    mode: 'rolling',
  });

  return `
    <div class="rq-optimizer-rolling-config">
      <div style="font-size: 12px; color: #71717a; margin-bottom: 8px;">Total Date Range</div>
      <div class="rq-optimizer-walkforward-inputs">
        <input type="date" class="rq-optimizer-date-input" data-action="rolling-total-start" value="${state.rollingTotalStart}" />
        <span>to</span>
        <input type="date" class="rq-optimizer-date-input" data-action="rolling-total-end" value="${state.rollingTotalEnd}" />
      </div>
      <div class="rq-optimizer-rolling-config-grid">
        <div class="rq-optimizer-rolling-config-field">
          <label>IS Window (months)</label>
          <input type="number" min="1" max="120" data-action="rolling-is-months" value="${state.rollingISWindowMonths}" />
        </div>
        <div class="rq-optimizer-rolling-config-field">
          <label>OOS Window (months)</label>
          <input type="number" min="1" max="60" data-action="rolling-oos-months" value="${state.rollingOOSWindowMonths}" />
        </div>
        <div class="rq-optimizer-rolling-config-field">
          <label>Step (months)</label>
          <input type="number" min="1" max="60" data-action="rolling-step-months" value="${state.rollingStepMonths}" />
        </div>
      </div>
      <div class="rq-optimizer-window-preview">
        <strong>${windows.length}</strong> windows generated
        ${windows.length > 0 ? ` · First: ${windows[0].isStart} → ${windows[0].oosEnd}` : ''}
        ${windows.length > 1 ? ` · Last: ${windows[windows.length - 1].isStart} → ${windows[windows.length - 1].oosEnd}` : ''}
      </div>
    </div>
  `;
}

function renderRecentRunsTable(runs: OptimizationRun[], best: OptimizationRun | null): string {
  const hasSymbol = runs.some(r => r.symbol);
  const hasTf = runs.some(r => r.timeframe);
  const paramKeys = getResultParamNames();

  return `
    <div class="rq-optimizer-section" style="margin-top: 20px;">
      <div class="rq-optimizer-section-title">Recent Runs</div>
      <div class="rq-optimizer-results" style="max-height: 200px;">
        <table class="rq-optimizer-results-table">
          <thead>
            <tr>
              <th>#</th>
              ${hasSymbol ? '<th>Symbol</th>' : ''}
              ${hasTf ? '<th>TF</th>' : ''}
              ${paramKeys.map(k => `<th>${k}</th>`).join('')}
              <th>Net %</th>
              <th>Sharpe</th>
              <th>PF</th>
              <th>Win%</th>
              <th>DD%</th>
              <th>Trades</th>
            </tr>
          </thead>
          <tbody>
            ${runs.slice(-10).reverse().map(run => `
              <tr class="${run === best ? 'best' : ''}">
                <td>${run.runNumber}</td>
                ${hasSymbol ? `<td style="font-family: 'JetBrains Mono', monospace; font-size: 11px;">${run.symbol || ''}</td>` : ''}
                ${hasTf ? `<td>${run.timeframe ? getTimeframeLabel(run.timeframe) : ''}</td>` : ''}
                ${paramKeys.map(k => `<td>${run.parameters[k]}</td>`).join('')}
                <td class="${run.metrics.netProfitPercent >= 0 ? 'rq-optimizer-positive' : 'rq-optimizer-negative'}">
                  ${run.metrics.netProfitPercent.toFixed(2)}%
                </td>
                <td>${run.metrics.sharpeRatio.toFixed(2)}</td>
                <td>${run.metrics.profitFactor.toFixed(2)}</td>
                <td>${run.metrics.winRate.toFixed(1)}%</td>
                <td class="rq-optimizer-negative">${run.metrics.maxDrawdownPercent.toFixed(2)}%</td>
                <td>${run.metrics.totalTrades}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function renderProgressView(): string {
  const progress = state.progress!;
  const percentage = Math.round((progress.currentRun / progress.totalRuns) * 100);
  const best = progress.bestSoFar;
  const wfPhase = (progress as any).walkForwardPhase as 'is' | 'oos' | undefined;

  return `
    <div class="rq-optimizer-modal">
      <div class="rq-optimizer-header">
        <div class="rq-optimizer-title">
          <div class="rq-optimizer-spinner"></div>
          Optimizing · ${percentage}%
        </div>
        <button class="rq-optimizer-close" aria-label="Stop">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M18 6L6 18M6 6l12 12"/>
          </svg>
        </button>
      </div>

      <div class="rq-optimizer-body">
        ${state.walkForwardEnabled && wfPhase ? `
          <div class="rq-optimizer-wf-phase">
            <div class="rq-optimizer-wf-phase-indicator ${wfPhase}"></div>
            <div class="rq-optimizer-wf-phase-text">
              ${wfPhase === 'is'
                ? '<strong>Phase 1:</strong> In-Sample Optimization'
                : '<strong>Phase 2:</strong> Out-of-Sample Validation'
              }
            </div>
          </div>
        ` : ''}

        <div class="rq-optimizer-progress">
          <div class="rq-optimizer-progress-text">
            Run ${progress.currentRun} of ${progress.totalRuns}
          </div>
          <div class="rq-optimizer-progress-bar-container">
            <div class="rq-optimizer-progress-bar" style="width: ${percentage}%"></div>
          </div>
          <div class="rq-optimizer-progress-detail">
            Testing: ${Object.entries(progress.currentParameters).map(([k, v]) => `${k}=${v}`).join(', ')}
          </div>

          ${best ? `
            <div class="rq-optimizer-best">
              <div class="rq-optimizer-best-title">Best Result So Far</div>
              <div class="rq-optimizer-best-value">
                ${getGoalDisplayValue(best, state.optimizationGoal)}
              </div>
              <div class="rq-optimizer-best-params">
                ${[
                  best.symbol ? `Symbol: ${best.symbol}` : '',
                  best.timeframe ? `TF: ${best.timeframe}` : '',
                  ...Object.entries(best.parameters).map(([k, v]) => `${k}=${v}`),
                ].filter(Boolean).join(', ')}
              </div>
            </div>
          ` : ''}
        </div>

        ${state.runs.length > 0 ? renderRecentRunsTable(state.runs, best) : ''}
      </div>

      <div class="rq-optimizer-footer">
        <div class="rq-optimizer-footer-left"></div>
        <div class="rq-optimizer-footer-right">
          <button class="rq-optimizer-btn-primary rq-optimizer-btn-danger" data-action="stop">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <rect x="6" y="6" width="12" height="12" rx="1"/>
            </svg>
            Stop
          </button>
        </div>
      </div>
    </div>
  `;
}

function renderResultsView(): string {
  const result = state.result!;
  const best = result.bestRun;
  const paramNames = getResultParamNames();
  const wfResult = result.walkForwardResult;
  const rollingResult = result.rollingWalkForwardResult;
  const hasMultiSymbol = !!(result.bestBySymbol && Object.keys(result.bestBySymbol).length > 0);
  const hasMultiTimeframe = !!(result.bestByTimeframe && Object.keys(result.bestByTimeframe).length > 0);
  const isMultiMode = hasMultiSymbol || hasMultiTimeframe;

  return `
    <div class="rq-optimizer-modal">
      <div class="rq-optimizer-header">
        <div class="rq-optimizer-title">
          <div class="rq-optimizer-logo">${RQ_LOGO_SVG}</div>
          ${result.error ? 'Optimization Failed' : 'Optimization Complete'}
        </div>
        <button class="rq-optimizer-close" aria-label="Close">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M18 6L6 18M6 6l12 12"/>
          </svg>
        </button>
      </div>

      <div class="rq-optimizer-body">
        ${result.error ? `
          <div style="margin-bottom: 20px; padding: 14px 16px; border-radius: 10px; background: rgba(239,68,68,0.12); border: 1px solid rgba(239,68,68,0.4); color: #fca5a5; font-size: 13px; line-height: 1.5;">
            <strong style="display:block; margin-bottom: 4px; color: #f87171;">⚠ Optimization aborted</strong>
            ${escapeAttr(result.error)}
          </div>
        ` : ''}

        ${wfResult ? renderWalkForwardComparison(wfResult, best!) : ''}

        ${rollingResult ? renderRollingWFResults(rollingResult) : ''}

        ${hasMultiSymbol ? renderBestByDimension('Symbol', result.bestBySymbol!) : ''}
        ${hasMultiTimeframe ? renderBestByDimension('Timeframe', result.bestByTimeframe!, true) : ''}

        ${best && !wfResult && !rollingResult ? `
          <div class="rq-optimizer-best" style="margin-bottom: 20px;">
            <div class="rq-optimizer-best-title">Best Result (${getGoalLabel(state.optimizationGoal)})</div>
            <div class="rq-optimizer-best-value">
              ${getGoalDisplayValue(best, state.optimizationGoal)}
            </div>
            <div class="rq-optimizer-best-params" style="margin-top: 8px;">
              ${Object.entries(best.parameters).map(([k, v]) => `<strong>${k}</strong>=${v}`).join(' · ')}
              ${best.symbol ? ` · <strong>Symbol</strong>=${best.symbol}` : ''}
              ${best.timeframe ? ` · <strong>TF</strong>=${getTimeframeLabel(best.timeframe)}` : ''}
            </div>
            <div style="margin-top: 12px; display: flex; gap: 16px; font-size: 12px; color: #9ca3af;">
              <span>Net Profit: <strong class="${best.metrics.netProfitPercent >= 0 ? 'rq-optimizer-positive' : 'rq-optimizer-negative'}">${best.metrics.netProfitPercent.toFixed(2)}%</strong></span>
              <span>Trades: <strong>${best.metrics.totalTrades}</strong></span>
              <span>Win Rate: <strong>${best.metrics.winRate.toFixed(1)}%</strong></span>
              <span>Max DD: <strong class="rq-optimizer-negative">${best.metrics.maxDrawdownPercent.toFixed(2)}%</strong></span>
            </div>
          </div>
        ` : ''}

        <div class="rq-optimizer-section">
          <div class="rq-optimizer-section-title">All Results (${result.runs.length} runs)</div>
          <div class="rq-optimizer-results">
            <table class="rq-optimizer-results-table" id="rq-results-table">
              <thead>
                <tr>
                  <th data-sort="runNumber">#</th>
                  ${isMultiMode && hasMultiSymbol ? '<th data-sort="symbol">Symbol</th>' : ''}
                  ${isMultiMode && hasMultiTimeframe ? '<th data-sort="timeframe">TF</th>' : ''}
                  ${paramNames.map(k => `<th data-sort="param_${escapeAttr(k)}">${escapeAttr(k)}</th>`).join('')}
                  ${wfResult ? `
                    <th data-sort="isNetProfitPercent" title="In-Sample">IS Net%</th>
                    <th data-sort="oosNetProfitPercent" title="Out-of-Sample">OOS Net%</th>
                    <th data-sort="isSharpeRatio" title="In-Sample">IS Sharpe</th>
                    <th data-sort="oosSharpeRatio" title="Out-of-Sample">OOS Sharpe</th>
                    <th title="OOS/IS Ratio">Ratio</th>
                  ` : `
                    <th data-sort="netProfitPercent">Net %</th>
                    <th data-sort="sharpeRatio">Sharpe</th>
                    <th data-sort="profitFactor">PF</th>
                    <th data-sort="winRate">Win%</th>
                    <th data-sort="maxDrawdownPercent">DD%</th>
                    <th data-sort="totalTrades">Trades</th>
                  `}
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                ${result.runs.map(run => {
                  const isMetrics = run.inSampleMetrics || run.metrics;
                  const oosMetrics = run.outOfSampleMetrics;
                  const hasOOS = !!oosMetrics;

                  // Calculate ratio for this run
                  let ratio = 0;
                  if (hasOOS && isMetrics.sharpeRatio > 0) {
                    ratio = oosMetrics!.sharpeRatio / isMetrics.sharpeRatio;
                  }
                  const ratioClass = ratio >= 0.8 ? 'rq-optimizer-positive' : ratio >= 0.5 ? 'rq-optimizer-warning' : 'rq-optimizer-negative';

                  return `
                  <tr class="${run === best ? 'best' : ''}" data-run-number="${run.runNumber}">
                    <td>${run.runNumber}</td>
                    ${isMultiMode && hasMultiSymbol ? `<td style="font-family: 'JetBrains Mono', monospace; font-size: 11px;">${run.symbol || '-'}</td>` : ''}
                    ${isMultiMode && hasMultiTimeframe ? `<td>${run.timeframe ? getTimeframeLabel(run.timeframe) : '-'}</td>` : ''}
                    ${paramNames.map(k => `<td>${run.parameters[k]}</td>`).join('')}
                    ${wfResult ? `
                      <td class="${isMetrics.netProfitPercent >= 0 ? 'rq-optimizer-positive' : 'rq-optimizer-negative'}">
                        ${isMetrics.netProfitPercent.toFixed(2)}%
                      </td>
                      <td class="${hasOOS ? (oosMetrics!.netProfitPercent >= 0 ? 'rq-optimizer-positive' : 'rq-optimizer-negative') : ''}">
                        ${hasOOS ? oosMetrics!.netProfitPercent.toFixed(2) + '%' : '-'}
                      </td>
                      <td>${isMetrics.sharpeRatio.toFixed(2)}</td>
                      <td>${hasOOS ? oosMetrics!.sharpeRatio.toFixed(2) : '-'}</td>
                      <td class="${ratioClass}">${hasOOS ? ratio.toFixed(2) : '-'}</td>
                    ` : `
                      <td class="${run.metrics.netProfitPercent >= 0 ? 'rq-optimizer-positive' : 'rq-optimizer-negative'}">
                        ${run.metrics.netProfitPercent.toFixed(2)}%
                      </td>
                      <td>${run.metrics.sharpeRatio.toFixed(2)}</td>
                      <td>${run.metrics.profitFactor.toFixed(2)}</td>
                      <td>${run.metrics.winRate.toFixed(1)}%</td>
                      <td class="rq-optimizer-negative">${run.metrics.maxDrawdownPercent.toFixed(2)}%</td>
                      <td>${run.metrics.totalTrades}</td>
                    `}
                    <td>
                      <button class="rq-optimizer-apply-row-btn" data-action="apply-row" data-run-number="${run.runNumber}">
                        Apply
                      </button>
                    </td>
                  </tr>
                `}).join('')}
              </tbody>
            </table>
          </div>

          <div class="rq-optimizer-export-btns">
            <button class="rq-optimizer-btn-secondary" data-action="export">
              Download JSON
            </button>
          </div>

          ${renderPropFirmSection(result)}
          ${renderHeatmapSection(result)}
        </div>

        <a class="rq-optimizer-promo" href="${roboquantLink('/', 'results')}" target="_blank" rel="noopener noreferrer">
          <span class="rq-optimizer-promo-text">
            <span class="rq-optimizer-promo-title">Backtest this idea on Roboquant's native engine</span>
            <span class="rq-optimizer-promo-sub">Build and backtest strategies on CME data, then optimize and deploy them.</span>
          </span>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M7 17L17 7M17 7H7M17 7v10"/></svg>
        </a>
      </div>

      <div class="rq-optimizer-footer">
        <div class="rq-optimizer-footer-left">
          <span style="color: #6b7280; font-size: 12px;">
            Completed in ${Math.round(result.totalDuration / 1000)}s
          </span>
        </div>
        <div class="rq-optimizer-footer-right">
          ${state.viewingFromHistory ? `
            <button class="rq-optimizer-btn-secondary" data-action="back-to-history">
              ← Back to History
            </button>
          ` : `
            <button class="rq-optimizer-btn-secondary" data-action="reset">
              New Optimization
            </button>
          `}
          <button class="rq-optimizer-btn-secondary" data-action="cancel">
            Close
          </button>
        </div>
      </div>
    </div>
  `;
}

function renderBestByDimension(dimensionLabel: string, bests: Record<string, OptimizationRun>, isTimeframe: boolean = false): string {
  const entries = Object.entries(bests);
  if (entries.length === 0) return '';

  return `
    <div class="rq-optimizer-section" style="margin-bottom: 16px;">
      <div class="rq-optimizer-section-title">Best by ${dimensionLabel}</div>
      <div class="rq-optimizer-dimension-bests">
        ${entries.map(([key, run]) => `
          <div class="rq-optimizer-dimension-card">
            <div class="rq-optimizer-dimension-card-label">${isTimeframe ? getTimeframeLabel(key) : key}</div>
            <div class="rq-optimizer-dimension-card-value">
              ${getGoalDisplayValue(run, state.optimizationGoal)}
            </div>
            <div class="rq-optimizer-dimension-card-params">
              ${Object.entries(run.parameters).map(([k, v]) => `${k}=${v}`).join(', ')}
            </div>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

function renderRollingWFResults(rollingResult: RollingWalkForwardResult): string {
  const passedColor = rollingResult.windowsPassed === rollingResult.totalWindows ? '#24c6ff' :
    rollingResult.windowsPassed >= rollingResult.totalWindows * 0.7 ? '#f59e0b' : '#ef4444';
  const overfitColor = rollingResult.avgOverfittingScore >= 0.7 ? '#24c6ff' :
    rollingResult.avgOverfittingScore >= 0.5 ? '#f59e0b' : '#ef4444';

  return `
    <div class="rq-optimizer-section" style="margin-bottom: 16px;">
      <div class="rq-optimizer-section-title">Rolling Walk-Forward Summary</div>
      <div class="rq-optimizer-rolling-summary">
        <div class="rq-optimizer-rolling-stat">
          <div class="rq-optimizer-rolling-stat-label">Windows Passed</div>
          <div class="rq-optimizer-rolling-stat-value" style="color: ${passedColor}">
            ${rollingResult.windowsPassed}/${rollingResult.totalWindows}
          </div>
        </div>
        <div class="rq-optimizer-rolling-stat">
          <div class="rq-optimizer-rolling-stat-label">Avg OOS Score</div>
          <div class="rq-optimizer-rolling-stat-value" style="color: ${rollingResult.aggregatedScore >= 0 ? '#24c6ff' : '#ef4444'}">
            ${rollingResult.aggregatedScore.toFixed(2)}
          </div>
        </div>
        <div class="rq-optimizer-rolling-stat">
          <div class="rq-optimizer-rolling-stat-label">Avg Overfit Score</div>
          <div class="rq-optimizer-rolling-stat-value" style="color: ${overfitColor}">
            ${rollingResult.avgOverfittingScore.toFixed(2)}
          </div>
        </div>
        <div class="rq-optimizer-rolling-stat">
          <div class="rq-optimizer-rolling-stat-label">Consistency</div>
          <div class="rq-optimizer-rolling-stat-value" style="color: #a1a1aa">
            ${rollingResult.consistencyScore.toFixed(2)}
          </div>
        </div>
      </div>

      ${rollingResult.windowResults.length > 0 ? `
        <div class="rq-optimizer-results" style="max-height: 200px;">
          <table class="rq-optimizer-results-table">
            <thead>
              <tr>
                <th>Window</th>
                <th>IS Period</th>
                <th>OOS Period</th>
                <th>IS Sharpe</th>
                <th>OOS Sharpe</th>
                <th>Overfit</th>
                <th>Robust</th>
              </tr>
            </thead>
            <tbody>
              ${rollingResult.windowResults.map(wr => {
                const ofClass = wr.overfittingScore >= 0.7 ? 'rq-optimizer-positive' : wr.overfittingScore >= 0.5 ? 'rq-optimizer-warning' : 'rq-optimizer-negative';
                return `
                <tr>
                  <td>#${wr.windowNumber}</td>
                  <td style="font-size: 11px;">${wr.window.isStart} → ${wr.window.isEnd}</td>
                  <td style="font-size: 11px;">${wr.window.oosStart} → ${wr.window.oosEnd}</td>
                  <td>${wr.isMetrics.sharpeRatio.toFixed(2)}</td>
                  <td>${wr.oosMetrics.sharpeRatio.toFixed(2)}</td>
                  <td class="${ofClass}">${wr.overfittingScore.toFixed(2)}</td>
                  <td>${wr.isRobust ? '<span style="color: #24c6ff;">Yes</span>' : '<span style="color: #ef4444;">No</span>'}</td>
                </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </div>
      ` : ''}
    </div>
  `;
}

// ============================================================================
// Helper Functions
// ============================================================================

function calculateTotalCombinations(): number {
  if (state.selectedParams.size === 0) return 0;

  let total = 1;
  for (const param of state.selectedParams.values()) {
    if (param.type === 'dropdown') {
      total *= param.selectedOptions.length;
    } else if (param.type === 'boolean') {
      total *= 2;
    } else {
      // numeric
      const steps = Math.floor((param.max - param.min) / param.step) + 1;
      total *= steps;
    }
  }

  // Multiply by symbols count
  const symbolCount = state.symbols.length > 0 ? state.symbols.length : 1;
  // Multiply by timeframes count
  const tfCount = state.selectedTimeframes.length > 0 ? state.selectedTimeframes.length : 1;

  total *= symbolCount * tfCount;

  return total;
}

function getPreviewWindowCount(): number {
  const windows = generateRollingWindows({
    totalStart: state.rollingTotalStart,
    totalEnd: state.rollingTotalEnd,
    isWindowMonths: state.rollingISWindowMonths,
    oosWindowMonths: state.rollingOOSWindowMonths,
    stepMonths: state.rollingStepMonths,
    mode: 'rolling',
  });
  return Math.max(windows.length, 1);
}

function getGoalLabel(goal: OptimizationGoal): string {
  const labels: Record<OptimizationGoal, string> = {
    netProfit: 'Net Profit',
    netProfitPercent: 'Net Profit %',
    sharpeRatio: 'Sharpe Ratio',
    sortinoRatio: 'Sortino Ratio',
    profitFactor: 'Profit Factor',
    winRate: 'Win Rate',
    maxDrawdownPercent: 'Min Drawdown',
    calmarRatio: 'Calmar Ratio',
  };
  return labels[goal];
}

function getGoalDisplayValue(run: OptimizationRun, goal: OptimizationGoal): string {
  const value = run.metrics[goal as keyof typeof run.metrics];
  if (goal === 'winRate' || goal === 'netProfitPercent' || goal === 'maxDrawdownPercent') {
    return `${Number(value).toFixed(2)}%`;
  }
  return Number(value).toFixed(2);
}

function updateUI(): void {
  const overlay = document.getElementById('rq-optimizer-overlay');
  if (overlay) {
    // Preserve scroll positions across re-renders
    const body = overlay.querySelector('.rq-optimizer-body');
    const paramsScroll = overlay.querySelector('.rq-optimizer-params-scroll');
    const bodyScrollTop = body ? body.scrollTop : 0;
    const paramsScrollTop = paramsScroll ? paramsScroll.scrollTop : 0;

    overlay.innerHTML = renderModal();
    // Attach event listeners after rendering (CSP-safe)
    attachEventListeners();

    // Restore scroll positions
    const newBody = overlay.querySelector('.rq-optimizer-body');
    if (newBody && bodyScrollTop > 0) {
      newBody.scrollTop = bodyScrollTop;
    }
    const newParamsScroll = overlay.querySelector('.rq-optimizer-params-scroll');
    if (newParamsScroll && paramsScrollTop > 0) {
      newParamsScroll.scrollTop = paramsScrollTop;
    }
  }
}

// ============================================================================
// Public API (exposed to window)
// ============================================================================

export function injectOptimizerButton(): void {
  injectStyles();
  console.log('[RQ Optimizer] Attempting to inject button...');

  // Track if we've already set up the observer
  let observerSetup = false;

  // Place button at the end of the tabbar (middle of footer)
  const checkAndInject = () => {
    // Don't inject if already exists and is in the DOM
    const existingBtn = document.getElementById('rq-optimize-btn');
    if (existingBtn && document.body.contains(existingBtn)) {
      return;
    }

    // Remove orphaned button if it exists but is not in DOM
    if (existingBtn) {
      existingBtn.remove();
    }

    // Find the tabbar and append to it
    const tabbar = document.querySelector('#footer-chart-panel [class*="tabbar-"]');
    if (tabbar) {
      const btn = createOptimizeButton();
      tabbar.appendChild(btn);
      console.log('[RQ Optimizer] Button appended to tabbar');
      return;
    }

    console.log('[RQ Optimizer] No injection point found');
  };

  // Initial check after a delay
  setTimeout(checkAndInject, 1500);

  // Re-check periodically to handle strategy changes
  setInterval(checkAndInject, 2000);

  // Also observe for Strategy Tester appearing/changing
  if (!observerSetup) {
    observerSetup = true;
    const observer = new MutationObserver(() => {
      // Debounce the check
      setTimeout(checkAndInject, 200);
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }
}

export async function openOptimizer(): Promise<void> {
  injectStyles();

  // Create overlay
  let overlay = document.getElementById('rq-optimizer-overlay');
  if (!overlay) {
    overlay = createOverlay();
    document.body.appendChild(overlay);
  }

  state.isOpen = true;
  state.result = null;
  state.runs = [];
  state.selectedParams.clear();

  overlay.innerHTML = renderModal();

  // Fetch current inputs
  refreshInputs();
}

export function closeOptimizer(): void {
  if (state.isRunning) {
    if (!confirm('Optimization is running. Are you sure you want to close?')) {
      return;
    }
    stopOptimization();
  }

  state.isOpen = false;
  const overlay = document.getElementById('rq-optimizer-overlay');
  if (overlay) {
    overlay.remove();
  }
}

export async function refreshInputs(): Promise<void> {
  console.log('[RQ Optimizer] refreshInputs called, rqGetStrategyInputs available:', !!window.rqGetStrategyInputs);

  // Call the getStrategyInputs function directly since we're in the same context
  // This is set by the content script - it's now async and opens the settings dialog
  if (window.rqGetStrategyInputs) {
    try {
      const result = await window.rqGetStrategyInputs();
      console.log('[RQ Optimizer] Got inputs result:', result);
      if (result && result.inputs) {
        // Clear selections when inputs change (strategy switch or reopen)
        state.selectedParams.clear();
        state.inputs = result.inputs;
        console.log('[RQ Optimizer] State inputs updated:', state.inputs.length, 'inputs');
        console.log('[RQ Optimizer] Numeric inputs:', state.inputs.filter(i => i.type === 'numeric'));
        updateUI();
      }
    } catch (error) {
      console.error('[RQ Optimizer] Failed to get inputs:', error);
    }
  } else {
    console.warn('[RQ Optimizer] getStrategyInputs not available');
  }
}

export function toggleParam(name: string, currentValue: number): void {
  console.log('[RQ Optimizer] toggleParam called:', name, currentValue);
  if (state.selectedParams.has(name)) {
    state.selectedParams.delete(name);
  } else {
    state.selectedParams.set(name, {
      type: 'numeric',
      name,
      min: Math.max(1, Math.floor(currentValue * 0.5)),
      max: Math.ceil(currentValue * 1.5),
      step: 1,
    });
  }
  updateUI();
}

export function toggleParamByIndex(index: number): void {
  const optimizableInputs = state.inputs.filter(i => i.type === 'numeric' || i.type === 'dropdown' || i.type === 'checkbox');
  const input = optimizableInputs[index];
  if (!input) {
    console.error('[RQ Optimizer] Invalid param index:', index);
    return;
  }

  const isAlreadySelected = state.selectedParams.has(input.name);

  console.log('[RQ Optimizer] toggleParamByIndex called:', index, input.name, input.type);

  if (isAlreadySelected) {
    state.selectedParams.delete(input.name);
    updateUI();
  } else if (input.type === 'numeric') {
    toggleParam(input.name, Number(input.value) || 0);
  } else if (input.type === 'dropdown') {
    setDropdownParam(input);
  } else if (input.type === 'checkbox') {
    state.selectedParams.set(input.name, {
      type: 'boolean',
      name: input.name,
    });
    updateUI();
  }
}

function setDropdownParam(input: StrategyInput): void {
  // Options should already be cached from initial extraction
  const options = input.options;
  if (!options || options.length === 0) {
    console.warn('[RQ Optimizer] No options found for dropdown:', input.name);
    return;
  }

  state.selectedParams.set(input.name, {
    type: 'dropdown',
    name: input.name,
    options: [...options],
    selectedOptions: [...options], // all selected by default
  });
  updateUI();
}

function toggleDropdownOption(paramName: string, optionValue: string): void {
  const param = state.selectedParams.get(paramName);
  if (!param || param.type !== 'dropdown') return;

  const idx = param.selectedOptions.indexOf(optionValue);
  if (idx >= 0) {
    // Don't allow deselecting if only 2 options remain (need at least 2)
    if (param.selectedOptions.length <= 2) return;
    param.selectedOptions.splice(idx, 1);
  } else {
    param.selectedOptions.push(optionValue);
  }
  state.selectedParams.set(paramName, param);

  // Update the count label without re-rendering the full UI (which would close the dropdown)
  const overlay = document.getElementById('rq-optimizer-overlay');
  if (overlay) {
    const paramEl = overlay.querySelector(`[data-param-name="${paramName}"]`);
    const countEl = paramEl?.querySelector('.rq-optimizer-param-current');
    if (countEl) {
      countEl.textContent = `${param.selectedOptions.length}/${param.options.length} values`;
    }
    // Update the combinations count
    const countNumEl = overlay.querySelector('.rq-optimizer-param-count');
    if (countNumEl) {
      const totalCombinations = calculateTotalCombinations();
      countNumEl.innerHTML = `<span class="count-num">${state.selectedParams.size}</span> selected${totalCombinations > 0 ? ` · ${totalCombinations} combinations` : ''}`;
    }
  }
}

export function updateParam(name: string, field: 'min' | 'max' | 'step', value: string): void {
  const param = state.selectedParams.get(name);
  if (param && param.type === 'numeric') {
    param[field] = Number(value);
    state.selectedParams.set(name, param);
    updateUI();
  }
}

export function updateParamByIndex(index: number, field: 'min' | 'max' | 'step', value: string): void {
  const optimizableInputs = state.inputs.filter(i => i.type === 'numeric' || i.type === 'dropdown' || i.type === 'checkbox');
  const input = optimizableInputs[index];
  if (!input) return;
  updateParam(input.name, field, value);
}

export function setGoal(goal: string): void {
  state.optimizationGoal = goal as OptimizationGoal;
}

export function setDelay(seconds: string): void {
  state.delayBetweenRuns = Math.max(1000, Math.min(30000, Number(seconds) * 1000));
}

export function startOptimization(): void {
  if (state.selectedParams.size === 0) return;

  // Validate mode-specific requirements
  if ((state.optimizationMode === 'symbols' || state.optimizationMode === 'full_grid') && state.symbols.length === 0) {
    alert('Please add at least one symbol for multi-symbol optimization.');
    return;
  }
  if ((state.optimizationMode === 'timeframes' || state.optimizationMode === 'full_grid') && state.selectedTimeframes.length === 0) {
    alert('Please select at least one timeframe for multi-timeframe optimization.');
    return;
  }

  // Validate walk-forward dates if enabled
  const wfError = validateWalkForwardDates();
  if (wfError) {
    alert(wfError);
    return;
  }

  state.isRunning = true;
  state.runs = [];
  state.result = null;
  state.progress = {
    currentRun: 0,
    totalRuns: calculateTotalCombinations(),
    currentParameters: {},
    bestSoFar: null,
    status: 'running',
  };

  updateUI();

  // Build config
  const config: OptimizationConfig = {
    parameters: Array.from(state.selectedParams.values()),
    optimizationGoal: state.optimizationGoal,
    delayBetweenRuns: state.delayBetweenRuns,
    maxRuns: Infinity,
    mode: state.optimizationMode,
    symbols: state.symbols.length > 0 ? [...state.symbols] : undefined,
    timeframes: state.selectedTimeframes.length > 0 ? [...state.selectedTimeframes] : undefined,
    walkForward: getWalkForwardConfig(),
  };

  // Call content script function directly
  if (window.rqStartOptimization) {
    window.rqStartOptimization(config);
  } else {
    console.error('[RQ Optimizer] startOptimization not available');
    state.isRunning = false;
    updateUI();
  }
}

export function stopOptimization(): void {
  state.isRunning = false;
  if (state.progress) {
    state.progress.status = 'cancelled';
  }

  // Call content script function directly
  if (window.rqStopOptimization) {
    window.rqStopOptimization();
  }

  updateUI();
}

export function updateProgress(progress: OptimizationProgress): void {
  state.progress = progress;
  if (progress.status === 'completed' || progress.status === 'cancelled') {
    state.isRunning = false;
  }
  updateUI();
}

export function addRun(run: OptimizationRun): void {
  state.runs.push(run);

  // Update best if needed
  if (state.progress) {
    const currentBest = state.progress.bestSoFar;
    if (!currentBest || isBetterRun(run, currentBest, state.optimizationGoal)) {
      state.progress.bestSoFar = run;
    }
  }

  updateUI();
}

export function setResult(result: OptimizationResult): void {
  state.result = result;
  state.runs = result.runs;
  state.isRunning = false;

  // Auto-save to history
  saveToHistory(result).then(id => {
    state.currentHistoryId = id;
  }).catch(err => {
    console.error('[RQ Optimizer] Failed to save to history:', err);
    console.error('[RQ Optimizer] Result size estimate:', estimateJsonSizeBytes(result), 'bytes');
  });

  updateUI();
}

export function reset(): void {
  state.result = null;
  state.runs = [];
  state.progress = null;
  state.currentHistoryId = null;
  state.viewingFromHistory = false;
  updateUI();
}

export function exportCSV(): void {
  if (!state.result) return;

  const paramNames = getResultParamNames();
  const headers = ['Run', ...paramNames, 'Net Profit %', 'Sharpe', 'Sortino', 'Profit Factor', 'Win Rate', 'Max DD %', 'Trades'];

  const rows = state.result.runs.map(run => [
    run.runNumber,
    ...paramNames.map(k => run.parameters[k]),
    run.metrics.netProfitPercent.toFixed(2),
    run.metrics.sharpeRatio.toFixed(2),
    run.metrics.sortinoRatio.toFixed(2),
    run.metrics.profitFactor.toFixed(2),
    run.metrics.winRate.toFixed(1),
    run.metrics.maxDrawdownPercent.toFixed(2),
    run.metrics.totalTrades,
  ]);

  const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');

  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `optimization_${state.result.strategyName}_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function downloadResultAsJson(): void {
  if (!state.result) return;
  console.log('[RQ Optimizer] Downloading result as JSON');
  const json = JSON.stringify(state.result, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `optimization_${state.result.strategyName}_${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

export function applyBest(): void {
  if (!state.result?.bestRun) return;

  // Call content script function directly
  if (window.rqApplyParameters) {
    window.rqApplyParameters(state.result.bestRun.parameters);
  }

  closeOptimizer();
}

export function applyRunParameters(runNumber: number): void {
  if (!state.result) return;

  const run = state.result.runs.find(r => r.runNumber === runNumber);
  if (!run) {
    console.error('[RQ Optimizer] Run not found:', runNumber);
    return;
  }

  console.log('[RQ Optimizer] Applying parameters from run', runNumber, ':', run.parameters);

  if (window.rqApplyParameters) {
    window.rqApplyParameters(run.parameters);

    // Update button to show "Applied"
    const btn = document.querySelector(`[data-action="apply-row"][data-run-number="${runNumber}"]`);
    if (btn) {
      btn.textContent = '✓ Applied';
      btn.classList.add('applied');

      // Reset other buttons
      document.querySelectorAll('[data-action="apply-row"]').forEach(otherBtn => {
        if (otherBtn !== btn) {
          otherBtn.textContent = 'Apply';
          otherBtn.classList.remove('applied');
        }
      });
    }
  }
}

export function sortResults(column: string): void {
  // Simple sort toggle - would need more state for full implementation
  if (!state.result) return;

  state.result.runs.sort((a, b) => {
    if (column.startsWith('param_')) {
      const key = column.replace('param_', '');
      const aVal = a.parameters[key];
      const bVal = b.parameters[key];
      // For numeric values, sort numerically; for strings/booleans, sort lexically
      if (typeof aVal === 'number' && typeof bVal === 'number') {
        return bVal - aVal;
      }
      return String(bVal).localeCompare(String(aVal));
    }
    if (column === 'runNumber') {
      return a.runNumber - b.runNumber;
    }
    // Type-safe metric access
    const metricKey = column as keyof OptimizationMetrics;
    const aVal = a.metrics[metricKey];
    const bVal = b.metrics[metricKey];
    if (typeof aVal === 'number' && typeof bVal === 'number') {
      return bVal - aVal;
    }
    return 0;
  });

  updateUI();
}

function isBetterRun(a: OptimizationRun, b: OptimizationRun, goal: OptimizationGoal): boolean {
  const aVal = a.metrics[goal as keyof typeof a.metrics] as number;
  const bVal = b.metrics[goal as keyof typeof b.metrics] as number;

  // For drawdown, lower is better
  if (goal === 'maxDrawdownPercent') {
    return Math.abs(aVal) < Math.abs(bVal);
  }

  return aVal > bVal;
}

// ============================================================================
// Walk-Forward Functions
// ============================================================================

function toggleWalkForward(): void {
  state.walkForwardEnabled = !state.walkForwardEnabled;
  updateUI();
}

function setWalkForwardDate(field: 'inSampleStart' | 'inSampleEnd' | 'outOfSampleStart' | 'outOfSampleEnd', value: string): void {
  state[field] = value;
  // No need to update UI for date changes, they're reflected immediately in the inputs
}

function getWalkForwardConfig(): WalkForwardConfig | undefined {
  if (!state.walkForwardEnabled) return undefined;

  if (state.walkForwardMode === 'rolling') {
    const windows = generateRollingWindows({
      totalStart: state.rollingTotalStart,
      totalEnd: state.rollingTotalEnd,
      isWindowMonths: state.rollingISWindowMonths,
      oosWindowMonths: state.rollingOOSWindowMonths,
      stepMonths: state.rollingStepMonths,
      mode: 'rolling',
    });

    return {
      enabled: true,
      mode: 'rolling',
      totalStart: state.rollingTotalStart,
      totalEnd: state.rollingTotalEnd,
      isWindowMonths: state.rollingISWindowMonths,
      oosWindowMonths: state.rollingOOSWindowMonths,
      stepMonths: state.rollingStepMonths,
      windows,
    };
  }

  return {
    enabled: true,
    mode: 'single',
    inSampleStart: state.inSampleStart,
    inSampleEnd: state.inSampleEnd,
    outOfSampleStart: state.outOfSampleStart,
    outOfSampleEnd: state.outOfSampleEnd,
  };
}

function validateWalkForwardDates(): string | null {
  if (!state.walkForwardEnabled) return null;

  if (state.walkForwardMode === 'rolling') {
    const start = new Date(state.rollingTotalStart);
    const end = new Date(state.rollingTotalEnd);
    if (start >= end) {
      return 'Rolling WF start date must be before end date';
    }
    const windows = generateRollingWindows({
      totalStart: state.rollingTotalStart,
      totalEnd: state.rollingTotalEnd,
      isWindowMonths: state.rollingISWindowMonths,
      oosWindowMonths: state.rollingOOSWindowMonths,
      stepMonths: state.rollingStepMonths,
      mode: 'rolling',
    });
    if (windows.length === 0) {
      return 'Date range too short to generate any rolling windows with current settings';
    }
    return null;
  }

  const isStart = new Date(state.inSampleStart);
  const isEnd = new Date(state.inSampleEnd);
  const oosStart = new Date(state.outOfSampleStart);
  const oosEnd = new Date(state.outOfSampleEnd);

  if (isStart >= isEnd) {
    return 'In-Sample start date must be before end date';
  }

  if (oosStart >= oosEnd) {
    return 'Out-of-Sample start date must be before end date';
  }

  if (isEnd > oosStart) {
    return 'In-Sample period must not overlap with Out-of-Sample period';
  }

  return null;
}

// ============================================================================
// Prop Firm Challenge Section
// ============================================================================

function renderPropFirmSection(result: OptimizationResult): string {
  if (!result.bestRun) return '';

  const metrics = result.bestRun.metrics;
  const capital = metrics.netProfitPercent !== 0
    ? Math.abs(metrics.netProfit / (metrics.netProfitPercent / 100))
    : PROP_FIRM_DEFAULTS.accountSize;

  const { profitTargetPct, maxDailyLossPct, maxTotalLossPct } = PROP_FIRM_DEFAULTS;
  const dailyLossLimit = capital * (maxDailyLossPct / 100);

  // Check functions
  type CheckStatus = 'pass' | 'warn' | 'fail';
  interface CheckResult { status: CheckStatus; label: string; detail: string; }

  const ddPct = Math.abs(metrics.maxDrawdownPercent);
  const ddCheck: CheckResult = {
    label: 'Max Drawdown',
    detail: `${ddPct.toFixed(1)}% of ${maxTotalLossPct}% limit`,
    status: ddPct > maxTotalLossPct ? 'fail' : ddPct >= maxTotalLossPct * 0.8 ? 'warn' : 'pass',
  };

  const largestLossAbs = Math.abs(metrics.largestLoss);
  const largestLossPct = (largestLossAbs / capital) * 100;
  const llCheck: CheckResult = {
    label: 'Largest Loss',
    detail: `$${(largestLossAbs / 1000).toFixed(1)}K of $${(dailyLossLimit / 1000).toFixed(0)}K daily limit`,
    status: largestLossPct > maxDailyLossPct ? 'fail' : largestLossPct >= maxDailyLossPct * 0.8 ? 'warn' : 'pass',
  };

  const profitCheck: CheckResult = {
    label: 'Profit Target',
    detail: `${metrics.netProfitPercent.toFixed(1)}% vs ${profitTargetPct}% required`,
    status: metrics.netProfitPercent >= profitTargetPct ? 'pass' : metrics.netProfitPercent >= profitTargetPct * 0.5 ? 'warn' : 'fail',
  };

  const tradeCheck: CheckResult = {
    label: 'Trade Count',
    detail: `${metrics.totalTrades} trades (min 30)`,
    status: metrics.totalTrades >= 30 ? 'pass' : metrics.totalTrades >= 15 ? 'warn' : 'fail',
  };

  const checks = [ddCheck, llCheck, profitCheck, tradeCheck];
  const passCount = checks.filter(c => c.status === 'pass').length;
  const hasAnyFail = checks.some(c => c.status === 'fail');

  let verdict: string;
  let verdictColor: string;
  if (!hasAnyFail && passCount === checks.length) {
    verdict = 'COMPATIBLE';
    verdictColor = '#10b981';
  } else if (!hasAnyFail) {
    verdict = 'MARGINAL';
    verdictColor = '#f59e0b';
  } else {
    verdict = 'AT RISK';
    verdictColor = '#ef4444';
  }

  const statusDots: Record<CheckStatus, string> = {
    pass: '<span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:#10b981;"></span>',
    warn: '<span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:#f59e0b;"></span>',
    fail: '<span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:#ef4444;"></span>',
  };
  const statusColors: Record<CheckStatus, string> = { pass: '#10b981', warn: '#f59e0b', fail: '#ef4444' };
  const statusLabels: Record<CheckStatus, string> = { pass: 'PASS', warn: 'WARN', fail: 'FAIL' };

  const chevronSvg = `<svg class="rq-optimizer-heatmap-chevron ${state.propFirmExpanded ? 'expanded' : ''}" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M6 9l6 6 6-6"/></svg>`;

  const accountLabel = capital >= 1000 ? `$${Math.round(capital / 1000)}K` : `$${Math.round(capital)}`;

  return `
    <div class="rq-optimizer-heatmap-section" style="margin-top: 12px;">
      <div class="rq-optimizer-heatmap-header" data-action="toggle-propfirm" style="cursor: pointer;">
        <div class="rq-optimizer-heatmap-header-left">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#24c6ff" stroke-width="2"><path d="M12 15l-3-3h6l-3 3z"/><path d="M8 9V5a4 4 0 018 0v4"/><rect x="4" y="9" width="16" height="12" rx="2"/></svg>
          <span class="rq-optimizer-heatmap-header-title">Prop Firm Challenge</span>
        </div>
        ${chevronSvg}
      </div>
      ${state.propFirmExpanded ? `
        <div style="padding: 12px 16px;">
          <div style="color: #6b7280; font-size: 11px; margin-bottom: 12px;">
            ${accountLabel} account · ${profitTargetPct}% target · ${maxDailyLossPct}% daily · ${maxTotalLossPct}% max DD
          </div>

          ${checks.map(c => `
            <div style="display: flex; align-items: center; gap: 8px; padding: 6px 0; border-bottom: 1px solid rgba(255,255,255,0.05);">
              ${statusDots[c.status]}
              <span style="font-size: 12px; color: #e5e7eb; flex: 1; min-width: 0;">${c.label}</span>
              <span style="font-size: 11px; color: #9ca3af; flex: 1; min-width: 0; text-align: right;">${c.detail}</span>
              <span style="font-size: 10px; font-weight: 700; color: ${statusColors[c.status]}; width: 36px; text-align: right; flex-shrink: 0;">${statusLabels[c.status]}</span>
            </div>
          `).join('')}

          <div style="margin-top: 12px; padding: 10px; border-radius: 8px; background: ${verdictColor}11; border: 1px solid ${verdictColor}33; text-align: center;">
            <span style="font-size: 12px; font-weight: 700; color: ${verdictColor};">
              ${verdict} — ${passCount} of ${checks.length} checks passed
            </span>
          </div>

          <button data-action="propfirm-cta" class="rq-optimizer-btn-send" style="
            width: 100%; margin-top: 12px; justify-content: center;
          ">
            Build and backtest strategies on Roboquant
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M7 17L17 7M17 7H7M17 7v10"/></svg>
          </button>
          <div style="text-align: center; color: #6b7280; font-size: 10px; margin-top: 6px;">
            Native backtesting engine on CME data · optimize · deploy
          </div>
        </div>
      ` : ''}
    </div>
  `;
}

// ============================================================================
// Heatmap Functions
// ============================================================================

function renderHeatmapSection(result: OptimizationResult): string {
  const paramNames = Object.keys(result.runs[0]?.parameters || {});

  // Need at least 2 parameters for a heatmap
  if (paramNames.length < 2) {
    return '';
  }

  // Set default X/Y params if not set
  if (!state.heatmapXParam || !paramNames.includes(state.heatmapXParam)) {
    state.heatmapXParam = paramNames[0];
  }
  if (!state.heatmapYParam || !paramNames.includes(state.heatmapYParam)) {
    state.heatmapYParam = paramNames[1] || paramNames[0];
  }

  const metricOptions: { value: keyof OptimizationMetrics; label: string }[] = [
    { value: 'sharpeRatio', label: 'Sharpe Ratio' },
    { value: 'netProfitPercent', label: 'Net Profit %' },
    { value: 'profitFactor', label: 'Profit Factor' },
    { value: 'winRate', label: 'Win Rate' },
    { value: 'maxDrawdownPercent', label: 'Max Drawdown' },
    { value: 'sortinoRatio', label: 'Sortino Ratio' },
    { value: 'totalTrades', label: 'Total Trades' },
  ];

  return `
    <div class="rq-optimizer-heatmap-section">
      <div class="rq-optimizer-heatmap-header" data-action="toggle-heatmap">
        <div class="rq-optimizer-heatmap-header-left">
          <span class="rq-optimizer-heatmap-header-title">📊 Parameter Heatmap</span>
          <span class="rq-optimizer-heatmap-header-badge">Visualization</span>
        </div>
        <svg class="rq-optimizer-heatmap-chevron ${state.heatmapExpanded ? 'expanded' : ''}" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M6 9l6 6 6-6"/>
        </svg>
      </div>

      ${state.heatmapExpanded ? `
        <div class="rq-optimizer-heatmap-content">
          <div class="rq-optimizer-heatmap-controls">
            <div class="rq-optimizer-heatmap-control">
              <label>X Axis:</label>
              <select data-action="heatmap-x">
                ${paramNames.map(p => `<option value="${p}" ${p === state.heatmapXParam ? 'selected' : ''}>${p}</option>`).join('')}
              </select>
            </div>
            <div class="rq-optimizer-heatmap-control">
              <label>Y Axis:</label>
              <select data-action="heatmap-y">
                ${paramNames.map(p => `<option value="${p}" ${p === state.heatmapYParam ? 'selected' : ''}>${p}</option>`).join('')}
              </select>
            </div>
            <div class="rq-optimizer-heatmap-control">
              <label>Metric:</label>
              <select data-action="heatmap-metric">
                ${metricOptions.map(m => `<option value="${m.value}" ${m.value === state.heatmapMetric ? 'selected' : ''}>${m.label}</option>`).join('')}
              </select>
            </div>
            <div class="rq-optimizer-heatmap-toggle">
              <button class="rq-optimizer-heatmap-toggle-btn ${state.heatmapMode === '2d' ? 'active' : ''}" data-action="heatmap-2d">2D</button>
              <button class="rq-optimizer-heatmap-toggle-btn ${state.heatmapMode === '3d' ? 'active' : ''}" data-action="heatmap-3d">3D</button>
            </div>
          </div>

          <div class="rq-optimizer-heatmap-container" id="rq-heatmap-container">
            ${state.heatmapMode === '2d'
              ? '<canvas class="rq-optimizer-heatmap-canvas" id="rq-heatmap-canvas"></canvas>'
              : '<div class="rq-optimizer-heatmap-3d" id="rq-heatmap-3d"></div>'
            }
          </div>

          <div class="rq-optimizer-heatmap-legend">
            <span>Low</span>
            <div class="rq-optimizer-heatmap-gradient"></div>
            <span>High</span>
          </div>
        </div>
      ` : ''}
    </div>
  `;
}

function toggleHeatmapExpanded(): void {
  console.log('[RQ Optimizer] toggleHeatmapExpanded, current:', state.heatmapExpanded);
  state.heatmapExpanded = !state.heatmapExpanded;
  updateUI();
  if (state.heatmapExpanded) {
    console.log('[RQ Optimizer] Heatmap expanded, scheduling render');
    setTimeout(() => renderHeatmap(), 200);
  }
}

function renderHeatmap(): void {
  console.log('[RQ Optimizer] renderHeatmap called, mode:', state.heatmapMode, 'expanded:', state.heatmapExpanded);

  if (!state.result || !state.heatmapExpanded) {
    console.log('[RQ Optimizer] renderHeatmap skipped - no result or not expanded');
    return;
  }

  if (state.heatmapMode === '2d') {
    console.log('[RQ Optimizer] Rendering 2D heatmap');
    render2DHeatmap();
  } else {
    console.log('[RQ Optimizer] Rendering 3D heatmap');
    render3DHeatmap();
  }
}

interface HeatmapDataPoint {
  x: number;
  y: number;
  z: number;
  run: OptimizationRun;
}

function getHeatmapData(): { data: HeatmapDataPoint[]; xValues: number[]; yValues: number[]; minZ: number; maxZ: number } {
  if (!state.result) return { data: [], xValues: [], yValues: [], minZ: 0, maxZ: 1 };

  const xParam = state.heatmapXParam;
  const yParam = state.heatmapYParam;
  const metric = state.heatmapMetric;

  const data: HeatmapDataPoint[] = [];
  const xSet = new Set<number>();
  const ySet = new Set<number>();

  for (const run of state.result.runs) {
    const xRaw = run.parameters[xParam];
    const yRaw = run.parameters[yParam];
    // Heatmap only works with numeric params — skip non-numeric
    if (typeof xRaw !== 'number' || typeof yRaw !== 'number') continue;
    const x = xRaw;
    const y = yRaw;
    let z = run.metrics[metric] as number;

    // For drawdown, invert so that less negative is better (higher on heatmap)
    if (metric === 'maxDrawdownPercent') {
      z = -Math.abs(z);
    }

    xSet.add(x);
    ySet.add(y);
    data.push({ x, y, z, run });
  }

  const xValues = Array.from(xSet).sort((a, b) => a - b);
  const yValues = Array.from(ySet).sort((a, b) => a - b);

  const zValues = data.map(d => d.z);
  const minZ = Math.min(...zValues);
  const maxZ = Math.max(...zValues);

  return { data, xValues, yValues, minZ, maxZ };
}

function render2DHeatmap(): void {
  const canvas = document.getElementById('rq-heatmap-canvas') as HTMLCanvasElement;
  if (!canvas) return;

  const { data, xValues, yValues, minZ, maxZ } = getHeatmapData();
  if (data.length === 0) return;

  const container = canvas.parentElement;
  if (!container) return;

  // Set canvas size
  const padding = 60;
  const width = Math.min(600, container.clientWidth - 32);
  const height = 300;

  canvas.width = width;
  canvas.height = height;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  // Clear canvas
  ctx.fillStyle = '#0a0a0a';
  ctx.fillRect(0, 0, width, height);

  // Calculate cell size
  const plotWidth = width - padding * 2;
  const plotHeight = height - padding * 1.5;
  const cellWidth = plotWidth / xValues.length;
  const cellHeight = plotHeight / yValues.length;

  // Create lookup map for data
  const dataMap = new Map<string, HeatmapDataPoint>();
  for (const d of data) {
    dataMap.set(`${d.x}-${d.y}`, d);
  }

  // Draw cells
  for (let xi = 0; xi < xValues.length; xi++) {
    for (let yi = 0; yi < yValues.length; yi++) {
      const key = `${xValues[xi]}-${yValues[yi]}`;
      const point = dataMap.get(key);

      if (point) {
        const normalized = maxZ !== minZ ? (point.z - minZ) / (maxZ - minZ) : 0.5;
        const color = getHeatmapColor(normalized);

        ctx.fillStyle = color;
        ctx.fillRect(
          padding + xi * cellWidth,
          padding + (yValues.length - 1 - yi) * cellHeight,
          cellWidth - 1,
          cellHeight - 1
        );
      }
    }
  }

  // Draw axes
  ctx.strokeStyle = '#3f3f46';
  ctx.lineWidth = 1;

  // X-axis
  ctx.beginPath();
  ctx.moveTo(padding, height - padding / 2);
  ctx.lineTo(width - padding, height - padding / 2);
  ctx.stroke();

  // Y-axis
  ctx.beginPath();
  ctx.moveTo(padding, padding);
  ctx.lineTo(padding, height - padding / 2);
  ctx.stroke();

  // Draw labels
  ctx.fillStyle = '#71717a';
  ctx.font = '10px system-ui, sans-serif';
  ctx.textAlign = 'center';

  // X-axis labels
  const xStep = Math.max(1, Math.floor(xValues.length / 6));
  for (let i = 0; i < xValues.length; i += xStep) {
    const x = padding + i * cellWidth + cellWidth / 2;
    ctx.fillText(String(xValues[i]), x, height - padding / 4);
  }

  // Y-axis labels
  ctx.textAlign = 'right';
  const yStep = Math.max(1, Math.floor(yValues.length / 6));
  for (let i = 0; i < yValues.length; i += yStep) {
    const y = padding + (yValues.length - 1 - i) * cellHeight + cellHeight / 2;
    ctx.fillText(String(yValues[i]), padding - 8, y + 4);
  }

  // Axis titles
  ctx.fillStyle = '#a1a1aa';
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(state.heatmapXParam, width / 2, height - 4);

  ctx.save();
  ctx.translate(12, height / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText(state.heatmapYParam, 0, 0);
  ctx.restore();

  // Add tooltip on hover
  setupCanvasTooltip(canvas, data, xValues, yValues, cellWidth, cellHeight, padding);
}

function setupCanvasTooltip(
  canvas: HTMLCanvasElement,
  data: HeatmapDataPoint[],
  xValues: number[],
  yValues: number[],
  cellWidth: number,
  cellHeight: number,
  padding: number
): void {
  const container = canvas.parentElement;
  if (!container) return;

  // Remove existing tooltip
  const existingTooltip = container.querySelector('.rq-optimizer-heatmap-tooltip');
  if (existingTooltip) existingTooltip.remove();

  // Create tooltip element
  const tooltip = document.createElement('div');
  tooltip.className = 'rq-optimizer-heatmap-tooltip';
  tooltip.style.display = 'none';
  container.appendChild(tooltip);

  // Create data lookup
  const dataMap = new Map<string, HeatmapDataPoint>();
  for (const d of data) {
    dataMap.set(`${d.x}-${d.y}`, d);
  }

  canvas.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    const xi = Math.floor((mouseX - padding) / cellWidth);
    const yi = yValues.length - 1 - Math.floor((mouseY - padding) / cellHeight);

    if (xi >= 0 && xi < xValues.length && yi >= 0 && yi < yValues.length) {
      const key = `${xValues[xi]}-${yValues[yi]}`;
      const point = dataMap.get(key);

      if (point) {
        const metricLabel = getMetricLabel(state.heatmapMetric);
        const rawMetricValue = point.run.metrics[state.heatmapMetric];
        let metricValueStr: string;
        if (state.heatmapMetric === 'winRate' || state.heatmapMetric === 'netProfitPercent' || state.heatmapMetric === 'maxDrawdownPercent') {
          metricValueStr = `${Number(rawMetricValue).toFixed(2)}%`;
        } else {
          metricValueStr = Number(rawMetricValue).toFixed(2);
        }

        tooltip.innerHTML = `
          <div class="rq-optimizer-heatmap-tooltip-row">
            <span class="rq-optimizer-heatmap-tooltip-label">${state.heatmapXParam}:</span>
            <span class="rq-optimizer-heatmap-tooltip-value">${point.x}</span>
          </div>
          <div class="rq-optimizer-heatmap-tooltip-row">
            <span class="rq-optimizer-heatmap-tooltip-label">${state.heatmapYParam}:</span>
            <span class="rq-optimizer-heatmap-tooltip-value">${point.y}</span>
          </div>
          <div class="rq-optimizer-heatmap-tooltip-row">
            <span class="rq-optimizer-heatmap-tooltip-label">${metricLabel}:</span>
            <span class="rq-optimizer-heatmap-tooltip-value">${metricValueStr}</span>
          </div>
        `;
        tooltip.style.display = 'block';
        tooltip.style.left = `${mouseX + 10}px`;
        tooltip.style.top = `${mouseY - 10}px`;
        return;
      }
    }

    tooltip.style.display = 'none';
  });

  canvas.addEventListener('mouseleave', () => {
    tooltip.style.display = 'none';
  });
}

function getHeatmapColor(normalized: number): string {
  // Gradient from red (low) -> yellow -> green (high)
  if (normalized < 0.5) {
    // Red to Yellow
    const t = normalized * 2;
    const r = 239;
    const g = Math.round(68 + (158 - 68) * t);
    const b = Math.round(68 + (11 - 68) * t);
    return `rgb(${r}, ${g}, ${b})`;
  } else {
    // Yellow to Green
    const t = (normalized - 0.5) * 2;
    const r = Math.round(245 + (34 - 245) * t);
    const g = Math.round(158 + (197 - 158) * t);
    const b = Math.round(11 + (94 - 11) * t);
    return `rgb(${r}, ${g}, ${b})`;
  }
}

function getMetricLabel(metric: keyof OptimizationMetrics): string {
  const labels: Partial<Record<keyof OptimizationMetrics, string>> = {
    sharpeRatio: 'Sharpe Ratio',
    netProfitPercent: 'Net Profit %',
    profitFactor: 'Profit Factor',
    winRate: 'Win Rate',
    maxDrawdownPercent: 'Max Drawdown',
    sortinoRatio: 'Sortino Ratio',
    totalTrades: 'Total Trades',
  };
  return labels[metric] || metric;
}

// Plotly is now imported via npm package at the top of the file

async function render3DHeatmap(): Promise<void> {
  console.log('[RQ Optimizer] render3DHeatmap called');
  const container = document.getElementById('rq-heatmap-3d');
  console.log('[RQ Optimizer] 3D container found:', !!container);
  if (!container) {
    console.error('[RQ Optimizer] 3D container not found! Looking for rq-heatmap-3d');
    return;
  }

  // Show loading briefly
  container.innerHTML = `
    <div class="rq-optimizer-heatmap-loading">
      <div class="rq-optimizer-spinner"></div>
      <span>Rendering 3D visualization...</span>
    </div>
  `;

  const { data, xValues, yValues, minZ, maxZ } = getHeatmapData();
  if (data.length === 0) return;

  // Create Z matrix for surface plot
  const zMatrix: (number | null)[][] = [];
  const dataMap = new Map<string, number>();

  for (const d of data) {
    dataMap.set(`${d.x}-${d.y}`, d.z);
  }

  for (let yi = 0; yi < yValues.length; yi++) {
    const row: (number | null)[] = [];
    for (let xi = 0; xi < xValues.length; xi++) {
      const key = `${xValues[xi]}-${yValues[yi]}`;
      row.push(dataMap.get(key) ?? null);
    }
    zMatrix.push(row);
  }

  const surfaceData = [{
    type: 'surface',
    x: xValues,
    y: yValues,
    z: zMatrix,
    colorscale: [
      [0, '#ef4444'],
      [0.5, '#f59e0b'],
      [1, '#24c6ff']
    ],
    showscale: true,
    colorbar: {
      title: getMetricLabel(state.heatmapMetric),
      titleside: 'right',
      titlefont: { color: '#a1a1aa', size: 11 },
      tickfont: { color: '#71717a', size: 10 },
      bgcolor: 'rgba(0,0,0,0)',
      bordercolor: 'rgba(255,255,255,0.1)',
    },
    hovertemplate: `${state.heatmapXParam}: %{x}<br>${state.heatmapYParam}: %{y}<br>${getMetricLabel(state.heatmapMetric)}: %{z:.2f}<extra></extra>`,
  }];

  const layout = {
    paper_bgcolor: 'rgba(0,0,0,0)',
    plot_bgcolor: 'rgba(0,0,0,0)',
    margin: { l: 60, r: 30, t: 30, b: 60 },
    scene: {
      xaxis: {
        title: { text: state.heatmapXParam, font: { color: '#a1a1aa', size: 11 } },
        gridcolor: '#27272a',
        zerolinecolor: '#3f3f46',
        tickfont: { color: '#71717a', size: 10 },
      },
      yaxis: {
        title: { text: state.heatmapYParam, font: { color: '#a1a1aa', size: 11 } },
        gridcolor: '#27272a',
        zerolinecolor: '#3f3f46',
        tickfont: { color: '#71717a', size: 10 },
      },
      zaxis: {
        title: { text: getMetricLabel(state.heatmapMetric), font: { color: '#a1a1aa', size: 11 } },
        gridcolor: '#27272a',
        zerolinecolor: '#3f3f46',
        tickfont: { color: '#71717a', size: 10 },
      },
      bgcolor: '#0a0a0a',
    },
    font: { color: '#e4e4e7' },
  };

  const config = {
    displayModeBar: true,
    displaylogo: false,
    modeBarButtonsToRemove: ['toImage', 'sendDataToCloud'],
    responsive: true,
  };

  container.innerHTML = '';
  Plotly.newPlot(container, surfaceData, layout, config);
}

function renderWalkForwardComparison(wfResult: WalkForwardResult, best: OptimizationRun): string {
  const isMetrics = best.inSampleMetrics || best.metrics;
  const oosMetrics = best.outOfSampleMetrics;

  if (!oosMetrics) return '';

  const { overfittingScore, isRobust } = wfResult;

  // Determine robustness level
  let robustnessClass = 'overfit';
  let robustnessLabel = 'Overfit';
  if (overfittingScore >= 0.8) {
    robustnessClass = 'robust';
    robustnessLabel = 'Robust';
  } else if (overfittingScore >= 0.5) {
    robustnessClass = 'moderate';
    robustnessLabel = 'Moderate';
  }

  // Helper to calculate ratio with color
  const getRatioClass = (isVal: number, oosVal: number, lowerIsBetter = false): string => {
    if (isVal === 0) return '';
    const ratio = lowerIsBetter ? (isVal / oosVal) : (oosVal / isVal);
    if (ratio >= 0.8) return 'ratio-good';
    if (ratio >= 0.5) return 'ratio-warning';
    return 'ratio-bad';
  };

  const formatRatio = (isVal: number, oosVal: number, lowerIsBetter = false): string => {
    if (isVal === 0) return 'N/A';
    const ratio = lowerIsBetter ? (isVal / Math.abs(oosVal)) : (oosVal / isVal);
    return ratio.toFixed(2);
  };

  return `
    <div class="rq-optimizer-wf-comparison">
      <div class="rq-optimizer-section-title">Walk-Forward Analysis</div>

      <div class="rq-optimizer-best" style="margin-bottom: 16px;">
        <div class="rq-optimizer-best-title">🏆 Best Parameters</div>
        <div class="rq-optimizer-best-params" style="margin-top: 8px;">
          ${Object.entries(best.parameters).map(([k, v]) => `<strong>${k}</strong>=${v}`).join(' · ')}
        </div>
      </div>

      <table class="rq-optimizer-wf-comparison-table">
        <thead>
          <tr>
            <th>Metric</th>
            <th class="is-col">In-Sample</th>
            <th class="oos-col">Out-of-Sample</th>
            <th>OOS/IS Ratio</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Net Profit %</td>
            <td class="is-col">${isMetrics.netProfitPercent.toFixed(2)}%</td>
            <td class="oos-col">${oosMetrics.netProfitPercent.toFixed(2)}%</td>
            <td class="ratio-col ${getRatioClass(isMetrics.netProfitPercent, oosMetrics.netProfitPercent)}">${formatRatio(isMetrics.netProfitPercent, oosMetrics.netProfitPercent)}</td>
          </tr>
          <tr>
            <td>Sharpe Ratio</td>
            <td class="is-col">${isMetrics.sharpeRatio.toFixed(2)}</td>
            <td class="oos-col">${oosMetrics.sharpeRatio.toFixed(2)}</td>
            <td class="ratio-col ${getRatioClass(isMetrics.sharpeRatio, oosMetrics.sharpeRatio)}">${formatRatio(isMetrics.sharpeRatio, oosMetrics.sharpeRatio)}</td>
          </tr>
          <tr>
            <td>Profit Factor</td>
            <td class="is-col">${isMetrics.profitFactor.toFixed(2)}</td>
            <td class="oos-col">${oosMetrics.profitFactor.toFixed(2)}</td>
            <td class="ratio-col ${getRatioClass(isMetrics.profitFactor, oosMetrics.profitFactor)}">${formatRatio(isMetrics.profitFactor, oosMetrics.profitFactor)}</td>
          </tr>
          <tr>
            <td>Win Rate</td>
            <td class="is-col">${isMetrics.winRate.toFixed(1)}%</td>
            <td class="oos-col">${oosMetrics.winRate.toFixed(1)}%</td>
            <td class="ratio-col ${getRatioClass(isMetrics.winRate, oosMetrics.winRate)}">${formatRatio(isMetrics.winRate, oosMetrics.winRate)}</td>
          </tr>
          <tr>
            <td>Max Drawdown</td>
            <td class="is-col">${isMetrics.maxDrawdownPercent.toFixed(2)}%</td>
            <td class="oos-col">${oosMetrics.maxDrawdownPercent.toFixed(2)}%</td>
            <td class="ratio-col ${getRatioClass(Math.abs(isMetrics.maxDrawdownPercent), Math.abs(oosMetrics.maxDrawdownPercent), true)}">${formatRatio(Math.abs(isMetrics.maxDrawdownPercent), Math.abs(oosMetrics.maxDrawdownPercent), true)}</td>
          </tr>
          <tr>
            <td>Total Trades</td>
            <td class="is-col">${isMetrics.totalTrades}</td>
            <td class="oos-col">${oosMetrics.totalTrades}</td>
            <td class="ratio-col">-</td>
          </tr>
        </tbody>
      </table>

      <div class="rq-optimizer-overfitting-score">
        <span class="rq-optimizer-overfitting-label">Overfitting Score:</span>
        <span class="rq-optimizer-overfitting-value ${robustnessClass}">${overfittingScore.toFixed(2)}</span>
        <span class="rq-optimizer-overfitting-badge ${robustnessClass}">${robustnessLabel}</span>
      </div>
    </div>
  `;
}

// Expose to window for inline handlers
declare global {
  interface Window {
    rqOptimizer: {
      open: typeof openOptimizer;
      close: typeof closeOptimizer;
      start: typeof startOptimization;
      stop: typeof stopOptimization;
      refreshInputs: typeof refreshInputs;
      toggleParam: typeof toggleParam;
      toggleParamByIndex: typeof toggleParamByIndex;
      updateParam: typeof updateParam;
      updateParamByIndex: typeof updateParamByIndex;
      setGoal: typeof setGoal;
      setDelay: typeof setDelay;
      exportJSON: typeof downloadResultAsJson;
      applyBest: typeof applyBest;
      sortResults: typeof sortResults;
      reset: typeof reset;
    };
    // Functions set by content script (async - opens settings dialog to read inputs)
    rqGetStrategyInputs?: () => Promise<{ inputs: StrategyInput[] }>;
    rqStartOptimization?: (config: OptimizationConfig) => void;
    rqStopOptimization?: () => void;
    rqApplyParameters?: (params: Record<string, number | string | boolean>) => void;
    rqGetDropdownOptions?: (name: string) => Promise<string[]>;
    // Multi-symbol/timeframe functions set by content script
    rqChangeSymbol?: (symbol: string) => Promise<{ success: boolean }>;
    rqChangeTimeframe?: (timeframe: string) => Promise<{ success: boolean }>;
  }
}

// Initialize immediately
console.log('[RQ Optimizer] Initializing window.rqOptimizer...');

window.rqOptimizer = {
  open: openOptimizer,
  close: closeOptimizer,
  start: startOptimization,
  stop: stopOptimization,
  refreshInputs,
  toggleParam,
  toggleParamByIndex,
  updateParam,
  updateParamByIndex,
  setGoal,
  setDelay,
  exportJSON: downloadResultAsJson,
  applyBest,
  sortResults,
  reset,
};

console.log('[RQ Optimizer] window.rqOptimizer initialized:', Object.keys(window.rqOptimizer));

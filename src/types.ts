/**
 * Shared types for the Strategy Optimizer for TradingView extension
 * (background service worker, content script, optimizer UI and popup).
 */

// ============================================================================
// Status Types
// ============================================================================

export interface StatusResponse {
  type: 'STATUS';
  extensionVersion: string;
  connected: boolean;
  tradingViewTab: TradingViewTabInfo | null;
  editorState: EditorState;
}

export interface TradingViewTabInfo {
  tabId: number;
  url: string;
  title: string;
  /** Whether the user is logged in to TradingView */
  loggedIn: boolean;
}

export type EditorState =
  | 'not_found'        // Pine Editor not visible
  | 'closed'           // Pine Editor tab exists but closed
  | 'ready'            // Pine Editor open and ready
  | 'compiling'        // Currently compiling
  | 'error';           // Editor in error state

// ============================================================================
// Symbol & Timeframe Responses
// ============================================================================

export interface ChangeSymbolResponse {
  type: 'SYMBOL_CHANGED';
  requestId: string;
  success: boolean;
  symbol: string;
  error?: string;
}

export interface ChangeTimeframeResponse {
  type: 'TIMEFRAME_CHANGED';
  requestId: string;
  success: boolean;
  timeframe: string;
  error?: string;
}

// ============================================================================
// Internal Extension Types
// ============================================================================

/** Message from the content script (or the popup, for GET_STATUS) to background */
export interface ContentToBackgroundMessage {
  type:
    | 'GET_STATUS'
    | 'CONTENT_READY'
    | 'EDITOR_STATE_CHANGED'
    | 'HEARTBEAT'
    | 'SET_DATE_RANGE_VIA_DEBUGGER'
    | 'TRIGGER_TAB_REFRESH';
  tabId: number;
  payload?: unknown;
}

/** Message from background to content script */
export interface BackgroundToContentMessage {
  type: 'PING_CONTENT';
  requestId?: string;
  payload?: unknown;
}

// ============================================================================
// Constants
// ============================================================================

export const EXTENSION_VERSION = '3.0.0';

// ============================================================================
// Backtest Types
// ============================================================================

export interface BacktestTrade {
  /** Trade number */
  tradeNumber: number;
  /** Trade type: Long or Short */
  type: 'Long' | 'Short';
  /** Entry signal name */
  signal: string;
  /** Entry date/time */
  entryDate: string;
  /** Entry price */
  entryPrice: number;
  /** Exit date/time (null if still open) */
  exitDate: string | null;
  /** Exit price (null if still open) */
  exitPrice: number | null;
  /** Contracts/shares traded */
  contracts: number;
  /** Profit/Loss in currency */
  profitLoss: number;
  /** Profit/Loss percentage */
  profitLossPercent: number;
  /** Cumulative profit after this trade */
  cumulativeProfit: number;
  /** Cumulative profit after this trade, as % of initial capital */
  cumulativeProfitPercent: number;
  /** Run-up (max profit during trade) */
  runUp: number;
  /** Drawdown (max loss during trade) */
  drawdown: number;
}

// ============================================================================
// Optimization Types
// ============================================================================

/** Detected input parameter from TradingView strategy settings */
export interface StrategyInput {
  /** Input name/label as shown in TradingView */
  name: string;
  /** Current value */
  value: number | string | boolean;
  /** Input type */
  type: 'numeric' | 'checkbox' | 'time' | 'color' | 'dropdown';
  /** Section/group the input belongs to */
  section?: string;
  /** DOM element index for targeting */
  index: number;
  /** Available options for dropdown inputs (cached after first fetch) */
  options?: string[];
}

/** Parameter configuration for optimization (discriminated union) */
export type OptimizationParameter =
  | NumericOptimizationParameter
  | DropdownOptimizationParameter
  | BooleanOptimizationParameter;

export interface NumericOptimizationParameter {
  type: 'numeric';
  /** Input name (must match StrategyInput.name) */
  name: string;
  /** Minimum value */
  min: number;
  /** Maximum value */
  max: number;
  /** Step size */
  step: number;
}

export interface DropdownOptimizationParameter {
  type: 'dropdown';
  /** Input name (must match StrategyInput.name) */
  name: string;
  /** All available options */
  options: string[];
  /** User-chosen subset of options to test */
  selectedOptions: string[];
}

export interface BooleanOptimizationParameter {
  type: 'boolean';
  /** Input name (must match StrategyInput.name) */
  name: string;
}

/** Single window in rolling walk-forward */
export interface WalkForwardWindow {
  windowNumber: number;
  isStart: string;  // YYYY-MM-DD
  isEnd: string;    // YYYY-MM-DD
  oosStart: string; // YYYY-MM-DD
  oosEnd: string;   // YYYY-MM-DD
}

/** Walk-forward mode */
export type WalkForwardMode = 'single' | 'rolling' | 'anchored';

/** Walk-Forward (IS/OOS) configuration */
export interface WalkForwardConfig {
  /** Whether walk-forward optimization is enabled */
  enabled: boolean;
  /** Walk-forward mode */
  mode?: WalkForwardMode;

  // Single mode (original)
  /** In-Sample period start date (YYYY-MM-DD) */
  inSampleStart?: string;
  /** In-Sample period end date (YYYY-MM-DD) */
  inSampleEnd?: string;
  /** Out-of-Sample period start date (YYYY-MM-DD) */
  outOfSampleStart?: string;
  /** Out-of-Sample period end date (YYYY-MM-DD) */
  outOfSampleEnd?: string;

  // Rolling/Anchored mode
  totalStart?: string;
  totalEnd?: string;
  isWindowMonths?: number;
  oosWindowMonths?: number;
  stepMonths?: number;

  // Pre-computed windows (from frontend)
  windows?: WalkForwardWindow[];
}

/** Optimization mode */
export type OptimizationMode = 'params' | 'timeframes' | 'symbols' | 'full_grid';

/** Configuration for an optimization run */
export interface OptimizationConfig {
  /** Parameters to optimize */
  parameters: OptimizationParameter[];
  /** Metric to optimize for */
  optimizationGoal: OptimizationGoal;
  /** Delay between runs in milliseconds (default: 3000) */
  delayBetweenRuns: number;
  /** Maximum number of runs (default: 100) */
  maxRuns: number;
  /** Optimization mode: params (default), timeframes, symbols, or full_grid */
  mode?: OptimizationMode;
  /** Backtest context: Symbol to test on (optional, uses current if not set) */
  symbol?: string;
  /** Backtest context: Timeframe to test on (optional, uses current if not set) */
  timeframe?: string;
  /** Multiple symbols to test across (for symbols/full_grid modes) */
  symbols?: string[];
  /** Multiple timeframes to test across (for timeframes/full_grid modes) */
  timeframes?: string[];
  /** Backtest context: Date range for the backtest (optional, uses current if not set) */
  dateRange?: {
    start: string;  // YYYY-MM-DD
    end: string;    // YYYY-MM-DD
  };
  /** Walk-Forward (IS/OOS) configuration */
  walkForward?: WalkForwardConfig;
}

/** Available optimization goals */
export type OptimizationGoal =
  | 'netProfit'
  | 'netProfitPercent'
  | 'sharpeRatio'
  | 'sortinoRatio'
  | 'profitFactor'
  | 'winRate'
  | 'maxDrawdownPercent'
  | 'calmarRatio';

/** Single optimization run result */
export interface OptimizationRun {
  /** Run number (1-indexed) */
  runNumber: number;
  /** Parameter values for this run */
  parameters: Record<string, number | string | boolean>;
  /** Key metrics extracted (In-Sample metrics when walk-forward is enabled) */
  metrics: OptimizationMetrics;
  /** Timestamp of run completion */
  timestamp: string;
  /** Duration of this run in ms */
  duration: number;
  /** Symbol this run was tested on (multi-symbol mode) */
  symbol?: string;
  /** Timeframe this run was tested on (multi-timeframe mode) */
  timeframe?: string;
  /** In-Sample metrics (when walk-forward is enabled) */
  inSampleMetrics?: OptimizationMetrics;
  /** Out-of-Sample metrics (when walk-forward is enabled) */
  outOfSampleMetrics?: OptimizationMetrics;
  /** Full trade list for this run */
  trades?: BacktestTrade[];
  /** In-Sample trades (when walk-forward is enabled) */
  inSampleTrades?: BacktestTrade[];
  /** Out-of-Sample trades (when walk-forward is enabled) */
  outOfSampleTrades?: BacktestTrade[];
  /** Rolling walk-forward: window number this run belongs to */
  windowNumber?: number;
}

/** Simplified metrics for optimization (subset of full backtest) */
export interface OptimizationMetrics {
  netProfit: number;
  netProfitPercent: number;
  grossProfit: number;
  grossLoss: number;
  maxDrawdown: number;
  maxDrawdownPercent: number;
  sharpeRatio: number;
  sortinoRatio: number;
  profitFactor: number;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  avgTrade: number;
  avgTradePercent: number;
  largestWin: number;
  largestLoss: number;
}

/** Walk-Forward analysis result */
export interface WalkForwardResult {
  /** Best run with both IS and OOS metrics */
  bestRun: OptimizationRun;
  /** Overfitting score (OOS/IS ratio - closer to 1 = more robust) */
  overfittingScore: number;
  /** Whether the strategy is considered robust (overfittingScore > 0.7) */
  isRobust: boolean;
  /** Original date range before walk-forward (for restoration) */
  originalDateRange?: { start: string; end: string };
}

/** Result for a single rolling window */
export interface WindowResult {
  windowNumber: number;
  window: WalkForwardWindow;
  bestRunParams: Record<string, number | string | boolean>;
  isMetrics: OptimizationMetrics;
  oosMetrics: OptimizationMetrics;
  overfittingScore: number;
  isRobust: boolean;
}

/** Aggregated rolling walk-forward result */
export interface RollingWalkForwardResult {
  windows: WalkForwardWindow[];
  windowResults: WindowResult[];
  /** Average OOS metric across all windows */
  aggregatedScore: number;
  /** Standard deviation of OOS performance (consistency measure) */
  consistencyScore: number;
  /** Average overfitting score across windows */
  avgOverfittingScore: number;
  /** Number of windows that passed robustness check */
  windowsPassed: number;
  /** Total number of windows */
  totalWindows: number;
  /** Overall robustness assessment */
  isRobust: boolean;
}

/** Full optimization result */
export interface OptimizationResult {
  /** Strategy name */
  strategyName: string;
  /** Symbol */
  symbol: string;
  /** Timeframe */
  timeframe: string;
  /** Optimization configuration used */
  config: OptimizationConfig;
  /** All runs */
  runs: OptimizationRun[];
  /** Best run based on optimization goal */
  bestRun: OptimizationRun | null;
  /** Best run per symbol (multi-symbol mode) */
  bestBySymbol?: Record<string, OptimizationRun>;
  /** Best run per timeframe (multi-timeframe mode) */
  bestByTimeframe?: Record<string, OptimizationRun>;
  /** Total duration in ms */
  totalDuration: number;
  /** Start timestamp */
  startedAt: string;
  /** End timestamp */
  completedAt: string;
  /** Whether optimization was cancelled */
  cancelled: boolean;
  /** Fatal error that aborted the optimization (results may be partial/invalid) */
  error?: string;
  /** Walk-Forward analysis result (when walk-forward is enabled) */
  walkForwardResult?: WalkForwardResult;
  /** Rolling walk-forward aggregated result */
  rollingWalkForwardResult?: RollingWalkForwardResult;
}

/** Optimization progress update */
export interface OptimizationProgress {
  /** Current run number */
  currentRun: number;
  /** Total runs planned */
  totalRuns: number;
  /** Current parameters being tested */
  currentParameters: Record<string, number | string | boolean>;
  /** Best result so far */
  bestSoFar: OptimizationRun | null;
  /** Status */
  status: 'running' | 'paused' | 'completed' | 'cancelled' | 'error';
  /** Error message if status is 'error' */
  error?: string;
}

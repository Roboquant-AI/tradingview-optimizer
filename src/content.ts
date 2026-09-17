/**
 * Content Script - Runs on TradingView pages
 *
 * Responsibilities:
 * - Drive the in-page strategy optimizer (read inputs, apply parameter sets,
 *   change symbol/timeframe/date range, extract backtest metrics)
 * - Report tab and editor state to the background service worker
 */

// Global error handlers for debugging crashes
window.addEventListener('error', (event) => {
  console.error('[RQ Extension Content] UNCAUGHT ERROR:', event.error);
  console.error('[RQ Extension Content] Message:', event.message);
  console.error('[RQ Extension Content] Filename:', event.filename, 'Line:', event.lineno);
});

window.addEventListener('unhandledrejection', (event) => {
  console.error('[RQ Extension Content] UNHANDLED PROMISE REJECTION:', event.reason);
});

console.log('[RQ Extension Content] Global error handlers attached');

import type {
  BackgroundToContentMessage,
  EditorState,
  BacktestTrade,
  StrategyInput,
  OptimizationConfig,
  OptimizationRun,
  OptimizationMetrics,
  OptimizationResult,
  OptimizationProgress,
  WalkForwardResult,
  WalkForwardWindow,
  WindowResult,
  RollingWalkForwardResult,
  ChangeSymbolResponse,
  ChangeTimeframeResponse,
} from './types';
import { parseCSVTrades, calculateMetricsFromTrades } from './trades';
import selectors from './selectors.json';
import { injectOptimizerButton, updateProgress, addRun, setResult } from './optimizer-ui';

// ============================================================================
// State
// ============================================================================

interface ContentState {
  editorState: EditorState;
  isCompiling: boolean;
  observer: MutationObserver | null;
  originalCode: string | null;
  // Optimization state
  isOptimizing: boolean;
  optimizationRequestId: string | null;
  optimizationCancelled: boolean;
}

const state: ContentState = {
  editorState: 'not_found',
  isCompiling: false,
  observer: null,
  originalCode: null,
  // Optimization state
  isOptimizing: false,
  optimizationRequestId: null,
  optimizationCancelled: false,
};

// ============================================================================
// Initialization
// ============================================================================

function initialize(): void {
  console.log('[RQ Extension] Content script initializing on:', window.location.href);

  // Notify background that content script is ready
  chrome.runtime.sendMessage({ type: 'CONTENT_READY', tabId: 0 });

  // Start observing for editor
  setupEditorObserver();

  // Check initial state
  updateEditorState();

  // Listen for messages from background
  chrome.runtime.onMessage.addListener(handleBackgroundMessage);

  // Set up heartbeat to keep service worker aware of us
  // This prevents disconnection after service worker termination
  setupHeartbeat();

  // Auto-dismiss TradingView warning popups (e.g. Deep Backtesting caution)
  setupWarningPopupDismisser();

  console.log('[RQ Extension] Content script initialized');
}

/**
 * Periodically ping the background service worker to:
 * 1. Keep it alive (prevent termination due to inactivity)
 * 2. Re-register if it woke up and lost our state
 *
 * Chrome MV3 service workers can be terminated after ~30s of inactivity.
 */
function setupHeartbeat(): void {
  const HEARTBEAT_INTERVAL = 20000; // 20 seconds - before the 30s termination

  setInterval(() => {
    // Only send heartbeat if editor is ready (active use case)
    if (state.editorState === 'ready' || state.editorState === 'closed') {
      chrome.runtime.sendMessage({
        type: 'HEARTBEAT',
        tabId: 0,
        payload: state.editorState
      }).catch(() => {
        // Service worker might have been terminated - re-register
        console.log('[RQ Extension] Heartbeat failed - re-registering');
        chrome.runtime.sendMessage({ type: 'CONTENT_READY', tabId: 0 }).catch(() => {});
        updateEditorState();
      });
    }
  }, HEARTBEAT_INTERVAL);
}

/**
 * Auto-dismiss TradingView warning/caution popups (e.g. Deep Backtesting warning).
 * Uses a MutationObserver to detect when these popups appear and clicks their close button.
 */
function setupWarningPopupDismisser(): void {
  function dismissWarningPopups(): void {
    // Target the warning/caution informer containers that TradingView shows
    const warningContainers = document.querySelectorAll(
      '[class*="container-warning"], [class*="container-caution"]'
    );

    for (const container of warningContainers) {
      const closeBtn = container.querySelector('button[class*="close-button"]') ||
                       container.querySelector('button:has(path[d*="m1.5 1.5 9 9"])');
      if (closeBtn instanceof HTMLElement) {
        console.log('[RQ Extension] Auto-dismissing TradingView warning popup');
        closeBtn.click();
      }
    }
  }

  // Check immediately on init
  dismissWarningPopups();

  // Observe for new popups appearing
  const observer = new MutationObserver(() => {
    dismissWarningPopups();
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });
}

/**
 * One-shot helper to dismiss any currently visible warning popups.
 * Called during optimization loops as a safety net.
 */
function dismissWarningPopupsOnce(): void {
  const warningContainers = document.querySelectorAll(
    '[class*="container-warning"], [class*="container-caution"]'
  );
  for (const container of warningContainers) {
    const closeBtn = container.querySelector('button[class*="close-button"]') ||
                     container.querySelector('button:has(path[d*="m1.5 1.5 9 9"])');
    if (closeBtn instanceof HTMLElement) {
      console.log('[RQ Extension] Dismissing warning popup during optimization');
      closeBtn.click();
    }
  }
}

// ============================================================================
// Editor Detection & State
// ============================================================================

function setupEditorObserver(): void {
  state.observer = new MutationObserver(() => {
    updateEditorState();
  });

  state.observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'style'],
  });
}

function updateEditorState(): void {
  const newState = detectEditorState();

  if (newState !== state.editorState) {
    state.editorState = newState;
    chrome.runtime.sendMessage({
      type: 'EDITOR_STATE_CHANGED',
      tabId: 0,
      payload: newState,
    });
    console.log('[RQ Extension] Editor state changed to:', newState);
  }
}

function detectEditorState(): EditorState {
  // Check if Pine Editor Monaco editor exists (most reliable indicator)
  const monacoEditor = findElement(selectors.monaco.editor, selectors.monaco.editorAlt);

  if (!monacoEditor) {
    // Check if the Pine Editor dialog/container exists but Monaco hasn't loaded yet
    const editorContainer = findElement(
      selectors.pineEditor.container,
      selectors.pineEditor.containerAlt,
      selectors.pineEditor.widget
    );

    if (editorContainer) {
      return 'closed'; // Container exists but editor not ready
    }

    return 'not_found';
  }

  // Check visibility
  const isVisible = isElementVisible(monacoEditor);
  if (!isVisible) {
    return 'closed';
  }

  // Check if compiling
  if (state.isCompiling) {
    return 'compiling';
  }

  return 'ready';
}

// ============================================================================
// Message Handler
// ============================================================================

function handleBackgroundMessage(
  message: BackgroundToContentMessage,
  _sender: chrome.runtime.MessageSender,
  sendResponse: (response: unknown) => void
): boolean {
  console.log('[RQ Extension] Received message:', message.type);

  switch (message.type) {
    case 'PING_CONTENT':
      // Service worker is asking us to re-register (probably after wake-up)
      console.log('[RQ Extension] Received PING_CONTENT - re-registering with background');
      chrome.runtime.sendMessage({ type: 'CONTENT_READY', tabId: 0 });
      updateEditorState(); // This sends EDITOR_STATE_CHANGED
      sendResponse({ alive: true, editorState: state.editorState, isOptimizing: state.isOptimizing });
      return true;
  }

  sendResponse({ received: true });
  return true;
}

// ============================================================================
// Utilities
// ============================================================================

function findElement(...selectors: (string | undefined)[]): Element | null {
  for (const selector of selectors) {
    if (!selector) continue;
    const element = document.querySelector(selector);
    if (element) return element;
  }
  return null;
}

function isElementVisible(element: Element): boolean {
  const rect = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);

  return (
    rect.width > 0 &&
    rect.height > 0 &&
    style.display !== 'none' &&
    style.visibility !== 'hidden' &&
    style.opacity !== '0'
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================================
// CSV-Based Trade Extraction (More Reliable)
// ============================================================================

interface CSVExtractionResult {
  trades: BacktestTrade[];
  rawCsvContent: string;
}

async function extractTradesViaCSV(): Promise<CSVExtractionResult> {

  // Click the "List of Trades" tab first
  const tradesTab = document.querySelector('button[id="List of Trades"]') ||
    findElement(selectors.tradesList?.tabButton, selectors.tradesList?.tabButtonAlt);

  if (tradesTab) {
    (tradesTab as HTMLElement).click();
    await sleep(500);
  }

  // Find the download/export button in the Strategy Tester toolbar
  // User-provided selector: .tabsActions-H1Od6fDQ .downloadButton-FFj560zh
  const downloadBtn = document.querySelector('.tabsActions-H1Od6fDQ .downloadButton-FFj560zh') ||
    document.querySelector('[data-name="download"]') ||
    document.querySelector('button[aria-label*="ownload"]') ||
    document.querySelector('[data-tooltip*="ownload"]') ||
    // Find by the download icon SVG path (the exact path TradingView uses)
    Array.from(document.querySelectorAll('button')).find(btn => {
      const path = btn.querySelector('svg path');
      const d = path?.getAttribute('d') || '';
      // TradingView download icon path starts with "M7 17v4.5"
      return d.startsWith('M7 17v4.5') || d.includes('M7 17v4.5');
    }) ||
    // Fallback: find any button with download-looking SVG in Strategy Tester area
    Array.from(document.querySelectorAll('.backtesting-content-wrapper button, [class*="strategyReport"] button')).find(btn => {
      const svg = btn.querySelector('svg[viewBox="0 0 28 28"]');
      return svg !== null;
    });

  if (!downloadBtn) {
    console.log('[RQ Extension] Download button not found');
    throw new Error('Download button not found in Strategy Tester. Make sure the List of Trades tab is visible.');
  }

  // Use multiple interception strategies to capture CSV without downloading
  console.log('[RQ Extension] CSV Extraction: Starting interception setup');

  return new Promise((resolve) => {
    let resolved = false;

    const handleCSV = (csvContent: string) => {
      if (resolved) {
        console.log('[RQ Extension] CSV Extraction: Already resolved, ignoring duplicate');
        return;
      }
      console.log('[RQ Extension] CSV Extraction: handleCSV called, content length:', csvContent.length);
      resolved = true;
      cleanup();
      // Return both the parsed trades AND the raw CSV content
      const trades = parseCSVTrades(csvContent);
      console.log('[RQ Extension] CSV Extraction: Parsed', trades.length, 'trades');
      resolve({
        trades,
        rawCsvContent: csvContent,
      });
    };

    // Store original methods to restore later
    const originalCreateObjectURL = URL.createObjectURL;
    const originalCreateElement = document.createElement.bind(document);

    const cleanup = () => {
      console.log('[RQ Extension] CSV Extraction: Cleanup called');
      URL.createObjectURL = originalCreateObjectURL;
      document.createElement = originalCreateElement;
      document.removeEventListener('click', clickInterceptor, true);
    };

    // Strategy 1: Capture click events on anchors with blob URLs (capturing phase)
    const clickInterceptor = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const anchor = target.closest('a') as HTMLAnchorElement | null;

      console.log('[RQ Extension] CSV Extraction: Click interceptor fired, target:', target.tagName, 'anchor:', !!anchor);

      if (anchor) {
        console.log('[RQ Extension] CSV Extraction: Anchor found - href:', anchor.href?.substring(0, 50), 'download:', anchor.download);
      }

      if (anchor && anchor.href && anchor.href.startsWith('blob:') && anchor.download && anchor.download.endsWith('.csv')) {
        console.log('[RQ Extension] CSV Extraction: INTERCEPTED CSV download click!');

        // Stop the event from triggering download
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();

        // Fetch the blob content
        fetch(anchor.href)
          .then(r => r.text())
          .then((content) => {
            console.log('[RQ Extension] CSV Extraction: Fetched blob content, length:', content.length);
            URL.revokeObjectURL(anchor.href);
            handleCSV(content);
          })
          .catch((err) => {
            console.error('[RQ Extension] CSV Extraction: Fetch failed:', err);
            URL.revokeObjectURL(anchor.href);
          });

        // Don't remove anchor — let TradingView clean it up to avoid removeChild errors
        return;
      }
    };

    // Add listener in CAPTURING phase (before the event reaches the target)
    document.addEventListener('click', clickInterceptor, true);
    console.log('[RQ Extension] CSV Extraction: Click interceptor added');

    // Strategy 2: Override URL.createObjectURL to capture the blob content directly
    URL.createObjectURL = function(obj: Blob | MediaSource) {
      console.log('[RQ Extension] CSV Extraction: createObjectURL called, type:', obj instanceof Blob ? 'Blob' : 'MediaSource', 'size:', obj instanceof Blob ? obj.size : 'N/A');

      const url = originalCreateObjectURL.call(URL, obj);

      if (obj instanceof Blob && obj.size > 0) {
        console.log('[RQ Extension] CSV Extraction: Reading blob content...');
        const reader = new FileReader();
        reader.onload = () => {
          const content = reader.result as string;
          const hasTradeHeader = content && content.includes('Trade #');
          console.log('[RQ Extension] CSV Extraction: Blob content read, length:', content?.length, 'has Trade # header:', hasTradeHeader);
          if (hasTradeHeader) {
            console.log('[RQ Extension] CSV Extraction: CSV content captured via blob!');
            handleCSV(content);
          }
        };
        reader.readAsText(obj);
      }

      return url;
    };
    console.log('[RQ Extension] CSV Extraction: createObjectURL override installed');

    // Strategy 3: Override document.createElement to intercept anchor creation
    document.createElement = function<K extends keyof HTMLElementTagNameMap>(tagName: K): HTMLElementTagNameMap[K] {
      const element = originalCreateElement(tagName);

      if (tagName.toLowerCase() === 'a') {
        console.log('[RQ Extension] CSV Extraction: Anchor element created');
        // Monitor when href/download are set
        const anchor = element as unknown as HTMLAnchorElement;
        const originalClick = anchor.click.bind(anchor);

        anchor.click = function() {
          console.log('[RQ Extension] CSV Extraction: Anchor.click() called - href:', this.href?.substring(0, 50), 'download:', this.download);

          if (this.href && this.href.startsWith('blob:') && this.download && this.download.endsWith('.csv')) {
            console.log('[RQ Extension] CSV Extraction: BLOCKING anchor.click() for CSV download!');

            // Fetch the blob content
            fetch(this.href)
              .then(r => r.text())
              .then((content) => {
                console.log('[RQ Extension] CSV Extraction: Fetched from blocked click, length:', content.length);
                URL.revokeObjectURL(this.href);
                handleCSV(content);
              })
              .catch((err) => {
                console.error('[RQ Extension] CSV Extraction: Fetch failed:', err);
              });

            // Don't remove anchor — let TradingView clean it up to avoid removeChild errors
            return; // Don't call original click
          }

          return originalClick();
        };
      }

      return element;
    };
    console.log('[RQ Extension] CSV Extraction: createElement override installed');

    // Click the download button
    console.log('[RQ Extension] CSV Extraction: Clicking download button now...');
    (downloadBtn as HTMLElement).click();

    // Timeout
    setTimeout(() => {
      if (!resolved) {
        console.log('[RQ Extension] CSV Extraction: TIMEOUT - no CSV captured after 5s');
        resolved = true;
        cleanup();
        resolve({ trades: [], rawCsvContent: '' });
      }
    }, 5000);
  });
}


// ============================================================================
// Strategy Metadata Extraction
// ============================================================================

function extractStrategyMetadata(): {
  strategyName: string;
  symbol: string;
  timeframe: string;
  dateRange: { start: string; end: string };
} {
  // Strategy name from data-strategy-title attribute, or from the strategy group title
  const strategyBtn = document.querySelector('[data-strategy-title]');
  const strategyName = strategyBtn?.getAttribute('data-strategy-title') ||
    document.querySelector('[class*="strategyGroup"] [class*="title"]')?.textContent?.trim() ||
    'Unknown Strategy';

  // Symbol from chart header toolbar button
  // TradingView uses #header-toolbar-symbol-search with a span containing the symbol
  const symbolEl = document.querySelector('#header-toolbar-symbol-search span[class*="value-"]') ||
    document.querySelector('#header-toolbar-symbol-search span') ||
    document.querySelector('[data-symbol-short]') ||
    findElement(selectors.chart?.symbol);
  const symbol = symbolEl?.textContent?.trim() || 'Unknown';

  // Timeframe from chart header toolbar
  // TradingView shows the current timeframe in the toolbar - try multiple selectors
  let timeframe = '';

  // Method 1: Look for time-interval-menu button
  const intervalBtn = document.querySelector('[data-name="time-interval-menu"]');
  if (intervalBtn) {
    // The button text itself contains the timeframe
    const btnText = intervalBtn.textContent?.trim() || '';
    // Extract just the timeframe part (e.g., "15m" from possible longer text)
    const tfMatch = btnText.match(/^(\d+[mhDWM]?|\d+\s*min|\d+\s*hour|[DWMS])/i);
    if (tfMatch) {
      timeframe = tfMatch[1];
    }
  }

  // Method 2: Look in the intervals container
  if (!timeframe) {
    const intervalsContainer = document.querySelector('#header-toolbar-intervals');
    if (intervalsContainer) {
      // Look for active/selected button
      const activeBtn = intervalsContainer.querySelector('[class*="isActive"]') ||
        intervalsContainer.querySelector('[aria-checked="true"]') ||
        intervalsContainer.querySelector('button[class*="selected"]');
      if (activeBtn) {
        timeframe = activeBtn.textContent?.trim() || '';
      }
    }
  }

  // Method 3: Check URL for timeframe parameter
  if (!timeframe) {
    const urlMatch = window.location.href.match(/interval=(\d+[mhDWMS]?)/i);
    if (urlMatch) {
      timeframe = urlMatch[1];
    }
  }

  // Method 4: Look for any button that looks like a timeframe display
  if (!timeframe) {
    const allButtons = document.querySelectorAll('#header-toolbar-intervals button, [class*="interval"] button');
    for (const btn of allButtons) {
      const text = btn.textContent?.trim() || '';
      if (/^\d+[mhDWM]?$/.test(text)) {
        timeframe = text;
        break;
      }
    }
  }

  console.log('[RQ Extension] Detected timeframe:', timeframe || '(not found)');

  // Date range from the button text (e.g., "Jan 3, 2022 — Dec 22, 2025")
  const dateRangeEl = document.querySelector('.dateRangeMenuWrapper-ucbE4pMM button') ||
    document.querySelector('[class*="dateRange"] button');
  // Use innerText to avoid duplicated text from nested elements
  const dateRangeText = (dateRangeEl as HTMLElement | null)?.innerText?.trim() || dateRangeEl?.textContent?.trim() || '';

  // Split on various dash types (—, –, -)
  const dateParts = dateRangeText.split(/[—–-]/).map(d => d.trim()).filter(Boolean);
  const start = dateParts[0] || '';
  const end = dateParts[1] || '';

  return {
    strategyName,
    symbol,
    timeframe,
    dateRange: { start, end },
  };
}

// ============================================================================
// Optimization Functions
// ============================================================================

/**
 * Extract all inputs from the strategy settings dialog
 * This will open the dialog if it's not already open, extract inputs, then close it
 * @param targetStrategyName - Optional strategy name to target (when the caller already knows it)
 */
async function extractStrategyInputsAsync(targetStrategyName?: string): Promise<StrategyInput[]> {
  const inputs: StrategyInput[] = [];
  const settingsSelectors = (selectors as any).strategySettings;

  // Temporarily hide our optimizer overlay so it doesn't block clicks
  const optimizerOverlay = document.getElementById('rq-optimizer-overlay');
  if (optimizerOverlay) {
    optimizerOverlay.style.display = 'none';
    console.log('[RQ Extension] Temporarily hiding optimizer overlay');
  }

  try {
    // Check if settings dialog is already open by looking for the dialog
    let dialog = document.querySelector('[data-name="indicator-properties-dialog"]') ||
      document.querySelector('[class*="dialog-"][class*="backdrop"]')?.querySelector('[class*="content"]');

    const dialogWasOpen = !!dialog;

    // If dialog not open, click the settings button to open it
    if (!dialog) {
      console.log('[RQ Extension] Settings dialog not open, opening it...');

    // Use the provided strategy name, or fall back to Strategy Tester title
    const strategyTesterTitle = document.querySelector('[class*="strategyGroup"] [class*="title"]')?.textContent?.trim() ||
      document.querySelector('[data-name="backtesting"] [class*="strategy"]')?.textContent?.trim();

    // Prefer the explicitly provided name
    const targetName = targetStrategyName || strategyTesterTitle;
    console.log('[RQ Extension] Target strategy:', targetName, '(provided:', targetStrategyName, ', tester:', strategyTesterTitle, ')');

    // Helper function for fuzzy strategy name matching
    const fuzzyMatch = (name1: string, name2: string): boolean => {
      const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
      const n1 = normalize(name1);
      const n2 = normalize(name2);
      // Check if normalized strings match or one contains the other
      if (n1 === n2 || n1.includes(n2) || n2.includes(n1)) return true;
      // Check if they share significant words (at least 2 words in common)
      const words1 = name1.toLowerCase().split(/\s+/).filter(w => w.length > 2);
      const words2 = name2.toLowerCase().split(/\s+/).filter(w => w.length > 2);
      const commonWords = words1.filter(w => words2.some(w2 => w.includes(w2) || w2.includes(w)));
      return commonWords.length >= 2;
    };

    // If we have a target strategy name, select it from the Strategy Tester dropdown and open its settings
    if (targetName) {
      // Find the strategy dropdown button in Strategy Tester
      const strategyDropdown = document.querySelector('button[data-strategy-title]') as HTMLElement;
      if (strategyDropdown) {
        const currentStrategy = strategyDropdown.getAttribute('data-strategy-title');
        console.log('[RQ Extension] Current strategy in dropdown:', currentStrategy);

        // Check if target strategy is already selected (using fuzzy matching)
        const isAlreadySelected = currentStrategy && fuzzyMatch(currentStrategy, targetName);
        console.log('[RQ Extension] Fuzzy match result:', isAlreadySelected);

        // Open the dropdown menu
        console.log('[RQ Extension] Opening strategy dropdown...');
        strategyDropdown.click();
        await sleep(300);

        // If not already selected, find and click the correct strategy first
        if (!isAlreadySelected) {
          console.log('[RQ Extension] Switching strategy...');
          const menuItems = document.querySelectorAll('[role="menuitemcheckbox"]');
          console.log('[RQ Extension] Found', menuItems.length, 'strategy menu items');

          for (const item of menuItems) {
            const label = item.getAttribute('aria-label') || item.textContent?.trim();
            console.log('[RQ Extension] Menu item:', label);
            if (label && fuzzyMatch(targetName, label)) {
              console.log('[RQ Extension] Clicking strategy menu item:', label);
              (item as HTMLElement).click();
              await sleep(500); // Wait for strategy to switch
              // Re-open dropdown to access Settings
              strategyDropdown.click();
              await sleep(300);
              break;
            }
          }
        }

        // Now click the "Settings..." option in the dropdown menu
        const settingsMenuItem = document.querySelector('[data-name="legend-settings-action"], [role="menuitem"][aria-label*="Settings"]') as HTMLElement;
        if (settingsMenuItem) {
          console.log('[RQ Extension] Clicking Settings from dropdown menu');
          settingsMenuItem.click();

          // Wait for dialog to appear (poll for up to 3 seconds)
          for (let i = 0; i < 30; i++) {
            await sleep(100);
            dialog = document.querySelector('[data-name="indicator-properties-dialog"]');
            if (dialog) {
              console.log('[RQ Extension] Settings dialog opened from dropdown');
              break;
            }
          }
        } else {
          // Try finding Settings by text content
          const allMenuItems = document.querySelectorAll('[role="menuitem"]');
          for (const item of allMenuItems) {
            if (item.textContent?.includes('Settings')) {
              console.log('[RQ Extension] Clicking Settings menu item by text');
              (item as HTMLElement).click();

              // Wait for dialog to appear
              for (let i = 0; i < 30; i++) {
                await sleep(100);
                dialog = document.querySelector('[data-name="indicator-properties-dialog"]');
                if (dialog) break;
              }
              break;
            }
          }
        }

        // Close dropdown if dialog didn't open
        if (!dialog) {
          console.log('[RQ Extension] Settings dialog not opened from dropdown, closing menu');
          document.body.click();
          await sleep(100);
        }
      } else {
        console.log('[RQ Extension] Strategy dropdown button not found');
      }
    }

    // Only search for settings button in legend if dialog wasn't already opened from dropdown
    let settingsBtn: Element | null = null;

    if (!dialog) {
      // Find all strategy/indicator legend items
      const legendItems = document.querySelectorAll('[class*="sourcesWrapper"] [class*="sources"] > div, [class*="legend"] [class*="item"]');
      console.log('[RQ Extension] Found', legendItems.length, 'legend items');

      // If we have a target strategy name, find that specific one in the legend
      if (targetName) {
        for (const item of legendItems) {
          const titleEl = item.querySelector('[class*="title"]');
          const title = titleEl?.textContent?.trim();
          // Match if title contains or is contained by target name (handles partial matches)
          if (title && (targetName.toLowerCase().includes(title.toLowerCase()) || title.toLowerCase().includes(targetName.toLowerCase()))) {
            settingsBtn = item.querySelector('[data-name="legend-settings-action"], [data-qa-id="legend-settings-action"], button[aria-label*="Settings"]');
            if (settingsBtn) {
              console.log('[RQ Extension] Found settings button for strategy:', title);
              break;
            }
          }
        }
      }
    } else {
      console.log('[RQ Extension] Dialog already opened from dropdown, skipping legend search');
    }

    // Only search for fallback settings buttons if dialog wasn't already opened
    if (!dialog) {
      // Fallback: Try multiple selectors for the strategy settings button (gear icon)
      if (!settingsBtn) {
        const settingsSelectors_list = [
          '[data-qa-id="legend-settings-action"]',
          '[data-name="legend-settings-action"]',
          'button[aria-label*="Settings"]',
          'button[aria-label*="settings"]',
          '[class*="legend"] [class*="settings"]',
          '[class*="legend"] button[class*="button-"]',
          // Strategy tester specific
          '[data-name="backtesting"] [class*="settings"]',
          '[class*="strategyGroup"] button',
        ];

        for (const selector of settingsSelectors_list) {
          settingsBtn = document.querySelector(selector);
          if (settingsBtn) {
            console.log('[RQ Extension] Found settings button with fallback selector:', selector);
            break;
          }
        }
      }

      // Also try finding by the gear SVG icon
      if (!settingsBtn) {
        const allButtons = document.querySelectorAll('button');
        for (const btn of allButtons) {
          const svg = btn.querySelector('svg');
          const title = svg?.querySelector('title');
          if (title?.textContent?.toLowerCase().includes('settings') ||
              btn.getAttribute('aria-label')?.toLowerCase().includes('settings')) {
            settingsBtn = btn;
            console.log('[RQ Extension] Found settings button by SVG/aria-label');
            break;
          }
        }
      }

      if (!settingsBtn) {
        console.log('[RQ Extension] Settings button not found. Available buttons with data attributes:');
        document.querySelectorAll('button[data-name], button[data-qa-id]').forEach(btn => {
          console.log('  -', btn.getAttribute('data-name') || btn.getAttribute('data-qa-id'), btn.className.substring(0, 50));
        });
        return [];
      }
    }

    // Only click settings button if dialog wasn't already opened from dropdown
    if (!dialog && settingsBtn) {
      // Click to open settings - use realistic mouse events
      const btn = settingsBtn as HTMLElement;

      // Simulate full click sequence
      btn.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      btn.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      await sleep(50);
      btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
      btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }));
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));

      console.log('[RQ Extension] Clicked settings button with mouse events');
      await sleep(800); // Wait longer for dialog

      // Wait for dialog to appear
      for (let i = 0; i < 20; i++) {
        dialog = document.querySelector('[data-name="indicator-properties-dialog"]') ||
          document.querySelector('[data-dialog-name*="indicator"]') ||
          document.querySelector('[data-dialog-name*="strategy"]') ||
          document.querySelector('[class*="dialog"][class*="content"]') ||
          document.querySelector('[class*="modal"][class*="content"]');
        if (dialog) {
          console.log('[RQ Extension] Dialog appeared');
          break;
        }
        await sleep(100);
      }

      if (!dialog) {
        console.log('[RQ Extension] Settings dialog did not open. Looking for any dialogs:');
        document.querySelectorAll('[class*="dialog"], [class*="modal"], [data-dialog-name]').forEach(el => {
          console.log('  -', el.className.substring(0, 80), el.getAttribute('data-dialog-name'));
        });
        return [];
      }
    }
  }

  // Every path above either sets dialog or returns; this narrows the type.
  if (!dialog) {
    return [];
  }

  console.log('[RQ Extension] Settings dialog found');

  // Click on the "Inputs" tab to ensure we're seeing input parameters
  const inputsTab = dialog.querySelector('button[id="Inputs"]') ||
    Array.from(dialog.querySelectorAll('button')).find(b =>
      b.textContent?.toLowerCase().trim() === 'inputs'
    );

  if (inputsTab) {
    (inputsTab as HTMLElement).click();
    await sleep(300);
    console.log('[RQ Extension] Clicked Inputs tab');
  }

  // Now extract inputs from within the dialog
  const searchRoot = dialog;

  // Find all numeric inputs within the dialog - try multiple selectors
  // TradingView uses various input types for numeric values
  const numericSelectors = [
    'input[inputmode="numeric"][data-qa-id="ui-lib-Input-input"]', // Exact TradingView selector
    'input[inputmode="numeric"]',
    'input[inputmode="decimal"]',
    'input[type="number"]',
    'input[data-property-id]', // TradingView property inputs
    'input.input-RUSovanF', // TradingView input class
    '[class*="inputWrapper"] input',
    '[class*="cell-"] input[type="text"]',
  ];

  const numericInputs = new Set<Element>();
  for (const selector of numericSelectors) {
    searchRoot.querySelectorAll(selector).forEach(el => numericInputs.add(el));
  }

  console.log('[RQ Extension] Found', numericInputs.size, 'potential inputs with selectors');

  let index = 0;
  numericInputs.forEach((input: Element) => {
    const inputEl = input as HTMLInputElement;
    const value = inputEl.value;

    // Check if value looks numeric (including negative and decimals)
    const isNumeric = value !== '' && !isNaN(parseFloat(value)) && isFinite(Number(value));

    // Find the label for this input by traversing up and looking for the label cell
    const label = findInputLabel(inputEl);

    console.log('[RQ Extension] Input:', { label, value, isNumeric, type: inputEl.type, inputmode: inputEl.inputMode });

    if (label && isNumeric && !isPropertyInput(label)) {
      inputs.push({
        name: label,
        value: parseFloat(value) || 0,
        type: 'numeric',
        section: findInputSection(inputEl),
        index: index++,
      });
    }
  });

  // Find checkboxes within the dialog (for reference, not optimization)
  const checkboxes = searchRoot.querySelectorAll(
    settingsSelectors?.checkbox || 'input[type="checkbox"]'
  );

  checkboxes.forEach((checkbox: Element) => {
    const checkEl = checkbox as HTMLInputElement;
    const label = findCheckboxLabel(checkEl);

    if (label && !isPropertyInput(label)) {
      inputs.push({
        name: label,
        value: checkEl.checked,
        type: 'checkbox',
        section: findInputSection(checkEl),
        index: index++,
      });
    }
  });

  // Find dropdown/combobox inputs within the dialog and pre-fetch their options
  const comboboxes = searchRoot.querySelectorAll('button[role="combobox"]');
  for (const combobox of comboboxes) {
    const comboEl = combobox as HTMLElement;
    const label = findInputLabel(comboEl as any) || findComboboxLabel(comboEl);
    const currentValue = comboEl.querySelector('[class*="middleSlot"]')?.textContent?.trim()
      || comboEl.textContent?.trim() || '';

    if (label && !isPropertyInput(label)) {
      // Pre-fetch options by briefly opening the dropdown popup
      let options: string[] = [];
      try {
        comboEl.click();
        await sleep(300);
        // Scope to the listbox associated with this combobox (via aria-controls) or the last visible one
        const listboxId = comboEl.getAttribute('aria-controls');
        const listbox = listboxId
          ? document.getElementById(listboxId)
          : document.querySelector('[role="listbox"]');
        const optionEls = listbox
          ? listbox.querySelectorAll('[role="option"]')
          : document.querySelectorAll('[role="option"]');
        options = Array.from(optionEls)
          .map(opt => opt.querySelector('[class*="title-"]')?.textContent?.trim() || opt.textContent?.trim())
          .filter(Boolean) as string[];
        // Close popup
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await sleep(200);
        console.log(`[RQ Extension] Dropdown "${label}" options:`, options);
      } catch (err) {
        console.warn(`[RQ Extension] Failed to fetch options for dropdown "${label}":`, err);
      }

      inputs.push({
        name: label,
        value: currentValue,
        type: 'dropdown',
        section: findInputSection(comboEl),
        index: index++,
        options: options.length > 0 ? options : undefined,
      });
    }
  }

  console.log('[RQ Extension] Found inputs:', inputs);
  console.log('[RQ Extension] Input types breakdown:', {
    numeric: inputs.filter(i => i.type === 'numeric').length,
    checkbox: inputs.filter(i => i.type === 'checkbox').length,
    dropdown: inputs.filter(i => i.type === 'dropdown').length,
    other: inputs.filter(i => i.type !== 'numeric' && i.type !== 'checkbox' && i.type !== 'dropdown').length,
  });

    // Close the dialog if we opened it (so it doesn't block the optimizer UI)
    if (!dialogWasOpen) {
      const closeBtn = dialog.querySelector('[data-name="close"]') ||
        dialog.querySelector('button[aria-label="Close"]') ||
        dialog.querySelector('[class*="close"]');

      if (closeBtn) {
        console.log('[RQ Extension] Closing settings dialog');
        (closeBtn as HTMLElement).click();
        await sleep(200);
      }
    }

    return inputs;
  } finally {
    // Always restore the optimizer overlay
    if (optimizerOverlay) {
      optimizerOverlay.style.display = '';
      console.log('[RQ Extension] Restored optimizer overlay');
    }
  }
}

/**
 * Find the label for a numeric input
 */
function findInputLabel(input: HTMLInputElement): string | null {
  // TradingView structure: .cell-RLntasnw.first-RLntasnw (label) + .cell-RLntasnw (input)
  // So we need to find the parent cell, then the previous sibling cell

  // First find the containing cell
  let cell = input.closest('[class*="cell-"]');
  if (!cell) return null;

  // Get the previous sibling that's a "first" cell (contains label)
  let prevCell = cell.previousElementSibling;
  while (prevCell) {
    if (prevCell.className.includes('first-')) {
      const inner = prevCell.querySelector('[class*="inner-"]');
      if (inner) {
        return inner.textContent?.trim() || null;
      }
    }
    prevCell = prevCell.previousElementSibling;
  }

  return null;
}

/**
 * Find the label for a checkbox
 */
function findCheckboxLabel(checkbox: HTMLInputElement): string | null {
  // Checkboxes have their label as a sibling span
  const label = checkbox.closest('label');
  if (label) {
    const labelText = label.querySelector('[class*="label-"]');
    if (labelText) {
      return labelText.textContent?.trim() || null;
    }
  }
  return null;
}

/**
 * Find the section name for an input
 */
function findInputSection(element: HTMLElement): string | undefined {
  // Walk up to find a section header
  let current: HTMLElement | null = element;
  while (current) {
    const sectionHeader = current.previousElementSibling;
    if (sectionHeader?.hasAttribute('data-section-name')) {
      return sectionHeader.getAttribute('data-section-name') || undefined;
    }
    // Also check for title elements
    const title = current.querySelector('[class*="title-"]');
    if (title) {
      return title.textContent?.trim();
    }
    current = current.parentElement;
  }
  return undefined;
}

/**
 * Check if this is a "Properties" tab input (not strategy input)
 */
function isPropertyInput(label: string): boolean {
  const propertyLabels = [
    'Initial capital',
    'Base currency',
    'Default order size',
    'Pyramiding',
    'Commission',
    'Verify price for limit orders',
    'Slippage',
    'Margin for long positions',
    'Margin for short positions',
  ];
  return propertyLabels.some(p => label.toLowerCase().includes(p.toLowerCase()));
}

/**
 * Find the label for a combobox/dropdown button.
 * Traverses up to find the row container then looks for a sibling label cell.
 */
function findComboboxLabel(combobox: HTMLElement): string | null {
  // Same structure as numeric inputs: .cell-first (label) + .cell (combobox)
  let cell = combobox.closest('[class*="cell-"]');
  if (!cell) return null;

  let prevCell = cell.previousElementSibling;
  while (prevCell) {
    if (prevCell.className.includes('first-')) {
      const inner = prevCell.querySelector('[class*="inner-"]');
      if (inner) {
        return inner.textContent?.trim() || null;
      }
    }
    prevCell = prevCell.previousElementSibling;
  }

  return null;
}

/**
 * Get all available options for a dropdown input by opening the combobox popup.
 * Opens the strategy settings dialog if it isn't already open.
 */
async function getDropdownOptions(name: string): Promise<string[]> {
  // Hide optimizer overlay so it doesn't block the settings dialog
  const optimizerOverlay = document.getElementById('rq-optimizer-overlay');
  if (optimizerOverlay) {
    optimizerOverlay.style.display = 'none';
  }

  try {
    // Check if settings dialog is already open
    let dialog = document.querySelector('[data-name="indicator-properties-dialog"]');
    const dialogWasOpen = !!dialog;

    // Open it if not already open
    if (!dialog) {
      console.log('[RQ Extension] Opening settings dialog to fetch dropdown options...');
      dialog = await openSettingsDialogForOptimization();
      if (!dialog) {
        console.warn('[RQ Extension] Could not open settings dialog for dropdown options');
        return [];
      }
      await sleep(300);
    }

    const comboboxes = dialog.querySelectorAll('button[role="combobox"]');

    for (const combobox of comboboxes) {
      const comboEl = combobox as HTMLElement;
      const label = findInputLabel(comboEl as any) || findComboboxLabel(comboEl);
      if (label !== name) continue;

      // Click to open the dropdown popup
      comboEl.click();
      await sleep(300);

      // Read options from the popup listbox (scoped to this combobox's listbox)
      const listboxId = comboEl.getAttribute('aria-controls');
      const listbox = listboxId
        ? document.getElementById(listboxId)
        : document.querySelector('[role="listbox"]');
      const optionEls = listbox
        ? listbox.querySelectorAll('[role="option"]')
        : document.querySelectorAll('[role="option"]');
      const options = Array.from(optionEls)
        .map(opt => opt.querySelector('[class*="title-"]')?.textContent?.trim() || opt.textContent?.trim())
        .filter(Boolean) as string[];

      // Close the dropdown popup by pressing Escape
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await sleep(200);

      // Close settings dialog if we opened it
      if (!dialogWasOpen) {
        await closeSettingsDialog();
      }

      console.log(`[RQ Extension] Dropdown "${name}" options:`, options);
      return options;
    }

    // Close settings dialog if we opened it and didn't find the dropdown
    if (!dialogWasOpen) {
      await closeSettingsDialog();
    }

    console.warn(`[RQ Extension] Dropdown not found: ${name}`);
    return [];
  } finally {
    // Restore optimizer overlay
    if (optimizerOverlay) {
      optimizerOverlay.style.display = '';
    }
  }
}

/**
 * Set a dropdown/combobox value by selecting an option from the popup.
 */
async function setDropdownValue(name: string, targetValue: string): Promise<boolean> {
  const dialog = document.querySelector('[data-name="indicator-properties-dialog"]');
  const searchRoot = dialog || document;
  const comboboxes = searchRoot.querySelectorAll('button[role="combobox"]');

  for (const combobox of comboboxes) {
    const comboEl = combobox as HTMLElement;
    const label = findInputLabel(comboEl as any) || findComboboxLabel(comboEl);
    if (label !== name) continue;

    // Check if already the right value
    const currentValue = comboEl.querySelector('[class*="middleSlot"]')?.textContent?.trim()
      || comboEl.textContent?.trim();
    if (currentValue === targetValue) {
      console.log(`[RQ Extension] Dropdown "${name}" already set to "${targetValue}"`);
      return true;
    }

    // Click to open listbox
    comboEl.click();
    await sleep(300);

    // Find and click target option
    const options = document.querySelectorAll('[role="option"]');
    for (const option of options) {
      const optText = option.querySelector('[class*="title-"]')?.textContent?.trim()
        || option.textContent?.trim();
      if (optText === targetValue) {
        (option as HTMLElement).click();
        await sleep(200);
        console.log(`[RQ Extension] Set dropdown "${name}" = "${targetValue}"`);
        return true;
      }
    }

    // Close if option not found
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await sleep(100);
    console.warn(`[RQ Extension] Option "${targetValue}" not found in dropdown "${name}"`);
    return false;
  }

  console.warn(`[RQ Extension] Dropdown not found: ${name}`);
  return false;
}

/**
 * Set a checkbox value by clicking if needed.
 */
async function setCheckboxValue(name: string, checked: boolean): Promise<boolean> {
  const dialog = document.querySelector('[data-name="indicator-properties-dialog"]');
  const searchRoot = dialog || document;
  const checkboxes = searchRoot.querySelectorAll('input[type="checkbox"]');

  for (const checkbox of checkboxes) {
    const checkEl = checkbox as HTMLInputElement;
    const label = findCheckboxLabel(checkEl);
    if (label !== name) continue;

    if (checkEl.checked !== checked) {
      checkEl.click();
      await sleep(100);
    }
    console.log(`[RQ Extension] Set checkbox "${name}" = ${checked}`);
    return true;
  }

  console.warn(`[RQ Extension] Checkbox not found: ${name}`);
  return false;
}

/**
 * Set a single numeric input value by name
 */
async function setNumericInputValue(name: string, value: number): Promise<boolean> {
  // Search within the settings dialog first
  const dialog = document.querySelector('[data-name="indicator-properties-dialog"]') ||
    document.querySelector('[class*="dialog"][class*="content"]');

  const searchRoot = dialog || document;
  const inputs = searchRoot.querySelectorAll('input[inputmode="numeric"]');

  console.log(`[RQ Extension] setInputValue: searching for "${name}" in ${inputs.length} inputs`);

  for (const input of inputs) {
    const inputEl = input as HTMLInputElement;
    const label = findInputLabel(inputEl);

    if (label === name) {
      const applied = await writeNumericInput(inputEl, value);
      if (applied) {
        console.log(`[RQ Extension] Set ${name} = ${value}`);
        return true;
      }
      console.warn(`[RQ Extension] Input "${name}" found but value did not stick (wanted ${value}, has "${inputEl.value}")`);
      return false;
    }
  }

  console.warn(`[RQ Extension] Input not found: ${name}. Available labels:`,
    Array.from(inputs).map(i => findInputLabel(i as HTMLInputElement)).filter(Boolean));
  return false;
}

/**
 * Write a value into a numeric input and VERIFY it stuck.
 *
 * Strategy 1: native value setter + synthetic input/change events (fast path,
 * works with classic React controlled inputs).
 * Strategy 2 (fallback): simulate real typing per character with key events and
 * InputEvent('insertText'), which survives stricter event-trust checks.
 *
 * Returns true only if the input still holds the target value after blur —
 * a reverted value means the framework rejected the synthetic update and the
 * backtest would silently re-run with OLD parameters.
 */
async function writeNumericInput(inputEl: HTMLInputElement, value: number): Promise<boolean> {
  const target = String(value);
  const matches = () => {
    const current = parseFloat(inputEl.value.replace(/\s/g, '').replace(/,/g, ''));
    return Number.isFinite(current) && current === value;
  };

  // --- Strategy 1: native setter + synthetic events ---
  inputEl.focus();
  await sleep(50);
  inputEl.select();
  await sleep(50);

  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  if (nativeInputValueSetter) {
    nativeInputValueSetter.call(inputEl, target);
  } else {
    inputEl.value = target;
  }
  inputEl.dispatchEvent(new Event('input', { bubbles: true }));
  inputEl.dispatchEvent(new Event('change', { bubbles: true }));
  inputEl.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
  inputEl.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Enter' }));
  inputEl.blur();
  await sleep(150);

  if (matches()) return true;

  // --- Strategy 2: simulate real typing ---
  console.log(`[RQ Extension] Native-setter write reverted (input shows "${inputEl.value}"), retrying with typing simulation`);
  inputEl.focus();
  await sleep(50);
  inputEl.select();
  await sleep(50);

  // Clear with Backspace, then type each character
  inputEl.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Backspace' }));
  if (nativeInputValueSetter) nativeInputValueSetter.call(inputEl, '');
  else inputEl.value = '';
  inputEl.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
  inputEl.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Backspace' }));
  await sleep(30);

  for (const ch of target) {
    inputEl.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: ch }));
    inputEl.dispatchEvent(new KeyboardEvent('keypress', { bubbles: true, key: ch }));
    if (nativeInputValueSetter) nativeInputValueSetter.call(inputEl, inputEl.value + ch);
    else inputEl.value = inputEl.value + ch;
    inputEl.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ch }));
    inputEl.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: ch }));
    await sleep(15);
  }

  inputEl.dispatchEvent(new Event('change', { bubbles: true }));
  inputEl.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));
  inputEl.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Enter' }));
  await sleep(50);
  inputEl.blur();
  await sleep(150);

  return matches();
}

/**
 * Unified input value setter — dispatches to numeric, dropdown, or checkbox handler.
 */
async function setInputValue(name: string, value: number | string | boolean): Promise<boolean> {
  if (typeof value === 'boolean') {
    return setCheckboxValue(name, value);
  } else if (typeof value === 'string') {
    return setDropdownValue(name, value);
  } else {
    return setNumericInputValue(name, value);
  }
}

/**
 * Commit the settings dialog by clicking the Ok/Submit button.
 *
 * IMPORTANT: this is NOT the same as closeSettingsDialog(), which clicks the
 * X — TradingView treats X as Cancel and may DISCARD pending input changes,
 * silently re-running the backtest with the old parameters.
 */
async function commitSettingsDialog(): Promise<boolean> {
  const dialog = document.querySelector('[data-name="indicator-properties-dialog"]') ||
    document.querySelector('[class*="dialog"][class*="content"]');
  if (!dialog) return false;

  const okBtn = (dialog.querySelector('button[name="submit"]') ||
    dialog.querySelector('[data-name="submit-button"]') ||
    Array.from(dialog.querySelectorAll('button')).find(btn => {
      const t = btn.textContent?.trim().toLowerCase();
      return t === 'ok' || t === 'apply';
    })) as HTMLElement | undefined;

  if (okBtn) {
    okBtn.click();
    await sleep(300);
    return true;
  }

  console.warn('[RQ Extension] Ok button not found in settings dialog, falling back to close (changes may not commit)');
  await closeSettingsDialog();
  return false;
}

/**
 * Apply one optimization run's parameter set and COMMIT it via the dialog's
 * Ok button. Verifies every input actually accepted its value.
 *
 * Returns the list of parameter names that failed to apply. A non-empty list
 * means the backtest would re-run with stale values — callers must treat that
 * as a hard error instead of recording garbage results.
 */
async function applyParameterSet(
  params: Record<string, number | string | boolean>,
  strategyName?: string,
): Promise<string[]> {
  const dialog = await openSettingsDialogForOptimization(strategyName);
  if (!dialog) {
    return Object.keys(params);
  }

  const failed: string[] = [];
  for (const [name, value] of Object.entries(params)) {
    const ok = await setInputValue(name, value);
    if (!ok) failed.push(name);
    await sleep(100);
  }

  // Commit via Ok so TradingView definitively applies the new inputs
  // (closes the dialog; callers reopen it on the next run).
  const committed = await commitSettingsDialog();
  await sleep(300);

  if (!committed) {
    throw new Error(
      'TradingView settings could not be confirmed because the Ok/Apply button was not found. No optimization result was recorded.'
    );
  }

  return failed;
}

/**
 * Apply multiple parameters at once.
 * Opens the strategy settings dialog, sets each value, then closes (applies).
 */
async function handleApplyParameters(parameters: Record<string, number | string | boolean>): Promise<void> {
  console.log('[RQ Extension] Applying parameters:', parameters);

  // Open settings dialog (same approach as optimization runs)
  const dialog = await openSettingsDialogForOptimization();
  if (!dialog) {
    console.error('[RQ Extension] Could not open settings dialog to apply parameters');
    return;
  }

  for (const [name, value] of Object.entries(parameters)) {
    const ok = await setInputValue(name, value);
    if (!ok) console.warn(`[RQ Extension] applyParameters: "${name}" did not apply`);
    await sleep(100);
  }

  // Commit via Ok so TradingView definitively applies the new inputs
  // (X-close can act as Cancel and discard them)
  const committed = await commitSettingsDialog();
  await sleep(500);

  if (!committed) {
    console.error('[RQ Extension] Parameters were not applied because the settings dialog could not be confirmed');
    return;
  }

  // Wait for backtest to recalculate
  await waitForBacktestUpdate();
  console.log('[RQ Extension] Parameters applied successfully');
}

/**
 * Check for and click the "Update Report" button if it exists
 */
async function clickUpdateReportIfNeeded(): Promise<boolean> {
  // Look for update report button with various selectors
  const updateButtonSelectors = [
    '[class*="updateButton"]',
    'button[class*="update"]',
    '[data-name="update-report"]',
    'button[class*="recalculate"]',
    '[class*="recalcButton"]',
  ];

  for (const selector of updateButtonSelectors) {
    const btn = document.querySelector(selector);
    if (btn && isElementVisible(btn)) {
      console.log('[RQ Extension] Found Update Report button with selector:', selector);
      (btn as HTMLElement).click();
      await sleep(500);
      return true;
    }
  }

  // Also search by button text content
  const allButtons = document.querySelectorAll('button');
  for (const btn of allButtons) {
    const text = btn.textContent?.toLowerCase().trim() || '';
    if ((text.includes('update') && text.includes('report')) ||
        text.includes('recalculate') ||
        text === 'update') {
      if (isElementVisible(btn)) {
        console.log('[RQ Extension] Found Update Report button by text:', text);
        (btn as HTMLElement).click();
        await sleep(500);
        return true;
      }
    }
  }

  return false;
}

/**
 * Wait for backtest to recalculate after changing parameters
 */
async function waitForBacktestUpdate(timeout = 10000): Promise<void> {
  const startTime = Date.now();

  // Dismiss any warning popups (e.g. Deep Backtesting caution) that may block interaction
  dismissWarningPopupsOnce();

  // First, check if there's an "Update Report" button that needs to be clicked
  const clickedUpdate = await clickUpdateReportIfNeeded();
  if (clickedUpdate) {
    console.log('[RQ Extension] Clicked Update Report button, waiting for recalculation...');
  }

  // Wait for any loading indicator to appear then disappear
  await sleep(500); // Give TV time to start recalculating

  while (Date.now() - startTime < timeout) {
    // Check again for update button (it might appear after initial changes)
    await clickUpdateReportIfNeeded();

    const loading = document.querySelector('[class*="loading"]');
    if (!loading || !isElementVisible(loading)) {
      // Additional wait to ensure data is fully updated
      await sleep(300);
      return;
    }
    await sleep(100);
  }
}


/**
 * Generate all parameter combinations for grid search
 */
function generateParameterCombinations(
  parameters: OptimizationConfig['parameters'],
  maxRuns: number
): Record<string, number | string | boolean>[] {
  const combinations: Record<string, number | string | boolean>[] = [];

  // Recursive function to generate combinations
  function generate(index: number, current: Record<string, number | string | boolean>): void {
    if (combinations.length >= maxRuns) return;

    if (index >= parameters.length) {
      combinations.push({ ...current });
      return;
    }

    const param = parameters[index];
    let values: (number | string | boolean)[];

    if (param.type === 'dropdown') {
      values = param.selectedOptions;
    } else if (param.type === 'boolean') {
      values = [true, false];
    } else {
      // numeric (default for backwards compatibility with params without type)
      const numParam = param as { min: number; max: number; step: number; name: string };
      values = [];
      for (let v = numParam.min; v <= numParam.max; v += numParam.step) {
        values.push(Math.round(v * 1e10) / 1e10);
      }
    }

    for (const value of values) {
      if (combinations.length >= maxRuns) break;
      current[param.name] = value;
      generate(index + 1, current);
    }
  }

  generate(0, {});
  return combinations;
}

// ============================================================================
// Date Range Manipulation for Walk-Forward
// ============================================================================

/**
 * Get the current date range from TradingView's date picker
 */
async function getCurrentDateRange(): Promise<{ start: string; end: string } | null> {
  // Find the date range button and read its text content
  const dateRangeBtn = document.querySelector('.dateRangeMenuWrapper-rQLA_iPz button') ||
    document.querySelector('[class*="dateRangeMenuWrapper"] button');

  if (!dateRangeBtn) {
    console.log('[RQ Extension] Date range button not found');
    return null;
  }

  // Use innerText to avoid duplicated text from nested elements
  const text = (dateRangeBtn as HTMLElement).innerText?.trim() || dateRangeBtn.textContent?.trim() || '';
  // Format: "Jan 3, 2022 — Dec 22, 2025"
  const parts = text.split(/[—–-]/).map(d => d.trim()).filter(Boolean);

  if (parts.length !== 2) {
    console.log('[RQ Extension] Could not parse date range:', text);
    return null;
  }

  return { start: parts[0], end: parts[1] };
}

/**
 * Set the backtest date range in TradingView
 * @param startDate Date in YYYY-MM-DD format
 * @param endDate Date in YYYY-MM-DD format
 */
async function setBacktestDateRange(startDate: string, endDate: string): Promise<boolean> {
  console.log(`[RQ Extension] ========== Setting date range: ${startDate} to ${endDate} ==========`);

  // First, try using debugger API (more reliable for React inputs)
  console.log('[RQ Extension] Trying debugger API method first...');
  try {
    const debuggerResult = await chrome.runtime.sendMessage({
      type: 'SET_DATE_RANGE_VIA_DEBUGGER',
      startDate,
      endDate,
    });
    if (debuggerResult?.success) {
      console.log('[RQ Extension] Date range set successfully via debugger API');
      return true;
    }
    console.log('[RQ Extension] Debugger API method failed, falling back to DOM manipulation');
  } catch (err) {
    console.warn('[RQ Extension] Debugger API error:', err);
  }

  // Fallback: DOM manipulation with retry logic - try up to 3 times
  for (let attempt = 1; attempt <= 3; attempt++) {
    console.log(`[RQ Extension] DOM Attempt ${attempt}/3`);

    try {
      // 1. Click date range button to open the menu
      const dateRangeBtn = document.querySelector('.dateRangeMenuWrapper-rQLA_iPz button') ||
        document.querySelector('[class*="dateRangeMenuWrapper"] button');

      if (!dateRangeBtn) {
        console.error('[RQ Extension] Date range button not found');
        continue;
      }

      console.log('[RQ Extension] Clicking date range button');
      (dateRangeBtn as HTMLElement).click();
      await sleep(1000); // Increased wait

      // 2. Click "Custom date range..." option - it has an ellipsis character
      let customOption = document.querySelector('[aria-label="Custom date range…"]') ||
        document.querySelector('[aria-label="Custom date range..."]') ||
        document.querySelector('[data-value="custom"]');

      // Also try by text content
      if (!customOption) {
        const menuItems = document.querySelectorAll('[class*="item-"], [class*="menuItem"], [role="menuitem"], [class*="dropdown"] [class*="item"]');
        console.log('[RQ Extension] Looking for custom option among', menuItems.length, 'menu items');
        for (const item of menuItems) {
          const text = item.textContent?.toLowerCase() || '';
          if (text.includes('custom')) {
            customOption = item;
            console.log('[RQ Extension] Found custom option by text:', text.substring(0, 30));
            break;
          }
        }
      }

      if (!customOption) {
        console.error('[RQ Extension] Custom date range option not found');
        // Close the menu by pressing Escape
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await sleep(300);
        continue;
      }

      console.log('[RQ Extension] Clicking custom date range option');
      (customOption as HTMLElement).click();
      await sleep(1000); // Increased wait

      // 3. Find the date inputs in the custom date range dialog
      let dateInputs = document.querySelectorAll('input[inputmode="numeric"][data-qa-id="ui-lib-Input-input"]');

      if (dateInputs.length < 2) {
        dateInputs = document.querySelectorAll('input[data-qa-id="ui-lib-Input-input"]');
      }

      if (dateInputs.length < 2) {
        // Try finding within a dialog/popup
        const popup = document.querySelector('[class*="popup-"], [class*="dialog-"], [class*="menuWrap"]');
        if (popup) {
          dateInputs = popup.querySelectorAll('input');
        }
      }

      console.log('[RQ Extension] Found', dateInputs.length, 'date inputs');

      if (dateInputs.length < 2) {
        console.error('[RQ Extension] Date inputs not found');
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await sleep(300);
        continue;
      }

      // The inputs should be in order: start date, end date
      const startInput = dateInputs[0] as HTMLInputElement;
      const endInput = dateInputs[1] as HTMLInputElement;

      const currentStart = startInput.value;
      const currentEnd = endInput.value;
      console.log('[RQ Extension] BEFORE - Start:', currentStart, 'End:', currentEnd);

      // Determine the order to set dates to avoid TradingView validation issues:
      // - If new start >= current end, we must set END first to expand the range
      // - Otherwise set START first
      const shouldSetEndFirst = startDate >= currentEnd;
      console.log('[RQ Extension] Setting order:', shouldSetEndFirst ? 'END first, then START' : 'START first, then END');

      if (shouldSetEndFirst) {
        // Set END date first (expand range forward)
        console.log('[RQ Extension] Setting end date to:', endDate);
        await setDateInputValue(endInput, endDate);
        await sleep(500);
        console.log('[RQ Extension] End input after setting:', endInput.value);

        // Then set START date
        console.log('[RQ Extension] Setting start date to:', startDate);
        await setDateInputValue(startInput, startDate);
        await sleep(500);
        console.log('[RQ Extension] Start input after setting:', startInput.value);
      } else {
        // Set START date first
        console.log('[RQ Extension] Setting start date to:', startDate);
        await setDateInputValue(startInput, startDate);
        await sleep(500);
        console.log('[RQ Extension] Start input after setting:', startInput.value);

        // Then set END date
        console.log('[RQ Extension] Setting end date to:', endDate);
        await setDateInputValue(endInput, endDate);
        await sleep(500);
        console.log('[RQ Extension] End input after setting:', endInput.value);
      }

      // Double-check and retry if needed
      await sleep(300); // Extra wait for TV async validation

      // Re-read values (DOM might have been updated by React)
      const finalStart = startInput.value;
      const finalEnd = endInput.value;

      // If values are wrong, try setting them one more time
      if (finalStart !== startDate) {
        console.log('[RQ Extension] Start date needs retry, setting again...');
        await setDateInputValue(startInput, startDate);
        await sleep(300);
      }
      if (finalEnd !== endDate) {
        console.log('[RQ Extension] End date needs retry, setting again...');
        await setDateInputValue(endInput, endDate);
        await sleep(300);
      }

      console.log('[RQ Extension] AFTER - Start:', startInput.value, 'End:', endInput.value);

      // Verify values were actually set - check both possible orders (TV might swap them)
      const actualStart = startInput.value;
      const actualEnd = endInput.value;

      // Accept if values match in either order (TV might display them differently)
      const valuesCorrect = (actualStart === startDate && actualEnd === endDate);
      const valuesSwapped = (actualStart === endDate && actualEnd === startDate);

      if (!valuesCorrect && !valuesSwapped) {
        console.error('[RQ Extension] Date values not set correctly! Expected:', startDate, endDate, 'Got:', actualStart, actualEnd);
        // Try again
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await sleep(300);
        continue;
      }

      if (valuesSwapped) {
        console.warn('[RQ Extension] Dates were swapped by TV, but values are correct');
      }

      // Wait for TradingView's async validation to complete
      await sleep(500);

      // 6. Click Apply/OK button
      let applyBtn = document.querySelector('button[data-name="apply-button"]') ||
        document.querySelector('button[name="submit"]');

      if (!applyBtn) {
        const allButtons = document.querySelectorAll('button');
        for (const btn of allButtons) {
          const text = btn.textContent?.toLowerCase().trim() || '';
          if (text === 'select' || text === 'apply' || text === 'ok' || text === 'go') {
            applyBtn = btn;
            break;
          }
        }
      }

      if (!applyBtn) {
        console.error('[RQ Extension] Apply button not found');
        continue;
      }

      const applyBtnEl = applyBtn as HTMLButtonElement;
      console.log('[RQ Extension] Apply button found:', applyBtnEl.textContent?.trim(), 'disabled:', applyBtnEl.disabled);

      // Check if the button is disabled
      if (applyBtnEl.disabled) {
        console.warn('[RQ Extension] Select button is DISABLED - TradingView validation failed!');
        console.warn('[RQ Extension] This may mean the dates are outside available data range for this symbol');

        // Try to re-focus inputs and trigger validation
        startInput.focus();
        startInput.dispatchEvent(new Event('blur', { bubbles: true }));
        await sleep(200);
        endInput.focus();
        endInput.dispatchEvent(new Event('blur', { bubbles: true }));
        await sleep(500);

        // Check again if button is enabled
        if (applyBtnEl.disabled) {
          console.error('[RQ Extension] Button still disabled after retry - dates may be invalid for this symbol');
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          await sleep(300);
          continue;
        }
      }

      console.log('[RQ Extension] Clicking apply button:', applyBtnEl.textContent?.trim());

      // Focus the button and use multiple methods to ensure the click registers
      applyBtnEl.focus();
      await sleep(100);

      // Try click first
      applyBtnEl.click();
      await sleep(300);

      // Also dispatch mousedown/mouseup events (more reliable for some React buttons)
      applyBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      await sleep(50);
      applyBtn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
      await sleep(50);
      applyBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await sleep(300);

      // Also try pressing Enter on the button
      applyBtn.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
      applyBtn.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));

      await sleep(1500); // Wait for dialog to close and chart to update

      // Verify the dialog closed (if date inputs are still visible, apply didn't work)
      const dialogStillOpen = document.querySelector('input[inputmode="numeric"][data-qa-id="ui-lib-Input-input"]');
      if (dialogStillOpen) {
        console.warn('[RQ Extension] Dialog still open after clicking Apply - trying Enter key on inputs');
        // Try pressing Enter on the last input
        (dialogStillOpen as HTMLInputElement).focus();
        dialogStillOpen.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
        await sleep(500);
      }

      // 7. Wait for backtest to recalculate
      await waitForBacktestUpdate(15000);

      // 8. Verify the date range was actually applied by checking the button text
      const dateRangeBtnAfter = document.querySelector('.dateRangeMenuWrapper-rQLA_iPz button') ||
        document.querySelector('[class*="dateRangeMenuWrapper"] button');
      if (dateRangeBtnAfter) {
        const btnText = (dateRangeBtnAfter as HTMLElement).textContent?.trim() || '';
        console.log('[RQ Extension] Date range button after apply:', btnText);

        // Check if the button text contains our dates (in various formats)
        const startYMD = startDate; // 2025-01-01
        const endYMD = endDate;     // 2026-01-30
        const startParts = startDate.split('-');
        const endParts = endDate.split('-');
        const startDMY = `${startParts[2]}.${startParts[1]}.${startParts[0]}`; // 01.01.2025
        const endDMY = `${endParts[2]}.${endParts[1]}.${endParts[0]}`;         // 30.01.2026

        if (btnText.includes(startYMD) || btnText.includes(startDMY) ||
            btnText.includes(endYMD) || btnText.includes(endDMY)) {
          console.log('[RQ Extension] ========== Date range verified and set successfully ==========');
        } else {
          console.warn('[RQ Extension] Date range button text does not contain expected dates!');
          console.warn('[RQ Extension] Expected:', startDate, 'to', endDate, '| Button shows:', btnText);
        }
      }

      console.log('[RQ Extension] ========== Date range set successfully ==========');
      return true;

    } catch (error) {
      console.error('[RQ Extension] Error setting date range (attempt', attempt, '):', error);
      await sleep(500);
    }
  }

  console.error('[RQ Extension] Failed to set date range after 3 attempts');
  return false;
}

/**
 * Set date input value with proper event dispatching for TradingView's React inputs
 */
async function setDateInputValue(input: HTMLInputElement, dateValue: string): Promise<void> {
  console.log('[RQ Extension] setDateInputValue: setting', input.placeholder || 'input', 'to', dateValue);

  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;

  // Method 1: Try using execCommand (works for some React inputs)
  input.focus();
  await sleep(100);
  input.select();
  await sleep(50);

  // Try execCommand first - this often works better for React inputs
  const execResult = document.execCommand('insertText', false, dateValue);
  console.log('[RQ Extension] execCommand result:', execResult, 'input value:', input.value);

  if (input.value === dateValue) {
    // Success! Dispatch change event and blur
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new Event('blur', { bubbles: true }));
    await sleep(300);
    return;
  }

  // Method 2: Native setter with comprehensive events
  console.log('[RQ Extension] Trying native setter method...');
  input.focus();
  await sleep(100);

  // Clear the input
  if (nativeInputValueSetter) {
    nativeInputValueSetter.call(input, '');
  } else {
    input.value = '';
  }
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(50);

  // Set the full value at once
  if (nativeInputValueSetter) {
    nativeInputValueSetter.call(input, dateValue);
  } else {
    input.value = dateValue;
  }

  // Dispatch all the events React might be listening to
  input.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, data: dateValue, inputType: 'insertText' }));
  input.dispatchEvent(new Event('change', { bubbles: true }));

  // Simulate blur/focus cycle to trigger validation
  input.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
  await sleep(100);
  input.dispatchEvent(new FocusEvent('focus', { bubbles: true }));
  await sleep(50);
  input.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
  await sleep(200);

  console.log('[RQ Extension] After native setter: input value =', input.value);

  if (input.value === dateValue) {
    return;
  }

  // Method 3: Type character by character (fallback)
  console.log('[RQ Extension] Trying character-by-character method...');
  input.focus();
  await sleep(100);

  // Select all and delete
  input.select();
  await sleep(50);
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', code: 'Delete', bubbles: true }));
  input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Delete', code: 'Delete', bubbles: true }));
  if (nativeInputValueSetter) {
    nativeInputValueSetter.call(input, '');
  }
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(50);

  // Type each character
  for (let i = 0; i < dateValue.length; i++) {
    const char = dateValue[i];
    const keyCode = char === '-' ? 189 : char.charCodeAt(0);

    input.dispatchEvent(new KeyboardEvent('keydown', {
      key: char,
      code: char === '-' ? 'Minus' : `Digit${char}`,
      keyCode: keyCode,
      which: keyCode,
      bubbles: true,
      cancelable: true,
    }));

    // Update value
    const newValue = dateValue.substring(0, i + 1);
    if (nativeInputValueSetter) {
      nativeInputValueSetter.call(input, newValue);
    } else {
      input.value = newValue;
    }

    input.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      cancelable: true,
      data: char,
      inputType: 'insertText',
    }));

    input.dispatchEvent(new KeyboardEvent('keyup', {
      key: char,
      code: char === '-' ? 'Minus' : `Digit${char}`,
      keyCode: keyCode,
      which: keyCode,
      bubbles: true,
    }));

    await sleep(30);
  }

  // Final events
  input.dispatchEvent(new Event('change', { bubbles: true }));
  await sleep(100);

  // Press Tab to move to next field (triggers validation)
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', code: 'Tab', bubbles: true }));
  input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Tab', code: 'Tab', bubbles: true }));
  await sleep(200);

  console.log('[RQ Extension] Final input value:', input.value);
}

/**
 * Calculate overfitting score based on IS vs OOS performance
 * Returns a score between 0 and 1 where higher is better (less overfit)
 */
function calculateOverfittingScore(
  isMetrics: OptimizationMetrics,
  oosMetrics: OptimizationMetrics
): number {
  // Calculate ratio of key metrics (OOS/IS)
  // We want OOS performance to be similar to IS performance

  const ratios: number[] = [];

  // Net profit ratio (if positive)
  if (isMetrics.netProfitPercent > 0 && oosMetrics.netProfitPercent > 0) {
    ratios.push(Math.min(1, oosMetrics.netProfitPercent / isMetrics.netProfitPercent));
  } else if (isMetrics.netProfitPercent > 0) {
    // OOS is negative while IS was positive - bad sign
    ratios.push(0);
  }

  // Sharpe ratio
  if (isMetrics.sharpeRatio > 0 && oosMetrics.sharpeRatio > 0) {
    ratios.push(Math.min(1, oosMetrics.sharpeRatio / isMetrics.sharpeRatio));
  } else if (isMetrics.sharpeRatio > 0) {
    ratios.push(0);
  }

  // Profit factor
  if (isMetrics.profitFactor > 1 && oosMetrics.profitFactor > 1) {
    ratios.push(Math.min(1, oosMetrics.profitFactor / isMetrics.profitFactor));
  } else if (isMetrics.profitFactor > 1) {
    ratios.push(oosMetrics.profitFactor > 0.5 ? 0.3 : 0);
  }

  // Win rate
  if (isMetrics.winRate > 0) {
    ratios.push(Math.min(1, oosMetrics.winRate / isMetrics.winRate));
  }

  // Average all ratios
  if (ratios.length === 0) return 0;
  const avgRatio = ratios.reduce((sum, r) => sum + r, 0) / ratios.length;

  return Math.max(0, Math.min(1, avgRatio));
}

/**
 * Calculate standard deviation of an array of numbers
 */
function calculateStdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const squaredDiffs = values.map(v => Math.pow(v - mean, 2));
  const variance = squaredDiffs.reduce((a, b) => a + b, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

/**
 * Main optimization handler - supports both standard and walk-forward modes
 */
async function handleStartOptimization(
  requestId: string,
  config: OptimizationConfig,
  strategyName?: string
): Promise<void> {
  console.log('[RQ Extension] Starting optimization:', config, 'for strategy:', strategyName);

  state.isOptimizing = true;
  state.optimizationRequestId = requestId;
  state.optimizationCancelled = false;

  const startTime = Date.now();
  const runs: OptimizationRun[] = [];
  let bestRun: OptimizationRun | null = null;
  let walkForwardResult: WalkForwardResult | undefined;
  let optimizationError: string | undefined;

  // Apply backtest context settings (symbol, timeframe, date range) if specified
  try {
    // Change symbol if specified
    if (config.symbol) {
      console.log(`[RQ Extension] Changing symbol to: ${config.symbol}`);
      const symbolResult = await handleChangeSymbol(requestId, config.symbol);
      if (!symbolResult.success) {
        console.warn('[RQ Extension] Failed to change symbol:', symbolResult.error);
      } else {
        await sleep(2000); // Wait for symbol change to take effect
      }
    }

    // Change timeframe if specified
    if (config.timeframe) {
      console.log(`[RQ Extension] Changing timeframe to: ${config.timeframe}`);
      const tfResult = await handleChangeTimeframe(requestId, config.timeframe);
      if (!tfResult.success) {
        console.warn('[RQ Extension] Failed to change timeframe:', tfResult.error);
      } else {
        await sleep(1500); // Wait for timeframe change to take effect
      }
    }

    // Set date range if specified (and walk-forward is not enabled - it uses its own dates)
    if (config.dateRange && !config.walkForward?.enabled) {
      console.log(`[RQ Extension] Setting date range: ${config.dateRange.start} to ${config.dateRange.end}`);
      const dateResult = await setBacktestDateRange(config.dateRange.start, config.dateRange.end);
      if (!dateResult) {
        console.warn('[RQ Extension] Failed to set date range');
      } else {
        await sleep(2000); // Wait for backtest to recalculate
      }
    }
  } catch (error) {
    console.error('[RQ Extension] Error applying backtest context settings:', error);
    // Continue with optimization even if settings fail
  }

  // Extract strategy metadata
  const metadata = extractStrategyMetadata();

  // Generate parameter combinations
  const combinations = generateParameterCombinations(config.parameters, config.maxRuns);
  const symbolCount = config.symbols && config.symbols.length > 0 ? config.symbols.length : 1;
  const tfCount = config.timeframes && config.timeframes.length > 0 ? config.timeframes.length : 1;
  const totalRuns = combinations.length * symbolCount * tfCount;

  console.log(`[RQ Extension] Generated ${combinations.length} combinations × ${symbolCount} symbols × ${tfCount} timeframes = ${totalRuns} total runs`);

  // Store original date range for restoration after walk-forward
  const originalDateRange = await getCurrentDateRange();
  console.log('[RQ Extension] Original date range:', originalDateRange);

  // Check if walk-forward is enabled
  const wfConfig = config.walkForward;
  const isWalkForward = wfConfig?.enabled === true;

  // Rolling walk-forward tracking
  let currentWindowNumber = 0;
  let totalWindowsCount = 0;

  // Send progress update helper
  const sendProgress = (currentRun: number, currentParams: Record<string, number | string | boolean>, phase?: 'is' | 'oos', windowNum?: number, totalWindowNum?: number) => {
    const progress: OptimizationProgress & { walkForwardPhase?: 'is' | 'oos'; currentWindow?: number; totalWindows?: number } = {
      currentRun,
      totalRuns, // Both IS and OOS phases run all combinations
      currentParameters: currentParams,
      bestSoFar: bestRun,
      status: state.optimizationCancelled ? 'cancelled' : 'running',
    };

    if (phase) {
      progress.walkForwardPhase = phase;
    }
    if (windowNum !== undefined) {
      progress.currentWindow = windowNum;
      progress.totalWindows = totalWindowNum;
    }

    // Also update UI directly
    updateProgress(progress);
  };

  // Track when the last successful run completed
  let lastRunCompleteTime = Date.now();
  const STALE_THRESHOLD_MS = 15000; // 15 seconds

  // Helper to check if TV tab is stale and trigger refresh
  const checkAndRefreshStaleTab = async (runNumber: number, phase?: string): Promise<void> => {
    const timeSinceLastRun = Date.now() - lastRunCompleteTime;

    if (timeSinceLastRun > STALE_THRESHOLD_MS) {
      console.log(`[RQ Extension] Run ${runNumber}${phase ? ` (${phase})` : ''} - Tab appears stale (${Math.round(timeSinceLastRun / 1000)}s since last activity). Triggering tab refresh...`);

      try {
        // Request background script to switch tabs to wake up TradingView
        const response = await chrome.runtime.sendMessage({
          type: 'TRIGGER_TAB_REFRESH',
        });
        console.log('[RQ Extension] Tab refresh response:', response);

        // Give TV a moment to wake up after the tab switch
        await sleep(500);

        // Reset the timer after refresh
        lastRunCompleteTime = Date.now();
      } catch (error) {
        console.error('[RQ Extension] Tab refresh failed:', error);
      }
    }
  };

  // Helper to mark a run as complete (resets stale timer)
  const markRunComplete = () => {
    lastRunCompleteTime = Date.now();
  };

  // Open the settings dialog and keep it open during optimization
  const settingsDialog = await openSettingsDialogForOptimization(strategyName);
  if (!settingsDialog) {
    console.error('[RQ Extension] Could not open settings dialog for optimization');
    state.isOptimizing = false;
    return;
  }

  // Trigger tab switch to wake up TradingView before starting optimization
  console.log('[RQ Extension] Triggering tab switch to wake up TradingView before optimization...');
  try {
    await chrome.runtime.sendMessage({ type: 'TRIGGER_TAB_REFRESH' });
    await sleep(10000); // Wait 10 seconds after tab switch
    console.log('[RQ Extension] Tab switch complete, starting optimization');
  } catch (error) {
    console.error('[RQ Extension] Tab refresh failed at start:', error);
  }

  // Track window results for rolling walk-forward
  const windowResults: WindowResult[] = [];
  let rollingWalkForwardResult: RollingWalkForwardResult | undefined;

  try {
    if (isWalkForward && wfConfig) {
      // ================================================================
      // WALK-FORWARD MODE (Single or Rolling)
      // ================================================================
      const wfMode = wfConfig.mode || 'single';
      const isRolling = wfMode === 'rolling' || wfMode === 'anchored';
      const windows: WalkForwardWindow[] = isRolling && wfConfig.windows ? wfConfig.windows : [];

      console.log(`[RQ Extension] Walk-Forward mode: ${wfMode}, windows: ${windows.length}`);

      if (isRolling && windows.length > 0) {
        // ================================================================
        // ROLLING WALK-FORWARD MODE
        // ================================================================
        totalWindowsCount = windows.length;
        console.log(`[RQ Extension] Rolling Walk-Forward: ${windows.length} windows`);

        for (let windowIdx = 0; windowIdx < windows.length; windowIdx++) {
          if (state.optimizationCancelled) {
            console.log('[RQ Extension] Rolling walk-forward cancelled');
            break;
          }

          const window = windows[windowIdx];
          currentWindowNumber = window.windowNumber;
          console.log(`[RQ Extension] Window ${currentWindowNumber}/${windows.length}: IS ${window.isStart}→${window.isEnd}, OOS ${window.oosStart}→${window.oosEnd}`);

          // Trigger tab switch before each window
          try {
            await chrome.runtime.sendMessage({ type: 'TRIGGER_TAB_REFRESH' });
            await sleep(3000);
          } catch (error) {
            console.error('[RQ Extension] Tab refresh failed at window start:', error);
          }

          // Track runs for this window
          const windowRuns: OptimizationRun[] = [];

          // === PHASE 1: In-Sample for this window ===
          await closeSettingsDialog();
          await sleep(300);

          const isDateSet = await setBacktestDateRange(window.isStart, window.isEnd);
          if (!isDateSet) {
            console.error(`[RQ Extension] Failed to set IS date range for window ${currentWindowNumber}`);
          }

          const reopenedDialog = await openSettingsDialogForOptimization(strategyName);
          if (!reopenedDialog) {
            console.error(`[RQ Extension] Could not reopen dialog for window ${currentWindowNumber}`);
            continue;
          }

          // Run all parameter combinations on IS period for this window
          for (let i = 0; i < combinations.length; i++) {
            if (state.optimizationCancelled) break;

            const params = combinations[i];
            const runNumber = i + 1;

            await checkAndRefreshStaleTab(runNumber, `W${currentWindowNumber}-IS`);

            console.log(`[RQ Extension] Window ${currentWindowNumber} IS Run ${runNumber}/${totalRuns}:`, params);
            sendProgress(runNumber, params, 'is', currentWindowNumber, totalWindowsCount);

            const runStart = Date.now();

            // Apply parameters (set + verify + commit via Ok)
            {
              const failedParams = await applyParameterSet(params, strategyName);
              if (failedParams.length > 0) {
                throw new Error(
                  `Could not apply parameter(s): ${failedParams.join(', ')} ` +
                  `(window ${currentWindowNumber} IS run ${runNumber}). Aborting to avoid recording stale results.`
                );
              }
            }
            await sleep(500);
            await waitForBacktestUpdate();
            await sleep(config.delayBetweenRuns);

            // Extract IS trades
            let isTrades: BacktestTrade[] = [];
            try {
              const csvResult = await extractTradesViaCSV();
              isTrades = csvResult.trades;
            } catch (err) {
              console.warn(`[RQ Extension] Failed to extract IS trades W${currentWindowNumber} run ${runNumber}:`, err);
            }

            const isMetrics = calculateMetricsFromTrades(isTrades);

            const run: OptimizationRun = {
              runNumber,
              parameters: params,
              metrics: isMetrics,
              inSampleMetrics: isMetrics,
              trades: isTrades,
              inSampleTrades: isTrades,
              timestamp: new Date().toISOString(),
              duration: Date.now() - runStart,
              windowNumber: currentWindowNumber,
            };

            windowRuns.push(run);
            runs.push(run);
            addRun(run);

            if (!bestRun || isBetterRun(run, bestRun, config.optimizationGoal)) {
              bestRun = run;
            }

            markRunComplete();
          }

          // === PHASE 2: Out-of-Sample for this window ===
          if (windowRuns.length > 0 && !state.optimizationCancelled) {
            console.log(`[RQ Extension] Window ${currentWindowNumber} OOS phase: ${window.oosStart}→${window.oosEnd}`);

            try {
              await chrome.runtime.sendMessage({ type: 'TRIGGER_TAB_REFRESH' });
              await sleep(3000);
            } catch (error) {
              console.error('[RQ Extension] Tab refresh failed at OOS start:', error);
            }

            await closeSettingsDialog();
            await sleep(300);

            const oosDateSet = await setBacktestDateRange(window.oosStart, window.oosEnd);
            if (!oosDateSet) {
              console.error(`[RQ Extension] Failed to set OOS date range for window ${currentWindowNumber}`);
            }

            // Run ALL combinations on OOS for this window
            for (let i = 0; i < windowRuns.length; i++) {
              if (state.optimizationCancelled) break;

              const run = windowRuns[i];
              const params = run.parameters;

              await checkAndRefreshStaleTab(i + 1, `W${currentWindowNumber}-OOS`);

              console.log(`[RQ Extension] Window ${currentWindowNumber} OOS Run ${i + 1}/${windowRuns.length}:`, params);
              sendProgress(i + 1, params, 'oos', currentWindowNumber, totalWindowsCount);

              // Apply parameters (set + verify + commit via Ok)
              {
                const failedParams = await applyParameterSet(params, strategyName);
                if (failedParams.length > 0) {
                  throw new Error(
                    `Could not apply parameter(s): ${failedParams.join(', ')} ` +
                    `(window ${currentWindowNumber} OOS run ${i + 1}). Aborting to avoid recording stale results.`
                  );
                }
              }
              await sleep(500);
              await waitForBacktestUpdate();
              await sleep(config.delayBetweenRuns);

              try {
                const csvResult = await extractTradesViaCSV();
                run.outOfSampleTrades = csvResult.trades;
              } catch (err) {
                console.warn(`[RQ Extension] Failed to extract OOS trades W${currentWindowNumber} run ${i + 1}:`, err);
              }

              const oosMetrics = calculateMetricsFromTrades(run.outOfSampleTrades || []);
              run.outOfSampleMetrics = oosMetrics;

              markRunComplete();
            }

            // Find best run for this window and calculate window result
            let bestWindowRun = windowRuns[0];
            for (const run of windowRuns) {
              if (run.outOfSampleMetrics && isBetterRun(run, bestWindowRun, config.optimizationGoal)) {
                bestWindowRun = run;
              }
            }

            if (bestWindowRun && bestWindowRun.inSampleMetrics && bestWindowRun.outOfSampleMetrics) {
              const isProfit = bestWindowRun.inSampleMetrics.netProfitPercent;
              const oosProfit = bestWindowRun.outOfSampleMetrics.netProfitPercent;
              const overfitScore = calculateOverfittingScore(bestWindowRun.inSampleMetrics, bestWindowRun.outOfSampleMetrics);

              windowResults.push({
                windowNumber: currentWindowNumber,
                window,
                bestRunParams: bestWindowRun.parameters,
                isMetrics: bestWindowRun.inSampleMetrics,
                oosMetrics: bestWindowRun.outOfSampleMetrics,
                overfittingScore: overfitScore,
                isRobust: overfitScore >= 0.7,
              });

              console.log(`[RQ Extension] Window ${currentWindowNumber} complete: IS ${isProfit.toFixed(2)}%, OOS ${oosProfit.toFixed(2)}%, Overfit ${overfitScore.toFixed(2)}`);
            }
          }
        }

        // Calculate aggregated rolling walk-forward result
        if (windowResults.length > 0) {
          const oosReturns = windowResults.map(w => w.oosMetrics.netProfitPercent);
          const avgOosReturn = oosReturns.reduce((a, b) => a + b, 0) / oosReturns.length;
          const consistencyStdDev = calculateStdDev(oosReturns);
          const avgOverfitScore = windowResults.reduce((a, b) => a + b.overfittingScore, 0) / windowResults.length;
          const passedWindows = windowResults.filter(w => w.isRobust).length;

          rollingWalkForwardResult = {
            windows,
            windowResults,
            aggregatedScore: avgOosReturn,
            consistencyScore: consistencyStdDev,
            avgOverfittingScore: avgOverfitScore,
            windowsPassed: passedWindows,
            totalWindows: windowResults.length,
            isRobust: passedWindows >= windowResults.length * 0.6 && avgOverfitScore >= 0.6,
          };

          console.log(`[RQ Extension] Rolling WF complete: ${passedWindows}/${windowResults.length} windows passed, avg OOS ${avgOosReturn.toFixed(2)}%`);
        }

      } else {
        // ================================================================
        // SINGLE WALK-FORWARD MODE (original behavior)
        // ================================================================
        console.log('[RQ Extension] Single Walk-Forward mode');

        // PHASE 1: In-Sample Optimization
        console.log('[RQ Extension] Phase 1: In-Sample period', wfConfig.inSampleStart, 'to', wfConfig.inSampleEnd);

        // Close settings dialog temporarily to set date range
        await closeSettingsDialog();
        await sleep(300);

        // Set date range to In-Sample period
        const isDateSet = await setBacktestDateRange(wfConfig.inSampleStart!, wfConfig.inSampleEnd!);
        if (!isDateSet) {
          console.error('[RQ Extension] Failed to set In-Sample date range');
          // Continue anyway - user may have already set the dates
        }

        // Reopen settings dialog for parameter optimization
        const reopenedDialog = await openSettingsDialogForOptimization(strategyName);
        if (!reopenedDialog) {
          console.error('[RQ Extension] Could not reopen settings dialog after setting IS dates');
          state.isOptimizing = false;
          return;
        }

        // Run all parameter combinations on IS period
        for (let i = 0; i < combinations.length; i++) {
          if (state.optimizationCancelled) {
            console.log('[RQ Extension] Optimization cancelled');
            break;
          }

          const params = combinations[i];
          const runNumber = i + 1;

          // Check if TV tab is stale and trigger refresh if needed
          await checkAndRefreshStaleTab(runNumber, 'IS');

          console.log(`[RQ Extension] IS Run ${runNumber}/${totalRuns}:`, params);
          sendProgress(runNumber, params, 'is');

          const runStart = Date.now();

          // Apply parameters (set + verify + commit via Ok)
          {
            const failedParams = await applyParameterSet(params, strategyName);
            if (failedParams.length > 0) {
              throw new Error(
                `Could not apply parameter(s): ${failedParams.join(', ')} ` +
                `(IS run ${runNumber}). Aborting to avoid recording stale results.`
              );
            }
          }
          await sleep(500);

          // Wait for backtest to update (this will click Update Report if needed)
          await waitForBacktestUpdate();
          await sleep(config.delayBetweenRuns);

        // Extract full trade data for this run via CSV
        let isTrades: BacktestTrade[] = [];
        try {
          console.log(`[RQ Extension] Extracting trades via CSV for IS run ${runNumber}...`);
          const csvResult = await extractTradesViaCSV();
          isTrades = csvResult.trades;
          console.log(`[RQ Extension] IS run ${runNumber}: extracted ${isTrades.length} trades`);
        } catch (err) {
          console.warn('[RQ Extension] Failed to extract trades for IS run:', err);
        }

        // Calculate metrics from trades (not from TV UI)
        const isMetrics = calculateMetricsFromTrades(isTrades);
        console.log(`[RQ Extension] IS run ${runNumber} metrics from trades:`, {
          netProfitPercent: isMetrics.netProfitPercent.toFixed(2),
          winRate: isMetrics.winRate.toFixed(1),
          profitFactor: isMetrics.profitFactor.toFixed(2),
          trades: isMetrics.totalTrades,
        });

        const run: OptimizationRun = {
          runNumber,
          parameters: params,
          metrics: isMetrics, // Default metrics are IS metrics
          inSampleMetrics: isMetrics,
          trades: isTrades,
          inSampleTrades: isTrades,
          timestamp: new Date().toISOString(),
          duration: Date.now() - runStart,
        };

        runs.push(run);
        addRun(run);

        // Update best run based on IS metrics
        if (!bestRun || isBetterRun(run, bestRun, config.optimizationGoal)) {
          bestRun = run;
        }

        // Mark this run as complete (resets stale timer)
        markRunComplete();
      }

      // PHASE 2: Out-of-Sample - Run ALL combinations
      if (runs.length > 0 && !state.optimizationCancelled) {
        console.log('[RQ Extension] Phase 2: Out-of-Sample - running ALL combinations');

        // Trigger tab switch to wake up TradingView before OOS phase
        console.log('[RQ Extension] Triggering tab switch to wake up TradingView before OOS phase...');
        try {
          await chrome.runtime.sendMessage({ type: 'TRIGGER_TAB_REFRESH' });
          await sleep(10000); // Wait 10 seconds after tab switch
          console.log('[RQ Extension] Tab switch complete, starting OOS phase');
        } catch (error) {
          console.error('[RQ Extension] Tab refresh failed at OOS start:', error);
        }

        // Close settings dialog to change date range
        await closeSettingsDialog();
        await sleep(300);

        // Set date range to Out-of-Sample period
        const oosDateSet = await setBacktestDateRange(wfConfig.outOfSampleStart!, wfConfig.outOfSampleEnd!);
        if (!oosDateSet) {
          console.error('[RQ Extension] Failed to set Out-of-Sample date range');
        }

        // Run ALL combinations on OOS period
        for (let i = 0; i < runs.length; i++) {
          if (state.optimizationCancelled) {
            console.log('[RQ Extension] Optimization cancelled during OOS phase');
            break;
          }

          const run = runs[i];
          const params = run.parameters;

          // Check if TV tab is stale and trigger refresh if needed
          await checkAndRefreshStaleTab(i + 1, 'OOS');

          console.log(`[RQ Extension] OOS Run ${i + 1}/${runs.length}:`, params);
          sendProgress(i + 1, params, 'oos');

          // Apply parameters (set + verify + commit via Ok)
          {
            const failedParams = await applyParameterSet(params, strategyName);
            if (failedParams.length > 0) {
              throw new Error(
                `Could not apply parameter(s): ${failedParams.join(', ')} ` +
                `(OOS run ${i + 1}). Aborting to avoid recording stale results.`
              );
            }
          }
          await sleep(500);

          // Wait for OOS backtest to complete (this will click Update Report if needed)
          await waitForBacktestUpdate();
          await sleep(config.delayBetweenRuns);

          // Extract full trade data for OOS via CSV
          try {
            console.log(`[RQ Extension] Extracting trades via CSV for OOS run ${i + 1}...`);
            const csvResult = await extractTradesViaCSV();
            run.outOfSampleTrades = csvResult.trades;
            console.log(`[RQ Extension] OOS run ${i + 1}: extracted ${run.outOfSampleTrades.length} trades`);
          } catch (err) {
            console.warn('[RQ Extension] Failed to extract trades for OOS run:', err);
          }

          // Calculate OOS metrics from trades (not from TV UI)
          const oosMetrics = calculateMetricsFromTrades(run.outOfSampleTrades || []);
          run.outOfSampleMetrics = oosMetrics;
          console.log(`[RQ Extension] OOS run ${i + 1} metrics from trades:`, {
            netProfitPercent: oosMetrics.netProfitPercent.toFixed(2),
            winRate: oosMetrics.winRate.toFixed(1),
            profitFactor: oosMetrics.profitFactor.toFixed(2),
            trades: oosMetrics.totalTrades,
          });

          // Calculate overfitting score for this run
          const isMetrics = run.inSampleMetrics || run.metrics;
          const runOverfitScore = calculateOverfittingScore(isMetrics, oosMetrics);
          console.log(`[RQ Extension] Run ${run.runNumber} overfitting score:`, runOverfitScore.toFixed(2));

          // Mark this run as complete (resets stale timer)
          markRunComplete();
        }

        // Find the best run considering BOTH IS and OOS performance
        // Use a combined score: avg of IS metric and OOS metric (weighted towards OOS for robustness)
        let bestCombinedRun: OptimizationRun | null = null;
        let bestCombinedScore = -Infinity;

        for (const run of runs) {
          if (!run.outOfSampleMetrics) continue;

          const isMetrics = run.inSampleMetrics || run.metrics;
          const oosMetrics = run.outOfSampleMetrics;

          // Get the optimization goal metric from both periods
          let isValue = isMetrics[config.optimizationGoal as keyof OptimizationMetrics] as number;
          let oosValue = oosMetrics[config.optimizationGoal as keyof OptimizationMetrics] as number;

          // For drawdown, invert (less negative is better)
          if (config.optimizationGoal === 'maxDrawdownPercent') {
            isValue = -Math.abs(isValue);
            oosValue = -Math.abs(oosValue);
          }

          // Combined score: 40% IS + 60% OOS (favor OOS for robustness)
          const combinedScore = isValue * 0.4 + oosValue * 0.6;

          if (combinedScore > bestCombinedScore) {
            bestCombinedScore = combinedScore;
            bestCombinedRun = run;
          }
        }

        // Update bestRun to the one with best combined IS+OOS performance
        if (bestCombinedRun) {
          bestRun = bestCombinedRun;
          console.log('[RQ Extension] Best combined IS+OOS run:', bestRun.runNumber, bestRun.parameters);
        }

        // Calculate final overfitting score for the best run
        if (bestRun && bestRun.outOfSampleMetrics) {
          const isMetrics = bestRun.inSampleMetrics || bestRun.metrics;
          const overfittingScore = calculateOverfittingScore(isMetrics, bestRun.outOfSampleMetrics);

          walkForwardResult = {
            bestRun,
            overfittingScore,
            isRobust: overfittingScore >= 0.7,
            originalDateRange: originalDateRange || undefined,
          };

          console.log('[RQ Extension] Walk-Forward complete. Best run overfitting score:', overfittingScore);
        }
      }
      } // End single walk-forward else

    } else {
      // ================================================================
      // STANDARD MODE (no walk-forward) — with multi-symbol/timeframe support
      // ================================================================
      const symbolsToTest = config.symbols && config.symbols.length > 0 ? config.symbols : [null]; // null = current
      const timeframesToTest = config.timeframes && config.timeframes.length > 0 ? config.timeframes : [null]; // null = current
      let globalRunNumber = 0;

      // Track best by dimension
      const bestBySymbol: Record<string, OptimizationRun> = {};
      const bestByTimeframe: Record<string, OptimizationRun> = {};

      for (const symbol of symbolsToTest) {
        if (state.optimizationCancelled) break;

        // Change symbol if needed
        if (symbol) {
          console.log(`[RQ Extension] Changing symbol to: ${symbol}`);
          await closeSettingsDialog();
          await sleep(300);
          const symResult = await handleChangeSymbol(requestId, symbol);
          if (!symResult.success) {
            console.warn(`[RQ Extension] Failed to change symbol to ${symbol}:`, symResult.error);
            continue;
          }
          await sleep(2000);
          // Re-open settings dialog after symbol change
          const reopened = await openSettingsDialogForOptimization(strategyName);
          if (!reopened) {
            console.error(`[RQ Extension] Could not reopen dialog after symbol change to ${symbol}`);
            continue;
          }
        }

        for (const timeframe of timeframesToTest) {
          if (state.optimizationCancelled) break;

          // Change timeframe if needed
          if (timeframe) {
            console.log(`[RQ Extension] Changing timeframe to: ${timeframe}`);
            await closeSettingsDialog();
            await sleep(300);
            const tfResult = await handleChangeTimeframe(requestId, timeframe);
            if (!tfResult.success) {
              console.warn(`[RQ Extension] Failed to change timeframe to ${timeframe}:`, tfResult.error);
              continue;
            }
            await sleep(1500);
            // Re-open settings dialog after timeframe change
            const reopened = await openSettingsDialogForOptimization(strategyName);
            if (!reopened) {
              console.error(`[RQ Extension] Could not reopen dialog after timeframe change to ${timeframe}`);
              continue;
            }
          }

          // Run all parameter combinations for this symbol/timeframe pair
          for (let i = 0; i < combinations.length; i++) {
            if (state.optimizationCancelled) {
              console.log('[RQ Extension] Optimization cancelled');
              break;
            }

            const params = combinations[i];
            globalRunNumber++;
            const runNumber = globalRunNumber;

            // Check if TV tab is stale and trigger refresh if needed
            await checkAndRefreshStaleTab(runNumber);

            const contextStr = [symbol, timeframe].filter(Boolean).join('/');
            console.log(`[RQ Extension] Run ${runNumber}/${totalRuns}${contextStr ? ` [${contextStr}]` : ''}:`, params);
            sendProgress(runNumber, params);

            const runStart = Date.now();

            // Apply parameters (set + verify + commit via Ok)
            const failedParams = await applyParameterSet(params, strategyName);
            if (failedParams.length > 0) {
              throw new Error(
                `Could not apply parameter(s): ${failedParams.join(', ')}. ` +
                `TradingView did not accept the value — every further run would silently reuse the old inputs. ` +
                `This usually means TradingView changed their settings dialog; please report this so we can update the extension.`
              );
            }

            // Wait for backtest to update
            await waitForBacktestUpdate();
            await sleep(config.delayBetweenRuns);

            // Extract full trade data for this run via CSV
            let trades: BacktestTrade[] = [];
            try {
              console.log(`[RQ Extension] Extracting trades via CSV for run ${runNumber}...`);
              const csvResult = await extractTradesViaCSV();
              trades = csvResult.trades;
              console.log(`[RQ Extension] Run ${runNumber}: extracted ${trades.length} trades`);
            } catch (err) {
              console.warn('[RQ Extension] Failed to extract trades for run:', err);
            }

            // Calculate metrics from trades (not from TV UI)
            const metrics = calculateMetricsFromTrades(trades);
            console.log(`[RQ Extension] Run ${runNumber} metrics from trades:`, {
              netProfitPercent: metrics.netProfitPercent.toFixed(2),
              winRate: metrics.winRate.toFixed(1),
              profitFactor: metrics.profitFactor.toFixed(2),
              trades: metrics.totalTrades,
            });

            const run: OptimizationRun = {
              runNumber,
              parameters: params,
              metrics,
              trades,
              timestamp: new Date().toISOString(),
              duration: Date.now() - runStart,
              symbol: symbol || undefined,
              timeframe: timeframe || undefined,
            };

            runs.push(run);
            addRun(run);

            // Update best run
            if (!bestRun || isBetterRun(run, bestRun, config.optimizationGoal)) {
              bestRun = run;
            }

            // Track best by symbol
            if (symbol) {
              if (!bestBySymbol[symbol] || isBetterRun(run, bestBySymbol[symbol], config.optimizationGoal)) {
                bestBySymbol[symbol] = run;
              }
            }

            // Track best by timeframe
            if (timeframe) {
              if (!bestByTimeframe[timeframe] || isBetterRun(run, bestByTimeframe[timeframe], config.optimizationGoal)) {
                bestByTimeframe[timeframe] = run;
              }
            }

            // Mark this run as complete (resets stale timer)
            markRunComplete();
          }
        }
      }

      // Store dimension bests on the result (will be attached below)
      (state as any)._bestBySymbol = Object.keys(bestBySymbol).length > 0 ? bestBySymbol : undefined;
      (state as any)._bestByTimeframe = Object.keys(bestByTimeframe).length > 0 ? bestByTimeframe : undefined;
    }
  } catch (error) {
    console.error('[RQ Extension] Optimization error:', error);
    optimizationError = error instanceof Error ? error.message : String(error);
  }

  // Surface suspicious runs as a diagnostic only. Identical results can be valid
  // when the tested parameters do not affect the sampled market period, so this
  // must not turn an otherwise verified optimization into a false failure.
  if (!optimizationError && runs.length >= 3) {
    const signatures = runs.map(r => JSON.stringify(r.trades || []));
    const paramKeys = runs.map(r => JSON.stringify(r.parameters));
    const allTradesIdentical = signatures.every(s => s === signatures[0] && s !== '[]');
    const paramsDiffer = new Set(paramKeys).size > 1;
    if (allTradesIdentical && paramsDiffer) {
      console.warn(
        '[RQ Extension] All runs produced identical full trade records despite different parameters. ' +
        'The inputs and dialog confirmation were verified, but review the strategy parameters if this was unexpected.'
      );
    }
  }

  // Build final result
  const result: OptimizationResult = {
    strategyName: metadata.strategyName,
    symbol: metadata.symbol,
    timeframe: metadata.timeframe,
    config,
    runs,
    bestRun,
    bestBySymbol: (state as any)._bestBySymbol,
    bestByTimeframe: (state as any)._bestByTimeframe,
    totalDuration: Date.now() - startTime,
    startedAt: new Date(startTime).toISOString(),
    completedAt: new Date().toISOString(),
    cancelled: state.optimizationCancelled,
    error: optimizationError,
    walkForwardResult,
    rollingWalkForwardResult,
  };

  // Clean up temp state
  delete (state as any)._bestBySymbol;
  delete (state as any)._bestByTimeframe;

  setResult(result);

  state.isOptimizing = false;
  state.optimizationRequestId = null;

  // Close the settings dialog
  await closeSettingsDialog();

  console.log('[RQ Extension] Optimization complete:', result);
}

/**
 * Open settings dialog for optimization (keeps it open)
 * Uses the Strategy Tester dropdown approach to ensure correct strategy is targeted
 */
async function openSettingsDialogForOptimization(targetStrategyName?: string): Promise<Element | null> {
  // Check if already open
  let dialog = document.querySelector('[data-name="indicator-properties-dialog"]') ||
    document.querySelector('[data-dialog-name*="indicator"]') ||
    document.querySelector('[data-dialog-name*="strategy"]') ||
    document.querySelector('[class*="dialog"][class*="content"]');

  if (dialog) {
    console.log('[RQ Extension] Settings dialog already open');
    // Make sure we're on the Inputs tab
    const inputsTab = dialog.querySelector('button[id="Inputs"]') ||
      Array.from(dialog.querySelectorAll('button')).find(b =>
        b.textContent?.toLowerCase().trim() === 'inputs'
      );
    if (inputsTab) {
      (inputsTab as HTMLElement).click();
      await sleep(200);
    }
    return dialog;
  }

  // Helper function for fuzzy strategy name matching
  const fuzzyMatch = (name1: string, name2: string): boolean => {
    const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const n1 = normalize(name1);
    const n2 = normalize(name2);
    // Check if normalized strings match or one contains the other
    if (n1 === n2 || n1.includes(n2) || n2.includes(n1)) return true;
    // Check if they share significant words (at least 2 words in common)
    const words1 = name1.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    const words2 = name2.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    const commonWords = words1.filter(w => words2.some(w2 => w.includes(w2) || w2.includes(w)));
    return commonWords.length >= 2;
  };

  // Use the provided strategy name, or fall back to Strategy Tester title
  const strategyTesterTitle = document.querySelector('[class*="strategyGroup"] [class*="title"]')?.textContent?.trim() ||
    document.querySelector('[data-name="backtesting"] [class*="strategy"]')?.textContent?.trim() ||
    document.querySelector('button[data-strategy-title]')?.getAttribute('data-strategy-title')?.trim();
  const targetName = targetStrategyName || strategyTesterTitle;
  console.log('[RQ Extension] Target strategy for optimization:', targetName, '(provided:', targetStrategyName, ', tester:', strategyTesterTitle, ')');

  // Try to use the Strategy Tester dropdown approach
  // Poll for up to 10 seconds if dropdown not found (strategy may still be loading after injection)
  let strategyDropdown = document.querySelector('button[data-strategy-title]') as HTMLElement;
  if (!strategyDropdown) {
    console.log('[RQ Extension] Strategy Tester dropdown not found, waiting for it to appear...');
    for (let i = 0; i < 20; i++) {
      await sleep(500);
      strategyDropdown = document.querySelector('button[data-strategy-title]') as HTMLElement;
      if (strategyDropdown) {
        console.log('[RQ Extension] Strategy Tester dropdown appeared after', (i + 1) * 500, 'ms');
        break;
      }
    }
  }
  if (strategyDropdown && targetName) {
    const currentStrategy = strategyDropdown.getAttribute('data-strategy-title');
    console.log('[RQ Extension] Current strategy in dropdown:', currentStrategy);

    // Check if target strategy is already selected (using fuzzy matching)
    const isAlreadySelected = currentStrategy && fuzzyMatch(currentStrategy, targetName);
    console.log('[RQ Extension] Fuzzy match result:', isAlreadySelected);

    // Open the dropdown menu
    console.log('[RQ Extension] Opening strategy dropdown for optimization...');
    strategyDropdown.click();
    await sleep(300);

    // If not already selected, find and click the correct strategy first
    if (!isAlreadySelected) {
      console.log('[RQ Extension] Switching to correct strategy...');
      const menuItems = document.querySelectorAll('[role="menuitemcheckbox"]');
      console.log('[RQ Extension] Found', menuItems.length, 'strategy menu items');

      for (const item of menuItems) {
        const label = item.getAttribute('aria-label') || item.textContent?.trim();
        console.log('[RQ Extension] Menu item:', label);
        if (label && fuzzyMatch(targetName, label)) {
          console.log('[RQ Extension] Clicking strategy menu item:', label);
          (item as HTMLElement).click();
          await sleep(500); // Wait for strategy to switch
          // Re-open dropdown to access Settings
          strategyDropdown.click();
          await sleep(300);
          break;
        }
      }
    }

    // Now click the "Settings..." option in the dropdown menu
    const settingsMenuItem = document.querySelector('[data-name="legend-settings-action"], [role="menuitem"][aria-label*="Settings"]') as HTMLElement;
    if (settingsMenuItem) {
      console.log('[RQ Extension] Clicking Settings from dropdown menu');
      settingsMenuItem.click();

      // Wait for dialog to appear (poll for up to 3 seconds)
      for (let i = 0; i < 30; i++) {
        await sleep(100);
        dialog = document.querySelector('[data-name="indicator-properties-dialog"]');
        if (dialog) {
          console.log('[RQ Extension] Settings dialog opened from dropdown');
          break;
        }
      }
    } else {
      // Try finding Settings by text content
      const allMenuItems = document.querySelectorAll('[role="menuitem"]');
      for (const item of allMenuItems) {
        if (item.textContent?.includes('Settings')) {
          console.log('[RQ Extension] Clicking Settings menu item by text');
          (item as HTMLElement).click();

          // Wait for dialog to appear
          for (let i = 0; i < 30; i++) {
            await sleep(100);
            dialog = document.querySelector('[data-name="indicator-properties-dialog"]');
            if (dialog) break;
          }
          break;
        }
      }
    }

    // Close dropdown if dialog didn't open
    if (!dialog) {
      console.log('[RQ Extension] Settings dialog not opened from dropdown, closing menu');
      document.body.click();
      await sleep(200);
    }
  }

  // Fallback: try direct settings button if dropdown approach didn't work
  if (!dialog) {
    console.log('[RQ Extension] Falling back to direct settings button approach');
    const settingsSelectors_list = [
      '[data-qa-id="legend-settings-action"]',
      '[data-name="legend-settings-action"]',
      'button[aria-label*="Settings"]',
    ];

    let settingsBtn: Element | null = null;
    for (const selector of settingsSelectors_list) {
      settingsBtn = document.querySelector(selector);
      if (settingsBtn) break;
    }

    if (!settingsBtn) {
      console.log('[RQ Extension] Settings button not found for optimization');
      return null;
    }

    // Click with mouse events
    const btn = settingsBtn as HTMLElement;
    btn.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    btn.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    await sleep(50);
    btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
    btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }));
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));

    console.log('[RQ Extension] Clicked settings button for optimization');
    await sleep(800);

    // Wait for dialog
    for (let i = 0; i < 20; i++) {
      dialog = document.querySelector('[data-name="indicator-properties-dialog"]') ||
        document.querySelector('[class*="dialog"][class*="content"]');
      if (dialog) break;
      await sleep(100);
    }
  }

  if (!dialog) {
    console.log('[RQ Extension] Settings dialog did not open for optimization');
    return null;
  }

  // Click Inputs tab
  const inputsTab = dialog.querySelector('button[id="Inputs"]') ||
    Array.from(dialog.querySelectorAll('button')).find(b =>
      b.textContent?.toLowerCase().trim() === 'inputs'
    );
  if (inputsTab) {
    (inputsTab as HTMLElement).click();
    await sleep(200);
    console.log('[RQ Extension] Clicked Inputs tab for optimization');
  }

  return dialog;
}

/**
 * Close the settings dialog
 */
async function closeSettingsDialog(): Promise<void> {
  const dialog = document.querySelector('[data-name="indicator-properties-dialog"]') ||
    document.querySelector('[class*="dialog"][class*="content"]');

  if (!dialog) return;

  const closeBtn = dialog.querySelector('[data-name="close"]') ||
    dialog.querySelector('button[aria-label="Close"]') ||
    dialog.querySelector('[class*="close"]');

  if (closeBtn) {
    (closeBtn as HTMLElement).click();
    console.log('[RQ Extension] Closed settings dialog after optimization');
    await sleep(200);
  }
}

/**
 * Compare two runs based on optimization goal
 */
function isBetterRun(
  a: OptimizationRun,
  b: OptimizationRun,
  goal: OptimizationConfig['optimizationGoal']
): boolean {
  const aVal = a.metrics[goal as keyof OptimizationMetrics] as number;
  const bVal = b.metrics[goal as keyof OptimizationMetrics] as number;

  // For drawdown, lower (less negative) is better
  if (goal === 'maxDrawdownPercent') {
    return Math.abs(aVal) < Math.abs(bVal);
  }

  return aVal > bVal;
}

// ============================================================================
// Symbol & Timeframe Handlers
// ============================================================================

/**
 * Helper to close the symbol search dialog reliably
 */
async function closeSymbolSearchDialog(): Promise<void> {
  // Method 1: Try to click the close button
  const closeBtn = document.querySelector('[data-name="symbol-search-close-button"]') ||
    document.querySelector('[class*="dialog"] [class*="close"]') ||
    document.querySelector('[class*="search"] button[class*="close"]') ||
    document.querySelector('[class*="symbolSearch"] [class*="close"]');

  if (closeBtn) {
    console.log('[RQ Extension] Closing symbol search via close button');
    (closeBtn as HTMLElement).click();
    await sleep(200);
    return;
  }

  // Method 2: Press Escape on the active element
  const activeElement = document.activeElement as HTMLElement;
  if (activeElement) {
    activeElement.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape',
      code: 'Escape',
      keyCode: 27,
      which: 27,
      bubbles: true,
      cancelable: true,
    }));
    await sleep(100);
  }

  // Method 3: Also dispatch on document
  document.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'Escape',
    code: 'Escape',
    keyCode: 27,
    which: 27,
    bubbles: true,
    cancelable: true,
  }));
  await sleep(100);

  // Method 4: Click outside the dialog (on overlay/backdrop)
  const overlay = document.querySelector('[class*="overlay"]') ||
    document.querySelector('[class*="backdrop"]') ||
    document.querySelector('[class*="modalBackground"]');

  if (overlay) {
    console.log('[RQ Extension] Clicking overlay to close symbol search');
    (overlay as HTMLElement).click();
    await sleep(100);
  }

  console.log('[RQ Extension] Symbol search dialog close attempted');
}

/**
 * Handler for CHANGE_SYMBOL - change the chart symbol
 */
async function handleChangeSymbol(requestId: string, symbol: string): Promise<ChangeSymbolResponse> {
  try {
    console.log('[RQ Extension] Changing symbol to:', symbol);

    // Click on the symbol button in the chart header
    const symbolBtn = document.querySelector('[data-name="symbol-search"]') ||
      document.querySelector('[id="header-toolbar-symbol-search"]') ||
      document.querySelector('button[aria-label*="Symbol Search"]') ||
      document.querySelector('[class*="symbolInput"]');

    if (!symbolBtn) {
      console.log('[RQ Extension] Symbol button not found');
      return {
        type: 'SYMBOL_CHANGED',
        requestId,
        success: false,
        symbol: '',
        error: 'Symbol button not found',
      };
    }

    (symbolBtn as HTMLElement).click();
    await sleep(800); // Longer wait for dialog to open

    // Find the search input - try multiple selectors (same as handleSearchSymbols)
    let searchInput = document.querySelector('[data-name="symbol-search-input"]') ||
      document.querySelector('input[data-role="search"]') ||
      document.querySelector('[class*="input-"][class*="search"] input') ||
      document.querySelector('[class*="dialogContent"] input[type="text"]') ||
      document.querySelector('[class*="search"] input') ||
      document.querySelector('input[placeholder*="Search"]') ||
      document.querySelector('input[placeholder*="symbol"]') ||
      document.querySelector('input[placeholder*="Symbol"]');

    // If still not found, look for any visible input in a dialog/overlay
    if (!searchInput) {
      const allInputs = document.querySelectorAll('input[type="text"], input:not([type])');
      for (const inp of allInputs) {
        const rect = inp.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          const parent = inp.closest('[class*="dialog"], [class*="overlay"], [class*="popup"], [class*="modal"]');
          if (parent) {
            searchInput = inp;
            console.log('[RQ Extension] Found search input via fallback in dialog');
            break;
          }
        }
      }
    }

    if (!searchInput) {
      console.log('[RQ Extension] Search input not found for symbol change');
      await closeSymbolSearchDialog();
      return {
        type: 'SYMBOL_CHANGED',
        requestId,
        success: false,
        symbol: '',
        error: 'Search input not found',
      };
    }

    console.log('[RQ Extension] Found search input for symbol change:', (searchInput as HTMLElement).className);

    const input = searchInput as HTMLInputElement;
    input.focus();
    input.value = symbol;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(1200); // Wait for search results

    // Click the first result - try multiple selectors
    let firstResult = document.querySelector('[data-name="list-item-title"]')?.closest('[class*="listRow"], [class*="itemRow"], [class*="row"]') ||
      document.querySelector('[data-name="symbol-search-results-row"]') ||
      document.querySelector('[class*="listItem"]') ||
      document.querySelector('[class*="symbolRow"]');

    if (firstResult) {
      console.log('[RQ Extension] Clicking first search result');
      (firstResult as HTMLElement).click();
    } else {
      // Try pressing Enter to select
      console.log('[RQ Extension] No result found, pressing Enter');
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
    }

    await sleep(2000); // Wait for chart to load with new symbol

    // Verify the symbol changed
    const currentSymbol = document.querySelector('[data-symbol-short]')?.textContent?.trim() ||
      document.querySelector('[class*="symbolDescription"]')?.textContent?.trim() || symbol;

    console.log('[RQ Extension] Symbol changed to:', currentSymbol);

    return {
      type: 'SYMBOL_CHANGED',
      requestId,
      success: true,
      symbol: currentSymbol,
    };
  } catch (error) {
    console.error('[RQ Extension] Change symbol failed:', error);
    return {
      type: 'SYMBOL_CHANGED',
      requestId,
      success: false,
      symbol: '',
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Handler for CHANGE_TIMEFRAME - change the chart timeframe
 */
async function handleChangeTimeframe(requestId: string, timeframe: string): Promise<ChangeTimeframeResponse> {
  try {
    console.log('[RQ Extension] Changing timeframe to:', timeframe);

    // Normalize timeframe input - handle various formats
    const normalizeTimeframe = (tf: string): { display: string; minutes: number } => {
      const lower = tf.toLowerCase().trim();
      // Parse number + unit
      const match = lower.match(/^(\d+)\s*(m|min|h|hour|d|day|w|week)?$/i);
      if (match) {
        const num = parseInt(match[1]);
        const unit = (match[2] || 'm').toLowerCase();
        if (unit.startsWith('h')) return { display: `${num}h`, minutes: num * 60 };
        if (unit.startsWith('d')) return { display: `${num}D`, minutes: num * 1440 };
        if (unit.startsWith('w')) return { display: `${num}W`, minutes: num * 10080 };
        return { display: `${num}`, minutes: num }; // minutes
      }
      // Handle letter-only formats
      if (lower === 'd' || lower === '1d') return { display: '1D', minutes: 1440 };
      if (lower === 'w' || lower === '1w') return { display: '1W', minutes: 10080 };
      return { display: tf, minutes: 0 };
    };

    const normalized = normalizeTimeframe(timeframe);
    console.log('[RQ Extension] Normalized timeframe:', normalized);

    // Method 1: Try keyboard shortcut first (most reliable)
    // TradingView listens for number keys to change timeframe
    const chart = document.querySelector('.chart-container') || document.body;

    // Focus chart area first
    (chart as HTMLElement).click();
    await sleep(100);

    // For minute timeframes, just type the number
    if (normalized.minutes > 0 && normalized.minutes < 60) {
      const digits = normalized.minutes.toString();
      console.log('[RQ Extension] Typing timeframe digits:', digits);
      for (const digit of digits) {
        chart.dispatchEvent(new KeyboardEvent('keydown', {
          key: digit,
          code: `Digit${digit}`,
          keyCode: 48 + parseInt(digit),
          bubbles: true,
          cancelable: true,
        }));
        chart.dispatchEvent(new KeyboardEvent('keyup', {
          key: digit,
          code: `Digit${digit}`,
          keyCode: 48 + parseInt(digit),
          bubbles: true,
          cancelable: true,
        }));
        await sleep(50);
      }
      // Press Enter to confirm
      chart.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
      await sleep(500);
    }

    // Method 2: Click on timeframe button and select from dropdown
    const timeframeBtnSelectors = [
      '[data-name="time-interval-menu"]',
      '#header-toolbar-intervals button',
      '[id*="header-toolbar-intervals"]',
      'button[aria-label*="time"]',
      'button[aria-label*="interval"]',
      '[class*="intervalsContainer"] button',
      // Find button that shows current timeframe (e.g., "15m", "1D")
      'button:has([class*="apply-common-tooltip"])',
    ];

    let timeframeBtn: Element | null = null;
    for (const selector of timeframeBtnSelectors) {
      try {
        timeframeBtn = document.querySelector(selector);
        if (timeframeBtn) {
          console.log('[RQ Extension] Found timeframe button with selector:', selector);
          break;
        }
      } catch (e) {
        // :has() might not be supported
      }
    }

    // Fallback: find by looking for buttons with timeframe-like text
    if (!timeframeBtn) {
      const allButtons = document.querySelectorAll('button');
      for (const btn of allButtons) {
        const text = btn.textContent?.trim() || '';
        if (/^\d+[mhDWM]?$/.test(text) || /^\d+\s*(min|hour|day)/i.test(text)) {
          console.log('[RQ Extension] Found timeframe button by text:', text);
          timeframeBtn = btn;
          break;
        }
      }
    }

    if (timeframeBtn) {
      console.log('[RQ Extension] Clicking timeframe button...');
      (timeframeBtn as HTMLElement).click();
      await sleep(400);

      // Look for dropdown menu items
      const menuSelectors = [
        '[data-name="menu-inner"] [role="menuitem"]',
        '[data-name="menu-inner"] [role="option"]',
        '[class*="dropdown"] [class*="item"]',
        '[class*="menu"] [class*="item"]',
        '[role="listbox"] [role="option"]',
        '[class*="menuBox"] button',
        '[class*="menuBox"] [class*="row"]',
      ];

      let menuItems: NodeListOf<Element> | null = null;
      for (const selector of menuSelectors) {
        menuItems = document.querySelectorAll(selector);
        if (menuItems.length > 0) {
          console.log('[RQ Extension] Found', menuItems.length, 'menu items with selector:', selector);
          break;
        }
      }

      if (menuItems && menuItems.length > 0) {
        // Build list of valid minute-based options to match
        // We need to be precise - "30" should match "30 minutes" NOT "30 seconds"
        const minutePatterns = [
          // Exact matches for minute timeframes
          new RegExp(`^${normalized.minutes}$`, 'i'),                    // "30"
          new RegExp(`^${normalized.minutes}m$`, 'i'),                   // "30m"
          new RegExp(`^${normalized.minutes}\\s*min(ute)?s?$`, 'i'),     // "30 minutes", "30min"
          // Hour patterns (if applicable)
          ...(normalized.minutes >= 60 ? [
            new RegExp(`^${normalized.minutes / 60}h$`, 'i'),            // "1h"
            new RegExp(`^${normalized.minutes / 60}\\s*hours?$`, 'i'),   // "1 hour"
          ] : []),
          // Day patterns
          ...(normalized.minutes >= 1440 ? [
            new RegExp(`^${normalized.minutes / 1440}D$`, 'i'),          // "1D"
            new RegExp(`^${normalized.minutes / 1440}\\s*days?$`, 'i'),  // "1 day"
          ] : []),
        ];

        let found = false;
        const allOptions: string[] = [];

        for (const item of menuItems) {
          const text = item.textContent?.trim() || '';
          allOptions.push(text);

          // Skip non-minute timeframes (ticks, seconds)
          const lowerText = text.toLowerCase();
          if (lowerText.includes('tick') || lowerText.includes('second')) {
            continue;
          }

          // Check if this matches our target timeframe
          for (const pattern of minutePatterns) {
            if (pattern.test(text)) {
              console.log('[RQ Extension] Clicking timeframe option:', text);
              (item as HTMLElement).click();
              found = true;
              break;
            }
          }
          if (found) break;
        }

        // If not found with patterns, try scrolling and looking for more options
        if (!found) {
          // Look for minute-based options more loosely
          for (const item of menuItems) {
            const text = item.textContent?.trim() || '';
            const lowerText = text.toLowerCase();

            // Skip ticks and seconds
            if (lowerText.includes('tick') || lowerText.includes('second')) continue;

            // Check if it contains our number and is minute-based
            if (lowerText.includes('minute') && lowerText.includes(normalized.minutes.toString())) {
              console.log('[RQ Extension] Clicking timeframe option (loose match):', text);
              (item as HTMLElement).click();
              found = true;
              break;
            }
          }
        }

        if (!found) {
          console.log('[RQ Extension] Timeframe not found. Looking for:', normalized.minutes, 'minutes');
          console.log('[RQ Extension] Available options:', allOptions.slice(0, 15));
          // Close menu
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

          // Try keyboard shortcut as last resort
          console.log('[RQ Extension] Trying keyboard shortcut...');
          await sleep(300);

          // For TradingView, typing a number changes the timeframe
          // Need to make sure chart is focused
          const chartFrame = document.querySelector('.chart-markup-table') || document.body;
          (chartFrame as HTMLElement).click();
          await sleep(100);

          // Type the timeframe
          for (const digit of normalized.minutes.toString()) {
            document.dispatchEvent(new KeyboardEvent('keydown', {
              key: digit,
              code: `Digit${digit}`,
              keyCode: 48 + parseInt(digit),
              bubbles: true,
            }));
            await sleep(30);
          }
          // Press Enter to confirm
          await sleep(100);
          document.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter',
            code: 'Enter',
            keyCode: 13,
            bubbles: true,
          }));
        }
      } else {
        console.log('[RQ Extension] No menu items found after clicking timeframe button');
        // Close any open menu
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      }
    } else {
      console.log('[RQ Extension] Timeframe button not found with any selector');
    }

    await sleep(1000); // Wait for chart to update

    // Wait for backtest to recalculate if a strategy is running
    await waitForBacktestUpdate();

    // Verify the change
    const currentTf = extractStrategyMetadata().timeframe;
    console.log('[RQ Extension] Timeframe after change:', currentTf);

    return {
      type: 'TIMEFRAME_CHANGED',
      requestId,
      success: true,
      timeframe: currentTf || normalized.display,
    };
  } catch (error) {
    console.error('[RQ Extension] Change timeframe failed:', error);
    return {
      type: 'TIMEFRAME_CHANGED',
      requestId,
      success: false,
      timeframe: '',
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

// ============================================================================
// Expose functions to window for optimizer-ui
// ============================================================================

declare global {
  interface Window {
    rqGetStrategyInputs?: () => Promise<{ inputs: StrategyInput[] }>;
    rqStartOptimization?: (config: OptimizationConfig) => void;
    rqStopOptimization?: () => void;
    rqApplyParameters?: (params: Record<string, number | string | boolean>) => void;
    rqGetDropdownOptions?: (name: string) => Promise<string[]>;
    rqChangeSymbol?: (symbol: string) => Promise<{ success: boolean }>;
    rqChangeTimeframe?: (timeframe: string) => Promise<{ success: boolean }>;
  }
}

window.rqGetStrategyInputs = async () => {
  const inputs = await extractStrategyInputsAsync();
  return { inputs };
};

window.rqStartOptimization = (config: OptimizationConfig) => {
  handleStartOptimization(`opt-${Date.now()}`, config);
};

window.rqStopOptimization = () => {
  state.optimizationCancelled = true;
};

window.rqApplyParameters = (params: Record<string, number | string | boolean>) => {
  handleApplyParameters(params);
};

window.rqGetDropdownOptions = async (name: string) => {
  return getDropdownOptions(name);
};

window.rqChangeSymbol = async (symbol: string) => {
  const result = await handleChangeSymbol(`sym-${Date.now()}`, symbol);
  return { success: result.success };
};

window.rqChangeTimeframe = async (timeframe: string) => {
  const result = await handleChangeTimeframe(`tf-${Date.now()}`, timeframe);
  return { success: result.success };
};

// ============================================================================
// Start
// ============================================================================

// Wait for DOM to be ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    initialize();
    // Inject optimizer button after a delay to ensure Strategy Tester is loaded
    setTimeout(() => injectOptimizerButton(), 2000);
  });
} else {
  initialize();
  // Inject optimizer button after a delay to ensure Strategy Tester is loaded
  setTimeout(() => injectOptimizerButton(), 2000);
}

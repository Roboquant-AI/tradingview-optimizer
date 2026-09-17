/**
 * Background Service Worker
 *
 * Tracks TradingView tabs running the content script, reports status to the
 * popup, and performs the privileged actions the in-page optimizer needs
 * (setting the backtest date range via the debugger API, waking a stale tab).
 */

// ============================================================================
// Global Error Handlers (for debugging crashes)
// ============================================================================

self.addEventListener('error', (event) => {
  console.error('[RQ Extension Background] UNCAUGHT ERROR:', event.error);
  console.error('[RQ Extension Background] Error message:', event.message);
  console.error('[RQ Extension Background] Stack:', event.error?.stack);
});

self.addEventListener('unhandledrejection', (event) => {
  console.error('[RQ Extension Background] UNHANDLED PROMISE REJECTION:', event.reason);
  console.error('[RQ Extension Background] Reason stack:', event.reason?.stack);
});

console.log('[RQ Extension Background] Service worker started at:', new Date().toISOString());

import type {
  StatusResponse,
  TradingViewTabInfo,
  EditorState,
  ContentToBackgroundMessage,
} from './types';
import { EXTENSION_VERSION } from './types';

// ============================================================================
// State Management
// ============================================================================

interface ExtensionState {
  /** Currently active TradingView tabs with content script loaded */
  tradingViewTabs: Map<number, TradingViewTabInfo>;
  /** Current editor state per tab */
  editorStates: Map<number, EditorState>;
}

const state: ExtensionState = {
  tradingViewTabs: new Map(),
  editorStates: new Map(),
};

// ============================================================================
// Content Script Message Handler
// ============================================================================

chrome.runtime.onMessage.addListener(
  (
    message: ContentToBackgroundMessage & { type: string; startDate?: string; endDate?: string },
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: unknown) => void
  ) => {
    // Handle popup messages (no tab id)
    if (message.type === 'GET_STATUS') {
      (async () => {
        if (state.tradingViewTabs.size === 0) {
          await recoverTradingViewTabs();
        }
        sendResponse(await getStatus());
      })();
      return true;
    }

    const tabId = sender.tab?.id;
    if (!tabId) return;

    switch (message.type) {
      case 'CONTENT_READY':
        handleContentReady(tabId, sender.tab!);
        break;

      case 'EDITOR_STATE_CHANGED':
        handleEditorStateChanged(tabId, message.payload as EditorState);
        break;

      case 'HEARTBEAT':
        // Content script is keeping us alive and synced
        // Re-register the tab if we don't have it (service worker woke up)
        if (!state.tradingViewTabs.has(tabId) && sender.tab) {
          console.log('[RQ Extension] Heartbeat from unknown tab - re-registering:', tabId);
          handleContentReady(tabId, sender.tab);
        }
        // Update editor state from heartbeat payload
        if (message.payload) {
          handleEditorStateChanged(tabId, message.payload as EditorState);
        }
        sendResponse({ received: true });
        return true;

      case 'SET_DATE_RANGE_VIA_DEBUGGER':
        // Handle date range setting via debugger API (more reliable than DOM manipulation)
        (async () => {
          const success = await setDateRangeViaDebugger(tabId, message.startDate || '', message.endDate || '');
          sendResponse({ success });
        })();
        return true;

      case 'TRIGGER_TAB_REFRESH':
        // Content script requests a quick tab switch to wake up stale TradingView
        (async () => {
          const result = await performTabRefresh(tabId);
          sendResponse({ success: result });
        })();
        return true; // Keep channel open for async response
    }

    sendResponse({ received: true });
    return true;
  }
);

// ============================================================================
// Tab Lifecycle
// ============================================================================

chrome.tabs.onRemoved.addListener((tabId) => {
  state.tradingViewTabs.delete(tabId);
  state.editorStates.delete(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!state.tradingViewTabs.has(tabId)) return;
  // A TradingView tab navigated away, or started loading without a URL change
  // (reload): drop it. The content script re-registers via CONTENT_READY.
  const navigatedAway = changeInfo.url !== undefined && !changeInfo.url.includes('tradingview.com');
  const reloading = changeInfo.status === 'loading' && changeInfo.url === undefined;
  if (navigatedAway || reloading) {
    state.tradingViewTabs.delete(tabId);
    state.editorStates.delete(tabId);
  }
});

// ============================================================================
// Service Worker Wake-Up Recovery
// ============================================================================

/**
 * Manifest V3 service workers are ephemeral - they can be terminated after
 * ~30 seconds of inactivity. When this happens, all in-memory state is lost.
 *
 * This function re-discovers existing TradingView tabs and asks them to
 * re-register their state.
 */
async function recoverTradingViewTabs(): Promise<void> {
  console.log('[RQ Extension] Recovering TradingView tabs after service worker wake-up');

  try {
    // Find all TradingView tabs
    const tabs = await chrome.tabs.query({ url: '*://*.tradingview.com/*' });

    for (const tab of tabs) {
      if (tab.id && tab.url?.includes('tradingview.com')) {
        console.log('[RQ Extension] Found TradingView tab:', tab.id, tab.url?.substring(0, 50));

        // Try to ping the content script to re-register
        try {
          await chrome.tabs.sendMessage(tab.id, { type: 'PING_CONTENT' });
          // Content script will respond by sending CONTENT_READY and EDITOR_STATE_CHANGED
        } catch (e) {
          // Content script not loaded - that's okay, might not be on chart page
          console.log('[RQ Extension] Tab', tab.id, 'content script not responding');
        }
      }
    }
  } catch (error) {
    console.error('[RQ Extension] Error recovering tabs:', error);
  }
}

// Recover tabs when service worker starts (e.g., after being terminated)
recoverTradingViewTabs();

// ============================================================================
// Handlers
// ============================================================================

function handleContentReady(tabId: number, tab: chrome.tabs.Tab): void {
  state.tradingViewTabs.set(tabId, {
    tabId,
    url: tab.url || '',
    title: tab.title || '',
    loggedIn: false, // Will be updated by content script
  });
  state.editorStates.set(tabId, 'not_found');
}

function handleEditorStateChanged(tabId: number, editorState: EditorState): void {
  state.editorStates.set(tabId, editorState);
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Performs a quick tab switch to wake up a stale TradingView tab.
 * Switches to the TV tab, waits 2 seconds, then switches back to the original tab.
 * This helps when TradingView becomes unresponsive due to being in the background.
 */
async function performTabRefresh(tvTabId: number): Promise<boolean> {
  console.log('[RQ Extension] Performing tab refresh to wake up TradingView...');

  try {
    // Get the currently active tab to return to it later
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const originalTabId = activeTab?.id;
    const originalWindowId = activeTab?.windowId;

    // Get the TradingView tab info
    const tvTab = await chrome.tabs.get(tvTabId);

    // Switch to the TradingView tab
    console.log('[RQ Extension] Switching to TradingView tab:', tvTabId);
    await chrome.tabs.update(tvTabId, { active: true });

    // Also focus the window if it's different
    if (tvTab.windowId && tvTab.windowId !== originalWindowId) {
      await chrome.windows.update(tvTab.windowId, { focused: true });
    }

    // Wait 2 seconds to let TV wake up
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Switch back to the original tab
    if (originalTabId) {
      console.log('[RQ Extension] Switching back to original tab:', originalTabId);
      await chrome.tabs.update(originalTabId, { active: true });

      if (originalWindowId) {
        await chrome.windows.update(originalWindowId, { focused: true });
      }
    }

    console.log('[RQ Extension] Tab refresh complete');
    return true;
  } catch (error) {
    console.error('[RQ Extension] Tab refresh failed:', error);
    return false;
  }
}

function findActiveEditorTab(): TradingViewTabInfo | null {
  // Prefer tab with ready editor
  for (const [tabId, info] of state.tradingViewTabs) {
    if (state.editorStates.get(tabId) === 'ready') {
      return info;
    }
  }

  // Fall back to any TradingView tab
  const firstTab = state.tradingViewTabs.values().next();
  return firstTab.done ? null : firstTab.value;
}

async function getStatus(): Promise<StatusResponse> {
  const activeTab = findActiveEditorTab();

  return {
    type: 'STATUS',
    extensionVersion: EXTENSION_VERSION,
    connected: state.tradingViewTabs.size > 0,
    tradingViewTab: activeTab,
    editorState: activeTab ? (state.editorStates.get(activeTab.tabId) || 'not_found') : 'not_found',
  };
}

// ============================================================================
// Debugger-based Date Range
// ============================================================================

/**
 * Set date range in TradingView backtester using Chrome Debugger API
 * This is more reliable than DOM manipulation for React inputs
 */
async function setDateRangeViaDebugger(tabId: number, startDate: string, endDate: string): Promise<boolean> {
  console.log(`[RQ Extension] === setDateRangeViaDebugger START: ${startDate} to ${endDate} ===`);

  try {
    // Attach debugger
    console.log('[RQ Extension] Attaching debugger for date range...');
    await chrome.debugger.attach({ tabId }, '1.3');
    await new Promise(resolve => setTimeout(resolve, 100));

    // Step 1: Click the date range button to open the menu
    console.log('[RQ Extension] Step 1: Opening date range menu...');
    const openMenuResult = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
      expression: `
        (function() {
          const dateRangeBtn = document.querySelector('.dateRangeMenuWrapper-rQLA_iPz button') ||
            document.querySelector('[class*="dateRangeMenuWrapper"] button');
          if (dateRangeBtn) {
            dateRangeBtn.click();
            return { success: true };
          }
          return { success: false, error: 'Date range button not found' };
        })()
      `,
      returnByValue: true,
    }) as { result?: { value?: { success: boolean; error?: string } } };

    if (!openMenuResult?.result?.value?.success) {
      console.error('[RQ Extension] Failed to open date menu:', openMenuResult?.result?.value?.error);
      await chrome.debugger.detach({ tabId });
      return false;
    }
    await new Promise(resolve => setTimeout(resolve, 800));

    // Step 2: Click "Custom date range..." option
    console.log('[RQ Extension] Step 2: Clicking Custom date range option...');
    const clickCustomResult = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
      expression: `
        (function() {
          let customOption = document.querySelector('[aria-label="Custom date range…"]') ||
            document.querySelector('[aria-label="Custom date range..."]') ||
            document.querySelector('[data-value="custom"]');

          if (!customOption) {
            const menuItems = document.querySelectorAll('[class*="item-"], [class*="menuItem"], [role="menuitem"], [class*="dropdown"] [class*="item"]');
            for (const item of menuItems) {
              const text = item.textContent?.toLowerCase() || '';
              if (text.includes('custom')) {
                customOption = item;
                break;
              }
            }
          }

          if (customOption) {
            customOption.click();
            return { success: true };
          }
          return { success: false, error: 'Custom option not found' };
        })()
      `,
      returnByValue: true,
    }) as { result?: { value?: { success: boolean; error?: string } } };

    if (!clickCustomResult?.result?.value?.success) {
      console.error('[RQ Extension] Failed to click custom option:', clickCustomResult?.result?.value?.error);
      await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
        type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27,
      });
      await chrome.debugger.detach({ tabId });
      return false;
    }
    await new Promise(resolve => setTimeout(resolve, 800));

    // Step 3: Find and set the date inputs using Input.insertText
    console.log('[RQ Extension] Step 3: Setting date inputs via CDP...');

    // Get current values to determine order
    const currentValuesResult = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
      expression: `
        (function() {
          const dateInputs = document.querySelectorAll('input[inputmode="numeric"][data-qa-id="ui-lib-Input-input"]');
          if (dateInputs.length < 2) {
            return { success: false, error: 'Date inputs not found', count: dateInputs.length };
          }
          return {
            success: true,
            startValue: dateInputs[0].value,
            endValue: dateInputs[1].value,
          };
        })()
      `,
      returnByValue: true,
    }) as { result?: { value?: { success: boolean; startValue?: string; endValue?: string; error?: string } } };

    if (!currentValuesResult?.result?.value?.success) {
      console.error('[RQ Extension] Date inputs not found:', currentValuesResult?.result?.value?.error);
      await chrome.debugger.detach({ tabId });
      return false;
    }

    const currentEnd = currentValuesResult?.result?.value?.endValue || '';
    const shouldSetEndFirst = startDate >= currentEnd;
    console.log(`[RQ Extension] Current end: ${currentEnd}, setting order: ${shouldSetEndFirst ? 'END first' : 'START first'}`);

    // Helper to set a date input via CDP
    const setDateInput = async (inputIndex: number, dateValue: string, label: string) => {
      console.log(`[RQ Extension] Setting ${label} input (index ${inputIndex}) to: ${dateValue}`);

      // Focus and select all in the input
      await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
        expression: `
          (function() {
            const inputs = document.querySelectorAll('input[inputmode="numeric"][data-qa-id="ui-lib-Input-input"]');
            const input = inputs[${inputIndex}];
            if (input) {
              input.focus();
              input.select();
              return true;
            }
            return false;
          })()
        `,
        returnByValue: true,
      });
      await new Promise(resolve => setTimeout(resolve, 100));

      // Use Input.insertText to type the date - this replaces selected text
      await chrome.debugger.sendCommand({ tabId }, 'Input.insertText', {
        text: dateValue,
      });
      await new Promise(resolve => setTimeout(resolve, 100));

      // Trigger blur to validate
      await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
        expression: `
          (function() {
            const inputs = document.querySelectorAll('input[inputmode="numeric"][data-qa-id="ui-lib-Input-input"]');
            const input = inputs[${inputIndex}];
            if (input) {
              input.dispatchEvent(new Event('change', { bubbles: true }));
              input.dispatchEvent(new Event('blur', { bubbles: true }));
              return { value: input.value };
            }
            return { error: 'Input not found' };
          })()
        `,
        returnByValue: true,
      });
      await new Promise(resolve => setTimeout(resolve, 200));
    };

    // Set dates in the correct order
    if (shouldSetEndFirst) {
      await setDateInput(1, endDate, 'END');
      await setDateInput(0, startDate, 'START');
    } else {
      await setDateInput(0, startDate, 'START');
      await setDateInput(1, endDate, 'END');
    }

    // Step 4: Verify and click Apply button
    console.log('[RQ Extension] Step 4: Verifying values and clicking Apply...');
    await new Promise(resolve => setTimeout(resolve, 300));

    const verifyAndApplyResult = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
      expression: `
        (function() {
          const inputs = document.querySelectorAll('input[inputmode="numeric"][data-qa-id="ui-lib-Input-input"]');
          const actualStart = inputs[0]?.value || '';
          const actualEnd = inputs[1]?.value || '';

          // Find and click apply button
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

          if (applyBtn && !applyBtn.disabled) {
            applyBtn.click();
            return { success: true, actualStart, actualEnd, clicked: true };
          } else if (applyBtn?.disabled) {
            return { success: false, actualStart, actualEnd, error: 'Apply button disabled - dates may be invalid' };
          }
          return { success: false, actualStart, actualEnd, error: 'Apply button not found' };
        })()
      `,
      returnByValue: true,
    }) as { result?: { value?: { success: boolean; actualStart?: string; actualEnd?: string; error?: string } } };

    const result = verifyAndApplyResult?.result?.value;
    console.log(`[RQ Extension] Apply result: ${JSON.stringify(result)}`);

    if (!result?.success) {
      console.error('[RQ Extension] Failed to apply dates:', result?.error);
      // Try pressing Escape to close dialog
      await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', {
        type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27,
      });
      await chrome.debugger.detach({ tabId });
      return false;
    }

    // Wait for chart to update
    await new Promise(resolve => setTimeout(resolve, 1500));

    // Detach debugger
    await chrome.debugger.detach({ tabId });
    console.log(`[RQ Extension] === setDateRangeViaDebugger SUCCESS ===`);
    return true;

  } catch (error) {
    console.error('[RQ Extension] setDateRangeViaDebugger error:', error);
    try {
      await chrome.debugger.detach({ tabId });
    } catch (e) {
      // Ignore detach error
    }
    return false;
  }
}

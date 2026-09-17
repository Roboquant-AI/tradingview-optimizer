/**
 * Extension popup
 *
 * Shows extension status and provides quick actions
 */

import { roboquantLink } from './config'
import { EXTENSION_VERSION } from './types'

interface StatusResponse {
  type: 'STATUS'
  extensionVersion: string
  connected: boolean
  tradingViewTab: { tabId: number; url: string } | null
  editorState: 'not_found' | 'closed' | 'ready' | 'compiling'
}

async function updateStatus(): Promise<void> {
  const extensionDot = document.getElementById('extensionStatus')
  const extensionText = document.getElementById('extensionStatusText')
  const tvDot = document.getElementById('tradingViewStatus')
  const tvText = document.getElementById('tradingViewStatusText')
  const editorDot = document.getElementById('editorStatus')
  const editorText = document.getElementById('editorStatusText')
  const versionEl = document.getElementById('version')
  const openTvBtn = document.getElementById('openTradingView')

  if (!extensionDot || !extensionText || !tvDot || !tvText || !editorDot || !editorText) {
    return
  }

  // Extension is always active if popup is open
  extensionDot.className = 'status-dot connected'
  extensionText.textContent = 'Active'

  try {
    // Get status from background
    const response = await chrome.runtime.sendMessage({ type: 'GET_STATUS' }) as StatusResponse

    if (response?.type === 'STATUS') {
      // Update version
      if (versionEl && response.extensionVersion) {
        versionEl.textContent = `v${response.extensionVersion}`
      }

      // TradingView tab status
      if (response.tradingViewTab) {
        tvDot.className = 'status-dot connected'
        tvText.textContent = 'Connected'
        if (openTvBtn) {
          (openTvBtn as HTMLAnchorElement).style.display = 'none'
        }
      } else {
        tvDot.className = 'status-dot disconnected'
        tvText.textContent = 'Not open'
        if (openTvBtn) {
          (openTvBtn as HTMLAnchorElement).style.display = 'flex'
        }
      }

      // Editor status
      switch (response.editorState) {
        case 'ready':
          editorDot.className = 'status-dot connected'
          editorText.textContent = 'Ready'
          break
        case 'closed':
          editorDot.className = 'status-dot warning'
          editorText.textContent = 'Will open automatically'
          break
        case 'compiling':
          editorDot.className = 'status-dot connected'
          editorText.textContent = 'Compiling...'
          break
        default:
          editorDot.className = 'status-dot disconnected'
          editorText.textContent = response.tradingViewTab ? 'Not detected' : 'Needs TradingView'
      }
    } else {
      // No response - something wrong
      tvDot.className = 'status-dot disconnected'
      tvText.textContent = 'Unknown'
      editorDot.className = 'status-dot disconnected'
      editorText.textContent = 'Unknown'
    }
  } catch (error) {
    console.error('Failed to get status:', error)
    tvDot.className = 'status-dot disconnected'
    tvText.textContent = 'Error'
    editorDot.className = 'status-dot disconnected'
    editorText.textContent = 'Error'
  }
}

// Update status on load
console.log('[RQ Popup] Script loaded')
document.addEventListener('DOMContentLoaded', () => {
  console.log('[RQ Popup] DOMContentLoaded')
  document.getElementById('roboquantCta')?.setAttribute('href', roboquantLink('/', 'popup'))
  document.getElementById('roboquantFooterLink')?.setAttribute('href', roboquantLink('/', 'popup-footer'))
  const versionEl = document.getElementById('version')
  if (versionEl) versionEl.textContent = `v${EXTENSION_VERSION}`
  updateStatus()

  // Refresh status every 2 seconds while popup is open
  setInterval(updateStatus, 2000)
})

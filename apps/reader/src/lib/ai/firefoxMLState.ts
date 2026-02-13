/**
 * Firefox Native ML State Management
 *
 * SOTA 2026: Progressive enhancement with just-in-time consent
 *
 * Three separate states:
 * 1. promptState: Whether we've asked the user (pending/accepted/declined)
 * 2. permissionGranted: Runtime check via permissions.contains
 * 3. apiPresent: Whether browser.trial.ml exists
 */

const STORAGE_KEY = 'firefox-ml-prompt-state'
const DECLINED_COOLDOWN_KEY = 'firefox-ml-declined-at'
const COOLDOWN_DAYS = 14 // Re-ask after 14 days if declined

export type PromptState = 'pending' | 'accepted' | 'declined'

/**
 * Get the prompt state (whether we've asked the user)
 */
export function getPromptState(): PromptState {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored === 'accepted' || stored === 'declined') {
      return stored
    }
    return 'pending'
  } catch {
    return 'pending'
  }
}

/**
 * Set the prompt state
 */
export function setPromptState(state: PromptState): void {
  try {
    localStorage.setItem(STORAGE_KEY, state)
    if (state === 'declined') {
      localStorage.setItem(DECLINED_COOLDOWN_KEY, Date.now().toString())
    }
  } catch {
    // Storage not available
  }
}

/**
 * Check if we should show the Firefox ML modal
 * - Only on Firefox
 * - Only if never asked OR if declined but cooldown passed
 */
export function shouldShowFirefoxMLModal(): boolean {
  // Only relevant for Firefox
  if (!isFirefoxBrowser()) return false

  const state = getPromptState()

  if (state === 'pending') return true

  if (state === 'declined') {
    // Check cooldown
    try {
      const declinedAt = localStorage.getItem(DECLINED_COOLDOWN_KEY)
      if (declinedAt) {
        const daysSince =
          (Date.now() - parseInt(declinedAt)) / (1000 * 60 * 60 * 24)
        if (daysSince >= COOLDOWN_DAYS) {
          // Reset to pending after cooldown
          setPromptState('pending')
          return true
        }
      }
    } catch {
      // Ignore
    }
    return false
  }

  // state === 'accepted' - don't show modal again
  return false
}

/**
 * Check if running in Firefox browser
 */
export function isFirefoxBrowser(): boolean {
  if (typeof navigator === 'undefined') return false
  return /Firefox/i.test(navigator.userAgent)
}

/**
 * Check if trialML permission is granted (runtime check)
 */
export async function isTrialMLPermissionGranted(): Promise<boolean> {
  try {
    const browserApi = (window as any).browser || (window as any).chrome
    if (!browserApi?.permissions?.contains) return false

    const granted = await browserApi.permissions.contains({
      permissions: ['trialML'],
    })
    return granted
  } catch {
    return false
  }
}

/**
 * Request trialML permission.
 * CRITICAL: Call this DIRECTLY from click handler (no awaits before)!
 */
export function requestTrialMLPermissionSync(): Promise<boolean> {
  const browserApi = (window as any).browser || (window as any).chrome
  if (!browserApi?.permissions?.request) {
    return Promise.resolve(false)
  }

  // This MUST be called directly from user gesture
  return browserApi.permissions.request({ permissions: ['trialML'] })
}

/**
 * Check if Firefox ML API is present in background script
 */
export async function isFirefoxMLApiPresent(): Promise<boolean> {
  try {
    const browserApi = (window as any).browser || (window as any).chrome
    if (!browserApi?.runtime?.sendMessage) return false

    const response = await browserApi.runtime.sendMessage({
      type: 'firefox-ml-check',
    })
    return response?.available === true
  } catch {
    return false
  }
}

/**
 * Get full Firefox ML status (derived from runtime checks, not persisted)
 */
export async function getFirefoxMLStatus(): Promise<{
  isFirefox: boolean
  promptState: PromptState
  permissionGranted: boolean
  apiPresent: boolean
  canUseNativeML: boolean
}> {
  const isFirefox = isFirefoxBrowser()

  if (!isFirefox) {
    return {
      isFirefox: false,
      promptState: 'pending',
      permissionGranted: false,
      apiPresent: false,
      canUseNativeML: false,
    }
  }

  const promptState = getPromptState()
  const permissionGranted = await isTrialMLPermissionGranted()
  const apiPresent = permissionGranted ? await isFirefoxMLApiPresent() : false

  return {
    isFirefox: true,
    promptState,
    permissionGranted,
    apiPresent,
    canUseNativeML: permissionGranted && apiPresent,
  }
}

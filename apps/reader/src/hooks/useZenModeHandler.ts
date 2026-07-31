import { useCallback, useEffect } from 'react'

import { useZenMode } from '../state'

declare const chrome: any

interface ZenModeHandlerOptions {
  /** Only one mounted instance should own global event listeners. */
  listen?: boolean
}

export function useZenModeHandler({
  listen = true,
}: ZenModeHandlerOptions = {}) {
  const [isZenMode, setZenMode] = useZenMode()

  const toggleZenMode = useCallback(async () => {
    const newState = !isZenMode

    // Chrome Extension environment
    if (
      typeof chrome !== 'undefined' &&
      chrome.windows &&
      chrome.windows.update
    ) {
      try {
        const window = await chrome.windows.getCurrent()
        if (window.id) {
          await chrome.windows.update(window.id, {
            state: newState ? 'fullscreen' : 'maximized',
          })
        }
      } catch (error) {
        console.error('Failed to toggle Chrome fullscreen:', error)
      }
    } else {
      // Standard Web/Firefox environment
      if (newState) {
        try {
          if (document.fullscreenEnabled) {
            await document.body.requestFullscreen()
          }
        } catch (e) {
          console.error('Fullscreen failed:', e)
        }
      } else {
        if (document.fullscreenElement) {
          try {
            await document.exitFullscreen()
          } catch (e) {
            console.error('Exit fullscreen failed:', e)
          }
        }
      }
    }

    setZenMode(newState)
  }, [isZenMode, setZenMode])

  useEffect(() => {
    if (!listen) return

    const hasWindowApi =
      typeof chrome !== 'undefined' &&
      chrome.windows &&
      chrome.windows.getCurrent &&
      chrome.windows.onBoundsChanged

    const handleFullscreenChange = () => {
      // Sync state if user exits fullscreen via ESC or browser UI
      if (!document.fullscreenElement && isZenMode) {
        // Only sync if we are NOT in Chrome extension environment (where fullscreenElement might not be set)
        // or if we want to support ESC key exiting.
        // For now, let's keep it simple: if document fullscreen exits, we exit zen mode.
        // But for Chrome windows API, this event might not fire or matter as much.
        // We'll rely on the toggle for now, but keep this for standard web.
        if (
          typeof chrome === 'undefined' ||
          !chrome.windows ||
          !chrome.windows.update
        ) {
          setZenMode(false)
        }
      }
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      // F11 is handled by the browser, so leave Zen immediately instead of
      // waiting for a window-state event that some browsers do not emit.
      if (event.key === 'F11' && isZenMode) {
        setZenMode(false)
        return
      }
      if (event.key === 'Escape' && isZenMode) {
        void toggleZenMode()
      }
    }

    const syncChromeWindowState = async () => {
      if (!hasWindowApi || !isZenMode) return
      try {
        const currentWindow = await chrome.windows.getCurrent()
        if (currentWindow.state !== 'fullscreen') {
          setZenMode(false)
        }
      } catch (error) {
        console.error('Failed to synchronize Chrome fullscreen state:', error)
      }
    }

    if (isZenMode) {
      document.addEventListener('keydown', handleKeyDown)
      if (hasWindowApi) {
        void syncChromeWindowState()
        chrome.windows.onBoundsChanged.addListener(syncChromeWindowState)
      }
    }

    document.addEventListener('fullscreenchange', handleFullscreenChange)

    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange)
      document.removeEventListener('keydown', handleKeyDown)
      if (hasWindowApi) {
        chrome.windows.onBoundsChanged.removeListener(syncChromeWindowState)
      }
    }
  }, [isZenMode, listen, setZenMode, toggleZenMode])

  return { toggleZenMode }
}

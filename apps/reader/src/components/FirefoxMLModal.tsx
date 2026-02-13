/**
 * Firefox Native ML Consent Modal
 *
 * SOTA 2026: Progressive enhancement with just-in-time consent
 * Redesigned to match BookDetailsModal aesthetics (Semantic Tokens)
 */

import React, { useState } from 'react'

import {
  setPromptState,
  requestTrialMLPermissionSync,
} from '../lib/ai/firefoxMLState'

interface FirefoxMLModalProps {
  isOpen: boolean
  onClose: (enabled: boolean) => void
}

export function FirefoxMLModal({ isOpen, onClose }: FirefoxMLModalProps) {
  const [status, setStatus] = useState<'idle' | 'requesting' | 'error'>('idle')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  if (!isOpen) return null

  const handleEnable = async () => {
    setStatus('requesting')
    try {
      // CRITICAL: Call permissions.request DIRECTLY (no awaits before!)
      const granted = await requestTrialMLPermissionSync()
      if (granted) {
        setPromptState('accepted')
        onClose(true)
      } else {
        setPromptState('declined')
        setStatus('error')
        setErrorMessage('Permission denied. Please try again.')
      }
    } catch (e: any) {
      console.error('[FirefoxMLModal] Permission request failed:', e)
      setErrorMessage(e.message || 'Request failed')
      setStatus('error')
    }
  }

  const handleDecline = () => {
    setPromptState('declined')
    onClose(false)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={handleDecline}
      />

      <div className="bg-background-light dark:bg-background-dark relative w-full max-w-md overflow-hidden rounded-3xl shadow-2xl transition-all">
        <div className="flex flex-col items-center p-8 text-center">
          {/* Hero Icon */}
          <div className="bg-surface-light dark:bg-surface-dark mb-6 rounded-2xl p-4 shadow-lg ring-1 ring-black/5 dark:ring-white/10">
            <span className="text-4xl">🚀</span>
          </div>

          <h2 className="text-text-light dark:text-text-dark mb-3 text-2xl font-bold leading-tight">
            Supercharge your Browser
          </h2>

          <p className="text-primary mb-6 text-sm font-medium uppercase tracking-wide">
            Firefox Native AI Acceleration
          </p>

          <p className="text-subtle-light dark:text-subtle-dark mb-8 text-sm leading-relaxed">
            Run AI models <strong>directly on your device</strong>. No server
            latency, complete privacy, and 50x faster indexing.
          </p>

          {/* Feature Grid */}
          <div className="mb-8 grid w-full grid-cols-2 gap-4">
            <div className="bg-surface-light dark:bg-surface-dark border-border-light dark:border-border-dark rounded-xl border p-4">
              <span className="mb-2 block text-xl">⚡</span>
              <span className="text-text-light dark:text-text-dark block text-xs font-bold">
                50X FASTER
              </span>
            </div>
            <div className="bg-surface-light dark:bg-surface-dark border-border-light dark:border-border-dark rounded-xl border p-4">
              <span className="mb-2 block text-xl">🔒</span>
              <span className="text-text-light dark:text-text-dark block text-xs font-bold">
                PRIVATE
              </span>
            </div>
          </div>

          {status === 'idle' && (
            <div className="w-full space-y-3">
              <button
                onClick={handleEnable}
                className="from-primary to-primary-dark shadow-primary/20 flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r px-8 py-3.5 font-bold text-white shadow-lg transition-all hover:scale-[1.02] hover:brightness-110 active:scale-[0.98]"
              >
                Enable Speed Boost
              </button>
              <button
                onClick={handleDecline}
                className="text-subtle-light dark:text-subtle-dark hover:text-text-light dark:hover:text-text-dark py-2 text-xs font-medium transition-colors"
              >
                Not right now
              </button>
              <p className="text-subtle-light dark:text-subtle-dark mt-4 text-[10px] opacity-60">
                Requires ~40MB one-time download.
              </p>
            </div>
          )}

          {status === 'requesting' && (
            <div className="flex w-full animate-pulse flex-col items-center space-y-3 py-2">
              <div className="border-primary h-6 w-6 animate-spin rounded-full border-2 border-t-transparent" />
              <p className="text-text-light dark:text-text-dark text-sm font-medium">
                Check the permission popup...
              </p>
              <p className="text-subtle-light dark:text-subtle-dark text-[10px]">
                Please click &quot;Allow&quot; in Firefox
              </p>
            </div>
          )}

          {status === 'error' && (
            <div className="bg-error/10 border-error/20 w-full space-y-2 rounded-xl border p-4 text-center">
              <p className="text-error text-sm font-bold">❌ Setup Failed</p>
              <p className="text-subtle-light dark:text-subtle-dark text-xs">
                {errorMessage}
              </p>
              <button
                onClick={handleEnable}
                className="text-text-light dark:text-text-dark text-xs font-bold underline"
              >
                Try Again
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default FirefoxMLModal

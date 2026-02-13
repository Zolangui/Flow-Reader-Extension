import { storageGetString, storageRemove, storageSetString } from '../storage'

import {
  createModelHealthState,
  normalizeModelError,
  type ModelReasonCode,
} from './modelHealth'
import { normalizeDiacritics } from './text'

export interface RewriteHistoryMessage {
  role: 'user' | 'assistant'
  content: string
}

export type IntentLabel =
  | 'question'
  | 'explain'
  | 'summarize'
  | 'define'
  | 'analyze'
  | 'concept'
  | 'general'

export interface IntentQuery {
  type: IntentLabel
  query: string
}

export interface IntentClassification {
  intents: IntentQuery[]
  primaryQuery: string
}

const REWRITE_TIMEOUT_MS = 8000
// Gemma (wllama) may take a while on first run (download + OPFS + single-thread init).
// Avoid flipping UI to "error" just because it is slow.
const PRELOAD_TIMEOUT_MS = 5 * 60_000

let slmWorker: Worker | null = null
let reqId = 0
const pending = new Map<number, (data: any) => void>()
const SLM_CACHE_KEY = 'slm_cached_v1'
const SLM_WARNING_KEY = 'slm_warning_v1'
const SLM_BACKEND = 'wllama'
const SLM_MODEL_ID = 'unsloth/gemma-3-270m-it-GGUF@gemma-3-270m-it-Q6_K.gguf'
const SINGLE_THREAD_WARNING = 'single_thread'
const loadCachedSync = () => {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(SLM_CACHE_KEY) === '1'
  } catch {
    return false
  }
}
const loadWarningSync = () => {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage.getItem(SLM_WARNING_KEY)
  } catch {
    return null
  }
}
const saveCached = () => {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(SLM_CACHE_KEY, '1')
  } catch {
    // ignore
  }
  void storageSetString(SLM_CACHE_KEY, '1')
}
const clearCached = () => {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(SLM_CACHE_KEY)
  } catch {
    // ignore
  }
  void storageRemove(SLM_CACHE_KEY)
}
const saveWarning = (warning: string | null) => {
  if (typeof window === 'undefined') return
  try {
    if (warning) {
      window.localStorage.setItem(SLM_WARNING_KEY, warning)
    } else {
      window.localStorage.removeItem(SLM_WARNING_KEY)
    }
  } catch {
    // ignore
  }
  if (warning) void storageSetString(SLM_WARNING_KEY, warning)
  else void storageRemove(SLM_WARNING_KEY)
}
let slmWarning: string | null = loadWarningSync()
let slmStatus: 'unknown' | 'downloading' | 'ready' | 'warning' | 'error' =
  loadCachedSync() ? (slmWarning ? 'warning' : 'ready') : 'unknown'
let slmLastError: string | null = null
let slmReasonCode: ModelReasonCode = 'none'

function shouldWarnSingleThread(): boolean {
  // In Firefox MV3 (and many extension contexts), SharedArrayBuffer is unavailable unless COOP/COEP are enabled.
  // This means wllama will run single-threaded (slower) even if model download is successful.
  return (
    typeof window !== 'undefined' &&
    typeof (window as any).SharedArrayBuffer === 'undefined'
  )
}

function ensureSingleThreadWarning() {
  if (!shouldWarnSingleThread()) return
  if (slmWarning === SINGLE_THREAD_WARNING) return
  setSlmWarning(SINGLE_THREAD_WARNING)
  if (slmStatus === 'ready') emitStatus('warning')
}

async function hydratePersistedState() {
  // Prefer extension storage (survives moz-extension:// UUID changes during dev reloads).
  try {
    const cached = (await storageGetString(SLM_CACHE_KEY)) === '1'
    const warning = await storageGetString(SLM_WARNING_KEY)
    if (warning !== slmWarning) slmWarning = warning
    if (cached) {
      const next: typeof slmStatus = slmWarning ? 'warning' : 'ready'
      if (slmStatus !== next) emitStatus(next)
    }
    if (cached) ensureSingleThreadWarning()
  } catch {
    // ignore hydration failures
  }
}

if (typeof window !== 'undefined') {
  void hydratePersistedState()
}

function emitStatus(
  status: typeof slmStatus,
  reasonCode: ModelReasonCode = 'none',
  message?: string,
) {
  slmStatus = status
  slmReasonCode = reasonCode
  if (status === 'ready' || status === 'warning') {
    saveCached()
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent('slm-status', {
        detail: {
          ...createModelHealthState(status, {
            reasonCode,
            message,
            backend: SLM_BACKEND,
            modelId: SLM_MODEL_ID,
          }),
          warning: slmWarning,
        },
      }),
    )
  }
}

function setSlmWarning(code: string | null) {
  slmWarning = code
  saveWarning(code)
}

function ensureWorker() {
  if (slmWorker || typeof Worker === 'undefined') return
  try {
    slmWorker = new Worker(new URL('./slm.worker.ts', import.meta.url), {
      type: 'module',
    })
  } catch (err) {
    slmLastError = 'worker_init_failed'
    emitStatus('error', 'worker_bootstrap_failed', slmLastError)
    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('slm-error', {
          detail: {
            ...createModelHealthState('error', {
              reasonCode: 'worker_bootstrap_failed',
              message: slmLastError,
              backend: SLM_BACKEND,
              modelId: SLM_MODEL_ID,
            }),
            stage: 'init',
          },
        }),
      )
    }
    console.error('[SLM Error]', { stage: 'init', message: slmLastError, err })
    return
  }

  slmWorker.onmessage = (e: MessageEvent) => {
    const { id, fatal, type } = e.data || {}
    if (type === 'slm-ready') {
      ensureSingleThreadWarning()
      emitStatus(
        slmWarning ? 'warning' : 'ready',
        slmWarning ? 'single_thread_only' : 'none',
      )
      return
    }
    if (type === 'slm-debug') {
      if (typeof window !== 'undefined') {
        window.dispatchEvent(
          new CustomEvent('slm-debug', { detail: e.data.data }),
        )
      }
      const dbg = e?.data?.data
      if (dbg?.message === 'logger_warn') {
        const args = Array.isArray(dbg?.args) ? dbg.args : [dbg?.args]
        const joined = args.map((item: any) => String(item || '')).join(' ')
        if (joined.includes('Multi-threads are not supported')) {
          setSlmWarning(SINGLE_THREAD_WARNING)
          if (slmStatus === 'ready' || slmStatus === 'unknown') {
            emitStatus('warning', 'single_thread_only', 'single_thread_only')
          }
        }
      }
      if (
        dbg?.message === 'download_complete' ||
        dbg?.message === 'cache_hit'
      ) {
        saveCached()
        if (slmStatus === 'unknown' || slmStatus === 'downloading') {
          emitStatus(
            slmWarning ? 'warning' : 'ready',
            dbg?.message === 'cache_hit' ? 'cache_hit' : 'download_complete',
          )
        }
      }
      if (process.env.NODE_ENV !== 'production') {
        console.log('[SLM Debug]', e.data.data)
      }
      return
    }
    if (type === 'slm-error') {
      // `slm.worker.ts` may emit `slm-error` plus `{ id, error }` for an in-flight request.
      // Resolve/reject that request first so callers do not hang until timeout.
      if (typeof id === 'number') {
        const resolver = pending.get(id)
        if (resolver) {
          pending.delete(id)
          resolver({ error: e?.data?.data?.message || 'slm_error', fatal })
        }
      }
      const stage = String(e?.data?.data?.stage || 'unknown')
      const message = String(e?.data?.data?.message || 'unknown_error')
      const stack =
        typeof e?.data?.data?.stack === 'string' ? e.data.data.stack : undefined
      slmLastError = message

      // If preload is slow/flaky, we don't want to "forget" a successful download (OPFS cache hit),
      // nor do we want to punish the user with a red badge when a retry might succeed.
      //
      // Treat `preload: timeout` as a non-fatal limitation: keep cached state, surface as WARNING,
      // and keep the button clickable for retry.
      const messageLower = message.toLowerCase()
      if (stage === 'preload' && messageLower.includes('timeout')) {
        setSlmWarning('preload_timeout')
        emitStatus('warning', 'preload_timeout', message)
        if (typeof window !== 'undefined') {
          window.dispatchEvent(
            new CustomEvent('slm-error', {
              detail: {
                ...createModelHealthState('warning', {
                  reasonCode: 'preload_timeout',
                  message,
                  backend: SLM_BACKEND,
                  modelId: SLM_MODEL_ID,
                }),
                stage,
                stack,
              },
            }),
          )
        }
        console.warn('[SLM]', { stage, message, stack })
        return
      }

      // In preload flow, model-load races are recoverable and should not paint the badge red.
      // Example: "loadModel() is not yet called" right after download/cache hit.
      if (
        stage === 'preload' &&
        (messageLower.includes('loadmodel') ||
          messageLower.includes('not yet called'))
      ) {
        setSlmWarning('preload_timeout')
        emitStatus('warning', 'preload_timeout', message)
        if (typeof window !== 'undefined') {
          window.dispatchEvent(
            new CustomEvent('slm-error', {
              detail: {
                ...createModelHealthState('warning', {
                  reasonCode: 'preload_timeout',
                  message,
                  backend: SLM_BACKEND,
                  modelId: SLM_MODEL_ID,
                }),
                stage,
                stack,
              },
            }),
          )
        }
        console.warn('[SLM]', { stage, message, stack })
        return
      }

      // For other init/runtime errors, do not persist a "ready" badge across reloads.
      // The GGUF is still in OPFS and will be a cache hit next time; we just avoid lying in the UI.
      clearCached()
      const normalized = normalizeModelError(message)
      emitStatus('error', normalized.reasonCode, normalized.message)
      if (typeof window !== 'undefined') {
        window.dispatchEvent(
          new CustomEvent('slm-error', {
            detail: {
              ...createModelHealthState('error', {
                reasonCode: normalized.reasonCode,
                message: normalized.message,
                backend: SLM_BACKEND,
                modelId: SLM_MODEL_ID,
              }),
              stage,
              stack,
            },
          }),
        )
      }
      // Always log errors in production builds too; otherwise users report "red badge" with no details.
      console.error('[SLM Error]', { stage, message, stack })
      return
    }
    if (type === 'slm-progress') {
      // Dispatch progress event
      if (typeof window !== 'undefined') {
        window.dispatchEvent(
          new CustomEvent('slm-progress', { detail: e.data.data }),
        )
      }
      return
    }
    if (typeof id !== 'number') return
    const resolver = pending.get(id)
    if (resolver) {
      pending.delete(id)
      resolver(e.data)
    }
    if (fatal) {
      slmWorker?.terminate()
      slmWorker = null
      pending.forEach((r) => r({ error: 'fatal' }))
      pending.clear()
      const fatalMessage = String(
        e?.data?.error || e?.data?.data?.message || 'fatal_worker_error',
      )
      slmLastError = fatalMessage
      clearCached()
      const normalized = normalizeModelError(fatalMessage)
      emitStatus('error', normalized.reasonCode, normalized.message)
      if (typeof window !== 'undefined') {
        window.dispatchEvent(
          new CustomEvent('slm-error', {
            detail: {
              ...createModelHealthState('error', {
                reasonCode: normalized.reasonCode,
                message: normalized.message,
                backend: SLM_BACKEND,
                modelId: SLM_MODEL_ID,
              }),
              stage: 'fatal',
            },
          }),
        )
      }
      console.error('[SLM Error]', { stage: 'fatal', message: fatalMessage })
    }
  }

  slmWorker.onerror = (ev: ErrorEvent) => {
    slmWorker?.terminate()
    slmWorker = null
    pending.forEach((r) => r({ error: 'worker_error' }))
    pending.clear()
    slmLastError = String(ev?.message || 'worker_error')
    clearCached()
    const normalized = normalizeModelError(slmLastError)
    emitStatus('error', normalized.reasonCode, normalized.message)
    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('slm-error', {
          detail: {
            ...createModelHealthState('error', {
              reasonCode: normalized.reasonCode,
              message: normalized.message,
              backend: SLM_BACKEND,
              modelId: SLM_MODEL_ID,
            }),
            stage: 'worker',
            message: slmLastError,
            filename: (ev as any)?.filename,
            lineno: (ev as any)?.lineno,
            colno: (ev as any)?.colno,
          },
        }),
      )
    }
    console.error('[SLM Error]', {
      stage: 'worker',
      message: slmLastError,
      filename: (ev as any)?.filename,
      lineno: (ev as any)?.lineno,
      colno: (ev as any)?.colno,
    })
  }
}

function compactText(input: string): string {
  return (input || '')
    .replace(/Sources:[^\n\r]*/gi, '')
    .replace(/\[S\d+:C\d+\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function shouldRewrite(
  query: string,
  history: RewriteHistoryMessage[],
): boolean {
  if (!query || history.length < 2) return false
  const normalized = normalizeDiacritics(query.toLowerCase().trim())
  const words = normalized.split(/\s+/).filter(Boolean)
  if (words.length > 10) return false

  if (words.length <= 5) return true

  const markers = [
    'entao',
    'so',
    'and',
    'e',
    'mas',
    'but',
    'por que',
    'porque',
    'why',
    'como',
    'how',
  ]
  if (markers.some((m) => normalized === m || normalized.startsWith(`${m} `)))
    return true

  const pronouns = [
    'isso',
    'isto',
    'ele',
    'ela',
    'eles',
    'elas',
    'it',
    'this',
    'that',
    'they',
    'them',
  ]
  if (pronouns.some((p) => words.includes(normalizeDiacritics(p)))) return true

  return normalized.endsWith('?')
}

async function rewriteWithWorker(
  query: string,
  history: RewriteHistoryMessage[],
): Promise<string | null> {
  ensureWorker()
  if (!slmWorker) return null
  if (slmStatus === 'unknown') emitStatus('downloading')

  return new Promise((resolve) => {
    const id = ++reqId
    const timeout = setTimeout(() => {
      pending.delete(id)
      resolve(null)
    }, REWRITE_TIMEOUT_MS)

    pending.set(id, (data) => {
      clearTimeout(timeout)
      if (data?.error) return resolve(null)
      const out = String(data?.text || '').trim()
      resolve(out || null)
    })

    const safeHistory = history.slice(-4).map((m) => ({
      role: m.role,
      content: compactText(m.content).slice(0, 200),
    }))

    slmWorker!.postMessage({
      type: 'rewrite',
      id,
      query: compactText(query).slice(0, 200),
      history: safeHistory,
    })
  })
}

async function classifyWithWorker(
  query: string,
  history: RewriteHistoryMessage[],
): Promise<IntentClassification | null> {
  ensureWorker()
  if (!slmWorker) return null
  if (slmStatus === 'unknown') emitStatus('downloading')

  return new Promise((resolve) => {
    const id = ++reqId
    const timeout = setTimeout(() => {
      pending.delete(id)
      resolve(null)
    }, REWRITE_TIMEOUT_MS)

    pending.set(id, (data) => {
      clearTimeout(timeout)
      if (data?.error) return resolve(null)
      const payload = data?.payload
      if (!payload || typeof payload !== 'object') return resolve(null)

      const intents = Array.isArray(payload.intents) ? payload.intents : []
      const primaryQuery =
        typeof payload.primaryQuery === 'string'
          ? payload.primaryQuery
          : intents[0]?.query || query

      const cleanedIntents = intents
        .map((item: any) => ({
          type: String(item?.type || 'general') as IntentLabel,
          query: String(item?.query || '').trim(),
        }))
        .filter((item: IntentQuery) => item.query.length > 0)

      if (cleanedIntents.length === 0) return resolve(null)

      resolve({
        intents: cleanedIntents,
        primaryQuery: primaryQuery.trim() || query,
      })
    })

    const safeHistory = history.slice(-4).map((m) => ({
      role: m.role,
      content: compactText(m.content).slice(0, 200),
    }))

    slmWorker!.postMessage({
      type: 'classify',
      id,
      query: compactText(query).slice(0, 200),
      history: safeHistory,
    })
  })
}

export async function rewriteQueryForRetrieval(
  query: string,
  history: RewriteHistoryMessage[],
): Promise<string> {
  if (!shouldRewrite(query, history)) return query

  const rewritten = await rewriteWithWorker(query, history)
  if (!rewritten) return query

  const cleaned = rewritten.replace(/^["']|["']$/g, '').trim()
  if (!cleaned || cleaned.length < 3) return query

  return cleaned
}

export async function classifyQueryForRetrieval(
  query: string,
  history: RewriteHistoryMessage[],
): Promise<IntentClassification | null> {
  // SOTA: intent classification should work even for the first user message (no prior turns).
  // The history still helps disambiguate follow-ups, but is not required.
  if (!query) return null
  return classifyWithWorker(query, history)
}

export function getSlmStatus() {
  return slmStatus
}

export function getSlmWarning() {
  return slmWarning
}

export function getSlmLastError() {
  return slmLastError
}

export function getSlmReasonCode() {
  return slmReasonCode
}

export async function preloadSlm(): Promise<void> {
  ensureWorker()
  if (!slmWorker) return
  const shouldShowDownloading = slmStatus === 'unknown' || slmStatus === 'error'
  if (shouldShowDownloading) emitStatus('downloading', 'download_started')

  return new Promise((resolve) => {
    const id = ++reqId
    const timeout = setTimeout(() => {
      pending.delete(id)
      // Non-fatal timeout: keep the model usable/cached and surface as warning, not hard failure.
      slmLastError = 'timeout'
      setSlmWarning('preload_timeout')
      emitStatus('warning', 'preload_timeout', 'timeout')
      if (typeof window !== 'undefined') {
        window.dispatchEvent(
          new CustomEvent('slm-error', {
            detail: {
              ...createModelHealthState('warning', {
                reasonCode: 'preload_timeout',
                message: 'timeout',
                backend: SLM_BACKEND,
                modelId: SLM_MODEL_ID,
              }),
              stage: 'preload',
              message: 'timeout',
            },
          }),
        )
        window.dispatchEvent(
          new CustomEvent('slm-debug', {
            detail: {
              message: 'preload_timeout',
              timeoutMs: PRELOAD_TIMEOUT_MS,
            },
          }),
        )
      }
      console.warn('[SLM]', { stage: 'preload', message: slmLastError })
      resolve()
    }, PRELOAD_TIMEOUT_MS)

    pending.set(id, (_data) => {
      clearTimeout(timeout)
      resolve()
    })

    slmWorker!.postMessage({
      type: 'preload',
      id,
    })
  })
}

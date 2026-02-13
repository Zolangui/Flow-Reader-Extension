import TurndownService from 'turndown'
import { gfm } from 'turndown-plugin-gfm'
import { v4 as uuidv4 } from 'uuid'
import type { Voy as VoyType } from 'voy-search' // CSP-safe WASM vector engine

import { db, VectorRecord } from '../../db'
import { fileToEpub } from '../../file'
import { storageGetString, storageRemove, storageSetString } from '../storage'

import { AI_CONFIG } from './config'
import {
  isTrialMLPermissionGranted,
  isFirefoxMLApiPresent,
} from './firefoxMLState'
import { normalizeLangForRAG } from './language'
import {
  createModelHealthState,
  normalizeModelError,
  type ModelReasonCode,
} from './modelHealth'
import { bm25Search, hybridSearch } from './retrieval'

// Utility to prevent main thread blocking (UI Freeze)
const yieldToMain = () =>
  new Promise((resolve) => requestAnimationFrame(resolve))

const RAG_VERSION_BASE = (AI_CONFIG as any).ragVersion ?? 'v1'

function computeRagVersion(args: {
  model: string
  dim: number
  locale: string
}) {
  const locale = normalizeLangForRAG(args.locale || 'en')
  return `${RAG_VERSION_BASE}|model:${args.model}|dim:${args.dim}|chunk:${AI_CONFIG.chunkSize}-${AI_CONFIG.chunkOverlap}|lang:${locale}`
}

const SINGLE_THREAD_WARNING = 'single_thread'

const isFirefoxRuntime = () =>
  typeof navigator !== 'undefined' && /Firefox/i.test(navigator.userAgent || '')

const FIREFOX_EMBED_MODEL_ID = (AI_CONFIG as any).embeddingModelFirefox as
  | string
  | undefined
const FIREFOX_EMBED_MODEL_URL = (AI_CONFIG as any).embeddingModelFirefoxUrl as
  | string
  | undefined
const FIREFOX_EMBED_DIM = (AI_CONFIG as any).embeddingDimFirefox as
  | number
  | undefined
const FIREFOX_EMBED_PREFIXES = (AI_CONFIG as any)
  .embeddingModelFirefoxPrefixes as
  | { query?: string; document?: string }
  | undefined
const FIREFOX_NATIVE_ML_MODEL_ID = 'Xenova/multilingual-e5-base'
const FIREFOX_NATIVE_MODEL_ID_PATTERN =
  /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)?$/

function resolveFirefoxNativeModelId(candidate?: string): string {
  const modelId = String(candidate || '').trim()
  if (
    modelId &&
    FIREFOX_NATIVE_MODEL_ID_PATTERN.test(modelId) &&
    !modelId.includes('@') &&
    !/gguf/i.test(modelId)
  ) {
    return modelId
  }
  return FIREFOX_NATIVE_ML_MODEL_ID
}

function forceEmbeddingDim(
  vec: Float32Array,
  targetDim?: number,
): Float32Array {
  const target = Number(targetDim)
  if (!Number.isFinite(target) || target <= 0) return vec
  if (vec.length === target) return vec
  if (vec.length > target) return vec.slice(0, target)
  const out = new Float32Array(target)
  out.set(vec)
  return out
}

const getEmbeddingConfig = () => {
  if (isFirefoxRuntime() && FIREFOX_EMBED_MODEL_ID && FIREFOX_EMBED_MODEL_URL) {
    return {
      // NOTE: backend is now auto-detected in the worker (WebGPU â†’ wllama fallback)
      // Previously hardcoded to 'wllama', now undefined to let worker decide
      backend: undefined,
      id: FIREFOX_EMBED_MODEL_ID,
      url: FIREFOX_EMBED_MODEL_URL,
      dim: FIREFOX_EMBED_DIM || AI_CONFIG.embeddingDim,
      prefixes: FIREFOX_EMBED_PREFIXES,
    }
  }

  return {
    backend: 'onnx' as const,
    id: AI_CONFIG.embeddingModel,
    dim: AI_CONFIG.embeddingDim,
  }
}

const shouldWarnEmbeddingSingleThread = () => {
  // Only relevant for Firefox wllama backend: without SharedArrayBuffer (COOP/COEP), wasm multi-thread is unavailable.
  const cfg = getEmbeddingConfig()
  const isFirefoxWllama = isFirefoxRuntime() && !!cfg.url
  if (cfg.backend !== 'wllama' && !isFirefoxWllama) return false
  return (
    typeof window !== 'undefined' &&
    typeof (window as any).SharedArrayBuffer === 'undefined'
  )
}

const EMBEDDING_CACHE_PREFIX = 'embedding_cached_v1:'
const EMBEDDING_WARNING_PREFIX = 'embedding_warning_v1:'
const getEmbeddingBackend = () => {
  const cfg = getEmbeddingConfig() as any
  if (cfg?.backend) return String(cfg.backend)
  if (cfg?.url) return 'wllama'
  return 'onnx'
}
const getEmbeddingCacheKey = () => {
  if (typeof window === 'undefined') return null
  const id = getEmbeddingConfig().id || 'default'
  return `${EMBEDDING_CACHE_PREFIX}${id}`
}
const getEmbeddingWarningKey = () => {
  if (typeof window === 'undefined') return null
  const id = getEmbeddingConfig().id || 'default'
  return `${EMBEDDING_WARNING_PREFIX}${id}`
}
const loadEmbeddingCached = () => {
  const key = getEmbeddingCacheKey()
  if (!key) return false
  try {
    return window.localStorage.getItem(key) === '1'
  } catch {
    return false
  }
}
const saveEmbeddingCached = () => {
  const key = getEmbeddingCacheKey()
  if (!key) return
  try {
    window.localStorage.setItem(key, '1')
  } catch {
    // ignore
  }
  void storageSetString(key, '1')
}
const clearEmbeddingCached = () => {
  const key = getEmbeddingCacheKey()
  if (!key) return
  try {
    window.localStorage.removeItem(key)
  } catch {
    // ignore
  }
  void storageRemove(key)
}
const loadEmbeddingWarning = () => {
  const key = getEmbeddingWarningKey()
  if (!key) return null
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}
const saveEmbeddingWarning = (warning: string | null) => {
  const key = getEmbeddingWarningKey()
  if (!key) return
  try {
    if (warning) {
      window.localStorage.setItem(key, warning)
    } else {
      window.localStorage.removeItem(key)
    }
  } catch {
    // ignore
  }
  if (warning) void storageSetString(key, warning)
  else void storageRemove(key)
}

// ============================================================================
// SOTA 2026: Firefox Native ML API (browser.trial.ml)
// Runs embeddings in native C++ process, 2-10x faster than WASM
// NOTE: browser.trial.ml is ONLY accessible in background scripts.
// Permission and consent are now handled by firefoxMLState.ts + FirefoxMLModal
// ============================================================================

let firefoxMLAvailable: boolean | null = null

function isFirefoxMLBackgroundUnavailableError(err: any): boolean {
  const msg = String(err?.message || err || '')
  return (
    /Receiving end does not exist/i.test(msg) ||
    /Could not establish connection/i.test(msg)
  )
}

function isEngineAlreadyCreatedErrorMessage(msg: string): boolean {
  return /engine already created/i.test(msg)
}

function shouldDisableFirefoxMLPath(msg: string): boolean {
  return (
    /Receiving end does not exist/i.test(msg) ||
    /Could not establish connection/i.test(msg) ||
    /Firefox ML not available/i.test(msg)
  )
}

/**
 * Detect if browser.trial.ml is available via the background script.
 * Returns cached result if already checked.
 */
async function hasFirefoxNativeML(): Promise<boolean> {
  if (firefoxMLAvailable !== null) return firefoxMLAvailable

  try {
    // Check permission first
    const hasPermission = await isTrialMLPermissionGranted()
    console.log('[RAG] trialML permission granted:', hasPermission)

    if (!hasPermission) {
      console.log('[RAG] Firefox Native ML: trialML permission not granted')
      firefoxMLAvailable = false
      return false
    }

    // Check if API is present in background
    const apiPresent = await isFirefoxMLApiPresent()
    console.log('[RAG] Firefox Native ML API present:', apiPresent)

    firefoxMLAvailable = apiPresent
    return apiPresent
  } catch (err: any) {
    console.log('[RAG] Firefox Native ML check error:', err?.message)
    firefoxMLAvailable = false
    return false
  }
}

/**
 * Reset Firefox ML availability cache (call after permission granted)
 */
export function resetFirefoxMLCache(): void {
  firefoxMLAvailable = null
}

/**
 * Perform embedding using Firefox Native ML API via background script.
 * Returns Float32Array embedding vector.
 */
async function embedWithFirefoxML(
  text: string,
  modelId: string,
  prefix?: string,
): Promise<Float32Array> {
  const nativeModelId = resolveFirefoxNativeModelId(modelId)
  if (nativeModelId !== modelId) {
    console.log(
      '[RAG] Adjusted Firefox ML modelId for native API compatibility:',
      {
        requestedModelId: modelId,
        nativeModelId,
      },
    )
  }
  console.log('[RAG] embedWithFirefoxML called:', {
    modelId: nativeModelId,
    textLen: text.length,
    prefix,
  })

  const browserApi = (window as any).browser || (window as any).chrome
  if (!browserApi?.runtime?.sendMessage) {
    console.error('[RAG] No runtime.sendMessage available')
    throw new Error('No runtime.sendMessage available')
  }

  console.log('[RAG] Sending firefox-ml-embed to background...')

  // Send embedding request to background script
  let response: any
  try {
    response = await browserApi.runtime.sendMessage({
      type: 'firefox-ml-embed',
      payload: { text, modelId: nativeModelId, prefix },
    })
  } catch (err: any) {
    if (isFirefoxMLBackgroundUnavailableError(err)) {
      // Background script endpoint is unavailable right now.
      // Disable Native ML path for this runtime session and fall back gracefully.
      firefoxMLAvailable = false
    }
    throw err
  }

  console.log('[RAG] Background response:', response)

  if (response?.error) {
    const errMsg = String(response.error)
    console.error('[RAG] Background returned error:', errMsg)

    // Transient/race-safe retry: engine may already exist while background key cache was cold.
    if (isEngineAlreadyCreatedErrorMessage(errMsg)) {
      console.warn(
        '[RAG] Retrying Firefox ML embed after engine-already-created signal...',
      )
      const retry = await browserApi.runtime.sendMessage({
        type: 'firefox-ml-embed',
        payload: { text, modelId: nativeModelId, prefix },
      })
      console.log('[RAG] Background retry response:', retry)
      if (retry?.embedding) {
        return new Float32Array(retry.embedding)
      }
      if (retry?.error) {
        const retryMsg = String(retry.error)
        if (shouldDisableFirefoxMLPath(retryMsg)) {
          firefoxMLAvailable = false
        }
        throw new Error(retryMsg)
      }
      throw new Error('No embedding in retry response')
    }

    if (shouldDisableFirefoxMLPath(errMsg)) {
      firefoxMLAvailable = false // disable only when endpoint/path is truly unavailable
    }
    throw new Error(errMsg)
  }

  if (!response?.embedding) {
    console.error('[RAG] No embedding in response:', response)
    throw new Error('No embedding in response')
  }

  console.log(
    '[RAG] Firefox ML embedding received, length:',
    response.embedding.length,
  )
  return new Float32Array(response.embedding)
}

// (Blob workers + `unsafe-eval` are blocked in AMO-safe builds).

export class IndexCompatibilityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'IndexCompatibilityError'
  }
}

/**
 * SOTA 2026: RAG Service (Worker Proxy Model)
 * Orchestrates document splitting, embedding, and vector search.
 * Uses a Web Worker to move heavy computations out of the Main Thread.
 */
export class RAGService {
  private static instance: RAGService
  private worker: Worker | null = null // indexing worker (ephemeral)
  private embedWorker: Worker | null = null // embedding worker (persistent)
  private embedPending = new Map<
    number,
    { resolve: (v: Float32Array) => void; reject: (e: Error) => void }
  >()
  private embedNextId = 1
  private embedInitKey: string | null = null
  private embedInitPromise: Promise<void> | null = null
  private embedInitResolve: (() => void) | null = null
  private embedInitReject: ((e: Error) => void) | null = null
  private embedOutputDim: number | null = null

  // SOTA v3.9.1: Optimization Caches
  private static voyInstances = new Map<
    string,
    { chunks: VoyType; chapters?: VoyType }
  >()
  private static allChunksCache = new Map<string, VectorRecord[]>()
  private static cacheAccessTime = new Map<string, number>()
  private static MAX_BOOKS_IN_RAM = 2

  private static embeddingWarning: string | null = loadEmbeddingWarning()
  private static embeddingStatus:
    | 'unknown'
    | 'downloading'
    | 'ready'
    | 'warning'
    | 'error' = loadEmbeddingCached()
    ? RAGService.embeddingWarning
      ? 'warning'
      : 'ready'
    : 'unknown'
  private static deferEmbedReadyCount = 0
  private static firefoxWarmupInFlight: Promise<void> | null = null
  private static firefoxWarmupInFlightModelId: string | null = null
  private static firefoxWarmupReadyModelId: string | null = null
  private static embeddingLastError: string | null = null
  private static embeddingReasonCode: ModelReasonCode = 'none'
  private static emitEmbeddingStatus(
    status: typeof RAGService.embeddingStatus,
    reasonCode: ModelReasonCode = 'none',
    message?: string,
  ) {
    RAGService.embeddingStatus = status
    RAGService.embeddingReasonCode = reasonCode
    if (status === 'ready' || status === 'warning') {
      saveEmbeddingCached()
    }
    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('embedding-status', {
          detail: {
            ...createModelHealthState(status, {
              reasonCode,
              message,
              backend: getEmbeddingBackend(),
              modelId: getEmbeddingConfig().id,
            }),
            warning: RAGService.embeddingWarning,
          },
        }),
      )
    }
  }
  private static emitEmbeddingError(message: string, stage?: string) {
    RAGService.embeddingLastError = message
    const normalized = normalizeModelError(message)
    if (normalized.isFatal) {
      // Fatal init/runtime failure: don't persist stale "ready" cache across reloads.
      clearEmbeddingCached()
      RAGService.emitEmbeddingStatus(
        'error',
        normalized.reasonCode,
        normalized.message,
      )
    } else {
      // Non-fatal (e.g. preload timeout): stay operational with warning.
      RAGService.setEmbeddingWarning('preload_timeout')
      RAGService.emitEmbeddingStatus(
        'warning',
        normalized.reasonCode,
        normalized.message,
      )
    }
    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('embedding-error', {
          detail: {
            ...createModelHealthState(
              normalized.isFatal ? 'error' : 'warning',
              {
                reasonCode: normalized.reasonCode,
                message: normalized.message,
                backend: getEmbeddingBackend(),
                modelId: getEmbeddingConfig().id,
              },
            ),
            stage,
          },
        }),
      )
    }
    if (normalized.isFatal) {
      // Always log fatal errors in production builds too; otherwise users see a red badge with no details.
      console.error('[Embedding Error]', { message, stage })
    } else {
      console.warn('[Embedding Warning]', { message, stage })
    }
  }
  private static emitReadyStatus() {
    if (
      shouldWarnEmbeddingSingleThread() &&
      RAGService.embeddingWarning !== SINGLE_THREAD_WARNING
    ) {
      RAGService.setEmbeddingWarning(SINGLE_THREAD_WARNING)
    }
    RAGService.emitEmbeddingStatus(
      RAGService.embeddingWarning ? 'warning' : 'ready',
      RAGService.embeddingWarning ? 'single_thread_only' : 'none',
    )
  }
  private static setEmbeddingWarning(code: string | null) {
    RAGService.embeddingWarning = code
    saveEmbeddingWarning(code)
  }

  private static handleEmbeddingDebug(data: any) {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('embedding-debug', { detail: data }))
    }
    if (process.env.NODE_ENV !== 'production') {
      console.log('[Embedding Debug]', data)
    }

    if (data?.message === 'logger_warn') {
      const args = Array.isArray(data?.args) ? data.args : [data?.args]
      const joined = args.map((item: any) => String(item || '')).join(' ')
      if (joined.includes('Multi-threads are not supported')) {
        RAGService.setEmbeddingWarning(SINGLE_THREAD_WARNING)
        if (
          RAGService.embeddingStatus === 'ready' ||
          RAGService.embeddingStatus === 'unknown'
        ) {
          RAGService.emitEmbeddingStatus(
            'warning',
            'single_thread_only',
            'single_thread_only',
          )
        }
      }
    }

    // Mark cached so the UI doesn't reset to "download" after refresh.
    if (
      data?.message === 'download_complete' ||
      data?.message === 'cache_hit'
    ) {
      saveEmbeddingCached()
      if (
        RAGService.embeddingStatus === 'unknown' ||
        RAGService.embeddingStatus === 'downloading'
      ) {
        RAGService.emitReadyStatus()
      }
    }
  }

  private static handleEmbeddingProgress(data: any) {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('embedding-progress', { detail: data }),
      )
    }
  }

  private isPreciseCfi(cfi: any): boolean {
    return (
      typeof cfi === 'string' &&
      cfi.startsWith('epubcfi(') &&
      cfi.includes('!') &&
      /:\d+/.test(cfi)
    )
  }

  private normalizeAnchorText(value: string): string {
    return String(value || '')
      .replace(/\s+/g, ' ')
      .replace(/[^\w\s\u00C0-\u024F]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase()
  }

  private buildAnchorProbes(content: string): string[] {
    const normalized = this.normalizeAnchorText(content)
    const words = normalized.split(/\s+/).filter(Boolean)
    if (words.length === 0) return []

    const probes: string[] = []
    const starts = [26, 20, 16, 12, 9]
    for (const n of starts) {
      if (words.length >= n) probes.push(words.slice(0, n).join(' '))
    }

    const middleStart = Math.max(0, Math.floor(words.length / 2) - 7)
    if (words.length >= middleStart + 12)
      probes.push(words.slice(middleStart, middleStart + 12).join(' '))
    if (words.length >= middleStart + 9)
      probes.push(words.slice(middleStart, middleStart + 9).join(' '))

    return Array.from(new Set(probes.filter((p) => p.length >= 36)))
  }

  private scoreAnchorMatch(contentNorm: string, excerptNorm: string): number {
    if (!excerptNorm) return 0
    let score = 0
    if (contentNorm.includes(excerptNorm)) score += 4
    const prefix = contentNorm.slice(0, 120)
    if (prefix && excerptNorm.includes(prefix)) score += 3
    if (
      prefix &&
      contentNorm.includes(
        excerptNorm.slice(0, Math.min(80, excerptNorm.length)),
      )
    )
      score += 1

    const contentWords = new Set(contentNorm.split(/\s+/).filter(Boolean))
    const excerptWords = excerptNorm.split(/\s+/).filter(Boolean)
    let overlap = 0
    for (const word of excerptWords) {
      if (contentWords.has(word)) overlap++
    }
    score += overlap / Math.max(1, excerptWords.length)
    return score
  }

  private resolveExactCfiForChunk(
    section: any,
    content: string,
  ): string | null {
    const probes = this.buildAnchorProbes(content)
    if (probes.length === 0) return null
    const contentNorm = this.normalizeAnchorText(content)

    for (const probe of probes) {
      let matches: any[] = []
      try {
        matches = (section.find(probe) || []) as any[]
      } catch {
        continue
      }
      const withCfi = matches.filter(
        (m) => typeof m?.cfi === 'string' && m.cfi.startsWith('epubcfi('),
      )
      if (withCfi.length === 0) continue
      if (withCfi.length === 1) return withCfi[0].cfi as string

      let best: { cfi: string; score: number } | null = null
      for (const m of withCfi) {
        const cfi = String(m.cfi || '')
        const excerptNorm = this.normalizeAnchorText(String(m.excerpt || ''))
        const score = this.scoreAnchorMatch(contentNorm, excerptNorm)
        if (!best || score > best.score) best = { cfi, score }
      }
      if (best && best.score >= 1.25) return best.cfi
      if (best) return best.cfi
    }

    return null
  }

  private buildDeterministicChunkAnchors(
    sectionNormalizedText: string,
    records: any[],
  ): Map<string, { start: number; end: number }> {
    const anchors = new Map<string, { start: number; end: number }>()
    let cursor = 0
    const ordered = [...records].sort(
      (a, b) => Number(a?.index || 0) - Number(b?.index || 0),
    )

    for (const record of ordered) {
      const id = String(record?.id || '')
      if (!id) continue

      const contentNorm = this.normalizeAnchorText(
        String(record?.content || ''),
      )
      if (contentNorm.length < 24) continue

      let foundAt = sectionNormalizedText.indexOf(
        contentNorm,
        Math.max(0, cursor),
      )
      if (foundAt === -1) {
        foundAt = sectionNormalizedText.indexOf(contentNorm)
      }
      if (foundAt === -1) continue

      const start = foundAt
      const end = foundAt + contentNorm.length
      anchors.set(id, { start, end })

      // Monotonic cursor to favor reading-order matches
      if (end > cursor) cursor = end
    }

    return anchors
  }

  private async enrichChunkAnchorsWithExactCfi(
    epub: any,
    spineItems: any[],
    bookId: string,
  ): Promise<{ total: number; updated: number }> {
    const vectors =
      (await db?.vectors.where('bookId').equals(bookId).toArray()) || []
    const pending = vectors.filter((record: any) => {
      const sec = record?.metadata?.sectionIndex
      if (!Number.isFinite(sec) || sec < 0) return false
      if (!record?.content || String(record.content).trim().length < 24)
        return false
      const existing = record?.metadata?.cfiExact || record?.metadata?.cfi
      return !this.isPreciseCfi(existing)
    })

    if (pending.length === 0) return { total: 0, updated: 0 }

    const bySection = new Map<number, any[]>()
    for (const record of pending) {
      const sec = Number(record.metadata?.sectionIndex)
      if (!bySection.has(sec)) bySection.set(sec, [])
      bySection.get(sec)!.push(record)
    }

    let updated = 0
    let doneSections = 0
    const totalSections = bySection.size
    const startedAt = Date.now()

    for (const [sectionIndex, records] of bySection.entries()) {
      const item =
        spineItems[sectionIndex] ||
        (sectionIndex > 0 ? spineItems[sectionIndex - 1] : null)

      if (!item || typeof item.load !== 'function') {
        doneSections++
        continue
      }

      const updates: any[] = []
      try {
        await item.load(epub.load.bind(epub))
        if (typeof item.find !== 'function') {
          doneSections++
          continue
        }

        const sectionTextNorm = this.normalizeAnchorText(
          String(item?.document?.body?.textContent || ''),
        )
        const deterministicAnchors = this.buildDeterministicChunkAnchors(
          sectionTextNorm,
          records,
        )

        for (const record of records) {
          const nextMetadata = { ...(record.metadata || {}) }
          let changed = false

          const deterministic = deterministicAnchors.get(
            String(record?.id || ''),
          )
          if (deterministic) {
            nextMetadata.anchorStartNorm = deterministic.start
            nextMetadata.anchorEndNorm = deterministic.end
            nextMetadata.anchorAlgo = 'seq_v1'
            changed = true
          }

          const existingPrecise = nextMetadata.cfiExact || nextMetadata.cfi
          if (!this.isPreciseCfi(existingPrecise)) {
            const exactCfi = this.resolveExactCfiForChunk(
              item,
              String(record.content || ''),
            )
            if (exactCfi) {
              nextMetadata.cfi = exactCfi
              nextMetadata.cfiExact = exactCfi
              nextMetadata.anchorSource = 'section.find'
              changed = true
            }
          }

          if (changed) {
            updates.push({ ...record, metadata: nextMetadata })
          }
        }
      } catch (err: any) {
        console.warn(
          `[RAG] Anchor enrichment failed for section ${sectionIndex}: ${String(
            err?.message || err,
          )}`,
        )
      } finally {
        try {
          item.unload()
        } catch {
          // ignore unload errors
        }
      }

      if (updates.length > 0) {
        await db?.vectors.bulkPut(updates)
        updated += updates.length
      }

      doneSections++
      if (
        doneSections === 1 ||
        doneSections % 4 === 0 ||
        doneSections === totalSections
      ) {
        const elapsedMs = Date.now() - startedAt
        console.log('[RAG] Anchor enrichment progress:', {
          doneSections,
          totalSections,
          updated,
          totalPending: pending.length,
          elapsedMs,
        })
      }
      await yieldToMain()
    }

    return { total: pending.length, updated }
  }

  private static handleEmbeddingError(data: any) {
    const msg = String(data?.message || 'embedding_error')
    RAGService.emitEmbeddingError(msg, data?.stage)
  }

  static getEmbeddingStatus() {
    return RAGService.embeddingStatus
  }
  static getEmbeddingWarning() {
    return RAGService.embeddingWarning
  }
  static getEmbeddingLastError() {
    return RAGService.embeddingLastError
  }

  static getEmbeddingReasonCode() {
    return RAGService.embeddingReasonCode
  }

  static async hydratePersistedState(): Promise<void> {
    if (typeof window === 'undefined') return

    // Use extension storage when available (survives moz-extension:// UUID changes in dev reloads).
    const cacheKey = getEmbeddingCacheKey()
    const warningKey = getEmbeddingWarningKey()
    if (!cacheKey || !warningKey) return

    try {
      const cached = (await storageGetString(cacheKey)) === '1'
      const warning = await storageGetString(warningKey)
      if (warning !== RAGService.embeddingWarning) {
        RAGService.setEmbeddingWarning(warning)
      }
      if (cached) {
        if (
          shouldWarnEmbeddingSingleThread() &&
          RAGService.embeddingWarning !== SINGLE_THREAD_WARNING
        ) {
          RAGService.setEmbeddingWarning(SINGLE_THREAD_WARNING)
        }
        RAGService.emitReadyStatus()
      }
    } catch {
      // ignore hydration failures
    }
  }

  private static async warmupFirefoxNativeML(
    modelId: string,
    timeoutMs = 300_000,
  ): Promise<void> {
    const browserApi = (globalThis as any).browser || (globalThis as any).chrome
    if (!browserApi?.runtime?.sendMessage) {
      throw new Error('firefox_ml_warmup_runtime_unavailable')
    }

    const nativeModelId = resolveFirefoxNativeModelId(modelId)
    if (RAGService.firefoxWarmupReadyModelId === nativeModelId) {
      return
    }
    if (
      RAGService.firefoxWarmupInFlight &&
      RAGService.firefoxWarmupInFlightModelId === nativeModelId
    ) {
      return RAGService.firefoxWarmupInFlight
    }

    const warmupPromise = (async () => {
      console.log('[RAG] Warming up Firefox ML engine...')

      let timeoutHandle: ReturnType<typeof setTimeout> | null = null
      try {
        const response = (await Promise.race([
          browserApi.runtime.sendMessage({
            type: 'firefox-ml-embed',
            payload: { text: 'warmup', modelId: nativeModelId },
          }),
          new Promise((_, reject) => {
            timeoutHandle = setTimeout(
              () => reject(new Error('firefox_ml_warmup_timeout')),
              timeoutMs,
            )
          }),
        ])) as any

        if (response?.error) {
          throw new Error(String(response.error))
        }

        RAGService.firefoxWarmupReadyModelId = nativeModelId
        console.log('[RAG] Firefox ML warmup complete')
      } catch (err: any) {
        if (isFirefoxMLBackgroundUnavailableError(err)) {
          // Background listener dropped (common during dev reload / worker restart).
          // Mark Native ML unavailable so subsequent flows skip delegation.
          firefoxMLAvailable = false
          throw new Error('firefox_ml_background_unavailable')
        }
        throw err
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle)
      }
    })()

    RAGService.firefoxWarmupInFlightModelId = nativeModelId
    RAGService.firefoxWarmupInFlight = warmupPromise

    try {
      await warmupPromise
    } finally {
      if (RAGService.firefoxWarmupInFlight === warmupPromise) {
        RAGService.firefoxWarmupInFlight = null
        RAGService.firefoxWarmupInFlightModelId = null
      }
    }
  }
  static async preloadEmbeddings(
    locale = 'en',
    options?: { downloadLocalModels?: boolean },
  ): Promise<void> {
    const allowDownload = options?.downloadLocalModels !== false
    // DIAGNOSTIC: Check Firefox ML availability (no auto-request)
    // Permission is now handled by FirefoxMLModal component
    let mlAvailable = false
    if (isFirefoxRuntime()) {
      console.log('[RAG] Firefox detected. Checking Native ML status...')
      mlAvailable = await hasFirefoxNativeML()
      console.log('[RAG] Firefox Native ML available:', mlAvailable)
    }

    const embedConfig = getEmbeddingConfig()
    const inst = RAGService.getInstance()
    const ragLocale = normalizeLangForRAG(locale, 'en')
    const shouldWarmupNative = mlAvailable && allowDownload
    let warmupStarted = false
    if (shouldWarmupNative) {
      RAGService.deferEmbedReadyCount += 1
    }

    try {
      const shouldShowDownloading =
        RAGService.embeddingStatus === 'unknown' ||
        RAGService.embeddingStatus === 'error'
      if (shouldShowDownloading) {
        RAGService.emitEmbeddingStatus('downloading', 'download_started')
      }
      await inst.ensureEmbeddingWorkerInitialized(
        embedConfig,
        ragLocale,
        embedConfig.dim,
        {
          downloadLocalModels: allowDownload,
        },
      )
      if (shouldWarmupNative) {
        warmupStarted = true
        await RAGService.warmupFirefoxNativeML(embedConfig.id)
      }
      RAGService.emitReadyStatus()
    } catch (err: any) {
      const msg = String(err?.message || err)
      if (warmupStarted) {
        if (msg.includes('firefox_ml_background_unavailable')) {
          // Non-fatal: keep UX smooth and use worker fallback without noisy warning.
          console.warn(
            '[RAG] Firefox ML background unavailable during warmup. Falling back to worker embeddings.',
          )
          RAGService.emitReadyStatus()
          return
        }
        // Warmup failures are non-fatal; keep model operational with warning/fallback.
        RAGService.emitEmbeddingError(`warmup_timeout: ${msg}`, 'preload')
      } else {
        RAGService.emitEmbeddingError(msg, 'preload')
      }
    } finally {
      if (shouldWarmupNative) {
        RAGService.deferEmbedReadyCount = Math.max(
          0,
          RAGService.deferEmbedReadyCount - 1,
        )
      }
    }
  }

  private constructor() {}

  static getInstance(): RAGService {
    if (!RAGService.instance) {
      RAGService.instance = new RAGService()
    }
    return RAGService.instance
  }

  private getWorker(): Worker {
    if (!this.worker) {
      // Next.js 12 / Webpack 5 standard for Worker instantiation
      this.worker = new Worker(new URL('./rag.worker.ts', import.meta.url), {
        type: 'module',
      })
    }
    return this.worker
  }

  private getEmbeddingWorker(): Worker {
    if (!this.embedWorker) {
      this.embedWorker = new Worker(
        new URL('./rag.worker.ts', import.meta.url),
        {
          type: 'module',
        },
      )

      this.embedWorker.addEventListener('message', (e: MessageEvent) => {
        const { type, payload, data, requestId } = (e as any).data || {}

        if (type === 'embed-result') {
          const rid = Number(requestId)
          const pending = this.embedPending.get(rid)
          if (!pending) return
          this.embedPending.delete(rid)

          const err = payload?.error
          if (err) {
            pending.reject(new Error(String(err)))
            return
          }

          const vec = payload?.vector
          if (vec instanceof Float32Array) {
            pending.resolve(vec)
          } else if (vec?.buffer) {
            pending.resolve(new Float32Array(vec.buffer))
          } else {
            pending.reject(new Error('Invalid embed result'))
          }
          return
        }

        if (type === 'embedding-debug') {
          RAGService.handleEmbeddingDebug(data)
          return
        }

        if (type === 'rag-progress') {
          RAGService.handleEmbeddingProgress(data)
          return
        }

        if (type === 'embedding-error') {
          RAGService.handleEmbeddingError(data)
          return
        }

        if (type === 'initialized') {
          this.embedOutputDim = Number(payload?.dim) || null
          if (this.embedInitResolve) {
            const resolve = this.embedInitResolve
            this.embedInitResolve = null
            this.embedInitReject = null
            resolve()
          }
          if (RAGService.deferEmbedReadyCount > 0) {
            console.log(
              '[RAG] Delaying ready status until Firefox ML warmup completes...',
            )
          } else {
            RAGService.emitReadyStatus()
          }
          return
        }

        if (type === 'request-embedding-batch') {
          console.log('[RAG-MAIN-DEBUG] Batch request from worker')
          const batchId = Number(payload?.id)

          const browser =
            (globalThis as any).browser || (globalThis as any).chrome
          console.log(
            '[RAG-MAIN-DEBUG] Forwarding batch to background script...',
            { count: payload.texts.length },
          )

          browser.runtime
            .sendMessage({
              type: 'firefox-ml-embed-batch',
              payload: {
                texts: payload.texts,
                modelId: resolveFirefoxNativeModelId(payload?.modelId),
              },
            })
            .then((response: any) => {
              if (response?.error) {
                console.log(
                  '[RAG-MAIN-DEBUG] Background returned error:',
                  response.error,
                )
                this.embedWorker?.postMessage({
                  type: 'embedding-batch-response',
                  payload: { id: batchId, error: response.error },
                })
              } else if (Array.isArray(response)) {
                console.log(
                  '[RAG-MAIN-DEBUG] Background returned vectors. Count:',
                  response.length,
                )
                const vectors = response.map((v: any) => new Float32Array(v))
                this.embedWorker?.postMessage({
                  type: 'embedding-batch-response',
                  payload: { id: batchId, vectors },
                })
              } else {
                this.embedWorker?.postMessage({
                  type: 'embedding-batch-response',
                  payload: {
                    id: batchId,
                    error: 'Invalid response from background',
                  },
                })
              }
            })
            .catch((err: any) => {
              console.log('[RAG-MAIN-DEBUG] runtime.sendMessage failed:', err)
              if (isFirefoxMLBackgroundUnavailableError(err)) {
                firefoxMLAvailable = false
              }
              this.embedWorker?.postMessage({
                type: 'embedding-batch-response',
                payload: { id: batchId, error: err.message || String(err) },
              })
            })
          return
        }
        if (type === 'request-embedding') {
          // SOTA: Worker requesting main-thread embedding (Firefox Native ML)
          const { id, text, modelId } = payload
          embedWithFirefoxML(text, modelId)
            .then((vec) => {
              this.embedWorker?.postMessage(
                {
                  type: 'embedding-response',
                  payload: { id, vector: vec },
                },
                [vec.buffer],
              )
            })
            .catch((err) => {
              this.embedWorker?.postMessage({
                type: 'embedding-response',
                payload: { id, error: String(err?.message || err) },
              })
            })
          return
        }

        if (type === 'error') {
          const reason = String(payload?.reason || payload || 'worker_error')
          if (reason.startsWith('FAILED_INIT:') && this.embedInitReject) {
            const reject = this.embedInitReject
            this.embedInitResolve = null
            this.embedInitReject = null
            reject(new Error(reason))
            return
          }
        }
      })

      this.embedWorker.addEventListener('error', () => {
        // Worker died; force re-init next time.
        this.embedInitPromise = null
        this.embedInitKey = null
        this.embedOutputDim = null
        this.embedWorker?.terminate()
        this.embedWorker = null
        RAGService.emitEmbeddingError('embedding_worker_error', 'runtime')
      })
    }
    return this.embedWorker
  }

  private embeddingInitKey(
    embedConfig: ReturnType<typeof getEmbeddingConfig>,
    locale: string,
    truncateDim?: number,
    firefoxDelegate?: boolean,
    options?: { downloadLocalModels?: boolean },
  ) {
    const prefixes = (embedConfig as any).prefixes || {}
    const url = (embedConfig as any).url || ''
    return [
      String(embedConfig.backend),
      String(embedConfig.id),
      String(url),
      String(truncateDim || ''),
      String(locale || ''),
      `delegate:${firefoxDelegate ? '1' : '0'}`,
      `download:${options?.downloadLocalModels !== false ? '1' : '0'}`,
      `q:${String(prefixes.query || '')}`,
      `d:${String(prefixes.document || '')}`,
    ].join('|')
  }

  private buildEmbeddingInitPayload(
    embedConfig: ReturnType<typeof getEmbeddingConfig>,
    locale: string,
    truncateDim?: number,
    firefoxDelegate?: boolean,
    options?: { downloadLocalModels?: boolean },
  ) {
    const payload: any = {
      backend: embedConfig.backend, // Can be undefined for auto-detection
      modelId: embedConfig.id,
      locale,
      truncateDim: truncateDim || embedConfig.dim,
      firefoxDelegate,
      config: {
        downloadLocalModels: options?.downloadLocalModels !== false,
      },
    }
    if (
      embedConfig.backend === 'wllama' ||
      (!embedConfig.backend && isFirefoxRuntime())
    ) {
      payload.modelUrl = (embedConfig as any).url
      payload.embeddingPrefixes = (embedConfig as any).prefixes
    }

    // If it's explicitly transformers, or we are on other browsers (fallback to transformers)
    if (
      embedConfig.backend === 'transformers' ||
      (!embedConfig.backend && !isFirefoxRuntime())
    ) {
      payload.model = embedConfig.id
    }

    return payload
  }

  private async ensureEmbeddingWorkerInitialized(
    embedConfig: ReturnType<typeof getEmbeddingConfig>,
    locale: string,
    truncateDim?: number,
    options?: { downloadLocalModels?: boolean },
  ): Promise<void> {
    const isFirefox = isFirefoxRuntime()
    const hasNativeML = isFirefox ? await hasFirefoxNativeML() : false
    const key = this.embeddingInitKey(
      embedConfig,
      locale,
      truncateDim,
      hasNativeML,
      options,
    )
    if (this.embedInitPromise && this.embedInitKey === key) {
      return this.embedInitPromise
    }

    const worker = this.getEmbeddingWorker()
    this.embedInitKey = key

    this.embedInitPromise = new Promise<void>((resolve, reject) => {
      this.embedInitResolve = resolve
      this.embedInitReject = reject
    })

    worker.postMessage({
      type: 'init',
      payload: this.buildEmbeddingInitPayload(
        embedConfig,
        locale,
        truncateDim,
        hasNativeML,
        options,
      ),
    })

    return this.embedInitPromise
  }

  private async embedInWorker(
    text: string,
    mode: 'query' | 'document',
    embedConfig: ReturnType<typeof getEmbeddingConfig>,
    locale: string,
    truncateDim?: number,
  ): Promise<Float32Array> {
    // SOTA 2026: Try Firefox Native ML first (main thread, 2-10x faster)
    const isFirefox = isFirefoxRuntime()
    const hasNativeML = isFirefox ? await hasFirefoxNativeML() : false

    console.log('[RAG] embedInWorker check:', { isFirefox, hasNativeML })

    if (isFirefox && hasNativeML) {
      console.log('[RAG] ðŸš€ Attempting Firefox Native ML embedding...')
      try {
        // Determine prefix based on mode
        const prefixes = (embedConfig as any).prefixes || {}
        const prefix = mode === 'query' ? prefixes.query : prefixes.document

        // Use a compatible model ID for browser.trial.ml
        // The API expects a native HF model id, not GGUF repo variants.
        const modelId = resolveFirefoxNativeModelId(embedConfig.id)

        const embedding = await embedWithFirefoxML(text, modelId, prefix)

        console.log('[RAG] âœ… Firefox Native ML embedding success!')

        // Enforce requested output dimension for index/query compatibility.
        return forceEmbeddingDim(embedding, truncateDim)
      } catch (err: any) {
        console.warn(
          '[RAG] âš ï¸ Firefox Native ML failed, falling back to worker:',
          err?.message,
        )
        // Fall through to worker-based embedding
      }
    } else {
      console.log(
        '[RAG] â„¹ï¸ Skipping Firefox ML:',
        isFirefox ? 'not available' : 'not Firefox',
      )
    }

    // Fallback: Use worker-based embedding (wllama/ONNX)
    await this.ensureEmbeddingWorkerInitialized(
      embedConfig,
      locale,
      truncateDim,
    )

    const worker = this.getEmbeddingWorker()
    const requestId = this.embedNextId++

    return await new Promise<Float32Array>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.embedPending.delete(requestId)
        reject(new Error('Embedding worker timeout'))
      }, 60_000)

      this.embedPending.set(requestId, {
        resolve: (v) => {
          clearTimeout(timeout)
          resolve(v)
        },
        reject: (e) => {
          clearTimeout(timeout)
          reject(e)
        },
      })

      worker.postMessage({
        type: 'embed',
        requestId,
        payload: { text, mode },
      })
    })
  }

  /**
   * SOTA: Indexing Pipeline (Hybrid Model)
   * 1. Main Thread: Extracts HTML -> Markdown from EPUB (DOM required)
   * 2. Worker: Handles Semantic Chunking, Embeddings, and Voy Indexing (CPU intense)
   *
   * @param liteMode - If true, skips embedding generation for instant import (<10s).
   *                   Books indexed in lite mode use BM25 search with on-demand vectorization.
   */
  async indexBook(
    file: File,
    bookId: string,
    onProgress: (p: number) => void,
    locale = 'en',
    liteMode = false,
  ) {
    const worker = this.getWorker()
    const ragLocale = normalizeLangForRAG(locale, 'en')
    const embedConfig = getEmbeddingConfig()

    // 1. Clear existing index
    await db?.vectors.where('bookId').equals(bookId).delete()
    await db?.indices.where('bookId').equals(bookId).delete()
    // Clear in-memory caches to avoid stale retrievals after reindex
    RAGService.voyInstances.delete(bookId)
    RAGService.allChunksCache.delete(bookId)
    RAGService.cacheAccessTime.delete(bookId)

    const epub = await fileToEpub(file)
    await epub.ready // Ensure spine is fully parsed

    const turndown = new TurndownService()
    turndown.use(gfm)

    const spineItems =
      (epub.spine as any).spineItems || (epub.spine as any).items
    const totalSpines = spineItems.length
    let processedSpines = 0
    let detectedDim = 384
    const indexingStartedAt = Date.now()

    // 2. Coalescing Buffer for Records (Main Thread Performance)
    const pendingRecords: any[] = []
    let flushTimer: any = null
    const FLUSH_MS = 150
    const FLUSH_SIZE = 500

    const flushRecords = async () => {
      if (pendingRecords.length > 0) {
        const batch = pendingRecords.splice(0, pendingRecords.length)

        // Industrial v3.4: Use crypto.randomUUID where available
        const genId = () =>
          typeof crypto !== 'undefined' && (crypto as any).randomUUID
            ? (crypto as any).randomUUID()
            : uuidv4()

        await db?.vectors.bulkAdd(
          batch.map((r: any) => ({
            id: genId(),
            ...r,
          })),
        )
        await yieldToMain()
      }
    }

    const isFirefox = isFirefoxRuntime()
    const hasNativeML = isFirefox ? await hasFirefoxNativeML() : false

    return new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        if (flushTimer) clearTimeout(flushTimer)
        worker.removeEventListener('message', handleMessage)
        // Terminate and nullify to ensure fresh start/GC
        worker.terminate()
        this.worker = null
      }

      const handleMessage = async (e: MessageEvent) => {
        const { type, payload, data } = e.data

        try {
          switch (type) {
            case 'embedding-debug':
              RAGService.handleEmbeddingDebug(data)
              break

            case 'rag-progress':
              RAGService.handleEmbeddingProgress(data)
              break

            case 'embedding-error':
              RAGService.handleEmbeddingError(data)
              break

            case 'request-embedding': {
              // Worker requesting main-thread embedding (Firefox Native ML)
              const { id, text, modelId } = payload
              embedWithFirefoxML(text, modelId)
                .then((vec) => {
                  worker.postMessage(
                    {
                      type: 'embedding-response',
                      payload: { id, vector: vec },
                    },
                    [vec.buffer],
                  )
                })
                .catch((err) => {
                  worker.postMessage({
                    type: 'embedding-response',
                    payload: { id, error: String(err?.message || err) },
                  })
                })
              break
            }

            case 'request-embedding-batch': {
              // SOTA: Two-Layer Batching (Worker -> Main -> Background)
              const { id, texts, mode } = payload
              const modelId = resolveFirefoxNativeModelId(
                payload?.modelId || embedConfig.id,
              )
              const timerLabel = `[RAG] Batch Embed (${texts.length} items)`
              const debugBatchLogs = process.env.NODE_ENV !== 'production'
              if (debugBatchLogs) {
                console.time(timerLabel)
              }

              // Send to background script in a single message
              const browser =
                (globalThis as any).browser || (globalThis as any).chrome
              if (debugBatchLogs) {
                console.log(
                  '[RAG] Sending firefox-ml-embed-batch to background',
                )
              }
              browser.runtime
                .sendMessage({
                  type: 'firefox-ml-embed-batch',
                  payload: { texts, modelId, mode },
                })
                .then((resp: any) => {
                  if (debugBatchLogs) {
                    console.timeEnd(timerLabel)
                    console.log(
                      '[RAG] Received response from background script for batch embedding.',
                    )
                  }
                  // 1. Handle explicit error from background
                  if (resp?.error) {
                    throw new Error(String(resp.error))
                  }

                  // 2. Validate response shape
                  if (!Array.isArray(resp)) {
                    throw new Error(
                      `Invalid batch response: ${Object.prototype.toString.call(
                        resp,
                      )}`,
                    )
                  }

                  // 3. Convert potential number[][] to Float32Array[]
                  // Background sends transferable arrays (vectors of numbers)
                  const vectors = resp.map((v: any) =>
                    v instanceof Float32Array ? v : new Float32Array(v),
                  )

                  // 4. Transfer multiple buffers safely
                  const buffers = vectors.map((v) => v.buffer)
                  worker.postMessage(
                    {
                      type: 'embedding-batch-response',
                      payload: { id, vectors },
                    },
                    buffers,
                  )
                })
                .catch((err: any) => {
                  if (debugBatchLogs) {
                    console.timeEnd(timerLabel)
                  }
                  if (isFirefoxMLBackgroundUnavailableError(err)) {
                    firefoxMLAvailable = false
                  }
                  console.error('[RAG] Batch delegation failed:', err)
                  worker.postMessage({
                    type: 'embedding-batch-response',
                    payload: { id, error: String(err?.message || err) },
                  })
                })
              break
            }
            case 'initialized':
              RAGService.emitReadyStatus()
              detectedDim = payload.dim || 384
              // Start processing first section
              await this.feedSection(
                epub,
                turndown,
                bookId,
                worker,
                processedSpines,
                ragLocale,
              )
              break

            case 'records':
              // Buffering records to avoid IDB fragmentation
              pendingRecords.push(...payload)

              // Industrial v3.4: Size-based flush + Time-based flush
              if (pendingRecords.length >= FLUSH_SIZE) {
                if (flushTimer) {
                  clearTimeout(flushTimer)
                  flushTimer = null
                }
                await flushRecords()
              } else if (!flushTimer) {
                flushTimer = setTimeout(async () => {
                  flushTimer = null
                  await flushRecords()
                }, FLUSH_MS)
              }
              break

            case 'sectionDone':
              processedSpines++
              onProgress(Math.round((processedSpines / totalSpines) * 100))
              if (
                processedSpines === 1 ||
                processedSpines % 5 === 0 ||
                processedSpines === totalSpines
              ) {
                const elapsedMs = Date.now() - indexingStartedAt
                const avgMsPerSection = elapsedMs / Math.max(1, processedSpines)
                const etaMs = Math.max(
                  0,
                  Math.round(avgMsPerSection * (totalSpines - processedSpines)),
                )
                console.log('[RAG] Index progress timing:', {
                  processedSpines,
                  totalSpines,
                  elapsedMs,
                  avgMsPerSection: Math.round(avgMsPerSection),
                  etaMs,
                })
              }

              if (payload?.skipped) {
                console.warn(
                  `Skipped section ${payload.sectionIndex}: ${payload.reason}`,
                )
              }

              if (processedSpines < totalSpines) {
                await this.feedSection(
                  epub,
                  turndown,
                  bookId,
                  worker,
                  processedSpines,
                  ragLocale,
                )
              } else {
                await flushRecords() // Final flush before finalize
                worker.postMessage({ type: 'finalize', payload: { bookId } })
              }
              break

            case 'finalized': {
              // Bulletproof Hardening v3.4: Final Sync Barrier
              if (flushTimer) {
                clearTimeout(flushTimer)
                flushTimer = null
              }
              await flushRecords()

              if (payload.skippedSections?.length > 0) {
                console.log(
                  `Indexing finished. Skipped ${payload.skippedSections.length} sections:`,
                  payload.skippedSections,
                )
              }

              const totalMs = Date.now() - indexingStartedAt
              console.log('[RAG] Indexing finished timing:', {
                totalSpines,
                totalMs,
                avgMsPerSection: Math.round(totalMs / Math.max(1, totalSpines)),
              })

              // SOTA v6.3: Defensive Put with Capability Check
              // Avoids overwriting if store is still in legacy 'bookId' schema (SchemaError prevention)
              const indicesHasKind =
                !!db?.indices &&
                Array.isArray((db.indices as any).schema?.primKey?.keyPath) &&
                (db.indices as any).schema.primKey.keyPath.includes('kind')

              const effectiveDim = payload.dim || detectedDim
              const ragLocale = normalizeLangForRAG(locale, 'en')
              const ragVersion = computeRagVersion({
                model: embedConfig.id,
                dim: effectiveDim,
                locale: ragLocale,
              })

              if (indicesHasKind) {
                await db?.indices.put({
                  bookId,
                  kind: 'chunks',
                  model: embedConfig.id,
                  data: payload.chunks,
                  dim: effectiveDim,
                  version: (AI_CONFIG as any).ragVersion,
                  ragVersion,
                  locale: ragLocale,
                })

                await db?.indices.put({
                  bookId,
                  kind: 'chapters',
                  model: embedConfig.id,
                  data: payload.chapters,
                  dim: effectiveDim,
                  version: (AI_CONFIG as any).ragVersion,
                  ragVersion,
                  locale: ragLocale,
                })
              } else {
                // Fallback: Old schema (no kind support), save minimal blob to avoid overwrite
                await db?.indices.put({
                  bookId,
                  model: embedConfig.id, // No kind property here
                  data: payload.chunks,
                  dim: effectiveDim,
                  version: (AI_CONFIG as any).ragVersion,
                  ragVersion,
                  locale: ragLocale,
                } as any)
              }

              // Precision pass: persist exact chunk anchors (CFI range) when resolvable.
              // This improves deterministic citation jump + highlight accuracy.
              if (!liteMode) {
                try {
                  const anchorStartedAt = Date.now()
                  const anchorStats = await this.enrichChunkAnchorsWithExactCfi(
                    epub,
                    spineItems,
                    bookId,
                  )
                  console.log('[RAG] Anchor enrichment finished:', {
                    total: anchorStats.total,
                    updated: anchorStats.updated,
                    elapsedMs: Date.now() - anchorStartedAt,
                  })
                } catch (err: any) {
                  console.warn(
                    '[RAG] Anchor enrichment skipped after failure:',
                    String(err?.message || err),
                  )
                }
              }

              cleanup()
              resolve()
              break
            }

            case 'error':
              // v3.4: Only fatal if no sectionIndex (init/finalize failure)
              if (payload?.sectionIndex === undefined) {
                RAGService.emitEmbeddingError(
                  String(payload?.reason || payload),
                  'worker',
                )
                throw new Error(payload?.reason || payload)
              } else {
                console.error(
                  `Worker error in section ${payload.sectionIndex}, but continuing:`,
                  payload.reason,
                )
                // The sectionDone message from worker-finally will trigger the next step
              }
              break
          }
        } catch (err: any) {
          cleanup()
          reject(err)
        }
      }

      worker.addEventListener('message', handleMessage)
      worker.onerror = (_e) => {
        cleanup()
        RAGService.emitEmbeddingError('worker_error', 'runtime')
        reject(new Error('Worker Error'))
      }
      // Initialize Worker after listeners are registered to avoid race
      RAGService.emitEmbeddingStatus('downloading')

      const workerInitPayload: any = {
        backend: embedConfig.backend,
        modelId: embedConfig.id,
        locale: ragLocale,
        truncateDim: embedConfig.dim,
        firefoxDelegate: hasNativeML, // SOTA: Pass delegation flag to index worker
      }
      if (
        embedConfig.backend === 'wllama' ||
        (!embedConfig.backend && isFirefoxRuntime())
      ) {
        workerInitPayload.modelUrl = embedConfig.url
        workerInitPayload.embeddingPrefixes = embedConfig.prefixes
      }
      if (
        embedConfig.backend === 'transformers' ||
        (!embedConfig.backend && !isFirefoxRuntime())
      ) {
        workerInitPayload.model = embedConfig.id
      }

      // Lite mode: Skip embedding, only chunk text for BM25 search
      if (liteMode) {
        workerInitPayload.liteMode = true
        console.log(
          '[RAG] ðŸš€ Lite mode enabled: Skipping embeddings for instant import',
        )
      }

      worker.postMessage({
        type: 'init',
        payload: workerInitPayload,
      })

      // SOTA: Warmup the engine immediately after init
      if (hasNativeML && !liteMode) {
        RAGService.warmupFirefoxNativeML(embedConfig.id).catch(() => {
          // Non-fatal during indexing flow; embed fallback remains operational.
        })
      }
    })
  }

  private async feedSection(
    epub: any,
    turndown: TurndownService,
    bookId: string,
    worker: Worker,
    index: number,
    locale: string,
  ) {
    const spineItems =
      (epub.spine as any).spineItems || (epub.spine as any).items
    const item = spineItems[index]
    if (!item) return

    // Elite Hardening v3.4: Universal Fallback Loader Chain
    const loaders = [
      null, // Attempt native item.load() first
      epub?.load?.bind(epub),
      epub?.request?.bind(epub),
      epub?.archive?.request?.bind(epub.archive),
    ].filter((l, i) => i === 0 || !!l)

    let loaded = false
    let lastErr: any = null
    const debugDiag = process.env.NODE_ENV !== 'production'

    try {
      for (const loader of loaders) {
        const loaderLabel = loader ? 'custom' : 'native'
        try {
          if (debugDiag) {
            console.debug(
              `[RAG DIAG] Section ${index}: trying loader ${loaderLabel}`,
            )
          }
          if (loader) await item.load(loader)
          else await item.load()
          if (debugDiag) {
            console.debug(
              `[RAG DIAG] Section ${index}: loaded with ${loaderLabel}`,
            )
          }
          loaded = true
          break
        } catch (err) {
          const msg = String((err as any)?.message || err)
          if (debugDiag) {
            console.debug(
              `[RAG DIAG] Section ${index}: loader ${loaderLabel} failed: ${msg}`,
            )
          }
          lastErr = err
        }
      }

      if (!loaded)
        throw lastErr || new Error('Failed to load spine item with all loaders')

      const doc = item.document
      if (!doc || !doc.body) throw new Error('Document body missing')

      // Bulletproof Hardening v3.4: Deep DOM Sanitization
      const bodyClone = doc.body.cloneNode(true) as HTMLElement

      // 1. Remove noise tags
      bodyClone
        .querySelectorAll(
          'script, style, iframe, object, embed, svg, math, link, meta, noscript',
        )
        .forEach((n) => n.remove())

      // 2. Remove oversized data-URIs
      bodyClone.querySelectorAll('img').forEach((img) => {
        const src = img.getAttribute('src') || ''
        if (src.startsWith('data:') && src.length > 2000) {
          img.removeAttribute('src')
        }
      })

      // 3. Strip attributes to speed up Turndown
      bodyClone.querySelectorAll('*').forEach((el) => {
        el.removeAttribute('style')
        el.removeAttribute('class')
        el.removeAttribute('id')
      })

      const markdown = turndown.turndown(bodyClone)
      const cfi = item.cfiBase
      const href = item.href
      const idref = item.idref
      const sectionTitle = item.label || `Section ${index}`

      worker.postMessage({
        type: 'index',
        payload: {
          bookId,
          markdown,
          locale, // SOTA: Pass current locale for segmentation
          metadata: { sectionIndex: index, cfi, href, idref, sectionTitle },
        },
      })
      await yieldToMain()
    } catch (e) {
      const msg = String((e as any)?.message || e)
      console.warn(`[RAG] Failed to extract section ${index}: ${msg}`)
      // Signal skip with reason to avoid hanging the worker pipeline
      worker.postMessage({
        type: 'index',
        payload: {
          bookId,
          markdown: '',
          metadata: {
            sectionIndex: index,
            cfi: '',
            href: item?.href || '',
            skipped: true,
            reason: msg,
          },
        },
      })
    } finally {
      try {
        // Critical: unload after all processing is done to avoid DeadObject
        item.unload()
      } catch {}
    }
  }

  /**
   * Retrieves relevant context for a query using Voy (CSP-safe WASM)
   * Now supports hybrid search (vector + BM25) for better results
   */
  async retrieveContext(
    bookId: string,
    query: string,
    topK = 5,
    options: {
      expandContext?: boolean
      maxChars?: number
      useHybrid?: boolean
      chapterGateTopN?: number
      softGateOutlierRank?: number
      disableChapterGate?: boolean
      locale?: string
    } = {},
  ) {
    const {
      expandContext = true,
      maxChars = 20000,
      useHybrid = true,
      chapterGateTopN = 3,
      softGateOutlierRank = 10,
      disableChapterGate = false,
      locale = 'en',
    } = options
    const embedConfig = getEmbeddingConfig()

    const telemetryStart =
      typeof performance !== 'undefined' && performance.now
        ? performance.now()
        : 0
    const logTelemetry = (results: number) => {
      if (process.env.NODE_ENV !== 'development') return
      const elapsed =
        typeof performance !== 'undefined' && performance.now
          ? Math.round(performance.now() - telemetryStart)
          : 0
      const heap = (performance as any)?.memory?.usedJSHeapSize
      console.log('[RAG Telemetry] retrieveContext', {
        elapsed,
        results,
        heap,
      })
    }

    // SOTA v6.3: Safe Retrieval Helper (Fixes SchemaError crash)
    const safeGetIndex = async (kind: 'chunks' | 'chapters') => {
      if (!db) return null
      try {
        // Try compound key first (New Schema)
        return await db.indices.get([bookId, kind] as any)
      } catch (e: any) {
        // Fallback: If 'kind' is not indexed (Old Schema), try fetching by bookId alone
        // This corresponds to the legacy single-index format (only chunks)

        // Fix: Check internal error object also (Dexie sometimes wraps it in _e)
        const errName = e?.name || e?._e?.name

        if (errName === 'SchemaError' || errName === 'DataError') {
          if (kind === 'chunks') {
            return await db.indices.get(bookId as any)
          }
          return null // Old schema has no chapters index
        }
        throw e
      }
    }

    const chunkIndexRecord = await safeGetIndex('chunks')
    const chapterIndexRecord = await safeGetIndex('chapters')

    const activeIndex = chunkIndexRecord

    // PHASE 2: Lite Mode Fallback - BM25 only when no vector index
    if (!activeIndex || !activeIndex.data) {
      console.log(
        '[RAG] ðŸ“– Lite mode retrieval: Using BM25 text search (no vector index)',
      )

      // Fetch text chunks from DB (stored without embeddings in lite mode)
      const textChunks =
        (await db?.vectors.where('bookId').equals(bookId).toArray()) || []

      if (textChunks.length === 0) {
        logTelemetry(0)
        return []
      }

      // SOTA v3.13: Stale lite-mode index detection
      // Pre-fix indices had zero overlap between chunks due to the processSectionLite bug.
      // Detect this by checking if adjacent chunk boundaries have no content overlap.
      if (textChunks.length >= 3) {
        const c0 = textChunks[0]?.content || ''
        const c1 = textChunks[1]?.content || ''
        const c0Words = c0.split(/\s+/).slice(-5).join(' ')
        const hasOverlap = c1.startsWith(c0Words) || c1.includes(c0Words)
        if (!hasOverlap && c0.length > 200) {
          console.warn(
            '[RAG] âš ï¸ Stale lite-mode index detected: chunks have zero overlap. Re-indexing recommended for better search quality.',
          )
        }
      }

      // Use BM25 search for text-only retrieval
      const ragLocale = normalizeLangForRAG(locale, 'en')
      const bm25Results = bm25Search(query, textChunks, topK * 2, ragLocale)

      // Apply context expansion if enabled
      let finalChunks = bm25Results.slice(0, topK)

      if (expandContext && finalChunks.length > 0) {
        const expanded: typeof finalChunks = []
        const seenChunks = new Set<number>()

        for (const chunk of finalChunks) {
          // Add chunk itself
          if (!seenChunks.has(chunk.index)) {
            seenChunks.add(chunk.index)
            expanded.push(chunk)
          }

          // Try to add neighbors (use metadata sectionId or just index proximity)
          const chunkMeta = (chunk as any).metadata || {}
          const neighbors = textChunks.filter((c) => {
            const cMeta = (c as any).metadata || {}
            const sameSection = chunkMeta.sectionId
              ? cMeta.sectionId === chunkMeta.sectionId
              : true
            return (
              sameSection &&
              Math.abs(c.index - chunk.index) <= 1 &&
              !seenChunks.has(c.index)
            )
          })

          for (const n of neighbors) {
            if (!seenChunks.has(n.index)) {
              seenChunks.add(n.index)
              expanded.push({ ...n, bm25Score: (chunk.bm25Score || 0) * 0.9 })
            }
          }
        }

        finalChunks = expanded.slice(0, topK)
      }

      logTelemetry(finalChunks.length)
      return finalChunks
    }

    if (activeIndex.model && activeIndex.model !== embedConfig.id) {
      throw new IndexCompatibilityError(
        'Embedding model mismatch. Re-indexing required.',
      )
    }

    // SOTA v7.2: ragVersion guard (locale + model + dim + chunking)
    if (activeIndex.ragVersion) {
      const expected = computeRagVersion({
        model: embedConfig.id,
        dim: activeIndex.dim || 384,
        locale: activeIndex.locale || locale,
      })
      if (activeIndex.ragVersion !== expected) {
        throw new IndexCompatibilityError(
          'RAG index version mismatch. Re-indexing required.',
        )
      }
    } else if (
      activeIndex.version &&
      activeIndex.version !== (AI_CONFIG as any).ragVersion
    ) {
      // Legacy version guard for old indices
      throw new IndexCompatibilityError(
        'RAG architecture mismatch. Re-indexing required.',
      )
    }

    if (!activeIndex.data) throw new Error('Index data is empty.')

    const { Voy } = await import('voy-search')

    let cached = RAGService.voyInstances.get(bookId)
    if (!cached) {
      // EVICT OLDEST if over capacity
      if (RAGService.voyInstances.size >= RAGService.MAX_BOOKS_IN_RAM) {
        const oldestId = Array.from(RAGService.cacheAccessTime.entries()).sort(
          (a, b) => a[1] - b[1],
        )[0]?.[0]
        if (oldestId) {
          RAGService.voyInstances.delete(oldestId)
          RAGService.allChunksCache.delete(oldestId)
          RAGService.cacheAccessTime.delete(oldestId)
        }
      }

      cached = {
        chunks: Voy.deserialize(activeIndex.data),
        chapters: chapterIndexRecord?.data
          ? Voy.deserialize(chapterIndexRecord.data)
          : undefined,
      }
      RAGService.voyInstances.set(bookId, cached)
    }
    RAGService.cacheAccessTime.set(bookId, Date.now())

    const effectiveDim = activeIndex.dim || embedConfig.dim || 384
    const ragLocale = normalizeLangForRAG(locale, 'en')
    const queryVector = await this.embedInWorker(
      query,
      'query',
      embedConfig,
      ragLocale,
      effectiveDim,
    )

    // ===== Chapter gating =====
    let allowedSections: Set<number> | null = null
    if (cached.chapters && !disableChapterGate) {
      const chapterResults = cached.chapters.search(
        queryVector as any,
        chapterGateTopN,
      )
      allowedSections = new Set(
        chapterResults.neighbors
          .map((n: any) => Number(n.id))
          .filter((id: number) => !isNaN(id)),
      )
    }

    // ===== cache allChunks + byIndex (somente se hÃ­brido) =====
    let allChunks: VectorRecord[] | null = null
    let byIndex: Map<number, VectorRecord> | null = null

    if (useHybrid) {
      allChunks = RAGService.allChunksCache.get(bookId) || null
      if (!allChunks) {
        allChunks =
          (await db?.vectors.where('bookId').equals(bookId).toArray()) || []
        RAGService.allChunksCache.set(bookId, allChunks)
      }
      if (allChunks.length === 0) {
        logTelemetry(0)
        return []
      }
      byIndex = new Map(allChunks.map((c) => [c.index, c]))
    }

    // ===== BM25 subset (speed) =====
    const bm25Corpus =
      useHybrid && allChunks
        ? allowedSections
          ? allChunks.filter((c) =>
              allowedSections!.has(c.metadata?.sectionIndex),
            )
          : allChunks
        : []

    // ===== Vector Search =====
    // SOTA v3.12: Proportional search topK
    const searchTopK = allowedSections ? Math.max(200, topK * 15) : topK * 4
    const vectorRaw = cached.chunks.search(queryVector as any, searchTopK)

    // score real (se houver distÃ¢ncia)
    const vectorResults: (VectorRecord & { score: number })[] = []
    for (let rank = 0; rank < vectorRaw.neighbors.length; rank++) {
      const n: any = vectorRaw.neighbors[rank]
      const id = Number(n.id)
      const dist =
        typeof n.distance === 'number'
          ? n.distance
          : typeof n.dist === 'number'
          ? n.dist
          : null
      const sim = dist === null ? 1 : 1 / (1 + dist)

      // pegar chunk
      let chunk: VectorRecord | undefined

      if (useHybrid && byIndex) {
        chunk = byIndex.get(id)
      } else {
        // vector-only: busca pontual
        const row = await db?.vectors
          .where('[bookId+index]')
          .equals([bookId, id] as any)
          .first()
        chunk = row as any
      }

      if (!chunk) continue

      // soft gate
      if (
        allowedSections &&
        !allowedSections.has(chunk.metadata?.sectionIndex)
      ) {
        if (rank > softGateOutlierRank) continue
      }

      vectorResults.push({ ...chunk, score: sim })
      if (vectorResults.length >= topK * 3) break
    }

    // ===== Hybrid fuse =====
    let finalRankedResults: (VectorRecord & { score: number })[] = []

    if (useHybrid) {
      const bm25Results = bm25Search(query, bm25Corpus, topK * 3, locale)
      const hybridResults = hybridSearch(vectorResults, bm25Results, 0.6, 60)

      finalRankedResults = hybridResults.slice(0, topK).map((r) => ({
        ...(r as any),
        score: (r as any).hybridScore,
      }))
    } else {
      finalRankedResults = vectorResults.slice(0, topK)
    }

    // ===== Expand context sem refetch (se allChunks existe) =====
    const outputList: (VectorRecord & { score: number })[] = []
    const seen = new Set<number>()

    for (const item of finalRankedResults) {
      const add = (c?: VectorRecord, mult = 0.9) => {
        if (!c) return
        if (seen.has(c.index)) return
        seen.add(c.index)
        outputList.push({ ...c, score: item.score * mult })
      }

      if (expandContext) {
        if (useHybrid && byIndex) {
          const prev = byIndex.get(item.index - 1)
          const next = byIndex.get(item.index + 1)
          if (
            prev &&
            prev.metadata?.sectionIndex === item.metadata?.sectionIndex
          )
            add(prev, 0.9)
          if (!seen.has(item.index)) {
            seen.add(item.index)
            outputList.push(item)
          }
          if (
            next &&
            next.metadata?.sectionIndex === item.metadata?.sectionIndex
          )
            add(next, 0.9)
        } else {
          // vector-only: fetch expansions pontuais
          const keys = [
            [bookId, item.index - 1],
            [bookId, item.index + 1],
          ]
          const expansions =
            (await db?.vectors
              .where('[bookId+index]')
              .anyOf(keys as any)
              .toArray()) || []
          const prev = expansions.find((e) => e.index === item.index - 1)
          const next = expansions.find((e) => e.index === item.index + 1)

          if (
            prev &&
            prev.metadata?.sectionIndex === item.metadata?.sectionIndex
          )
            add(prev, 0.9)
          if (!seen.has(item.index)) {
            seen.add(item.index)
            outputList.push(item)
          }
          if (
            next &&
            next.metadata?.sectionIndex === item.metadata?.sectionIndex
          )
            add(next, 0.9)
        }
      } else {
        if (!seen.has(item.index)) {
          seen.add(item.index)
          outputList.push(item)
        }
      }
    }

    // v3.12: Refined sorting & capping
    // 1. Sort by relevance to find the best snippets
    outputList.sort((a, b) => b.score - a.score)

    // 2. Take top results (limited to 20 for reading continuity logic)
    const bestResults = outputList.slice(0, 20)

    // 3. Re-sort by reading order so the AI gets a logical sequence
    bestResults.sort((a, b) => {
      const secA = a.metadata?.sectionIndex ?? 0
      const secB = b.metadata?.sectionIndex ?? 0
      if (secA !== secB) return secA - secB
      return a.index - b.index
    })

    // 4. Cap by chars while maintaining sequence
    const capped: (VectorRecord & { score: number })[] = []
    let len = 0
    for (const c of bestResults) {
      if (len + c.content.length > maxChars) break
      capped.push(c)
      len += c.content.length
    }
    logTelemetry(capped.length)
    return capped
  }
}

// Hydrate persisted status early so the UI doesn't flash "download" on reload,
// especially in Firefox where moz-extension:// UUID changes can reset localStorage.
if (typeof window !== 'undefined') {
  void RAGService.hydratePersistedState()
}

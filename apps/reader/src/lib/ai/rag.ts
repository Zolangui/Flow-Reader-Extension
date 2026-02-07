import TurndownService from 'turndown'
import { gfm } from 'turndown-plugin-gfm'
import { v4 as uuidv4 } from 'uuid'
import type { Voy as VoyType } from 'voy-search' // CSP-safe WASM vector engine

import { db, VectorRecord } from '../../db'
import { fileToEpub } from '../../file'
import { storageGetString, storageRemove, storageSetString } from '../storage'

import { AI_CONFIG } from './config'
import { normalizeLangForRAG } from './language'
import { bm25Search, hybridSearch } from './retrieval'

// Utility to prevent main thread blocking (UI Freeze)
const yieldToMain = () => new Promise(resolve => requestAnimationFrame(resolve))

const RAG_VERSION_BASE = (AI_CONFIG as any).ragVersion ?? 'v1'

function computeRagVersion(args: { model: string; dim: number; locale: string }) {
    const locale = normalizeLangForRAG(args.locale || 'en')
    return `${RAG_VERSION_BASE}|model:${args.model}|dim:${args.dim}|chunk:${AI_CONFIG.chunkSize}-${AI_CONFIG.chunkOverlap}|lang:${locale}`
}

const SINGLE_THREAD_WARNING = 'single_thread'

const isFirefoxRuntime = () =>
    typeof navigator !== 'undefined' && /Firefox/i.test(navigator.userAgent || '')

const FIREFOX_EMBED_MODEL_ID = (AI_CONFIG as any).embeddingModelFirefox as string | undefined
const FIREFOX_EMBED_MODEL_URL = (AI_CONFIG as any).embeddingModelFirefoxUrl as string | undefined
const FIREFOX_EMBED_DIM = (AI_CONFIG as any).embeddingDimFirefox as number | undefined
const FIREFOX_EMBED_PREFIXES = (AI_CONFIG as any).embeddingModelFirefoxPrefixes as
    | { query?: string; document?: string }
    | undefined

const getEmbeddingConfig = () => {
    if (isFirefoxRuntime() && FIREFOX_EMBED_MODEL_ID && FIREFOX_EMBED_MODEL_URL) {
        return {
            // NOTE: backend is now auto-detected in the worker (WebGPU → wllama fallback)
            // Previously hardcoded to 'wllama', now undefined to let worker decide
            backend: undefined,
            id: FIREFOX_EMBED_MODEL_ID,
            url: FIREFOX_EMBED_MODEL_URL,
            dim: FIREFOX_EMBED_DIM || AI_CONFIG.embeddingDim,
            prefixes: FIREFOX_EMBED_PREFIXES
        }
    }


    return {
        backend: 'onnx' as const,
        id: AI_CONFIG.embeddingModel,
        dim: AI_CONFIG.embeddingDim
    }
}

const shouldWarnEmbeddingSingleThread = () => {
    // Only relevant for Firefox wllama backend: without SharedArrayBuffer (COOP/COEP), wasm multi-thread is unavailable.
    const cfg = getEmbeddingConfig()
    if (cfg.backend !== 'wllama') return false
    return typeof window !== 'undefined' && typeof (window as any).SharedArrayBuffer === 'undefined'
}

const EMBEDDING_CACHE_PREFIX = 'embedding_cached_v1:'
const EMBEDDING_WARNING_PREFIX = 'embedding_warning_v1:'
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


// NOTE: wllama embeddings run inside `rag.worker.ts` to avoid Firefox MV3 CSP issues
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
    private embedPending = new Map<number, { resolve: (v: Float32Array) => void; reject: (e: Error) => void }>()
    private embedNextId = 1
    private embedInitKey: string | null = null
    private embedInitPromise: Promise<void> | null = null
    private embedInitResolve: (() => void) | null = null
    private embedInitReject: ((e: Error) => void) | null = null
    private embedOutputDim: number | null = null

    // SOTA v3.9.1: Optimization Caches
    private static voyInstances = new Map<string, { chunks: VoyType; chapters?: VoyType }>()
    private static allChunksCache = new Map<string, VectorRecord[]>()
    private static cacheAccessTime = new Map<string, number>()
    private static MAX_BOOKS_IN_RAM = 2

    private static embeddingWarning: string | null = loadEmbeddingWarning()
    private static embeddingStatus: 'unknown' | 'downloading' | 'ready' | 'warning' | 'error' = loadEmbeddingCached()
        ? (RAGService.embeddingWarning ? 'warning' : 'ready')
        : 'unknown'
    private static embeddingLastError: string | null = null
    private static emitEmbeddingStatus(status: typeof RAGService.embeddingStatus) {
        RAGService.embeddingStatus = status
        if (status === 'ready' || status === 'warning') {
            saveEmbeddingCached()
        }
        if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('embedding-status', { detail: { status, warning: RAGService.embeddingWarning } }))
        }
    }
    private static emitEmbeddingError(message: string, stage?: string) {
        RAGService.embeddingLastError = message
        // If init fails after download, do not persist a misleading "ready" badge across reloads.
        // The GGUF is still in OPFS and will be a cache hit next time; we just keep the UI honest.
        clearEmbeddingCached()
        RAGService.emitEmbeddingStatus('error')
        if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('embedding-error', { detail: { message, stage } }))
        }
        // Always log errors in production builds too; otherwise users see a red badge with no useful details.
        console.error('[Embedding Error]', { message, stage })
    }
    private static emitReadyStatus() {
        if (shouldWarnEmbeddingSingleThread() && RAGService.embeddingWarning !== SINGLE_THREAD_WARNING) {
            RAGService.setEmbeddingWarning(SINGLE_THREAD_WARNING)
        }
        RAGService.emitEmbeddingStatus(RAGService.embeddingWarning ? 'warning' : 'ready')
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
                if (RAGService.embeddingStatus === 'ready' || RAGService.embeddingStatus === 'unknown') {
                    RAGService.emitEmbeddingStatus('warning')
                }
            }
        }

        // Mark cached so the UI doesn't reset to "download" after refresh.
        if (data?.message === 'download_complete' || data?.message === 'cache_hit') {
            saveEmbeddingCached()
            if (RAGService.embeddingStatus === 'unknown' || RAGService.embeddingStatus === 'downloading') {
                RAGService.emitReadyStatus()
            }
        }
    }

    private static handleEmbeddingProgress(data: any) {
        if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('embedding-progress', { detail: data }))
        }
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
                if (shouldWarnEmbeddingSingleThread() && RAGService.embeddingWarning !== SINGLE_THREAD_WARNING) {
                    RAGService.setEmbeddingWarning(SINGLE_THREAD_WARNING)
                }
                RAGService.emitReadyStatus()
            }
        } catch {
            // ignore hydration failures
        }
    }

    static async preloadEmbeddings(locale = 'en'): Promise<void> {
        const embedConfig = getEmbeddingConfig()
        const inst = RAGService.getInstance()
        const ragLocale = normalizeLangForRAG(locale, 'en')
        try {
            RAGService.emitEmbeddingStatus('downloading')
            await inst.ensureEmbeddingWorkerInitialized(embedConfig, ragLocale, embedConfig.dim)
            RAGService.emitReadyStatus()
        } catch (err: any) {
            const msg = String(err?.message || err)
            RAGService.emitEmbeddingError(msg, 'preload')
        }
    }

    private constructor() { }

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
            this.embedWorker = new Worker(new URL('./rag.worker.ts', import.meta.url), {
                type: 'module',
            })

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
                    RAGService.emitReadyStatus()
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

    private embeddingInitKey(embedConfig: ReturnType<typeof getEmbeddingConfig>, locale: string, truncateDim?: number) {
        const prefixes = (embedConfig as any).prefixes || {}
        const url = (embedConfig as any).url || ''
        return [
            String(embedConfig.backend),
            String(embedConfig.id),
            String(url),
            String(truncateDim || ''),
            String(locale || ''),
            `q:${String(prefixes.query || '')}`,
            `d:${String(prefixes.document || '')}`,
        ].join('|')
    }

    private buildEmbeddingInitPayload(
        embedConfig: ReturnType<typeof getEmbeddingConfig>,
        locale: string,
        truncateDim?: number,
    ) {
        const payload: any = {
            backend: embedConfig.backend, // Can be undefined for auto-detection
            modelId: embedConfig.id,
            locale,
            truncateDim: truncateDim || embedConfig.dim,
        }
        if (embedConfig.backend === 'wllama' || (!embedConfig.backend && isFirefoxRuntime())) {
            payload.modelUrl = (embedConfig as any).url
            payload.embeddingPrefixes = (embedConfig as any).prefixes
        }

        // If it's explicitly transformers, or we are on other browsers (fallback to transformers)
        if (embedConfig.backend === 'transformers' || (!embedConfig.backend && !isFirefoxRuntime())) {
            payload.model = embedConfig.id
        }

        return payload
    }

    private async ensureEmbeddingWorkerInitialized(
        embedConfig: ReturnType<typeof getEmbeddingConfig>,
        locale: string,
        truncateDim?: number,
    ): Promise<void> {
        const key = this.embeddingInitKey(embedConfig, locale, truncateDim)
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
            payload: this.buildEmbeddingInitPayload(embedConfig, locale, truncateDim),
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
        await this.ensureEmbeddingWorkerInitialized(embedConfig, locale, truncateDim)

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
     */
    async indexBook(file: File, bookId: string, onProgress: (p: number) => void, locale = 'en') {
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

        const spineItems = (epub.spine as any).spineItems || (epub.spine as any).items
        const totalSpines = spineItems.length
        let processedSpines = 0
        let detectedDim = 384

        // 2. Coalescing Buffer for Records (Main Thread Performance)
        const pendingRecords: any[] = []
        let flushTimer: any = null
        const FLUSH_MS = 150
        const FLUSH_SIZE = 500

        const flushRecords = async () => {
            if (pendingRecords.length > 0) {
                const batch = pendingRecords.splice(0, pendingRecords.length)

                // Industrial v3.4: Use crypto.randomUUID where available
                const genId = () => (typeof crypto !== 'undefined' && (crypto as any).randomUUID)
                    ? (crypto as any).randomUUID()
                    : uuidv4()

                await db?.vectors.bulkAdd(batch.map((r: any) => ({
                    id: genId(),
                    ...r
                })))
                await yieldToMain()
            }
        }

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

                        case 'initialized':
                            RAGService.emitReadyStatus()
                            detectedDim = payload.dim || 384
                            // Start processing first section
                            await this.feedSection(epub, turndown, bookId, worker, processedSpines, ragLocale)
                            break

                        case 'records':
                            // Buffering records to avoid IDB fragmentation
                            pendingRecords.push(...payload)

                            // Industrial v3.4: Size-based flush + Time-based flush
                            if (pendingRecords.length >= FLUSH_SIZE) {
                                if (flushTimer) { clearTimeout(flushTimer); flushTimer = null }
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

                            if (payload?.skipped) {
                                console.warn(`Skipped section ${payload.sectionIndex}: ${payload.reason}`)
                            }

                            if (processedSpines < totalSpines) {
                                await this.feedSection(epub, turndown, bookId, worker, processedSpines, ragLocale)
                            } else {
                                await flushRecords() // Final flush before finalize
                                worker.postMessage({ type: 'finalize', payload: { bookId } })
                            }
                            break

                        case 'finalized': {
                            // Bulletproof Hardening v3.4: Final Sync Barrier
                            if (flushTimer) { clearTimeout(flushTimer); flushTimer = null }
                            await flushRecords()

                            if (payload.skippedSections?.length > 0) {
                                console.log(`Indexing finished. Skipped ${payload.skippedSections.length} sections:`, payload.skippedSections)
                            }

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
                                locale: ragLocale
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
                                    locale: ragLocale
                                })

                                await db?.indices.put({
                                    bookId,
                                    kind: 'chapters',
                                    model: embedConfig.id,
                                    data: payload.chapters,
                                    dim: effectiveDim,
                                    version: (AI_CONFIG as any).ragVersion,
                                    ragVersion,
                                    locale: ragLocale
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
                                    locale: ragLocale
                                } as any)
                            }

                            cleanup()
                            resolve()
                            break
                        }

                        case 'error':
                            // v3.4: Only fatal if no sectionIndex (init/finalize failure)
                            if (payload?.sectionIndex === undefined) {
                                RAGService.emitEmbeddingError(String(payload?.reason || payload), 'worker')
                                throw new Error(payload?.reason || payload)
                            } else {
                                console.error(`Worker error in section ${payload.sectionIndex}, but continuing:`, payload.reason)
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
                reject(new Error("Worker Error"))
            }
            // Initialize Worker after listeners are registered to avoid race
            RAGService.emitEmbeddingStatus('downloading')
            const workerInitPayload: any = {
                backend: embedConfig.backend,
                modelId: embedConfig.id,
                locale: ragLocale,
                truncateDim: embedConfig.dim
            }
            if (embedConfig.backend === 'wllama' || (!embedConfig.backend && isFirefoxRuntime())) {
                workerInitPayload.modelUrl = embedConfig.url
                workerInitPayload.embeddingPrefixes = embedConfig.prefixes
            }
            if (embedConfig.backend === 'transformers' || (!embedConfig.backend && !isFirefoxRuntime())) {
                workerInitPayload.model = embedConfig.id
            }
            worker.postMessage({
                type: 'init',
                payload: workerInitPayload
            })
        })
    }

    private async feedSection(epub: any, turndown: TurndownService, bookId: string, worker: Worker, index: number, locale: string) {
        const spineItems = (epub.spine as any).spineItems || (epub.spine as any).items
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

        try {
            for (const loader of loaders) {
                try {
                    console.log(`[RAG DIAG] Section ${index}: Trying loader`, loader ? 'custom' : 'native')
                    if (loader) await item.load(loader)
                    else await item.load()
                    console.log(`[RAG DIAG] Section ${index}: Loaded successfully`)
                    loaded = true
                    break
                } catch (err) {
                    console.log(`[RAG DIAG] Section ${index}: Loader failed`, err)
                    lastErr = err
                }
            }

            if (!loaded) throw lastErr || new Error("Failed to load spine item with all loaders")

            const doc = item.document
            if (!doc || !doc.body) throw new Error("Document body missing")

            // Bulletproof Hardening v3.4: Deep DOM Sanitization
            const bodyClone = doc.body.cloneNode(true) as HTMLElement

            // 1. Remove noise tags
            bodyClone.querySelectorAll('script, style, iframe, object, embed, svg, math, link, meta, noscript').forEach(n => n.remove())

            // 2. Remove oversized data-URIs
            bodyClone.querySelectorAll('img').forEach(img => {
                const src = img.getAttribute('src') || ''
                if (src.startsWith('data:') && src.length > 2000) {
                    img.removeAttribute('src')
                }
            })

            // 3. Strip attributes to speed up Turndown
            bodyClone.querySelectorAll('*').forEach(el => {
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
                    metadata: { sectionIndex: index, cfi, href, idref, sectionTitle }
                }
            })
            await yieldToMain()
        } catch (e) {
            console.error("Failed to extract section:", e)
            // Signal skip with reason to avoid hanging the worker pipeline
            worker.postMessage({
                type: 'index',
                payload: {
                    bookId,
                    markdown: "",
                    metadata: {
                        sectionIndex: index,
                        cfi: "",
                        href: item?.href || "",
                        skipped: true,
                        reason: String((e as any)?.message || e)
                    }
                }
            })
        } finally {
            try {
                // Critical: unload after all processing is done to avoid DeadObject
                item.unload()
            } catch { }
        }
    }

    /**
     * Retrieves relevant context for a query using Voy (CSP-safe WASM)
     * Now supports hybrid search (vector + BM25) for better results
     */
    /**
     * Retrieves relevant context for a query using Voy (CSP-safe WASM)
     * Now supports hybrid search (vector + BM25) for better results
     */
    async retrieveContext(bookId: string, query: string, topK = 5, options: {
        expandContext?: boolean;
        maxChars?: number;
        useHybrid?: boolean;
        chapterGateTopN?: number;
        softGateOutlierRank?: number;
        disableChapterGate?: boolean;
        locale?: string;
    } = {}) {
        const {
            expandContext = true,
            maxChars = 20000,
            useHybrid = true,
            chapterGateTopN = 3,
            softGateOutlierRank = 10,
            disableChapterGate = false,
            locale = 'en'
        } = options
        const embedConfig = getEmbeddingConfig()

        const telemetryStart = (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0
        const logTelemetry = (results: number) => {
            if (process.env.NODE_ENV !== 'development') return
            const elapsed = (typeof performance !== 'undefined' && performance.now)
                ? Math.round(performance.now() - telemetryStart)
                : 0
            const heap = (performance as any)?.memory?.usedJSHeapSize
            console.log('[RAG Telemetry] retrieveContext', {
                elapsed,
                results,
                heap
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
        if (!activeIndex) {
            logTelemetry(0)
            return []
        }

        if (activeIndex.model && activeIndex.model !== embedConfig.id) {
            throw new IndexCompatibilityError("Embedding model mismatch. Re-indexing required.")
        }

        // SOTA v7.2: ragVersion guard (locale + model + dim + chunking)
        if (activeIndex.ragVersion) {
            const expected = computeRagVersion({
                model: embedConfig.id,
                dim: activeIndex.dim || 384,
                locale: activeIndex.locale || locale
            })
            if (activeIndex.ragVersion !== expected) {
                throw new IndexCompatibilityError("RAG index version mismatch. Re-indexing required.")
            }
        } else if (activeIndex.version && activeIndex.version !== (AI_CONFIG as any).ragVersion) {
            // Legacy version guard for old indices
            throw new IndexCompatibilityError("RAG architecture mismatch. Re-indexing required.")
        }

        if (!activeIndex.data) throw new Error("Index data is empty.")

        const { Voy } = await import('voy-search')

        let cached = RAGService.voyInstances.get(bookId)
        if (!cached) {
            // EVICT OLDEST if over capacity
            if (RAGService.voyInstances.size >= RAGService.MAX_BOOKS_IN_RAM) {
                const oldestId = Array.from(RAGService.cacheAccessTime.entries())
                    .sort((a, b) => a[1] - b[1])[0]?.[0]
                if (oldestId) {
                    RAGService.voyInstances.delete(oldestId)
                    RAGService.allChunksCache.delete(oldestId)
                    RAGService.cacheAccessTime.delete(oldestId)
                }
            }

            cached = {
                chunks: Voy.deserialize(activeIndex.data),
                chapters: chapterIndexRecord?.data ? Voy.deserialize(chapterIndexRecord.data) : undefined
            }
            RAGService.voyInstances.set(bookId, cached)
        }
        RAGService.cacheAccessTime.set(bookId, Date.now())

        const effectiveDim = activeIndex.dim || embedConfig.dim || 384
        const ragLocale = normalizeLangForRAG(locale, 'en')
        const queryVector = await this.embedInWorker(query, 'query', embedConfig, ragLocale, effectiveDim)

        // ===== Chapter gating =====
        let allowedSections: Set<number> | null = null
        if (cached.chapters && !disableChapterGate) {
            const chapterResults = cached.chapters.search(queryVector as any, chapterGateTopN)
            allowedSections = new Set(chapterResults.neighbors.map((n: any) => Number(n.id)).filter((id: number) => !isNaN(id)))
        }

        // ===== cache allChunks + byIndex (somente se híbrido) =====
        let allChunks: VectorRecord[] | null = null
        let byIndex: Map<number, VectorRecord> | null = null

        if (useHybrid) {
            allChunks = RAGService.allChunksCache.get(bookId) || null
            if (!allChunks) {
                allChunks = await db?.vectors.where('bookId').equals(bookId).toArray() || []
                RAGService.allChunksCache.set(bookId, allChunks)
            }
            if (allChunks.length === 0) {
                logTelemetry(0)
                return []
            }
            byIndex = new Map(allChunks.map(c => [c.index, c]))
        }

        // ===== BM25 subset (speed) =====
        const bm25Corpus = (useHybrid && allChunks)
            ? (allowedSections ? allChunks.filter(c => allowedSections!.has(c.metadata?.sectionIndex)) : allChunks)
            : []

        // ===== Vector Search =====
        // SOTA v3.12: Proportional search topK
        const searchTopK = allowedSections ? Math.max(200, topK * 15) : topK * 4
        const vectorRaw = cached.chunks.search(queryVector as any, searchTopK)

        // score real (se houver distância)
        const vectorResults: (VectorRecord & { score: number })[] = []
        for (let rank = 0; rank < vectorRaw.neighbors.length; rank++) {
            const n: any = vectorRaw.neighbors[rank]
            const id = Number(n.id)
            const dist = typeof n.distance === 'number' ? n.distance : (typeof n.dist === 'number' ? n.dist : null)
            const sim = dist === null ? 1 : (1 / (1 + dist))

            // pegar chunk
            let chunk: VectorRecord | undefined

            if (useHybrid && byIndex) {
                chunk = byIndex.get(id)
            } else {
                // vector-only: busca pontual
                const row = await db?.vectors.where('[bookId+index]').equals([bookId, id] as any).first()
                chunk = row as any
            }

            if (!chunk) continue

            // soft gate
            if (allowedSections && !allowedSections.has(chunk.metadata?.sectionIndex)) {
                if (rank > softGateOutlierRank) continue
            }

            vectorResults.push({ ...chunk, score: sim })
            if (vectorResults.length >= topK * 3) break
        }

        // ===== Hybrid fuse =====
        let finalRankedResults: (VectorRecord & { score: number })[] = []

        if (useHybrid) {
            const bm25Results = bm25Search(query, bm25Corpus, topK * 3, locale)
            const hybridResults = hybridSearch(vectorResults, bm25Results, 0.5, 60)

            finalRankedResults = hybridResults.slice(0, topK).map(r => ({
                ...(r as any),
                score: (r as any).hybridScore
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
                    if (prev && prev.metadata?.sectionIndex === item.metadata?.sectionIndex) add(prev, 0.9)
                    if (!seen.has(item.index)) { seen.add(item.index); outputList.push(item) }
                    if (next && next.metadata?.sectionIndex === item.metadata?.sectionIndex) add(next, 0.9)
                } else {
                    // vector-only: fetch expansions pontuais
                    const keys = [
                        [bookId, item.index - 1],
                        [bookId, item.index + 1],
                    ]
                    const expansions = await db?.vectors.where('[bookId+index]').anyOf(keys as any).toArray() || []
                    const prev = expansions.find(e => e.index === item.index - 1)
                    const next = expansions.find(e => e.index === item.index + 1)

                    if (prev && prev.metadata?.sectionIndex === item.metadata?.sectionIndex) add(prev, 0.9)
                    if (!seen.has(item.index)) { seen.add(item.index); outputList.push(item) }
                    if (next && next.metadata?.sectionIndex === item.metadata?.sectionIndex) add(next, 0.9)
                }
            } else {
                if (!seen.has(item.index)) { seen.add(item.index); outputList.push(item) }
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

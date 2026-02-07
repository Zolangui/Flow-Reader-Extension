/// <reference lib="webworker" />
import { Wllama } from '@wllama/wllama/esm'
import type { Voy as VoyType } from 'voy-search'

const DEBUG_EMBED = process.env.NODE_ENV !== 'production'
const WLLAMA_ASSET_VERSION = '20260204a'

type Backend = 'transformers' | 'wllama' | 'webgpu'

// Xenova/all-MiniLM-L6-v2 produces 384-dim sentence embeddings.
const ONNX_DIM = 384
const WLLAMA_EMBED_MODEL_URL =
    'https://huggingface.co/Ralriki/multilingual-e5-large-instruct-GGUF/resolve/main/multilingual-e5-large-instruct-q6_k.gguf'

// EXPERIMENTAL: WebGPU model for 15-30x faster embeddings (Firefox 147+)
// Using multilingual-e5-large for SOTA multilingual support (100 languages, 1024-dim)
const WEBGPU_EMBED_MODEL = 'onnx-community/multilingual-e5-large'

const yieldToWorker = () => new Promise<void>(resolve => setTimeout(resolve, 0))

const isFirefox = typeof navigator !== 'undefined' && /Firefox/i.test(navigator.userAgent || '')

// EXPERIMENTAL: WebGPU detection for GPU-accelerated embeddings
async function hasWebGPU(): Promise<boolean> {
    console.log('[RAG WORKER] Checking WebGPU availability...')
    console.log('[RAG WORKER] isSecureContext:', typeof isSecureContext !== 'undefined' ? isSecureContext : 'unknown')
    console.log('[RAG WORKER] User Agent:', typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown')

    if (typeof navigator === 'undefined' || !(navigator as any).gpu) {
        console.log('[RAG WORKER] ❌ navigator.gpu is undefined')
        return false
    }

    const gpu = (navigator as any).gpu
    console.log('[RAG WORKER] navigator.gpu exists, requesting adapter...')
    try {
        // Try standard request first
        let adapter = await gpu.requestAdapter()

        if (!adapter) {
            console.log('[RAG WORKER] ⚠️ navigator.gpu.requestAdapter() returned null (Standard)')
            console.log('[RAG WORKER] Trying with powerPreference: low-power...')
            adapter = await gpu.requestAdapter({ powerPreference: 'low-power' })
        }

        if (!adapter) {
            console.log('[RAG WORKER] ⚠️ navigator.gpu.requestAdapter() returned null (Low-Power)')
            console.log('[RAG WORKER] Trying with powerPreference: high-performance...')
            adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' })
        }

        if (!adapter) {
            console.log('[RAG WORKER] ❌ WebGPU adapter still null after all attempts')
            return false
        }

        const info = await (adapter as any).requestAdapterInfo?.() || {}
        console.log('[RAG WORKER] ✅ WebGPU Adapter found:', {
            vendor: info.vendor,
            architecture: info.architecture,
            device: info.device,
            description: info.description
        })

        return true
    } catch (err: any) {
        console.error('[RAG WORKER] ❌ Fatal error requesting WebGPU adapter:', err?.message || err)
        return false
    }
}



let embedder: any = null
let wllama: Wllama | null = null
let useWllamaWorkerOverride = false
let backend: Backend | null = null
let voyChunks: VoyType | null = null
let voyChapters: VoyType | null = null
let initialized = false
let cancelled = false
let itemsAdded = 0
let embeddingModel = ''
let embedDim = ONNX_DIM
let outputDim = ONNX_DIM
let targetDim: number | null = null
let voyAcceptsTypedArrays = false
const skippedSections: { sectionIndex: number; reason: string }[] = []
let currentLocale = 'en'
let embeddingPrefixQuery = ''
let embeddingPrefixDocument = ''

let transformersPromise: Promise<typeof import('@xenova/transformers')> | null = null
async function getTransformers() {
    if (!transformersPromise) {
        transformersPromise = import('@xenova/transformers')
    }
    return transformersPromise
}

function debugLog(message: string, data?: Record<string, any>) {
    if (!DEBUG_EMBED) return
    try {
        self.postMessage({ type: 'embedding-debug', data: { message, ...(data || {}) } })
    } catch {
        // ignore debug post errors
    }
}

const METADATA_PREFIX = '__metadata__'

class DirectOPFSCacheManager {
    private async getCacheDir() {
        const storage = (navigator as any)?.storage
        if (!storage?.getDirectory) {
            throw new Error('OPFS not supported (navigator.storage.getDirectory missing)')
        }
        const opfsRoot = await storage.getDirectory()
        return await opfsRoot.getDirectoryHandle('cache', { create: true })
    }

    private async urlToFileName(url: string, prefix: string) {
        const hashBuffer = await crypto.subtle.digest(
            'SHA-1',
            new TextEncoder().encode(url)
        )
        const hashArray = Array.from(new Uint8Array(hashBuffer))
        const hashHex = hashArray
            .map((b) => b.toString(16).padStart(2, '0'))
            .join('')
        return `${prefix}${hashHex}_${url.split('/').pop()}`
    }

    private async writeMetadata(fileName: string, metadata: Record<string, any>) {
        const cacheDir = await this.getCacheDir()
        const fileHandle = await cacheDir.getFileHandle(fileName, { create: true })
        if ((fileHandle as any).createWritable) {
            const writable = await (fileHandle as any).createWritable()
            await writable.write(new TextEncoder().encode(JSON.stringify(metadata)))
            await writable.close()
            return
        }
        const accessHandle = await (fileHandle as any).createSyncAccessHandle?.()
        if (!accessHandle) {
            throw new Error('OPFS metadata write failed (no writable or sync access handle)')
        }
        const buf = new TextEncoder().encode(JSON.stringify(metadata))
        accessHandle.truncate(0)
        accessHandle.write(buf, { at: 0 })
        accessHandle.flush()
        accessHandle.close()
    }

    async write(name: string, stream: ReadableStream, metadata: Record<string, any>) {
        const cacheDir = await this.getCacheDir()
        const fileHandle = await cacheDir.getFileHandle(name, { create: true })
        const reader = stream.getReader()
        const syncHandle = (fileHandle as any).createSyncAccessHandle
            ? await (fileHandle as any).createSyncAccessHandle()
            : null
        const writable = !syncHandle && (fileHandle as any).createWritable
            ? await (fileHandle as any).createWritable()
            : null

        if (syncHandle) {
            syncHandle.truncate(0)
        } else if (writable) {
            await writable.truncate(0)
        }

        let offset = 0
        let done = false
        while (!done) {
            const chunk = await reader.read()
            done = chunk.done
            const value = chunk.value
            if (!value) continue
            if (syncHandle) {
                syncHandle.write(value, { at: offset })
            } else if (writable) {
                await writable.write({ type: 'write', position: offset, data: value })
            }
            offset += value.byteLength
        }

        if (syncHandle) {
            syncHandle.flush()
            syncHandle.close()
        } else if (writable) {
            await writable.close()
        }

        await this.writeMetadata(`${METADATA_PREFIX}${name}`, metadata)
    }

    async download(
        url: string,
        options: {
            headers?: Record<string, string>
            signal?: AbortSignal
            progressCallback?: (p: { loaded: number; total: number }) => void
        } = {}
    ): Promise<void> {
        debugLog('download_start', { url })
        const filename = await this.urlToFileName(url, '')
        const metadataFileName = await this.urlToFileName(url, METADATA_PREFIX)

        const cacheDir = await this.getCacheDir()
        const fileHandle = await cacheDir.getFileHandle(filename, { create: true })

        const response = await fetch(url, {
            headers: options.headers,
            signal: options.signal
        })
        debugLog('download_response', { status: response.status })
        if (!response.ok || !response.body) {
            throw new Error(`Download failed: ${response.status} ${response.statusText}`)
        }

        const total = Number(response.headers.get('content-length') || '0')
        const etag = (response.headers.get('etag') || '').replace(/[^A-Za-z0-9]/g, '')
        const reader = response.body.getReader()

        const syncHandle = (fileHandle as any).createSyncAccessHandle
            ? await (fileHandle as any).createSyncAccessHandle()
            : null
        const writable = !syncHandle && (fileHandle as any).createWritable
            ? await (fileHandle as any).createWritable()
            : null

        if (syncHandle) {
            syncHandle.truncate(0)
        } else if (writable) {
            await writable.truncate(0)
        }

        let loaded = 0
        let done = false
        while (!done) {
            const chunk = await reader.read()
            done = chunk.done
            const value = chunk.value
            if (!value) continue
            if (syncHandle) {
                syncHandle.write(value, { at: loaded })
            } else if (writable) {
                await writable.write({ type: 'write', position: loaded, data: value })
            }
            loaded += value.byteLength
            options.progressCallback?.({ loaded, total: total || loaded })
        }

        options.progressCallback?.({ loaded, total: total || loaded })

        if (syncHandle) {
            syncHandle.flush()
            syncHandle.close()
        } else if (writable) {
            await writable.close()
        }

        await this.writeMetadata(metadataFileName, {
            originalURL: url,
            originalSize: total || loaded,
            etag
        })
        debugLog('download_complete', { loaded, total: total || loaded })
    }

    async getNameFromURL(url: string): Promise<string> {
        return await this.urlToFileName(url, '')
    }

    async open(nameOrURL: string): Promise<Blob | null> {
        try {
            const cacheDir = await this.getCacheDir()
            const fileName = nameOrURL.includes('://')
                ? await this.urlToFileName(nameOrURL, '')
                : nameOrURL
            const fileHandle = await cacheDir.getFileHandle(fileName)
            const file = await (fileHandle as any).getFile()
            debugLog('cache_hit', { name: fileName, size: file?.size || 0 })
            return file || null
        } catch {
            const name = nameOrURL.includes('://')
                ? await this.urlToFileName(nameOrURL, '').catch(() => nameOrURL)
                : nameOrURL
            debugLog('cache_miss', { name })
            return null
        }
    }

    async getSize(nameOrURL: string): Promise<number> {
        try {
            const file = await this.open(nameOrURL)
            return file ? file.size : -1
        } catch {
            return -1
        }
    }

    async getMetadata(nameOrURL: string): Promise<{ originalSize: number; originalURL: string; etag: string } | null> {
        try {
            const cacheDir = await this.getCacheDir()
            const fileName = nameOrURL.includes('://')
                ? await this.urlToFileName(nameOrURL, '')
                : nameOrURL
            const metaHandle = await cacheDir.getFileHandle(`${METADATA_PREFIX}${fileName}`)
            const file = await (metaHandle as any).getFile()
            const json = await new Response(file).json().catch(() => null)
            return json || null
        } catch {
            return null
        }
    }

    async list(): Promise<Array<{ name: string; size: number; metadata: { originalSize: number; originalURL: string; etag: string } }>> {
        const cacheDir = await this.getCacheDir()
        const result: Array<{ name: string; size: number; metadata: { originalSize: number; originalURL: string; etag: string } }> = []
        const metadataMap: Record<string, any> = {}

        // @ts-ignore
        for await (const [name, handler] of cacheDir.entries()) {
            if (handler.kind === 'file' && String(name).startsWith(METADATA_PREFIX)) {
                const file = await (handler as any).getFile()
                const meta = await new Response(file).json().catch(() => null)
                metadataMap[String(name).replace(METADATA_PREFIX, '')] = meta
            }
        }

        // @ts-ignore
        for await (const [name, handler] of cacheDir.entries()) {
            if (handler.kind === 'file' && !String(name).startsWith(METADATA_PREFIX)) {
                const file = await (handler as any).getFile()
                const meta = metadataMap[String(name)] || {
                    originalSize: file.size,
                    originalURL: '',
                    etag: ''
                }
                result.push({ name: String(name), size: file.size, metadata: meta })
            }
        }
        return result
    }

    async deleteMany(predicate: (f: { name: string }) => boolean): Promise<void> {
        const cacheDir = await this.getCacheDir()
        const entries = await this.list()
        for (const entry of entries) {
            if (!predicate(entry)) continue
            await cacheDir.removeEntry(entry.name).catch(() => undefined)
            await cacheDir.removeEntry(`${METADATA_PREFIX}${entry.name}`).catch(() => undefined)
        }
    }

    async delete(nameOrURL: string): Promise<void> {
        const cacheDir = await this.getCacheDir()
        const fileName = nameOrURL.includes('://')
            ? await this.urlToFileName(nameOrURL, '')
            : nameOrURL
        await cacheDir.removeEntry(fileName).catch(() => undefined)
        await cacheDir.removeEntry(`${METADATA_PREFIX}${fileName}`).catch(() => undefined)
    }

    async clear(): Promise<void> {
        await this.deleteMany(() => true)
    }
}

const g = typeof self !== 'undefined' ? (self as any) : {}
const getURL = g.browser?.runtime?.getURL || g.chrome?.runtime?.getURL
const resolveWasmBase = () => {
    if (typeof getURL === 'function') return getURL('wasm/')
    const origin = (self as any)?.location?.origin
    if (origin) return `${origin}/wasm/`
    return '/wasm/'
}

async function configureTransformersEnv() {
    const { env } = await getTransformers()

    // SOTA: keep everything remote + cached by the browser. Avoid local-path probes that can fail under MV3.
    env.allowLocalModels = false
    env.useBrowserCache = true

    env.backends.onnx.wasm.wasmPaths = resolveWasmBase()
    debugLog('wasm_paths', { base: env.backends.onnx.wasm.wasmPaths })
}

const originalFetch = self.fetch.bind(self)
self.fetch = async (...args: any[]) => {
    if (DEBUG_EMBED) {
        const url = typeof args[0] === 'string' ? args[0] : args[0]?.url
        if (url) debugLog('fetch', { url })
    }
    return originalFetch(...args)
}

const installWllamaWorkerOverride = () => {
    // Firefox MV3 SOTA: Force use of physical worker with INLINED WASM
    // This bypasses 'worker-src blob:' CSP restrictions and 'NetworkError' from fetch.
    const anySelf = self as any
    if (anySelf.__wllamaWorkerOverrideInstalled) return

    const g = self as any
    const getURL = g.browser?.runtime?.getURL || g.chrome?.runtime?.getURL
    const origin = g?.location?.origin || ''
    const withVersion = (url: string) =>
        `${url}${url.includes('?') ? '&' : '?'}v=${WLLAMA_ASSET_VERSION}`
    const wllamaWorkerUrl =
        typeof getURL === 'function'
            ? withVersion(getURL('wasm/wllama.worker.js'))
            : withVersion(`${origin}/wasm/wllama.worker.js`)
    const opfsWorkerUrl =
        typeof getURL === 'function'
            ? withVersion(getURL('wasm/wllama.opfs.worker.js'))
            : withVersion(`${origin}/wasm/wllama.opfs.worker.js`)

    // wllama creates two different Blob workers:
    // - the main llama.cpp worker (large, contains Module + LLAMA_CPP_WORKER_CODE)
    // - the OPFS helper worker (smaller, used by CacheManager to write/download to OPFS)
    //
    // Routing by blob size is brittle across wllama versions/minifiers; in a Worker we can
    // synchronously peek the blob header via FileReaderSync and detect OPFS-related code.
    const OPFS_WORKER_MAX_BYTES = 20_000

    const originalCreateObjectURL = URL.createObjectURL.bind(URL)
    URL.createObjectURL = (blob: any) => {
        try {
            const blobType = String(blob?.type || '').toLowerCase()
            if (blob instanceof Blob && (blobType.includes('javascript') || blobType === '')) {
                let chosen: string
                try {
                    const fr =
                        typeof (self as any).FileReaderSync === 'function'
                            ? new (self as any).FileReaderSync()
                            : null
                    const head = fr ? String(fr.readAsText(blob.slice(0, 2048))) : ''

                    // Only override blobs that look like wllama workers. Avoid hijacking unrelated libs
                    // that legitimately create Blob workers inside this Worker.
                    const isLikelyWllama =
                        head.includes('LLAMA_CPP') ||
                        head.includes('wModuleInit') ||
                        head.includes('wllama') ||
                        head.includes('_wllama_') ||
                        head.includes('wllama_action') ||
                        head.includes('llama.cpp')
                    const isOpfs =
                        head.includes('navigator.storage.getDirectory') ||
                        head.includes('getDirectoryHandle') ||
                        head.toLowerCase().includes('opfs')

                    // Some wllama versions/minifiers can remove our fingerprint strings.
                    // In those cases, fall back to size heuristics: OPFS workers are tiny, llama workers are ~70-100KB.
                    if (!isOpfs && !isLikelyWllama) {
                        if (blob.size <= OPFS_WORKER_MAX_BYTES) {
                            chosen = opfsWorkerUrl
                        } else if (blob.size >= 60_000) {
                            chosen = wllamaWorkerUrl
                        } else {
                            return originalCreateObjectURL(blob)
                        }
                    } else {
                        chosen = isOpfs ? opfsWorkerUrl : wllamaWorkerUrl
                    }
                } catch {
                    // If we can't inspect the source, be conservative:
                    // - small blob: assume OPFS helper
                    // - very large blob: assume llama worker
                    // - otherwise: do not override
                    if (blob.size <= OPFS_WORKER_MAX_BYTES) {
                        chosen = opfsWorkerUrl
                    } else if (blob.size >= 60_000) {
                        chosen = wllamaWorkerUrl
                    } else {
                        return originalCreateObjectURL(blob)
                    }
                }
                debugLog('wllama_worker_override', {
                    url: chosen,
                    size: blob.size,
                    kind: chosen === opfsWorkerUrl ? 'opfs' : 'llama',
                })
                return chosen
            }
        } catch {
            // ignore override errors
        }
        return originalCreateObjectURL(blob)
    }

    anySelf.__wllamaWorkerOverrideInstalled = true
}


/**
 * Message Types for Communication
 */
interface InboundMessage {
    type: 'init' | 'index' | 'finalize' | 'cancel' | 'embed'
    payload?: any
    requestId?: number
}

/**
 * Optimized dot product
 */
function dotProduct(a: ArrayLike<number>, b: ArrayLike<number>) {
    let dot = 0
    const n = Math.min(a.length, b.length)
    for (let i = 0; i < n; i++) dot += a[i] * b[i]
    return dot
}

/**
 * Normalization Utility (Zero-Copy focused)
 */
function normalizeInPlace(vec: Float32Array) {
    let norm = 0
    for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i]
    norm = Math.sqrt(norm) || 1
    for (let i = 0; i < vec.length; i++) vec[i] /= norm
}

function maybeTruncateEmbedding(vec: Float32Array | number[]) {
    if (!outputDim || outputDim >= vec.length) return vec

    const truncated = vec instanceof Float32Array
        ? vec.slice(0, outputDim)
        : vec.slice(0, outputDim)

    let norm = 0
    for (let i = 0; i < truncated.length; i++) norm += truncated[i] * truncated[i]
    norm = Math.sqrt(norm) || 1
    for (let i = 0; i < truncated.length; i++) truncated[i] /= norm

    return truncated
}

async function embedWithWllama(text: string): Promise<Float32Array> {
    if (!wllama) throw new Error('Wllama not initialized')
    const input = `${embeddingPrefixDocument}${text}`

    debugLog('embed_start', { textLen: text.length, inputLen: input.length })
    const raw = await wllama.createEmbedding(input)
    debugLog('embed_done', { rawLen: raw.length })

    const vec = new Float32Array(embedDim)
    const len = Math.min(raw.length, embedDim)
    for (let i = 0; i < len; i++) vec[i] = raw[i]
    normalizeInPlace(vec)
    return vec
}

function applyEmbeddingPrefix(text: string, mode: 'query' | 'document') {
    const prefix = mode === 'query' ? embeddingPrefixQuery : embeddingPrefixDocument
    return `${prefix || ''}${text}`
}

async function embedText(text: string, mode: 'query' | 'document'): Promise<Float32Array> {
    const clean = String(text || '').trim()
    if (!clean) return new Float32Array(outputDim || embedDim || ONNX_DIM)

    if (backend === 'wllama') {
        if (!wllama) throw new Error('Wllama not initialized')
        const raw = await wllama.createEmbedding(applyEmbeddingPrefix(clean, mode))
        const vec = new Float32Array(embedDim)
        const len = Math.min(raw.length, embedDim)
        for (let i = 0; i < len; i++) vec[i] = raw[i]
        normalizeInPlace(vec)
        const maybe = maybeTruncateEmbedding(vec)
        return maybe instanceof Float32Array ? maybe : Float32Array.from(maybe as any)
    }

    if (!embedder) throw new Error('Embedder not initialized')
    // `pipeline('feature-extraction')` returns a callable that supports pooling/normalize.
    const out = await embedder(applyEmbeddingPrefix(clean, mode), { pooling: 'mean', normalize: true })
    const data = out?.data instanceof Float32Array ? out.data : new Float32Array(out?.data || [])
    const vec = data.length === embedDim ? data : data.slice(0, embedDim)
    normalizeInPlace(vec)
    const maybe = maybeTruncateEmbedding(vec)
    return maybe instanceof Float32Array ? maybe : Float32Array.from(maybe as any)
}

/**
 * Semantic Splitter (Internal to Worker, Locale Aware)
 */
function splitSentences(text: string, locale = 'en'): string[] {
    const blocks = text.split(/\n{2,}/g).map(b => b.trim()).filter(Boolean)
    if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
        try {
            const seg = new (Intl as any).Segmenter(locale, { granularity: 'sentence' })
            return blocks.flatMap(block =>
                Array.from(seg.segment(block))
                    .map((s: any) => s.segment.trim())
                    .filter((s: string) => s.length > 0)
            )
        } catch { }
    }
    // Fallback using global punctuation (includes CJK)
    return blocks
        .flatMap((b) =>
            b
                .match(/[^.!?\u3002\uFF01\uFF1F\u00A1\u00BF]+(?:[.!?\u3002\uFF01\uFF1F\u00A1\u00BF]+|$)/g)
                ?.map((s) => s.trim()) ?? [b],
        )
        .filter(Boolean)
}

/**
 * Safe TypedArray to Array conversion (Zero-Copy where possible)
 */
function toIntArray(ids: ArrayLike<any>): number[] {
    const out = new Array(ids.length)
    for (let i = 0; i < ids.length; i++) {
        const v = (ids as any)[i]
        out[i] = typeof v === 'bigint' ? Number(v) : (v | 0)
    }
    return out
}

function viewIds(inputIds: any, start: number, end: number) {
    if (inputIds?.subarray) return inputIds.subarray(start, end)
    return inputIds.slice(start, end)
}

/**
 * Main Initialization
 */
async function initialize(payload: {
    model?: string
    modelUrl?: string
    modelId?: string
    backend?: Backend
    locale?: string
    truncateDim?: number
    embeddingPrefixes?: { query?: string; document?: string }
    experimentalWebGPU?: boolean  // EXPERIMENTAL: Enable WebGPU for 15-30x faster embeddings
}) {

    try {
        const requestedDim = Number(payload?.truncateDim)
        const nextTargetDim = Number.isFinite(requestedDim) && requestedDim > 0 ? requestedDim : null

        if (payload.locale) currentLocale = payload.locale
        if (payload.embeddingPrefixes) {
            embeddingPrefixQuery = payload.embeddingPrefixes.query || ''
            embeddingPrefixDocument = payload.embeddingPrefixes.document || ''
            debugLog('embedding_prefixes', {
                query: embeddingPrefixQuery,
                document: embeddingPrefixDocument
            })
        } else {
            embeddingPrefixQuery = ''
            embeddingPrefixDocument = ''
        }

        const backendHint = payload?.backend
        // EXPERIMENTAL: Try WebGPU first for 15-30x faster embeddings (Firefox 147+)
        const webgpuAvailable = await hasWebGPU()
        const useExperimentalWebGPU = payload?.experimentalWebGPU !== false && webgpuAvailable

        let nextBackend: Backend
        if (backendHint === 'wllama') {
            nextBackend = 'wllama'
        } else if (backendHint === 'transformers') {
            nextBackend = 'transformers'
        } else if (backendHint === 'webgpu' || useExperimentalWebGPU) {
            nextBackend = 'webgpu'
            debugLog('webgpu_detected', { available: webgpuAvailable, experimental: true })
        } else {
            nextBackend = isFirefox ? 'wllama' : 'transformers'
        }

        console.log('[RAG WORKER] Backend selection:', { nextBackend, webgpuAvailable, isFirefox, backendHint })

        const modelUrl = payload?.modelUrl || WLLAMA_EMBED_MODEL_URL
        const nextModelId = nextBackend === 'wllama'
            ? (payload?.modelId || modelUrl)
            : String(payload?.model || '')

        if (initialized && backend === nextBackend && embeddingModel === nextModelId && targetDim === nextTargetDim) {
            self.postMessage({ type: 'initialized', payload: { dim: outputDim } })
            return
        }

        backend = nextBackend
        embeddingModel = nextModelId
        targetDim = nextTargetDim

        debugLog('backend', { name: backend })
        debugLog('init_start', { model: embeddingModel })

        const { Voy } = await import('voy-search')

        // EXPERIMENTAL: WebGPU backend for 15-30x faster embeddings
        if (backend === 'webgpu') {
            debugLog('webgpu_init_start', { model: WEBGPU_EMBED_MODEL })
            console.log('[RAG WORKER] 🚀 EXPERIMENTAL: Initializing WebGPU embedder for 15-30x speedup...')

            try {
                await configureTransformersEnv()
                const { pipeline } = await getTransformers()

                // NOTE: 'device' requires Transformers.js v3.x - cast as any for experimental support
                embedder = await pipeline('feature-extraction', WEBGPU_EMBED_MODEL, {
                    device: 'webgpu',  // 🔥 WebGPU acceleration (Transformers.js v3+)
                    quantized: true,
                    progress_callback: (d: any) => {
                        if (d.status === 'progress') {
                            debugLog('webgpu_progress', { file: d.file, progress: d.progress })
                            self.postMessage({
                                type: 'rag-progress',
                                data: { status: 'progress', progress: d.progress, file: d.file, backend: 'webgpu' }
                            })
                        }
                    }
                } as any)


                embedDim = ONNX_DIM
                wllama = null
                console.log('[RAG WORKER] ✅ WebGPU embedder initialized successfully!')
                debugLog('webgpu_init_success', { dim: embedDim })
            } catch (webgpuErr: any) {
                // Fallback to wllama if WebGPU fails
                console.warn('[RAG WORKER] ⚠️ WebGPU failed, falling back to wllama WASM:', webgpuErr?.message)
                debugLog('webgpu_init_failed', { error: String(webgpuErr?.message), fallback: 'wllama' })
                backend = 'wllama'  // Switch to wllama
            }
        }

        if (backend === 'wllama') {
            const anySelf = self as any
            if (!anySelf.document) {
                anySelf.document = { baseURI: self.location?.href || '' }
            }

            const initWllama = async (opts: { forceWorkerOverride: boolean }) => {
                // Prefer blob workers (fast path). If CSP blocks blob workers in some environments,
                // retry with a physical worker file override.
                if (opts.forceWorkerOverride && !useWllamaWorkerOverride) {
                    useWllamaWorkerOverride = true
                    installWllamaWorkerOverride()
                    debugLog('override_enabled', { workerOverride: true })
                }

                const withVersion = (url: string) =>
                    `${url}${url.includes('?') ? '&' : '?'}v=${WLLAMA_ASSET_VERSION}`

                const wasmPaths: any = {}
                if (typeof getURL === 'function') {
                    wasmPaths['single-thread/wllama.wasm'] = withVersion(getURL('wasm/wllama-single.wasm'))
                } else {
                    const origin = (self as any)?.location?.origin || ''
                    wasmPaths['single-thread/wllama.wasm'] = withVersion(`${origin}/wasm/wllama-single.wasm`)
                }

                // Only expose the multi-thread build if this context is actually cross-origin isolated.
                // Otherwise, wllama may probe the threaded build, which is noisy and can trigger CSP issues.
                const canUseMultiThread =
                    typeof (self as any).SharedArrayBuffer !== 'undefined' &&
                    (self as any).crossOriginIsolated === true
                if (canUseMultiThread) {
                    if (typeof getURL === 'function') {
                        wasmPaths['multi-thread/wllama.wasm'] = withVersion(getURL('wasm/wllama-multi.wasm'))
                    } else {
                        const origin = (self as any)?.location?.origin || ''
                        wasmPaths['multi-thread/wllama.wasm'] = withVersion(`${origin}/wasm/wllama-multi.wasm`)
                    }
                }

                debugLog('wllama_wasm_paths', wasmPaths)
                wllama = new Wllama(wasmPaths, {
                    cacheManager: new DirectOPFSCacheManager() as any,
                    allowOffline: true,
                    logger: {
                        debug: (...args) => debugLog('logger_debug', { args: args.map(a => String(a)) }),
                        log: (...args) => debugLog('logger_log', { args: args.map(a => String(a)) }),
                        warn: (...args) => debugLog('logger_warn', {
                            args: args.map(a => {
                                try { return typeof a === 'object' ? JSON.stringify(a) : String(a) } catch { return String(a) }
                            })
                        }),
                        error: (...args) => debugLog('logger_error', { args: args.map(a => String(a)) }),
                    }
                })

                // Best-effort: mark cached early for UX if OPFS already contains the model.
                try {
                    const name = await (wllama as any).cacheManager?.getNameFromURL?.(modelUrl)
                    const size = await (wllama as any).cacheManager?.getSize?.(name || modelUrl)
                    if (typeof size === 'number' && size > 0) {
                        debugLog('cache_hit', { name: name || modelUrl, size })
                    }
                } catch {
                    // ignore
                }

                debugLog('wllama_monitor', { status: 'rag_loading_model_start', url: modelUrl })
                await wllama.loadModelFromUrl(modelUrl, {
                    embeddings: true,
                    pooling_type: 'LLAMA_POOLING_TYPE_MEAN',
                    n_threads: 1,
                    progressCallback: ({ loaded, total }) => {
                        const pct = total ? (loaded / total) * 100 : 0
                        if (pct % 10 < 1 || pct === 100) {
                            debugLog('progress', { file: 'gguf', progress: pct, loaded, total })
                        }
                        if (pct === 100) {
                            debugLog('download_complete', { loaded, total })
                        }
                        self.postMessage({
                            type: 'rag-progress',
                            data: {
                                status: 'progress',
                                progress: pct,
                                file: 'gguf'
                            }
                        })
                    }
                })
                debugLog('wllama_monitor', { status: 'rag_loading_model_success' })
            }

            const shouldRetryWithOverride = (err: unknown) => {
                if (useWllamaWorkerOverride) return false
                const msg = err instanceof Error ? err.message : String(err || '')
                return (
                    msg.includes('Content-Security-Policy') ||
                    msg.includes('worker-src') ||
                    msg.includes('blob:') ||
                    msg.includes('unsafe-eval')
                )
            }

            try {
                // Firefox MV3 blocks Blob workers (CSP). Proactively enable override on Firefox.
                await initWllama({ forceWorkerOverride: isFirefox })
            } catch (loadErr: any) {
                debugLog('wllama_monitor', { status: 'rag_loading_model_failed', error: String(loadErr?.message || loadErr) })
                if (shouldRetryWithOverride(loadErr)) {
                    debugLog('retry_with_override', { reason: 'csp_blob_worker_blocked' })
                    wllama = null
                    await initWllama({ forceWorkerOverride: true })
                } else {
                    throw loadErr
                }
            }

            const ctxInfo = wllama.getLoadedContextInfo?.()
            embedDim = ctxInfo?.n_embd || embedDim
            embedder = null
        } else {
            if (!payload?.model) {
                throw new Error('Missing embedding model id')
            }

            await configureTransformersEnv()
            const { pipeline } = await getTransformers()

            embedder = await pipeline('feature-extraction', payload.model, {
                quantized: true,
                progress_callback: (d: any) => {
                    if (d.status === 'progress') {
                        debugLog('progress', {
                            file: d.file,
                            progress: d.progress,
                            loaded: d.loaded,
                            total: d.total,
                        })
                        self.postMessage({
                            type: 'rag-progress',
                            data: {
                                status: 'progress',
                                progress: d.progress,
                                file: d.file
                            }
                        })
                    }
                }
            })

            embedDim = ONNX_DIM
            wllama = null
        }

        voyChunks = new Voy()
        voyChapters = new Voy()

        // SOTA: Voy Probe (Check for Float32Array support to save allocation)
        try {
            const testVoy = new Voy()
            testVoy.add({
                embeddings: [{ id: "probe", title: "", url: "", embeddings: new Float32Array(embedDim) as any }]
            } as any)
            voyAcceptsTypedArrays = true
        } catch {
            voyAcceptsTypedArrays = false
        }

        outputDim = targetDim && targetDim < embedDim ? targetDim : embedDim

        initialized = true
        skippedSections.length = 0

        debugLog('ready')
        self.postMessage({ type: 'initialized', payload: { dim: outputDim } })
    } catch (err: any) {
        const msg = String(err?.message || err)
        debugLog('init_error', { message: msg })
        self.postMessage({ type: 'embedding-error', data: { message: msg, stage: 'init' } })
        self.postMessage({ type: 'error', payload: { reason: `FAILED_INIT: ${msg}` } })
    }
}

/**
 * Optimized Section Processor
 */
async function processSection(bookId: string, markdown: string, metadata: any) {
    if (!initialized || !voyChunks || !voyChapters) return
    if (backend === 'wllama') {
        return processSectionWllama(bookId, markdown, metadata)
    }
    if (!embedder) return

    let doneSent = false
    // Industrial v3.5: Accurate Telemetry Payload State
    let donePayload: any = { sectionIndex: metadata?.sectionIndex ?? -1, skipped: false }

    const sendDone = (p: any) => {
        if (!doneSent) {
            doneSent = true
            self.postMessage({ type: 'sectionDone', payload: p })
        }
    }

    try {
        // Bulletproof Hardening v3.5: Structured Skip Reporting
        if (!markdown || markdown.trim().length === 0 || metadata.skipped) {
            const reason = metadata.reason || "empty markdown"
            skippedSections.push({ sectionIndex: metadata.sectionIndex, reason })
            donePayload = { sectionIndex: metadata.sectionIndex, skipped: true, reason }
            sendDone(donePayload)
            return
        }

        const markdownTokens = await embedder.tokenizer(markdown)
        const inputIds = markdownTokens.input_ids.data
        const numTokens = inputIds.length

        // SOTA v3.9.1: Memory Guardrail
        // If chapter is too large (>8k tokens), Late Chunking consumes massive RAM (30MB+ buffers).
        // Fallback to simpler sentence-level pooling for stability on potato machines.
        const MAX_LATE_CHUNK_TOKENS = 8000
        const useLateChunking = numTokens <= MAX_LATE_CHUNK_TOKENS

        let tokenEmbeddings: Float32Array | null = null

        if (useLateChunking) {
            // Late Chunking (v3.8): Embed large windows to preserve context
            const WINDOW_SIZE = 510 // Less than 512 to be safe
            const STRIDE = 384

            tokenEmbeddings = new Float32Array(numTokens * embedDim)
            const tokenWeight = new Float32Array(numTokens).fill(0)
            let lateOk = true

            for (let i = 0; i < numTokens; i += STRIDE) {
                if (cancelled) break
                const end = Math.min(i + WINDOW_SIZE, numTokens)
                const windowView = viewIds(inputIds, i, end)
                const windowIds = toIntArray(windowView)

                if (windowIds.length === 0) continue

                try {
                    // Safe decode
                    const textWindow = embedder.tokenizer.decode(windowIds, { skip_special_tokens: true })
                    if (!textWindow || textWindow.trim().length === 0) continue

                    // Safe forward
                    const out = await embedder(textWindow, { pooling: 'none' })
                    const data = out.data

                    // SOTA v3.12: Token Logic Alignment Check
                    // If normalization changed token count, we cannot map back 1:1 using index `d`.
                    // Fallback to sentence pooling for this whole section to ensure correctness.
                    const seqLen = Math.floor(data.length / embedDim)
                    if (seqLen !== windowIds.length) {
                        console.warn(`Late Chunking Mismatch [${metadata?.sectionIndex}]: Tokens ${windowIds.length} vs Embeds ${seqLen}. Falling back to standard pooling.`)
                        lateOk = false
                        tokenEmbeddings = null
                        break
                    }

                    const windowLen = windowIds.length

                    // Average overlapping regions
                    for (let j = 0; j < windowLen; j++) {
                        const globalIdx = i + j
                        if (globalIdx >= numTokens) break

                        const startOff = globalIdx * embedDim
                        const winOff = j * embedDim

                        for (let d = 0; d < embedDim; d++) {
                            tokenEmbeddings[startOff + d] += data[winOff + d]
                        }
                        tokenWeight[globalIdx]++
                    }
                } catch (e: any) {
                    console.warn(`Late Chunking Error [${metadata?.sectionIndex}]: ${e.message}. Falling back.`)
                    lateOk = false
                    tokenEmbeddings = null
                    break
                }
                await yieldToWorker()
            }

            // Finalize token embeddings (average overlaps) only if logic held up
            if (lateOk && tokenEmbeddings) {
                for (let i = 0; i < numTokens; i++) {
                    const weight = tokenWeight[i]
                    if (weight > 1) {
                        const off = i * embedDim
                        for (let d = 0; d < embedDim; d++) tokenEmbeddings[off + d] /= weight
                    }
                }
            } else {
                // Ensure null if failed
                tokenEmbeddings = null
            }
        }

        // Chapter Embedding (v3.9): Mean pooling of all token embeddings (or sentence embeddings for large chapters)
        const sectionSumVec = new Float32Array(embedDim)

        if (useLateChunking && tokenEmbeddings) {
            for (let i = 0; i < numTokens; i++) {
                const off = i * embedDim
                for (let d = 0; d < embedDim; d++) sectionSumVec[d] += tokenEmbeddings[off + d]
            }
            if (numTokens > 0) {
                for (let d = 0; d < embedDim; d++) sectionSumVec[d] /= numTokens
            }
        }

        // Map sentences to token chunks
        const sentences = splitSentences(markdown, currentLocale)
        if (sentences.length === 0) return

        let currentPos = 0
        const sentenceVectors: Float32Array[] = []

        for (const sentence of sentences) {
            let startIdx = markdown.indexOf(sentence, currentPos)
            if (startIdx === -1) {
                // Robust fallback: some segmenters normalize spaces differently
                const searchSlice = sentence.slice(0, 30).trim()
                startIdx = markdown.indexOf(searchSlice, currentPos)
            }

            if (startIdx === -1) {
                sentenceVectors.push(new Float32Array(embedDim))
                continue
            }
            currentPos = startIdx + sentence.length

            const vec = new Float32Array(embedDim)

            if (useLateChunking && tokenEmbeddings) {
                // SOTA: Late Chunking Mapping (Efficient reuse of token embeddings)
                const charStartRatio = startIdx / markdown.length
                const charEndRatio = (startIdx + sentence.length) / markdown.length
                const tStart = Math.floor(charStartRatio * numTokens)
                const tEnd = Math.ceil(charEndRatio * numTokens)

                let count = 0
                for (let t = tStart; t < tEnd && t < numTokens; t++) {
                    for (let d = 0; d < embedDim; d++) vec[d] += tokenEmbeddings[t * embedDim + d]
                    count++
                }
                if (count > 0) for (let d = 0; d < embedDim; d++) vec[d] /= count
            } else {
                // FALLBACK (v3.9.1): Standard mean pooling for large chapters (RAM Safe)
                const out = await embedder(sentence, { pooling: 'mean', normalize: true })
                vec.set(out.data)

                // Add to section sum for chapter embedding
                for (let d = 0; d < embedDim; d++) sectionSumVec[d] += vec[d]
            }

            normalizeInPlace(vec)
            sentenceVectors.push(vec)
        }

        // Finalize Chapter Embedding if it was rolling
        if (!useLateChunking) {
            if (sentences.length > 0) {
                for (let d = 0; d < embedDim; d++) sectionSumVec[d] /= sentences.length
            }
        }
        normalizeInPlace(sectionSumVec)

        // Save Chapter Vector
        if (voyChapters) {
            const chapterRaw = voyAcceptsTypedArrays ? new Float32Array(sectionSumVec) : Array.from(sectionSumVec)
            const chapterEmb = maybeTruncateEmbedding(chapterRaw)
            voyChapters.add({
                embeddings: [{
                    id: String(metadata.sectionIndex),
                    title: "",
                    url: "",
                    embeddings: chapterEmb as any
                }]
            } as any)
        }

        const currentChunkVecSum = new Float32Array(embedDim)
        let currentChunkTokenCount = 0
        let currentChunkText: string[] = []
        let currentLen = 0

        const similarityThreshold = 0.5
        const minChunkSize = 100
        const maxChunkSize = 2500

        const recordsBatch: any[] = []
        const voyBatch: any[] = []

        const finalizeChunkLocal = (idx: number) => {
            const content = currentChunkText.join(' ')
            normalizeInPlace(currentChunkVecSum)

            const embRaw = voyAcceptsTypedArrays ? new Float32Array(currentChunkVecSum) : Array.from(currentChunkVecSum)
            const embToSend = maybeTruncateEmbedding(embRaw)

            voyBatch.push({ id: String(idx), title: "", url: "", embeddings: embToSend as any })
            if (voyBatch.length >= 64) {
                voyChunks!.add({ embeddings: [...voyBatch] } as any)
                voyBatch.length = 0
            }

            recordsBatch.push({ bookId, content, index: idx, metadata })

            currentChunkText = []
            currentLen = 0
            currentChunkVecSum.fill(0)
            currentChunkTokenCount = 0
        }

        for (let j = 0; j < sentences.length; j++) {
            if (cancelled) break
            const sentence = sentences[j]
            const vec = sentenceVectors[j]

            if (currentChunkText.length > 0) {
                // Topic shift detection (SOTA: Normalized Mean Vector Comparison)
                const meanVec = new Float32Array(embedDim)
                for (let d = 0; d < embedDim; d++) {
                    meanVec[d] = currentChunkVecSum[d] / (currentChunkTokenCount || 1)
                }

                // Normalize mean for cosine similarity
                let mag = 0
                for (let d = 0; d < embedDim; d++) mag += meanVec[d] * meanVec[d]
                mag = Math.sqrt(mag)
                if (mag > 0) {
                    for (let d = 0; d < embedDim; d++) meanVec[d] /= mag
                }

                const similarity = dotProduct(meanVec, vec)
                const isTopicShift = sentence.length > 25 && similarity < similarityThreshold
                const isTooBig = currentLen + sentence.length > maxChunkSize

                if ((isTopicShift && currentLen >= minChunkSize) || isTooBig) {
                    finalizeChunkLocal(itemsAdded++)
                }
            }

            currentChunkText.push(sentence)
            currentLen += (currentChunkText.length > 1 ? 1 : 0) + sentence.length
            for (let d = 0; d < embedDim; d++) currentChunkVecSum[d] += vec[d]
            currentChunkTokenCount++

            if (recordsBatch.length >= 12) {
                self.postMessage({ type: 'records', payload: [...recordsBatch] })
                recordsBatch.length = 0
            }
        }

        if (currentChunkText.length > 0) finalizeChunkLocal(itemsAdded++)
        if (voyBatch.length > 0) voyChunks!.add({ embeddings: voyBatch } as any)
        if (recordsBatch.length > 0) self.postMessage({ type: 'records', payload: recordsBatch })

        sendDone(donePayload)

    } catch (err: any) {
        // v3.5: Section error is now a SKIP, reported with REAL reason
        const reason = String(err?.message || err)
        console.error(`Worker Section Processor Failure [${metadata?.sectionIndex}]:`, reason)

        donePayload = { sectionIndex: metadata?.sectionIndex ?? -1, skipped: true, reason }
        skippedSections.push({ sectionIndex: donePayload.sectionIndex, reason })

        self.postMessage({
            type: 'error',
            payload: { sectionIndex: metadata?.sectionIndex, reason, fatal: false }
        })
    } finally {
        // GARANTIA ABSOLUTA: Always send the most accurate payload we have
        sendDone(donePayload)
    }
}

async function processSectionWllama(bookId: string, markdown: string, metadata: any) {
    if (!initialized || !wllama || !voyChunks || !voyChapters) return

    let doneSent = false
    let donePayload: any = { sectionIndex: metadata?.sectionIndex ?? -1, skipped: false }

    const sendDone = (p: any) => {
        if (!doneSent) {
            doneSent = true
            self.postMessage({ type: 'sectionDone', payload: p })
        }
    }

    try {
        if (!markdown || markdown.trim().length === 0 || metadata.skipped) {
            const reason = metadata.reason || 'empty markdown'
            skippedSections.push({ sectionIndex: metadata.sectionIndex, reason })
            donePayload = { sectionIndex: metadata.sectionIndex, skipped: true, reason }
            sendDone(donePayload)
            return
        }

        const sentences = splitSentences(markdown, currentLocale)
        if (sentences.length === 0) {
            const reason = 'no sentences'
            skippedSections.push({ sectionIndex: metadata.sectionIndex, reason })
            donePayload = { sectionIndex: metadata.sectionIndex, skipped: true, reason }
            sendDone(donePayload)
            return
        }

        // OPTIMIZATION: Pre-chunk sentences before embedding (reduces API calls 10x+)
        const minChunkSize = 100
        const maxChunkSize = 500  // Target ~500 chars per chunk for efficiency

        const preChunks: { text: string; sentences: string[] }[] = []
        let currentChunkText: string[] = []
        let currentLen = 0

        for (const sentence of sentences) {
            const willExceed = currentLen + sentence.length > maxChunkSize

            if (willExceed && currentLen >= minChunkSize) {
                // Finalize current pre-chunk
                preChunks.push({ text: currentChunkText.join(' '), sentences: [...currentChunkText] })
                currentChunkText = []
                currentLen = 0
            }

            currentChunkText.push(sentence)
            currentLen += (currentChunkText.length > 1 ? 1 : 0) + sentence.length
        }

        // Finalize last pre-chunk
        if (currentChunkText.length > 0) {
            preChunks.push({ text: currentChunkText.join(' '), sentences: [...currentChunkText] })
        }

        console.log('[RAG WORKER] Section', metadata.sectionIndex, ': optimized from', sentences.length, 'sentences to', preChunks.length, 'chunks')

        // Embed pre-chunks (much fewer calls!)
        const chunkVectors: Float32Array[] = []
        const sectionSumVec = new Float32Array(embedDim)

        for (let i = 0; i < preChunks.length; i++) {
            const chunk = preChunks[i]
            if (cancelled) break
            console.log('[RAG WORKER] Embedding chunk', i + 1, '/', preChunks.length, 'len=', chunk.text.length)
            const vec = await embedWithWllama(chunk.text)
            console.log('[RAG WORKER] Chunk', i + 1, 'embedded')
            chunkVectors.push(vec)
            for (let d = 0; d < embedDim; d++) sectionSumVec[d] += vec[d]
            await yieldToWorker()
        }

        console.log('[RAG WORKER] Section', metadata.sectionIndex, 'embedding complete, chunks:', chunkVectors.length)

        if (chunkVectors.length > 0) {
            for (let d = 0; d < embedDim; d++) sectionSumVec[d] /= chunkVectors.length
        }
        normalizeInPlace(sectionSumVec)

        // Add to chapter index
        if (voyChapters) {
            const chapterRaw = voyAcceptsTypedArrays ? new Float32Array(sectionSumVec) : Array.from(sectionSumVec)
            const chapterEmb = maybeTruncateEmbedding(chapterRaw)
            voyChapters.add({
                embeddings: [{
                    id: String(metadata.sectionIndex),
                    title: "",
                    url: "",
                    embeddings: chapterEmb as any
                }]
            } as any)
        }

        // Add chunks to index and records
        const recordsBatch: any[] = []
        const voyBatch: any[] = []

        for (let i = 0; i < preChunks.length; i++) {
            if (cancelled) break
            const chunk = preChunks[i]
            const vec = chunkVectors[i] || new Float32Array(embedDim)

            const embRaw = voyAcceptsTypedArrays ? new Float32Array(vec) : Array.from(vec)
            const embToSend = maybeTruncateEmbedding(embRaw)

            voyBatch.push({ id: String(itemsAdded), title: "", url: "", embeddings: embToSend as any })
            if (voyBatch.length >= 64) {
                voyChunks!.add({ embeddings: [...voyBatch] } as any)
                voyBatch.length = 0
            }

            recordsBatch.push({ bookId, content: chunk.text, index: itemsAdded, metadata })
            itemsAdded++

            if (recordsBatch.length >= 12) {
                self.postMessage({ type: 'records', payload: [...recordsBatch] })
                recordsBatch.length = 0
            }
        }

        // Flush remaining
        if (voyBatch.length > 0) {
            voyChunks!.add({ embeddings: [...voyBatch] } as any)
        }
        if (recordsBatch.length > 0) {
            self.postMessage({ type: 'records', payload: recordsBatch })
        }

        donePayload = { sectionIndex: metadata.sectionIndex, skipped: false }

        sendDone(donePayload)
    } catch (err: any) {
        const reason = String(err?.message || err)
        console.error(`Worker Section Processor Failure [${metadata?.sectionIndex}]:`, reason)

        donePayload = { sectionIndex: metadata?.sectionIndex ?? -1, skipped: true, reason }
        skippedSections.push({ sectionIndex: donePayload.sectionIndex, reason })

        self.postMessage({
            type: 'error',
            payload: { sectionIndex: metadata?.sectionIndex, reason, fatal: false }
        })
    } finally {
        sendDone(donePayload)
    }
}

/**
 * Worker Listener
 */
self.onmessage = async (e: MessageEvent<InboundMessage>) => {
    const { type, payload } = e.data
    console.log('[RAG WORKER] Received message:', type)

    switch (type) {
        case 'init':
            console.log('[RAG WORKER] Starting initialization...')
            cancelled = false
            itemsAdded = 0
            await initialize(payload)
            console.log('[RAG WORKER] Initialization complete, initialized=', initialized)
            break

        case 'index':
            console.log('[RAG WORKER] Processing section:', payload?.metadata?.sectionIndex)
            if (cancelled) return
            await processSection(payload.bookId, payload.markdown, payload.metadata)
            console.log('[RAG WORKER] Section done:', payload?.metadata?.sectionIndex)
            break

        case 'finalize':
            if (voyChunks && voyChapters) {
                // v3.5: Barrier Flush
                self.postMessage({ type: 'records', payload: [] })

                const chunks = voyChunks.serialize()
                const chapters = voyChapters.serialize()
                self.postMessage({
                    type: 'finalized',
                    payload: {
                        chunks,
                        chapters,
                        itemsAdded,
                        dim: outputDim,
                        skippedSections
                    }
                })
            }
            break

        case 'cancel':
            cancelled = true
            break

        case 'embed': {
            const requestId = e.data.requestId
            try {
                if (!initialized) throw new Error('RAG worker not initialized')
                const mode = payload?.mode === 'document' ? 'document' : 'query'
                const vec = await embedText(payload?.text || '', mode)
                // Return transferable buffer to avoid copies.
                self.postMessage(
                    { type: 'embed-result', requestId, payload: { vector: vec, dim: vec.length } },
                    vec?.buffer ? [vec.buffer] : undefined,
                )
            } catch (err: any) {
                const message = String(err?.message || err)
                debugLog('embed_error', { message })
                self.postMessage({ type: 'embedding-error', data: { message, stage: 'embed' } })
                self.postMessage({ type: 'embed-result', requestId, payload: { error: message } })
            }
            break
        }
    }
}

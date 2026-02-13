/// <reference lib="webworker" />
import type { Wllama } from '@wllama/wllama/esm'
import type { Voy as VoyType } from 'voy-search'

import { AI_CONFIG } from './config'

const DEBUG_EMBED = process.env.NODE_ENV !== 'production'
const WLLAMA_ASSET_VERSION = '20260204a'
const ENABLE_WLLAMA_WORKER_OVERRIDE_FALLBACK = false

type Backend = 'transformers' | 'wllama' | 'webgpu' | 'firefox-native'

// Xenova/all-MiniLM-L6-v2 produces 384-dim sentence embeddings.
// Note: multilingual-e5-base produces 768-dim; large produces 1024-dim.
const ONNX_DIM = 384
const E5_LARGE_DIM = 1024
const FIREFOX_ML_MODEL_ID = 'Xenova/multilingual-e5-base' // Default model ID for Native ML delegation
const FIREFOX_DELEGATE_MAX_BATCH_SIZE = 24
const FIREFOX_DELEGATE_MIN_BATCH_SIZE = 8
const FIREFOX_DELEGATE_MAX_BATCH_CHARS = 9500
const FIREFOX_DELEGATE_TIMEOUT_SINGLE_MS = 300000
const FIREFOX_DELEGATE_TIMEOUT_BASE_MS = 120000
const FIREFOX_DELEGATE_TIMEOUT_PER_ITEM_MS = 6000
const FIREFOX_DELEGATE_TIMEOUT_PER_1K_CHARS_MS = 9000
const WLLAMA_EMBED_MODEL_URL = (AI_CONFIG as any)
  .embeddingModelFirefoxUrl as string
const TOKEN_PRECHUNK_TARGET_TOKENS = 220
const TOKEN_PRECHUNK_MIN_TOKENS = 120
const TOKEN_PRECHUNK_MAX_TOKENS = 320
const TOKEN_PRECHUNK_OVERLAP_TOKENS = 24
const TOKEN_PRECHUNK_HARD_MAX_CHARS = 1800
const ENABLE_TOKEN_AWARE_PRECHUNKING = true
const SEMANTIC_MERGE_THRESHOLD_FLOOR = 0.42
const SEMANTIC_MERGE_THRESHOLD_CEIL = 0.62
const SEMANTIC_MERGE_THRESHOLD_DEFAULT = 0.5
const SEMANTIC_MERGE_MAX_TOKENS = 420
const SEMANTIC_MERGE_MAX_CHARS = 2500

// EXPERIMENTAL: WebGPU model for 15-30x faster embeddings (Firefox 147+)
// Keep WebGPU path aligned with Firefox Native ML default model family.
const WEBGPU_EMBED_MODEL = 'Xenova/multilingual-e5-base'

const yieldToWorker = () =>
  new Promise<void>((resolve) => setTimeout(resolve, 0))

const isFirefox =
  typeof navigator !== 'undefined' && /Firefox/i.test(navigator.userAgent || '')

// EXPERIMENTAL: WebGPU detection for GPU-accelerated embeddings
async function hasWebGPU(): Promise<boolean> {
  console.log('[RAG WORKER] Checking WebGPU availability...')
  console.log(
    '[RAG WORKER] isSecureContext:',
    typeof isSecureContext !== 'undefined' ? isSecureContext : 'unknown',
  )
  console.log(
    '[RAG WORKER] User Agent:',
    typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown',
  )

  if (typeof navigator === 'undefined' || !(navigator as any).gpu) {
    console.log('[RAG WORKER] âŒ navigator.gpu is undefined')
    return false
  }

  const gpu = (navigator as any).gpu
  console.log('[RAG WORKER] navigator.gpu exists, requesting adapter...')
  try {
    // Try standard request first
    let adapter = await gpu.requestAdapter()

    if (!adapter) {
      console.log(
        '[RAG WORKER] âš ï¸ navigator.gpu.requestAdapter() returned null (Standard)',
      )
      console.log('[RAG WORKER] Trying with powerPreference: low-power...')
      adapter = await gpu.requestAdapter({ powerPreference: 'low-power' })
    }

    if (!adapter) {
      console.log(
        '[RAG WORKER] âš ï¸ navigator.gpu.requestAdapter() returned null (Low-Power)',
      )
      console.log(
        '[RAG WORKER] Trying with powerPreference: high-performance...',
      )
      adapter = await gpu.requestAdapter({
        powerPreference: 'high-performance',
      })
    }

    if (!adapter) {
      console.log(
        '[RAG WORKER] âŒ WebGPU adapter still null after all attempts',
      )
      return false
    }

    const info = (await (adapter as any).requestAdapterInfo?.()) || {}
    console.log('[RAG WORKER] âœ… WebGPU Adapter found:', {
      vendor: info.vendor,
      architecture: info.architecture,
      device: info.device,
      description: info.description,
    })

    return true
  } catch (err: any) {
    console.error(
      '[RAG WORKER] âŒ Fatal error requesting WebGPU adapter:',
      err?.message || err,
    )
    return false
  }
}

// EXPERIMENTAL: Firefox Native ML API detection (2-10x faster than WASM)
// https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/trial/ml
async function hasFirefoxNativeML(): Promise<boolean> {
  try {
    const g = self as any

    // Diagnostic: Check what browser APIs exist
    const browserApi = g.browser || g.chrome

    if (!browserApi) {
      // Expected in worker context without special polyfills
      return false
    }

    if (!browserApi.trial?.ml?.createEngine) {
      return false
    }

    return true
  } catch (err: any) {
    return false
  }
}

let firefoxMLEngine: any = null
let embedder: any = null
let wllama: Wllama | null = null
let wllamaLoadPromise: Promise<void> | null = null
let wllamaEmbedModelUrl = WLLAMA_EMBED_MODEL_URL
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
let liteMode = false // PHASE 2: Lite mode skips embedding for instant import
let firefoxDelegate = false
let allowLocalModelDownloads = true
let nextEmbedId = 1
const pendingEmbeddings = new Map<
  number,
  { resolve: (v: Float32Array) => void; reject: (e: Error) => void }
>()
const pendingEmbedBatch = new Map<
  number,
  { resolve: (v: Float32Array[]) => void; reject: (e: Error) => void }
>()

let transformersPromise: Promise<typeof import('@xenova/transformers')> | null =
  null
async function getTransformers() {
  if (!transformersPromise) {
    transformersPromise = import('@xenova/transformers')
  }
  return transformersPromise
}

function debugLog(message: string, data?: Record<string, any>) {
  if (!DEBUG_EMBED) return
  try {
    self.postMessage({
      type: 'embedding-debug',
      data: { message, ...(data || {}) },
    })
  } catch {
    // ignore debug post errors
  }
}

const METADATA_PREFIX = '__metadata__'

class DirectOPFSCacheManager {
  private async getCacheDir() {
    const storage = (navigator as any)?.storage
    if (!storage?.getDirectory) {
      throw new Error(
        'OPFS not supported (navigator.storage.getDirectory missing)',
      )
    }
    const opfsRoot = await storage.getDirectory()
    return await opfsRoot.getDirectoryHandle('cache', { create: true })
  }

  private async urlToFileName(url: string, prefix: string) {
    const hashBuffer = await crypto.subtle.digest(
      'SHA-1',
      new TextEncoder().encode(url),
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
      throw new Error(
        'OPFS metadata write failed (no writable or sync access handle)',
      )
    }
    const buf = new TextEncoder().encode(JSON.stringify(metadata))
    accessHandle.truncate(0)
    accessHandle.write(buf, { at: 0 })
    accessHandle.flush()
    accessHandle.close()
  }

  async write(
    name: string,
    stream: ReadableStream,
    metadata: Record<string, any>,
  ) {
    const cacheDir = await this.getCacheDir()
    const fileHandle = await cacheDir.getFileHandle(name, { create: true })
    const reader = stream.getReader()
    const syncHandle = (fileHandle as any).createSyncAccessHandle
      ? await (fileHandle as any).createSyncAccessHandle()
      : null
    const writable =
      !syncHandle && (fileHandle as any).createWritable
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
    } = {},
  ): Promise<void> {
    debugLog('download_start', { url })
    const filename = await this.urlToFileName(url, '')
    const metadataFileName = await this.urlToFileName(url, METADATA_PREFIX)

    const cacheDir = await this.getCacheDir()
    const fileHandle = await cacheDir.getFileHandle(filename, { create: true })

    const response = await fetch(url, {
      headers: options.headers,
      signal: options.signal,
    })
    debugLog('download_response', { status: response.status })
    if (!response.ok || !response.body) {
      throw new Error(
        `Download failed: ${response.status} ${response.statusText}`,
      )
    }

    const total = Number(response.headers.get('content-length') || '0')
    const etag = (response.headers.get('etag') || '').replace(
      /[^A-Za-z0-9]/g,
      '',
    )
    const reader = response.body.getReader()

    const syncHandle = (fileHandle as any).createSyncAccessHandle
      ? await (fileHandle as any).createSyncAccessHandle()
      : null
    const writable =
      !syncHandle && (fileHandle as any).createWritable
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
      etag,
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

  async getMetadata(
    nameOrURL: string,
  ): Promise<{
    originalSize: number
    originalURL: string
    etag: string
  } | null> {
    try {
      const cacheDir = await this.getCacheDir()
      const fileName = nameOrURL.includes('://')
        ? await this.urlToFileName(nameOrURL, '')
        : nameOrURL
      const metaHandle = await cacheDir.getFileHandle(
        `${METADATA_PREFIX}${fileName}`,
      )
      const file = await (metaHandle as any).getFile()
      const json = await new Response(file).json().catch(() => null)
      return json || null
    } catch {
      return null
    }
  }

  async list(): Promise<
    Array<{
      name: string
      size: number
      metadata: { originalSize: number; originalURL: string; etag: string }
    }>
  > {
    const cacheDir = await this.getCacheDir()
    const result: Array<{
      name: string
      size: number
      metadata: { originalSize: number; originalURL: string; etag: string }
    }> = []
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
      if (
        handler.kind === 'file' &&
        !String(name).startsWith(METADATA_PREFIX)
      ) {
        const file = await (handler as any).getFile()
        const meta = metadataMap[String(name)] || {
          originalSize: file.size,
          originalURL: '',
          etag: '',
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
      await cacheDir
        .removeEntry(`${METADATA_PREFIX}${entry.name}`)
        .catch(() => undefined)
    }
  }

  async delete(nameOrURL: string): Promise<void> {
    const cacheDir = await this.getCacheDir()
    const fileName = nameOrURL.includes('://')
      ? await this.urlToFileName(nameOrURL, '')
      : nameOrURL
    await cacheDir.removeEntry(fileName).catch(() => undefined)
    await cacheDir
      .removeEntry(`${METADATA_PREFIX}${fileName}`)
      .catch(() => undefined)
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
  anySelf.__wllamaOriginalCreateObjectURL = originalCreateObjectURL
  anySelf.__wllamaUseWorkerOverride = false
  URL.createObjectURL = (blob: any) => {
    if (!anySelf.__wllamaUseWorkerOverride) {
      return originalCreateObjectURL(blob)
    }
    try {
      const blobType = String(blob?.type || '').toLowerCase()
      if (
        blob instanceof Blob &&
        (blobType.includes('javascript') || blobType === '')
      ) {
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

const setWllamaWorkerOverrideEnabled = (enabled: boolean) => {
  const anySelf = self as any
  installWllamaWorkerOverride()
  anySelf.__wllamaUseWorkerOverride = enabled
}

/**
 * Message Types for Communication
 */
interface InboundMessage {
  type:
    | 'init'
    | 'index'
    | 'finalize'
    | 'cancel'
    | 'embed'
    | 'embedding-response'
    | 'embedding-batch-response'
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

  const truncated =
    vec instanceof Float32Array
      ? vec.slice(0, outputDim)
      : vec.slice(0, outputDim)

  let norm = 0
  for (let i = 0; i < truncated.length; i++) norm += truncated[i] * truncated[i]
  norm = Math.sqrt(norm) || 1
  for (let i = 0; i < truncated.length; i++) truncated[i] /= norm

  return truncated
}

/**
 * Guardrail: Strict Dimension Enforcement
 * Returns a Float32Array of exactly targetDim length.
 * Pads with zeros or truncates as needed. RENORMALIZES if modified.
 */
function forceDim(vec: Float32Array | number[], target: number): Float32Array {
  const v = vec instanceof Float32Array ? vec : Float32Array.from(vec)
  if (v.length === target) return v

  const out = new Float32Array(target)
  out.set(v.subarray(0, Math.min(target, v.length)))
  // Renormalize if we truncated or padded, as the vector magnitude changed
  normalizeInPlace(out)
  return out
}

async function ensureWllama() {
  if (wllamaLoadPromise) {
    await wllamaLoadPromise
    return
  }
  if (wllama) {
    const loaded =
      typeof (wllama as any).isModelLoaded === 'function'
        ? (wllama as any).isModelLoaded()
        : false
    if (loaded) return
  }

  debugLog('wllama_init_lazy_start')
  const withVersion = (url: string) =>
    `${url}${url.includes('?') ? '&' : '?'}v=${WLLAMA_ASSET_VERSION}`
  const readErr = (err: unknown) =>
    err instanceof Error ? err.message : String(err || '')
  const isBlobCspError = (msg: string) => {
    const lower = msg.toLowerCase()
    return (
      (lower.includes('blob:') && lower.includes('content-security-policy')) ||
      (lower.includes('blob:') && lower.includes('worker-src')) ||
      (lower.includes('blob:') && lower.includes('script-src')) ||
      (lower.includes('blob') && lower.includes('refused to create')) ||
      (lower.includes('blob') && lower.includes('failed to construct'))
    )
  }
  const isOverrideNetworkError = (msg: string) =>
    msg.includes('NetworkError') ||
    msg.includes('failed to asynchronously prepare wasm') ||
    msg.includes('Aborted(NetworkError') ||
    msg.includes('wasm streaming compile failed')
  const preflightOverrideAssets = async () => {
    const g = self as any
    const getURL = g.browser?.runtime?.getURL || g.chrome?.runtime?.getURL
    const origin = g?.location?.origin || ''
    const workerUrl =
      typeof getURL === 'function'
        ? withVersion(getURL('wasm/wllama.worker.js'))
        : withVersion(`${origin}/wasm/wllama.worker.js`)
    const wasmUrl =
      typeof getURL === 'function'
        ? withVersion(getURL('wasm/wllama-single.wasm'))
        : withVersion(`${origin}/wasm/wllama-single.wasm`)
    const [workerRes, wasmRes] = await Promise.all([
      fetch(workerUrl, { cache: 'no-store' }),
      fetch(wasmUrl, { cache: 'no-store' }),
    ])
    if (!workerRes.ok)
      throw new Error(
        `worker_bootstrap_failed:${workerRes.status}:${workerUrl}`,
      )
    if (!wasmRes.ok)
      throw new Error(`worker_bootstrap_failed:${wasmRes.status}:${wasmUrl}`)
  }

  const init = async (opts: { forceWorkerOverride: boolean }) => {
    setWllamaWorkerOverrideEnabled(!!opts.forceWorkerOverride)
    if (opts.forceWorkerOverride) {
      await preflightOverrideAssets()
    }

    // Polyfill document for wllama if needed (probes DOM for script paths)
    const anySelf = self as any
    if (!anySelf.document) {
      anySelf.document = { baseURI: self.location?.href || '' }
    }

    const { Wllama } = await import('@wllama/wllama/esm')
    const wasmBase = resolveWasmBase()
    const canUseMultiThread =
      typeof (self as any).SharedArrayBuffer !== 'undefined' &&
      (self as any).crossOriginIsolated === true

    const wasmPaths = canUseMultiThread
      ? {
          'single-thread/wllama.wasm': withVersion(
            wasmBase + 'wllama-single.wasm',
          ),
          'multi-thread/wllama.wasm': withVersion(
            wasmBase + 'wllama-multi.wasm',
          ),
        }
      : {
          'single-thread/wllama.wasm': withVersion(
            wasmBase + 'wllama-single.wasm',
          ),
        }

    wllama = new Wllama(wasmPaths as any, {
      cacheManager: new DirectOPFSCacheManager() as any,
      allowOffline: true,
    })

    debugLog('wllama_monitor', {
      status: 'rag_loading_model_start',
      url: wllamaEmbedModelUrl,
    })

    await wllama.loadModelFromUrl(wllamaEmbedModelUrl, {
      embeddings: true,
      pooling_type: 'LLAMA_POOLING_TYPE_MEAN',
      n_threads: 1,
      progressCallback: ({ loaded, total }) => {
        const pct = total ? (loaded / total) * 100 : 0
        if (pct % 10 < 1 || pct === 100) {
          debugLog('progress', { file: 'gguf', progress: pct, loaded, total })
        }
        self.postMessage({
          type: 'rag-progress',
          data: { status: 'progress', progress: pct, file: 'gguf' },
        })
      },
    })
    debugLog('wllama_init_lazy_done')
  }

  wllamaLoadPromise = (async () => {
    try {
      // Fast path: native worker bootstrap (blob URL) when allowed by CSP.
      await init({ forceWorkerOverride: false })
      return
    } catch (firstErr) {
      if (!ENABLE_WLLAMA_WORKER_OVERRIDE_FALLBACK) {
        throw firstErr
      }
      const firstMsg = readErr(firstErr)
      if (!isBlobCspError(firstMsg)) {
        throw firstErr
      }
      debugLog('wllama_retry_with_override', {
        reason: 'csp_blob_worker_blocked',
        message: firstMsg,
      })
      wllama = null
    }

    try {
      // Fallback path for Firefox MV3 CSP setups that block blob workers.
      await init({ forceWorkerOverride: true })
      return
    } catch (secondErr) {
      const secondMsg = readErr(secondErr)
      if (isOverrideNetworkError(secondMsg)) {
        // Some Firefox builds fail on the override path even when blob workers are allowed.
        // Retry native once so we don't hard-fail from an override-only issue.
        debugLog('wllama_retry_without_override', { reason: secondMsg })
        wllama = null
        await init({ forceWorkerOverride: false })
        return
      }
      throw secondErr
    }
  })().finally(() => {
    wllamaLoadPromise = null
  })

  await wllamaLoadPromise
}

async function embedWithWllama(text: string): Promise<Float32Array> {
  await ensureWllama()
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
  const prefix =
    mode === 'query' ? embeddingPrefixQuery : embeddingPrefixDocument
  return `${prefix || ''}${text}`
}

/**
 * SOTA: Unified Batch Embedding
 * Handles Delegation, Native ML, and Fallback
 */
async function embedBatch(
  texts: string[],
  mode: 'query' | 'document',
): Promise<Float32Array[]> {
  if (texts.length === 0) return []

  // 1. Try Delegation (Preferred in Firefox SOTA)
  if (firefoxDelegate) {
    if (DEBUG_EMBED) {
      console.log(
        '[RAG-DEBUG] Attempting delegation for batch size:',
        texts.length,
      )
    }
    try {
      const res = await embedBatchWithFirefoxDelegate(texts, mode)
      if (DEBUG_EMBED) {
        console.log('[RAG-DEBUG] Delegation successful')
      }
      return res
    } catch (err: any) {
      if (DEBUG_EMBED) {
        console.log(
          '[RAG-DEBUG] Batch delegation failed. Error details:',
          JSON.stringify(err, Object.getOwnPropertyNames(err)),
        )
      }
      console.error(
        '[RAG WORKER] Batch delegation failed, retrying sequential delegation:',
        err?.message || err,
      )

      // Retry with single-item delegation before falling back to local Wllama/ONNX.
      // This avoids downloading the large GGUF model due to a single oversized batch timeout.
      const errMsg = String(err?.message || err || '')
      const isBackgroundUnavailable =
        /Could not establish connection/i.test(errMsg) ||
        /Receiving end does not exist/i.test(errMsg) ||
        /Firefox ML not available/i.test(errMsg)

      if (!isBackgroundUnavailable) {
        try {
          const seq: Float32Array[] = []
          for (const text of texts) {
            if (cancelled) break
            seq.push(await embedWithFirefoxDelegate(text, mode))
            await yieldToWorker()
          }
          if (seq.length === texts.length) {
            if (DEBUG_EMBED) {
              console.log('[RAG-DEBUG] Sequential delegation retry successful')
            }
            return seq
          }
          throw new Error(
            `Sequential delegation incomplete: ${seq.length}/${texts.length}`,
          )
        } catch (seqErr: any) {
          console.error(
            '[RAG WORKER] Sequential delegation also failed, falling back:',
            seqErr?.message || seqErr,
          )
          // Continue to direct backends
        }
      } else {
        console.warn(
          '[RAG WORKER] Delegation background unavailable; skipping sequential retry.',
        )
      }
    }
  } else {
    if (DEBUG_EMBED) {
      console.log('[RAG-DEBUG] firefoxDelegate is false. Skipping delegation.')
    }
  }
  // 2. Try Direct Native ML
  if (backend === 'firefox-native' && firefoxMLEngine) {
    try {
      const inputs = texts.map((t) => applyEmbeddingPrefix(t, mode))
      const result = await firefoxMLEngine.run({ args: inputs })

      // Native ML run() returns multiple outputs when given multiple args
      // Result format depends on platform/version. Usually an array of embedding results.
      const rawBatch = Array.isArray(result)
        ? result
        : result?.output || [result]

      return rawBatch.map((item: any) => {
        let data: number[]
        if (Array.isArray(item)) data = item
        else if (item?.data) data = Array.from(item.data)
        else if (item?.output?.[0]) data = Array.from(item.output[0].data || [])
        else data = []

        const vec = forceDim(
          new Float32Array(data),
          outputDim || embedDim || ONNX_DIM,
        )
        return vec
      })
    } catch (err: any) {
      console.warn(
        '[RAG WORKER] Native batch failed, falling back to Wllama:',
        err?.message,
      )
    }
  }

  // 3. Fallback to Wllama (Local WASM)
  // We use ensureWllama to guarantee it's ready (lazy load)
  if (!wllama && !allowLocalModelDownloads) {
    throw new Error('local_model_download_disabled')
  }
  await ensureWllama()
  if (wllama) {
    const vecs: Float32Array[] = []
    for (const text of texts) {
      if (cancelled) break
      vecs.push(await embedWithWllama(text))
      await yieldToWorker()
    }
    return vecs
  }

  // 4. Ultimate Fallback to Transformers.js (CPU/ONNX)
  if (embedder) {
    const vecs: Float32Array[] = []
    for (const text of texts) {
      if (cancelled) break
      const input = applyEmbeddingPrefix(text, mode)
      const out = await embedder(input, { pooling: 'mean', normalize: true })
      const data =
        out?.data instanceof Float32Array
          ? out.data
          : new Float32Array(out?.data || [])
      const vec = forceDim(data, outputDim || embedDim || ONNX_DIM)
      vecs.push(vec)
      await yieldToWorker()
    }
    return vecs
  }

  throw new Error('No embedding backend available')
}

async function embedWithFirefoxDelegate(
  text: string,
  mode: 'query' | 'document',
): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    const id = nextEmbedId++
    pendingEmbeddings.set(id, { resolve, reject })

    // Timeout to prevent hanging
    // Timeout to prevent hanging: Increased to 5 minutes (300000ms)
    const tid = setTimeout(() => {
      if (pendingEmbeddings.has(id)) {
        pendingEmbeddings.delete(id)
        reject(new Error('Firefox ML delegation timeout'))
      }
    }, FIREFOX_DELEGATE_TIMEOUT_SINGLE_MS)

    const input = applyEmbeddingPrefix(text, mode)
    // Request embedding from main thread
    // Guardrail: Always use fixed FIREFOX_ML_MODEL_ID
    self.postMessage({
      type: 'request-embedding',
      payload: { id, text: input, modelId: FIREFOX_ML_MODEL_ID },
    })

    // Clear timeout on success/error via response handler
    pendingEmbeddings.get(id)!.resolve = (v) => {
      clearTimeout(tid)
      resolve(v)
    }
    pendingEmbeddings.get(id)!.reject = (e) => {
      clearTimeout(tid)
      reject(e)
    }
  })
}

/**
 * SOTA: Batch Delegation (Worker -> Main Thread)
 * Reduces message overhead by factor of N.
 */
async function requestFirefoxDelegatedBatchChunk(
  inputs: string[],
  mode: 'query' | 'document',
  timeoutMs: number,
): Promise<Float32Array[]> {
  return new Promise((resolve, reject) => {
    const id = nextEmbedId++
    pendingEmbedBatch.set(id, { resolve, reject })

    const tid = setTimeout(() => {
      if (pendingEmbedBatch.has(id)) {
        pendingEmbedBatch.delete(id)
        reject(new Error('Firefox ML batch delegation timeout'))
      }
    }, timeoutMs)

    self.postMessage({
      type: 'request-embedding-batch',
      payload: { id, texts: inputs, mode, modelId: FIREFOX_ML_MODEL_ID },
    })

    pendingEmbedBatch.get(id)!.resolve = (v) => {
      clearTimeout(tid)
      resolve(v)
    }
    pendingEmbedBatch.get(id)!.reject = (e) => {
      clearTimeout(tid)
      reject(e)
    }
  })
}

function dedupeBatchInputs(inputs: string[]) {
  const sourceToUniqueIndex = new Array<number>(inputs.length)
  const uniqueInputs: string[] = []
  const seen = new Map<string, number>()

  for (let i = 0; i < inputs.length; i++) {
    const text = inputs[i]
    const existing = seen.get(text)
    if (existing !== undefined) {
      sourceToUniqueIndex[i] = existing
      continue
    }
    const nextIdx = uniqueInputs.length
    uniqueInputs.push(text)
    seen.set(text, nextIdx)
    sourceToUniqueIndex[i] = nextIdx
  }

  return { uniqueInputs, sourceToUniqueIndex }
}

function splitDelegationSubBatches(inputs: string[]) {
  const batches: string[][] = []
  let current: string[] = []
  let currentChars = 0

  for (const input of inputs) {
    const len = input.length
    const reachedItemCap = current.length >= FIREFOX_DELEGATE_MAX_BATCH_SIZE
    const reachedCharCap =
      current.length >= FIREFOX_DELEGATE_MIN_BATCH_SIZE &&
      currentChars + len > FIREFOX_DELEGATE_MAX_BATCH_CHARS

    if (current.length > 0 && (reachedItemCap || reachedCharCap)) {
      batches.push(current)
      current = []
      currentChars = 0
    }

    current.push(input)
    currentChars += len
  }

  if (current.length > 0) {
    batches.push(current)
  }

  return batches
}

function computeDelegationTimeoutMs(chunkSize: number, chunkChars: number) {
  const byItems = chunkSize * FIREFOX_DELEGATE_TIMEOUT_PER_ITEM_MS
  const byChars =
    Math.ceil(chunkChars / 1000) * FIREFOX_DELEGATE_TIMEOUT_PER_1K_CHARS_MS
  return Math.max(FIREFOX_DELEGATE_TIMEOUT_BASE_MS, byItems, byChars)
}

async function embedBatchWithFirefoxDelegate(
  texts: string[],
  mode: 'query' | 'document',
): Promise<Float32Array[]> {
  const inputs = texts.map((t) => applyEmbeddingPrefix(t, mode))
  if (inputs.length === 0) return []

  const { uniqueInputs, sourceToUniqueIndex } = dedupeBatchInputs(inputs)
  const batches = splitDelegationSubBatches(uniqueInputs)
  const totalChunks = batches.length
  const uniqueVectors: Float32Array[] = []
  const totalStart = Date.now()
  const totalChars = inputs.reduce((acc, t) => acc + t.length, 0)
  const uniqueChars = uniqueInputs.reduce((acc, t) => acc + t.length, 0)

  if (DEBUG_EMBED && uniqueInputs.length !== inputs.length) {
    console.log('[RAG-DEBUG] Delegation dedupe:', {
      inputs: inputs.length,
      unique: uniqueInputs.length,
      duplicates: inputs.length - uniqueInputs.length,
    })
  }

  for (let chunkIndex = 0; chunkIndex < batches.length; chunkIndex++) {
    const chunk = batches[chunkIndex]
    const chunkChars = chunk.reduce((acc, t) => acc + t.length, 0)
    const timeoutMs = computeDelegationTimeoutMs(chunk.length, chunkChars)
    const chunkStart = Date.now()

    if (DEBUG_EMBED) {
      console.log('[RAG-DEBUG] Delegation sub-batch start:', {
        chunkIndex: chunkIndex + 1,
        totalChunks,
        size: chunk.length,
        totalChars: chunkChars,
        avgChars: Number((chunkChars / Math.max(1, chunk.length)).toFixed(1)),
        timeoutMs,
      })
    }

    const vectors = await requestFirefoxDelegatedBatchChunk(
      chunk,
      mode,
      timeoutMs,
    )
    if (vectors.length !== chunk.length) {
      throw new Error(
        `Delegated batch size mismatch: expected ${chunk.length}, got ${vectors.length}`,
      )
    }
    uniqueVectors.push(...vectors)

    const chunkMs = Date.now() - chunkStart
    if (DEBUG_EMBED) {
      console.log('[RAG-DEBUG] Delegation sub-batch done:', {
        chunkIndex: chunkIndex + 1,
        totalChunks,
        size: chunk.length,
        totalChars: chunkChars,
        ms: chunkMs,
        msPerItem: Number((chunkMs / Math.max(1, chunk.length)).toFixed(1)),
      })
    }

    await yieldToWorker()
  }

  const allVectors = sourceToUniqueIndex.map((idx) => {
    const vec = uniqueVectors[idx]
    if (!vec) {
      throw new Error(`Missing delegated vector at unique index ${idx}`)
    }
    return vec
  })

  const totalMs = Date.now() - totalStart
  if (DEBUG_EMBED) {
    console.log('[RAG-DEBUG] Delegation batch complete:', {
      items: inputs.length,
      uniqueItems: uniqueInputs.length,
      subBatches: totalChunks,
      totalChars,
      uniqueChars,
      ms: totalMs,
      msPerItem: Number((totalMs / Math.max(1, inputs.length)).toFixed(1)),
      msPer1kChars:
        totalChars > 0 ? Number((totalMs / (totalChars / 1000)).toFixed(1)) : 0,
    })
  }

  return allVectors
}

async function embedText(
  text: string,
  mode: 'query' | 'document',
): Promise<Float32Array> {
  const clean = String(text || '').trim()
  if (!clean) return new Float32Array(outputDim || embedDim || ONNX_DIM)

  // SOTA: Delegate to main thread if Firefox Native ML is available there
  if (firefoxDelegate) {
    try {
      const vec = await embedWithFirefoxDelegate(clean, mode)
      // Guardrail: Strict Dimension Enforcement
      return forceDim(vec, outputDim || embedDim || ONNX_DIM)
    } catch (err: any) {
      console.warn(
        '[RAG WORKER] Firefox delegation failed (single), fallback to Wllama:',
        err?.message,
      )
      // Fallback to local Wllama below
    }
  }

  // Firefox Native ML backend (browser.trial.ml) - Direct Worker Usage
  if (backend === 'firefox-native') {
    if (!firefoxMLEngine) throw new Error('Firefox ML engine not initialized')
    const input = applyEmbeddingPrefix(clean, mode)
    const result = await firefoxMLEngine.run({ args: [input] })

    // Extract embedding from result (format may vary)
    let rawData: number[]
    if (Array.isArray(result) && Array.isArray(result[0])) {
      rawData = result[0]
    } else if (result?.output?.[0]) {
      rawData = Array.isArray(result.output[0])
        ? result.output[0]
        : Array.from(result.output[0].data || [])
    } else if (result?.data) {
      rawData = Array.from(result.data)
    } else {
      rawData = Array.isArray(result) ? result : []
    }

    const vec = new Float32Array(rawData.length || embedDim)
    for (let i = 0; i < rawData.length; i++) vec[i] = rawData[i]
    normalizeInPlace(vec)
    const maybe = maybeTruncateEmbedding(vec)
    return maybe instanceof Float32Array
      ? maybe
      : Float32Array.from(maybe as any)
  }

  // Fallback or explicit Wllama usage
  if (backend === 'wllama' || firefoxDelegate) {
    if (!wllama && !allowLocalModelDownloads) {
      throw new Error('local_model_download_disabled')
    }
    await ensureWllama()
    const raw = await wllama!.createEmbedding(applyEmbeddingPrefix(clean, mode))
    const vec = new Float32Array(embedDim)
    const len = Math.min(raw.length, embedDim)
    for (let i = 0; i < len; i++) vec[i] = raw[i]
    normalizeInPlace(vec)
    const maybe = maybeTruncateEmbedding(vec)
    return maybe instanceof Float32Array
      ? maybe
      : Float32Array.from(maybe as any)
  }

  if (!embedder) throw new Error('Embedder not initialized')
  // `pipeline('feature-extraction')` returns a callable that supports pooling/normalize.
  const out = await embedder(applyEmbeddingPrefix(clean, mode), {
    pooling: 'mean',
    normalize: true,
  })
  const data =
    out?.data instanceof Float32Array
      ? out.data
      : new Float32Array(out?.data || [])
  const vec = data.length === embedDim ? data : data.slice(0, embedDim)
  normalizeInPlace(vec)
  const maybe = maybeTruncateEmbedding(vec)
  return maybe instanceof Float32Array ? maybe : Float32Array.from(maybe as any)
}

/**
 * Semantic Splitter (Internal to Worker, Locale Aware)
 */
function splitSentences(text: string, locale = 'en'): string[] {
  const blocks = text
    .split(/\n{2,}/g)
    .map((b) => b.trim())
    .filter(Boolean)
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    try {
      const seg = new (Intl as any).Segmenter(locale, {
        granularity: 'sentence',
      })
      return blocks.flatMap((block) =>
        Array.from(seg.segment(block))
          .map((s: any) => s.segment.trim())
          .filter((s: string) => s.length > 0),
      )
    } catch {}
  }
  // Fallback using global punctuation (includes CJK)
  return blocks
    .flatMap(
      (b) =>
        b
          .match(
            /[^.!?\u3002\uFF01\uFF1F\u00A1\u00BF]+(?:[.!?\u3002\uFF01\uFF1F\u00A1\u00BF]+|$)/g,
          )
          ?.map((s) => s.trim()) ?? [b],
    )
    .filter(Boolean)
}

interface PreChunk {
  text: string
  sentences: string[]
  tokenCount: number
}

function estimateTokenCount(text: string, locale = 'en'): number {
  const clean = String(text || '').trim()
  if (!clean) return 0

  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    try {
      const seg = new (Intl as any).Segmenter(locale, { granularity: 'word' })
      let wordLike = 0
      let segmentCount = 0
      for (const part of seg.segment(clean) as any) {
        segmentCount++
        if ((part as any).isWordLike) {
          wordLike++
        }
      }
      if (wordLike > 0) {
        return Math.max(1, Math.round(wordLike * 1.25))
      }
      if (segmentCount > 0) {
        return Math.max(1, Math.round(segmentCount * 0.75))
      }
    } catch {
      // Fall back to language-agnostic heuristics.
    }
  }

  const whitespaceWords = clean.split(/\s+/g).filter(Boolean).length
  if (whitespaceWords > 0) {
    return Math.max(1, Math.round(whitespaceWords * 1.3))
  }

  const cjkChars = (
    clean.match(/[\u3400-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]/g) || []
  ).length
  if (cjkChars > 0) {
    return Math.max(1, Math.round(cjkChars * 1.05))
  }

  return Math.max(1, Math.ceil(clean.length / 4))
}

function buildLegacyCharPreChunks(
  sentences: string[],
  locale = 'en',
): PreChunk[] {
  const minChunkSize = 100
  const maxChunkSize = 500
  const preChunks: PreChunk[] = []
  let currentChunkText: string[] = []
  let currentLen = 0

  for (const sentence of sentences) {
    const willExceed = currentLen + sentence.length > maxChunkSize

    if (willExceed && currentLen >= minChunkSize) {
      const chunkSentences = [...currentChunkText]
      const chunkText = chunkSentences.join(' ')
      preChunks.push({
        text: chunkText,
        sentences: chunkSentences,
        tokenCount: estimateTokenCount(chunkText, locale),
      })
      currentChunkText = []
      currentLen = 0
    }

    currentChunkText.push(sentence)
    currentLen += (currentChunkText.length > 1 ? 1 : 0) + sentence.length
  }

  if (currentChunkText.length > 0) {
    const chunkSentences = [...currentChunkText]
    const chunkText = chunkSentences.join(' ')
    preChunks.push({
      text: chunkText,
      sentences: chunkSentences,
      tokenCount: estimateTokenCount(chunkText, locale),
    })
  }

  return preChunks
}

function buildTokenAwarePreChunks(
  sentences: string[],
  locale = 'en',
): PreChunk[] {
  const units = sentences
    .map((text) => {
      const clean = String(text || '').trim()
      if (!clean) return null
      return { text: clean, tokenCount: estimateTokenCount(clean, locale) }
    })
    .filter((u): u is { text: string; tokenCount: number } => !!u)

  if (units.length === 0) return []

  const preChunks: PreChunk[] = []
  let start = 0

  while (start < units.length) {
    let end = start
    let tokenTotal = 0
    let charTotal = 0

    while (end < units.length) {
      const unit = units[end]
      const nextTokenTotal = tokenTotal + unit.tokenCount
      const nextCharTotal =
        charTotal + (charTotal > 0 ? 1 : 0) + unit.text.length
      const shouldStopForMaxTokens =
        end > start && nextTokenTotal > TOKEN_PRECHUNK_MAX_TOKENS
      const shouldStopForMaxChars =
        end > start && nextCharTotal > TOKEN_PRECHUNK_HARD_MAX_CHARS

      if (shouldStopForMaxTokens || shouldStopForMaxChars) {
        break
      }

      tokenTotal = nextTokenTotal
      charTotal = nextCharTotal
      end++

      if (
        tokenTotal >= TOKEN_PRECHUNK_TARGET_TOKENS &&
        tokenTotal >= TOKEN_PRECHUNK_MIN_TOKENS
      ) {
        break
      }
    }

    if (end <= start) {
      end = start + 1
      tokenTotal = units[start].tokenCount
    }

    const slice = units.slice(start, end)
    preChunks.push({
      text: slice.map((u) => u.text).join(' '),
      sentences: slice.map((u) => u.text),
      tokenCount: tokenTotal,
    })

    if (end >= units.length) break

    let overlapTokens = 0
    let resume = end
    while (resume > start && overlapTokens < TOKEN_PRECHUNK_OVERLAP_TOKENS) {
      resume--
      overlapTokens += units[resume].tokenCount
    }

    const nextStart = Math.max(start + 1, resume)
    start = Math.min(end, nextStart)
  }

  return preChunks
}

function percentileSorted(values: number[], p: number): number {
  if (values.length === 0) return 0
  if (values.length === 1) return values[0]
  const clampedP = Math.max(0, Math.min(1, p))
  const idx = (values.length - 1) * clampedP
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  if (lo === hi) return values[lo]
  const t = idx - lo
  return values[lo] * (1 - t) + values[hi] * t
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  const denom = Math.sqrt(dotProduct(a, a)) * Math.sqrt(dotProduct(b, b))
  if (!Number.isFinite(denom) || denom <= 0) return 0
  return dotProduct(a, b) / denom
}

function computeAdaptiveMergeThreshold(vectors: Float32Array[]): number {
  if (vectors.length < 4) return SEMANTIC_MERGE_THRESHOLD_DEFAULT
  const sims: number[] = []
  for (let i = 1; i < vectors.length; i++) {
    const prev = vectors[i - 1]
    const next = vectors[i]
    if (!prev || !next || prev.length === 0 || next.length === 0) continue
    const sim = cosineSimilarity(prev, next)
    if (Number.isFinite(sim)) sims.push(sim)
  }

  if (sims.length < 4) return SEMANTIC_MERGE_THRESHOLD_DEFAULT
  sims.sort((a, b) => a - b)
  const p25 = percentileSorted(sims, 0.25)
  const p50 = percentileSorted(sims, 0.5)
  const p75 = percentileSorted(sims, 0.75)
  const iqr = Math.max(0, p75 - p25)
  const candidate = p50 - Math.min(0.08, iqr * 0.4)
  return Math.max(
    SEMANTIC_MERGE_THRESHOLD_FLOOR,
    Math.min(SEMANTIC_MERGE_THRESHOLD_CEIL, candidate),
  )
}

/**
 * Safe TypedArray to Array conversion (Zero-Copy where possible)
 */
function toIntArray(ids: ArrayLike<any>): number[] {
  const out = new Array(ids.length)
  for (let i = 0; i < ids.length; i++) {
    const v = (ids as any)[i]
    out[i] = typeof v === 'bigint' ? Number(v) : v | 0
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
  experimentalWebGPU?: boolean // EXPERIMENTAL: Enable WebGPU for 15-30x faster embeddings
  liteMode?: boolean // PHASE 2: Skip embedding for instant import (BM25 only)
  firefoxDelegate?: boolean // SOTA: Delegate embedding verification to main thread
  config?: { downloadLocalModels?: boolean }
}) {
  try {
    const requestedDim = Number(payload?.truncateDim)
    const nextTargetDim =
      Number.isFinite(requestedDim) && requestedDim > 0 ? requestedDim : null

    if (payload.locale) currentLocale = payload.locale
    if (payload.embeddingPrefixes) {
      embeddingPrefixQuery = payload.embeddingPrefixes.query || ''
      embeddingPrefixDocument = payload.embeddingPrefixes.document || ''
      debugLog('embedding_prefixes', {
        query: embeddingPrefixQuery,
        document: embeddingPrefixDocument,
      })
    } else {
      embeddingPrefixQuery = ''
      embeddingPrefixDocument = ''
    }

    firefoxDelegate = !!payload.firefoxDelegate
    allowLocalModelDownloads = payload?.config?.downloadLocalModels !== false

    if (firefoxDelegate) {
      console.log(
        '[RAG WORKER] ðŸš€ Firefox Delegation Enabled: Embeddings will be computed on Main Thread',
      )
      // Set outputDim for E5 Large if delegating?
      // Native ML default uses multilingual-e5-base (768 dim).
      // If we delegate, probe/init logic sets the effective dimension.
      // But valid outputDim might be overwritten later.
      // Let's assume the main thread handles the model correctly.
    }

    // PHASE 2: Lite mode - Skip all embedding model initialization
    if (payload.liteMode) {
      liteMode = true
      console.log(
        '[RAG WORKER] ðŸš€ LITE MODE: Skipping embedding model, chunks-only indexing',
      )
      debugLog('lite_mode_enabled', {})

      // Only initialize Voy for storing text chunks (no vectors)
      const { Voy } = await import('voy-search')
      voyChunks = new Voy({ embeddings: [] })
      voyChapters = new Voy({ embeddings: [] })

      initialized = true
      backend = null // No embedding backend in lite mode
      self.postMessage({
        type: 'initialized',
        payload: { dim: 0, liteMode: true },
      })
      return
    }

    const backendHint = payload?.backend
    // EXPERIMENTAL: Try WebGPU first for 15-30x faster embeddings (Firefox 147+)
    const webgpuAvailable = await hasWebGPU()
    const useExperimentalWebGPU =
      payload?.experimentalWebGPU !== false && webgpuAvailable

    // EXPERIMENTAL: Try Firefox native ML for 2-10x faster embeddings
    const firefoxNativeAvailable = isFirefox && (await hasFirefoxNativeML())

    let nextBackend: Backend
    if (backendHint === 'wllama') {
      nextBackend = 'wllama'
    } else if (backendHint === 'transformers') {
      nextBackend = 'transformers'
    } else if (backendHint === 'firefox-native') {
      nextBackend = 'firefox-native'
    } else if (backendHint === 'webgpu' || useExperimentalWebGPU) {
      nextBackend = 'webgpu'
      debugLog('webgpu_detected', {
        available: webgpuAvailable,
        experimental: true,
      })
    } else if (firefoxNativeAvailable) {
      // Firefox native ML is 2-10x faster than Wllama WASM
      nextBackend = 'firefox-native'
      debugLog('firefox_native_detected', { available: true })
    } else {
      nextBackend = isFirefox ? 'wllama' : 'transformers'
    }

    console.log('[RAG WORKER] Backend selection:', {
      nextBackend,
      webgpuAvailable,
      firefoxNativeAvailable,
      isFirefox,
      backendHint,
    })

    const modelUrl = payload?.modelUrl || WLLAMA_EMBED_MODEL_URL
    if (nextBackend === 'wllama' && !modelUrl) {
      throw new Error('Missing embedding modelUrl for wllama backend')
    }
    wllamaEmbedModelUrl = modelUrl
    const nextModelId =
      nextBackend === 'wllama'
        ? payload?.modelId || modelUrl
        : String(payload?.model || '')

    if (
      initialized &&
      backend === nextBackend &&
      embeddingModel === nextModelId &&
      targetDim === nextTargetDim
    ) {
      self.postMessage({ type: 'initialized', payload: { dim: outputDim } })
      return
    }

    backend = nextBackend
    embeddingModel = nextModelId
    targetDim = nextTargetDim

    debugLog('backend', { name: backend })
    debugLog('init_start', { model: embeddingModel })

    const { Voy } = await import('voy-search')

    if (
      backend === 'webgpu' ||
      backend === 'firefox-native' ||
      backend === 'wllama'
    ) {
      // EXPERIMENTAL: WebGPU backend for 15-30x faster embeddings
      if (backend === 'webgpu') {
        debugLog('webgpu_init_start', { model: WEBGPU_EMBED_MODEL })
        console.log(
          '[RAG WORKER] ðŸš€ EXPERIMENTAL: Initializing WebGPU embedder for 15-30x speedup...',
        )

        try {
          await configureTransformersEnv()
          const { pipeline } = await getTransformers()

          embedder = await pipeline('feature-extraction', WEBGPU_EMBED_MODEL, {
            device: 'webgpu',
            quantized: true,
            progress_callback: (d: any) => {
              if (d.status === 'progress') {
                debugLog('webgpu_progress', {
                  file: d.file,
                  progress: d.progress,
                })
                self.postMessage({
                  type: 'rag-progress',
                  data: {
                    status: 'progress',
                    progress: d.progress,
                    file: d.file,
                    backend: 'webgpu',
                  },
                })
              }
            },
          } as any)

          try {
            const probe = await embedder('test', {
              pooling: 'mean',
              normalize: true,
            })
            const probeData =
              probe?.data instanceof Float32Array
                ? probe.data
                : new Float32Array(probe?.data || [])
            embedDim = probeData.length || E5_LARGE_DIM
            console.log('[RAG WORKER] âœ… WebGPU embedDim probed:', embedDim)
          } catch {
            embedDim = E5_LARGE_DIM
            console.log(
              '[RAG WORKER] âš ï¸ WebGPU dim probe failed, using default:',
              embedDim,
            )
          }

          wllama = null
          console.log(
            '[RAG WORKER] âœ… WebGPU embedder initialized successfully!',
          )
          debugLog('webgpu_init_success', { dim: embedDim })
        } catch (webgpuErr: any) {
          console.warn(
            '[RAG WORKER] âš ï¸ WebGPU failed, falling back to wllama WASM:',
            webgpuErr?.message,
          )
          debugLog('webgpu_init_failed', {
            error: String(webgpuErr?.message),
            fallback: 'wllama',
          })
          backend = 'wllama'
        }
      }

      // EXPERIMENTAL: Firefox Native ML (browser.trial.ml) for 2-10x faster embeddings
      if (backend === 'firefox-native') {
        console.log(
          '[RAG WORKER] ðŸš€ EXPERIMENTAL: Initializing Firefox Native ML engine...',
        )
        debugLog('firefox_native_init_start', {})

        try {
          const g = self as any
          const browserApi = g.browser || g.chrome

          firefoxMLEngine = await browserApi.trial.ml.createEngine({
            taskName: 'feature-extraction',
            modelId: FIREFOX_ML_MODEL_ID,
            modelHub: 'huggingface',
          })

          try {
            const probeResult = await firefoxMLEngine.run({ args: ['test'] })
            const probeData =
              probeResult?.output?.[0] || probeResult?.[0] || probeResult
            if (Array.isArray(probeData)) {
              embedDim = probeData.length
            } else if (probeData?.data) {
              embedDim = probeData.data.length
            } else {
              embedDim = E5_LARGE_DIM
            }
            console.log(
              '[RAG WORKER] âœ… Firefox Native ML embedDim probed:',
              embedDim,
            )
          } catch {
            embedDim = E5_LARGE_DIM
            console.log(
              '[RAG WORKER] âš ï¸ Firefox Native ML dim probe failed, using default:',
              embedDim,
            )
          }

          embedder = null
          wllama = null
          console.log('[RAG WORKER] âœ… Firefox Native ML engine initialized!')
          debugLog('firefox_native_init_success', { dim: embedDim })
        } catch (firefoxErr: any) {
          console.warn(
            '[RAG WORKER] âš ï¸ Firefox Native ML failed, falling back to wllama:',
            firefoxErr?.message,
          )
          debugLog('firefox_native_init_failed', {
            error: String(firefoxErr?.message),
            fallback: 'wllama',
          })
          backend = 'wllama'
          firefoxMLEngine = null
        }
      }

      // SOTA: Lazy Loading for Wllama (common fallback for WebGPU/Native ML or default for Firefox)
      if (backend === 'wllama') {
        embedDim = E5_LARGE_DIM
        // SOTA v3.12: Eager Initialization on Mode Selection
        // When user clicks "RAG", we must download the models immediately.
        // This ensures "Start" is instant and respects user intent (Clicking RAG = "I want RAG").
        // OPTIMIZATION: If delegating to Main Thread (Firefox Native), DO NOT eagerly load Wllama.
        // This prevents "Double Loading" (Background loads ONNX, Worker loads GGUF) and saves 500MB+ RAM.
        const shouldEagerDownload =
          payload?.config?.downloadLocalModels !== false && !firefoxDelegate

        if (shouldEagerDownload) {
          console.log(
            '[RAG WORKER] ðŸš€ Eager Wllama download: Triggering background fetch...',
          )
          ensureWllama().catch((err) =>
            console.warn('[RAG WORKER] Eager Wllama pre-fetch failed:', err),
          )
        } else {
          console.log(
            '[RAG WORKER] ðŸ›‘ Eager Wllama download skipped (Delegation Active or User Disabled).',
          )
        }
      }
    } else {
      // Standard Transformers.js pipeline (CPU-based ONNX)
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
              data: { status: 'progress', progress: d.progress, file: d.file },
            })
          }
        },
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
        embeddings: [
          {
            id: 'probe',
            title: '',
            url: '',
            embeddings: new Float32Array(embedDim) as any,
          },
        ],
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
    self.postMessage({
      type: 'embedding-error',
      data: { message: msg, stage: 'init' },
    })
    self.postMessage({
      type: 'error',
      payload: { reason: `FAILED_INIT: ${msg}` },
    })
  }
}

/**
 * PHASE 2: Lite Mode Section Processor
 * Stores text chunks WITHOUT generating embeddings for instant import.
 * Uses zero-vectors for compatibility with Voy structure.
 * Retrieval relies on BM25 text search instead of vector similarity.
 */
async function processSectionLite(
  bookId: string,
  markdown: string,
  metadata: any,
) {
  let doneSent = false
  let donePayload: any = {
    sectionIndex: metadata?.sectionIndex ?? -1,
    skipped: false,
  }

  const sendDone = (p: any) => {
    if (!doneSent) {
      doneSent = true
      self.postMessage({ type: 'sectionDone', payload: p })
    }
  }

  try {
    // Skip empty sections
    if (!markdown || markdown.trim().length === 0 || metadata.skipped) {
      const reason = metadata.reason || 'empty markdown'
      skippedSections.push({ sectionIndex: metadata.sectionIndex, reason })
      donePayload = {
        sectionIndex: metadata.sectionIndex,
        skipped: true,
        reason,
      }
      sendDone(donePayload)
      return
    }

    // Simple sentence-based chunking (no embedding needed)
    const sentences = splitSentences(markdown, currentLocale)
    const target = 1000 // chars per chunk
    const overlap = 200

    const recordsBatch: any[] = []
    let current = ''
    let currentStart = 0
    let charOffset = 0

    const flushChunk = () => {
      if (!current.trim()) return

      // Create record with empty embedding (for BM25 text search)
      recordsBatch.push({
        bookId,
        sectionId: String(metadata.sectionIndex),
        chapterId: metadata.chapterId || '',
        chapterTitle: metadata.title || '',
        content: current.trim(),
        charStart: currentStart,
        charEnd: charOffset,
        // No embedding - zero vector placeholder
        embedding: null,
      })

      current = ''
      currentStart = charOffset
    }

    for (const s of sentences) {
      if (cancelled) break

      if (current.length + s.length > target) {
        // Keep overlap: capture words BEFORE flushing (flushChunk clears current)
        const words = current.split(/\s+/)
        flushChunk()
        const overlapWords = words.slice(
          -Math.min(words.length, Math.floor(overlap / 5)),
        )
        current = overlapWords.join(' ') + ' '
        currentStart = charOffset - current.length
      }

      current += s + ' '
      charOffset += s.length + 1
    }

    // Flush remaining
    flushChunk()

    // Add records (emit them back to main thread for DB storage)
    if (recordsBatch.length > 0) {
      self.postMessage({
        type: 'records',
        payload: recordsBatch, // SOTA: Always send raw array, Main Thread handles buffering
      })
      itemsAdded += recordsBatch.length
    }

    donePayload = {
      sectionIndex: metadata.sectionIndex,
      skipped: false,
      chunks: recordsBatch.length,
    }
    sendDone(donePayload)

    debugLog('lite_section_done', {
      sectionIndex: metadata.sectionIndex,
      chunks: recordsBatch.length,
    })
  } catch (err: any) {
    console.error('[RAG WORKER] Lite section error:', err?.message)
    donePayload = {
      sectionIndex: metadata.sectionIndex,
      skipped: true,
      reason: err?.message || 'lite_error',
    }
    sendDone(donePayload)
  }
}

/**
 * Optimized Section Processor
 */
async function processSection(bookId: string, markdown: string, metadata: any) {
  if (!initialized) return

  // PHASE 2: Lite mode - Store text chunks only, no embeddings
  if (liteMode) {
    return processSectionLite(bookId, markdown, metadata)
  }

  if (!voyChunks || !voyChapters) return
  // High-performance backends (Firefox, Wllama) use the optimized batch processor
  if (backend === 'wllama' || backend === 'firefox-native' || firefoxDelegate) {
    return processSectionOptimized(bookId, markdown, metadata)
  }
  if (!embedder) return

  let doneSent = false
  // Industrial v3.5: Accurate Telemetry Payload State
  let donePayload: any = {
    sectionIndex: metadata?.sectionIndex ?? -1,
    skipped: false,
  }

  const sendDone = (p: any) => {
    if (!doneSent) {
      doneSent = true
      self.postMessage({ type: 'sectionDone', payload: p })
    }
  }

  try {
    // Bulletproof Hardening v3.5: Structured Skip Reporting
    if (!markdown || markdown.trim().length === 0 || metadata.skipped) {
      const reason = metadata.reason || 'empty markdown'
      skippedSections.push({ sectionIndex: metadata.sectionIndex, reason })
      donePayload = {
        sectionIndex: metadata.sectionIndex,
        skipped: true,
        reason,
      }
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
          const textWindow = embedder.tokenizer.decode(windowIds, {
            skip_special_tokens: true,
          })
          if (!textWindow || textWindow.trim().length === 0) continue

          // Safe forward
          const out = await embedder(textWindow, { pooling: 'none' })
          const data = out.data

          // SOTA v3.12: Token Logic Alignment Check
          // If normalization changed token count, we cannot map back 1:1 using index `d`.
          // Fallback to sentence pooling for this whole section to ensure correctness.
          const seqLen = Math.floor(data.length / embedDim)
          if (seqLen !== windowIds.length) {
            console.warn(
              `Late Chunking Mismatch [${metadata?.sectionIndex}]: Tokens ${windowIds.length} vs Embeds ${seqLen}. Falling back to standard pooling.`,
            )
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
          console.warn(
            `Late Chunking Error [${metadata?.sectionIndex}]: ${e.message}. Falling back.`,
          )
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
            for (let d = 0; d < embedDim; d++)
              tokenEmbeddings[off + d] /= weight
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
        for (let d = 0; d < embedDim; d++)
          sectionSumVec[d] += tokenEmbeddings[off + d]
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
          for (let d = 0; d < embedDim; d++)
            vec[d] += tokenEmbeddings[t * embedDim + d]
          count++
        }
        if (count > 0) for (let d = 0; d < embedDim; d++) vec[d] /= count
      } else {
        // FALLBACK (v3.9.1): Standard mean pooling for large chapters (RAM Safe)
        const out = await embedder(sentence, {
          pooling: 'mean',
          normalize: true,
        })
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
      const chapterRaw = voyAcceptsTypedArrays
        ? new Float32Array(sectionSumVec)
        : Array.from(sectionSumVec)
      const chapterEmb = maybeTruncateEmbedding(chapterRaw)
      voyChapters.add({
        embeddings: [
          {
            id: String(metadata.sectionIndex),
            title: '',
            url: '',
            embeddings: chapterEmb as any,
          },
        ],
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

      const embRaw = voyAcceptsTypedArrays
        ? new Float32Array(currentChunkVecSum)
        : Array.from(currentChunkVecSum)
      const embToSend = maybeTruncateEmbedding(embRaw)

      voyBatch.push({
        id: String(idx),
        title: '',
        url: '',
        embeddings: embToSend as any,
      })
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
        const isTopicShift =
          sentence.length > 25 && similarity < similarityThreshold
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
    if (recordsBatch.length > 0)
      self.postMessage({ type: 'records', payload: recordsBatch })

    sendDone(donePayload)
  } catch (err: any) {
    // v3.5: Section error is now a SKIP, reported with REAL reason
    const reason = String(err?.message || err)
    console.error(
      `Worker Section Processor Failure [${metadata?.sectionIndex}]:`,
      reason,
    )

    donePayload = {
      sectionIndex: metadata?.sectionIndex ?? -1,
      skipped: true,
      reason,
    }
    skippedSections.push({ sectionIndex: donePayload.sectionIndex, reason })

    self.postMessage({
      type: 'error',
      payload: { sectionIndex: metadata?.sectionIndex, reason, fatal: false },
    })
  } finally {
    // GARANTIA ABSOLUTA: Always send the most accurate payload we have
    sendDone(donePayload)
  }
}

async function processSectionOptimized(
  bookId: string,
  markdown: string,
  metadata: any,
) {
  if (!initialized || !voyChunks || !voyChapters) return

  // SOTA v3.11: On-Start Robustness
  // Wllama download is now triggered during 'initialize' (Mode Selection).
  // We keep a safety check here just in case, but only if downloads are allowed.
  if (!wllama && !liteMode && backend === 'wllama') {
    // Check if download is allowed (defaults to true)
    // Note: We don't have access to global config here easily without passing it.
    // But initialized logic should have ideally handled it.
    // If we are here, we just try to ensure it exists if permitted.
    // Since we can't easily check config, we will skip the optimistic download here
    // and rely on the main flow or user interaction to trigger it if missing.
    // This avoids the bug where it auto-downloads even if disabled.
    console.log(
      '[RAG WORKER] processSectionOptimized: Wllama check skipped to respect potential user settings.',
    )
  }

  let doneSent = false
  let donePayload: any = {
    sectionIndex: metadata?.sectionIndex ?? -1,
    skipped: false,
  }

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
      donePayload = {
        sectionIndex: metadata.sectionIndex,
        skipped: true,
        reason,
      }
      sendDone(donePayload)
      return
    }

    const sentences = splitSentences(markdown, currentLocale)
    if (sentences.length === 0) {
      const reason = 'no sentences'
      skippedSections.push({ sectionIndex: metadata.sectionIndex, reason })
      donePayload = {
        sectionIndex: metadata.sectionIndex,
        skipped: true,
        reason,
      }
      sendDone(donePayload)
      return
    }

    // Token-aware pre-chunking with sentence boundaries and lightweight overlap.
    // This keeps sections under model limits more reliably across languages.
    let preChunks = ENABLE_TOKEN_AWARE_PRECHUNKING
      ? buildTokenAwarePreChunks(sentences, currentLocale)
      : buildLegacyCharPreChunks(sentences, currentLocale)
    if (ENABLE_TOKEN_AWARE_PRECHUNKING && preChunks.length === 0) {
      preChunks = buildLegacyCharPreChunks(sentences, currentLocale)
    }

    const totalPreChunkTokens = preChunks.reduce(
      (acc, chunk) => acc + chunk.tokenCount,
      0,
    )
    console.log(
      '[RAG WORKER] Section',
      metadata.sectionIndex,
      ': token-aware pre-chunking',
      {
        sentences: sentences.length,
        chunks: preChunks.length,
        avgTokens:
          preChunks.length > 0
            ? Number((totalPreChunkTokens / preChunks.length).toFixed(1))
            : 0,
        overlapTokens: TOKEN_PRECHUNK_OVERLAP_TOKENS,
      },
    )

    // SOTA: Unified Batch Embedding
    // Handles Delegation, Native ML, and Fallback seamlessly
    let chunkVectors: Float32Array[] = []
    const sectionSumVec = new Float32Array(embedDim)
    const embedStartedAt = Date.now()
    chunkVectors = await embedBatch(
      preChunks.map((c) => c.text),
      'document',
    )
    const embedMs = Date.now() - embedStartedAt
    console.log(
      '[RAG WORKER] Section',
      metadata.sectionIndex,
      ': embedding batch timing',
      {
        chunks: preChunks.length,
        ms: embedMs,
        msPerChunk: Number(
          (embedMs / Math.max(1, preChunks.length)).toFixed(1),
        ),
      },
    )

    // =====================================================================
    // SOTA v3.13: Topic-Shift Merge Pass (Firefox Quality Parity)
    // After batch-embedding, merge adjacent semantically-similar chunks
    // and keep boundaries where cosine similarity drops (topic shift).
    // This gives Firefox the same chunking quality as Chrome's Late Chunking.
    // =====================================================================
    const similarityThreshold = computeAdaptiveMergeThreshold(chunkVectors)

    interface MergedChunk {
      text: string
      vec: Float32Array
    }
    const merged: MergedChunk[] = []

    if (chunkVectors.length > 0) {
      // Start with the first chunk
      let currentText = preChunks[0].text
      let currentTokens = preChunks[0].tokenCount
      let currentVec = new Float32Array(chunkVectors[0])
      let currentCount = 1

      for (let i = 1; i < preChunks.length; i++) {
        const nextVec = chunkVectors[i]
        if (!nextVec || nextVec.length === 0) continue

        // Compute cosine similarity between current merged chunk and next chunk
        const sim = cosineSimilarity(currentVec, nextVec)
        const nextChunk = preChunks[i]
        const combinedLen = currentText.length + nextChunk.text.length + 1
        const combinedTokens = currentTokens + nextChunk.tokenCount

        if (
          sim >= similarityThreshold &&
          combinedLen <= SEMANTIC_MERGE_MAX_CHARS &&
          combinedTokens <= SEMANTIC_MERGE_MAX_TOKENS
        ) {
          // Merge: high similarity = same topic, combine text and average vectors
          currentText += ' ' + nextChunk.text
          const newCount = currentCount + 1
          for (let d = 0; d < embedDim; d++) {
            currentVec[d] =
              (currentVec[d] * currentCount + nextVec[d]) / newCount
          }
          currentCount = newCount
          currentTokens = combinedTokens
        } else {
          // Topic shift or size limit: finalize current chunk
          normalizeInPlace(currentVec)
          merged.push({ text: currentText, vec: currentVec })
          currentText = nextChunk.text
          currentTokens = nextChunk.tokenCount
          currentVec = new Float32Array(nextVec)
          currentCount = 1
        }
      }
      // Finalize last chunk
      normalizeInPlace(currentVec)
      merged.push({ text: currentText, vec: currentVec })
    }

    console.log(
      '[RAG WORKER] Section',
      metadata.sectionIndex,
      ': topic-shift merge',
      {
        preChunks: preChunks.length,
        semanticChunks: merged.length,
        threshold: Number(similarityThreshold.toFixed(3)),
        mergeMaxTokens: SEMANTIC_MERGE_MAX_TOKENS,
      },
    )

    // Process sum for chapter index using merged vectors
    for (const mc of merged) {
      for (let d = 0; d < embedDim; d++) sectionSumVec[d] += mc.vec[d]
    }

    console.log(
      '[RAG WORKER] Section',
      metadata.sectionIndex,
      'embedding complete, chunks:',
      merged.length,
    )

    if (merged.length > 0) {
      for (let d = 0; d < embedDim; d++) sectionSumVec[d] /= merged.length
    }
    normalizeInPlace(sectionSumVec)

    // Add to chapter index
    if (voyChapters) {
      const chapterRaw = voyAcceptsTypedArrays
        ? new Float32Array(sectionSumVec)
        : Array.from(sectionSumVec)
      const chapterEmb = maybeTruncateEmbedding(chapterRaw)
      voyChapters.add({
        embeddings: [
          {
            id: String(metadata.sectionIndex),
            title: '',
            url: '',
            embeddings: chapterEmb as any,
          },
        ],
      } as any)
    }

    // Add merged chunks to index and records
    const recordsBatch: any[] = []
    const voyBatch: any[] = []

    for (let i = 0; i < merged.length; i++) {
      if (cancelled) break
      const mc = merged[i]

      const embRaw = voyAcceptsTypedArrays
        ? new Float32Array(mc.vec)
        : Array.from(mc.vec)
      const embToSend = maybeTruncateEmbedding(embRaw)

      voyBatch.push({
        id: String(itemsAdded),
        title: '',
        url: '',
        embeddings: embToSend as any,
      })
      if (voyBatch.length >= 64) {
        voyChunks!.add({ embeddings: [...voyBatch] } as any)
        voyBatch.length = 0
      }

      recordsBatch.push({
        bookId,
        content: mc.text,
        index: itemsAdded,
        metadata,
      })
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
    console.error(
      `Worker Section Processor Failure [${metadata?.sectionIndex}]:`,
      reason,
    )

    donePayload = {
      sectionIndex: metadata?.sectionIndex ?? -1,
      skipped: true,
      reason,
    }
    skippedSections.push({ sectionIndex: donePayload.sectionIndex, reason })

    self.postMessage({
      type: 'error',
      payload: { sectionIndex: metadata?.sectionIndex, reason, fatal: false },
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
      console.log(
        '[RAG WORKER] Initialization complete, initialized=',
        initialized,
      )
      break

    case 'index':
      console.log(
        '[RAG WORKER] Processing section:',
        payload?.metadata?.sectionIndex,
      )
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
            skippedSections,
          },
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
          {
            type: 'embed-result',
            requestId,
            payload: { vector: vec, dim: vec.length },
          },
          vec?.buffer ? [vec.buffer] : undefined,
        )
      } catch (err: any) {
        const message = String(err?.message || err)
        debugLog('embed_error', { message })
        self.postMessage({
          type: 'embedding-error',
          data: { message, stage: 'embed' },
        })
        self.postMessage({
          type: 'embed-result',
          requestId,
          payload: { error: message },
        })
      }
      break
    }

    case 'embedding-response': {
      const { id, vector, error } = payload
      const pending = pendingEmbeddings.get(id)
      if (pending) {
        pendingEmbeddings.delete(id)
        if (error) {
          pending.reject(new Error(error))
        } else if (vector) {
          // Convert back to Float32Array if transferred as buffer or array
          const vec =
            vector instanceof Float32Array ? vector : new Float32Array(vector)
          pending.resolve(vec)
        } else {
          pending.reject(new Error('Invalid response from main thread'))
        }
      }
      break
    }

    case 'embedding-batch-response': {
      const { id, vectors, error } = payload
      const pending = pendingEmbedBatch.get(id)
      if (pending) {
        pendingEmbedBatch.delete(id)
        if (error) {
          pending.reject(new Error(error))
        } else if (vectors && Array.isArray(vectors)) {
          const chunks = vectors.map((v: any) =>
            v instanceof Float32Array ? v : new Float32Array(v),
          )
          pending.resolve(chunks)
        } else {
          pending.reject(new Error('Invalid batch response from main thread'))
        }
      }
      break
    }
  }
}

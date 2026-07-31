/// <reference lib="webworker" />

import { Wllama } from '@wllama/wllama/esm'

type RewriteHistoryMessage = { role: 'user' | 'assistant'; content: string }

type IntentLabel =
  | 'question'
  | 'explain'
  | 'summarize'
  | 'define'
  | 'analyze'
  | 'concept'
  | 'general'

type IntentQuery = { type: IntentLabel; query: string }
type IntentClassification = { intents: IntentQuery[]; primaryQuery: string }

type Inbound =
  | {
      type: 'rewrite'
      id: number
      query: string
      history: RewriteHistoryMessage[]
    }
  | {
      type: 'classify'
      id: number
      query: string
      history: RewriteHistoryMessage[]
    }
  | { type: 'preload'; id: number }

const DEBUG = process.env.NODE_ENV !== 'production'
const IS_FIREFOX =
  typeof navigator !== 'undefined' &&
  /Firefox/i.test((navigator as any)?.userAgent || '')

// SOTA (2026): Gemma 3 270M Instruct (GGUF) - good quality/size tradeoff.
const DEFAULT_MODEL_URL =
  'https://huggingface.co/unsloth/gemma-3-270m-it-GGUF/resolve/e45c5af7019a8d4f30dc82c5e0f35b0cce139631/gemma-3-270m-it-Q6_K.gguf'

// Cache-buster for local extension assets (workers/wasm). Firefox can keep old
// module-worker code around longer than you'd expect across reloads.
const WLLAMA_ASSET_VERSION = '20260204a'
// Blob-worker override is a fallback for Firefox CSP/Blob-worker edge cases.
// We keep it enabled only in Firefox and still prefer native blob workers first.
const ENABLE_WLLAMA_WORKER_OVERRIDE_FALLBACK = IS_FIREFOX

const MODEL_CTX = 4096
const MAX_HISTORY_TURNS = 4
const MAX_HISTORY_CHARS_PER_TURN = 220
const METADATA_PREFIX = '__metadata__'

function toErrorDetails(reason: unknown): { message: string; stack?: string } {
  if (reason instanceof Error) {
    return { message: reason.message || String(reason), stack: reason.stack }
  }
  if (typeof reason === 'string') {
    return { message: reason }
  }
  if (reason && typeof reason === 'object') {
    try {
      return { message: JSON.stringify(reason) }
    } catch {
      return { message: String(reason) }
    }
  }
  return { message: String(reason || 'unknown_worker_error') }
}

function postUnhandledWorkerError(stage: string, reason: unknown) {
  const { message, stack } = toErrorDetails(reason)
  try {
    self.postMessage({
      type: 'slm-error',
      data: { stage, message, stack },
      fatal: false,
    })
  } catch {
    // ignore
  }
}

// Guard against silent async failures in worker runtime. Without this, some
// rejected internal promises can leave the UI stuck in "downloading".
self.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
  postUnhandledWorkerError('unhandledrejection', event.reason)
})

self.addEventListener('error', (event: ErrorEvent) => {
  postUnhandledWorkerError('worker_runtime', event.error || event.message)
})

function debugLog(message: string, data?: Record<string, any>) {
  if (!DEBUG) return
  try {
    self.postMessage({ type: 'slm-debug', data: { message, ...(data || {}) } })
  } catch {
    // ignore
  }
}

function postError(
  id: number | null,
  err: unknown,
  stage: string,
  fatal = false,
) {
  const message = err instanceof Error ? err.message : String(err)
  const stack = err instanceof Error ? err.stack : undefined
  debugLog('error', { stage, message })
  try {
    self.postMessage({
      type: 'slm-error',
      data: { stage, message, stack },
      fatal,
    })
  } catch {
    // ignore
  }
  if (typeof id === 'number') {
    try {
      self.postMessage({ id, error: message, fatal })
    } catch {
      // ignore
    }
  }
}

function compactText(input: string): string {
  return (input || '')
    .replace(/Sources:[^\n\r]*/gi, '')
    .replace(/\[S\d+:C\d+\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function safeJsonParse<T>(text: string): T | null {
  const cleaned = String(text || '')
    .replace(/```(?:json)?/gi, '')
    .replace(/```/g, '')
    .trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return null
  const slice = cleaned.slice(start, end + 1)
  try {
    return JSON.parse(slice) as T
  } catch {
    return null
  }
}

// ----------------------------------------------------------------------------
// wllama bootstrapping (CSP-safe worker override + stable wasm bytes)
// ----------------------------------------------------------------------------

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
    const filename = await this.urlToFileName(url, '')
    const metadataFileName = await this.urlToFileName(url, METADATA_PREFIX)

    const cacheDir = await this.getCacheDir()
    const fileHandle = await cacheDir.getFileHandle(filename, { create: true })

    const response = await fetch(url, {
      headers: options.headers,
      signal: options.signal,
    })
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
      return file || null
    } catch {
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

  async getMetadata(nameOrURL: string): Promise<{
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

function createDirectOPFSCacheManager(): DirectOPFSCacheManager | null {
  try {
    if (typeof navigator === 'undefined') return null
    if (!(navigator as any)?.storage?.getDirectory) return null
    return new DirectOPFSCacheManager()
  } catch {
    return null
  }
}

let wllama: Wllama | null = null
let loadPromise: Promise<void> | null = null

function installWllamaWorkerOverride() {
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

  // wllama uses two blob workers:
  // - main llama.cpp worker (~70-100KB)
  // - OPFS helper worker (~4KB)
  //
  // Earlier we routed by blob size, but that is brittle across wllama versions/minifiers.
  // In a Worker context we can synchronously peek the blob header using FileReaderSync.
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
          // Heuristic: OPFS helper code references OPFS APIs; llama worker contains llama.cpp glue.
          const fr =
            typeof (self as any).FileReaderSync === 'function'
              ? new (self as any).FileReaderSync()
              : null
          const head = fr ? String(fr.readAsText(blob.slice(0, 2048))) : ''

          // Only override blobs that look like wllama workers. Otherwise we could break unrelated libs
          // that legitimately use Blob workers inside this Worker.
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
          // Fallback: size-based routing
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
      // ignore
    }
    return originalCreateObjectURL(blob)
  }

  anySelf.__wllamaWorkerOverrideInstalled = true
}

function setWllamaWorkerOverrideEnabled(enabled: boolean) {
  const anySelf = self as any
  if (enabled) {
    installWllamaWorkerOverride()
    anySelf.__wllamaUseWorkerOverride = true
    return
  }
  // Keep native blob-worker path untouched unless override is explicitly enabled.
  if (anySelf.__wllamaWorkerOverrideInstalled) {
    anySelf.__wllamaUseWorkerOverride = false
  }
}

function resolveWasmPaths() {
  const g = self as any
  const getURL = g.browser?.runtime?.getURL || g.chrome?.runtime?.getURL
  const origin = g?.location?.origin || ''

  const withVersion = (url: string) =>
    `${url}${url.includes('?') ? '&' : '?'}v=${WLLAMA_ASSET_VERSION}`

  const single =
    typeof getURL === 'function'
      ? withVersion(getURL('wasm/wllama-single.wasm'))
      : withVersion(`${origin}/wasm/wllama-single.wasm`)

  // Only expose the multi-thread build if the environment is actually capable of using it.
  // In Firefox MV3 (and many extension contexts), SharedArrayBuffer is unavailable, which causes
  // wllama to probe multi-thread and trip CSP / blob-worker restrictions.
  const canUseMultiThread =
    typeof (self as any).SharedArrayBuffer !== 'undefined' &&
    (self as any).crossOriginIsolated === true
  if (!canUseMultiThread) {
    return {
      'single-thread/wllama.wasm': single,
    } as const
  }

  const multi =
    typeof getURL === 'function'
      ? withVersion(getURL('wasm/wllama-multi.wasm'))
      : withVersion(`${origin}/wasm/wllama-multi.wasm`)
  return {
    'single-thread/wllama.wasm': single,
    'multi-thread/wllama.wasm': multi,
  } as const
}

async function ensureLoaded(modelUrl = DEFAULT_MODEL_URL): Promise<Wllama> {
  if (wllama && wllama.isModelLoaded()) return wllama
  if (loadPromise) {
    await loadPromise
    if (!wllama) throw new Error('SLM init failed')
    return wllama
  }

  const init = async (opts: { forceWorkerOverride: boolean }) => {
    // wllama uses `document.baseURI` to resolve some internal URLs; in Workers `document` is undefined.
    // Provide the minimal shape to avoid runtime crashes.
    const anySelf = self as any
    if (!anySelf.document) {
      anySelf.document = { baseURI: self.location?.href || '' }
    }

    // Prefer native blob workers (fast path). In Firefox MV3, CSP may block blob: workers depending on
    // the manifest CSP. If that happens, we fall back to a physical worker file override.
    setWllamaWorkerOverrideEnabled(!!opts.forceWorkerOverride)
    if (opts.forceWorkerOverride) {
      debugLog('override_enabled', { workerOverride: true })
    }

    const wasmPaths = resolveWasmPaths()
    debugLog('wllama_wasm_paths', wasmPaths as any)
    debugLog('init_start', { model: modelUrl })

    const directCacheManager = createDirectOPFSCacheManager()

    wllama = new Wllama(wasmPaths, {
      cacheManager: (directCacheManager || undefined) as any,
      allowOffline: true,
      logger: {
        debug: (...args) =>
          debugLog('logger_debug', { args: args.map((a) => String(a)) }),
        log: (...args) =>
          debugLog('logger_log', { args: args.map((a) => String(a)) }),
        warn: (...args) =>
          debugLog('logger_warn', {
            args: args.map((a) => {
              try {
                return typeof a === 'object' ? JSON.stringify(a) : String(a)
              } catch {
                return String(a)
              }
            }),
          }),
        error: (...args) =>
          debugLog('logger_error', { args: args.map((a) => String(a)) }),
      },
    })

    // Best effort: show cache hit early (for UX) if OPFS already contains the file.
    try {
      const name = await wllama.cacheManager.getNameFromURL(modelUrl)
      const size = await wllama.cacheManager.getSize(name)
      if (size > 0) {
        debugLog('cache_hit', { name, size })
      }
    } catch {
      // ignore
    }

    // Force explicit GET when not cached. This avoids rare states where
    // `loadModelFromUrl` probes with HEAD but does not start body transfer.
    if (directCacheManager) {
      let hasCachedModel = false
      try {
        const name = await directCacheManager.getNameFromURL(modelUrl)
        const size = await directCacheManager.getSize(name)
        hasCachedModel = size > 0
      } catch (err) {
        debugLog('cache_probe_failed', {
          message: err instanceof Error ? err.message : String(err),
        })
      }

      if (!hasCachedModel) {
        debugLog('download_start', { model: modelUrl })
        await directCacheManager.download(modelUrl, {
          progressCallback: ({ loaded, total }) => {
            const pct = total ? (loaded / total) * 100 : 0
            self.postMessage({
              type: 'slm-progress',
              data: {
                status: 'progress',
                file: 'gguf',
                progress: pct,
                loaded,
                total,
              },
            })
          },
        })
        debugLog('download_complete', { model: modelUrl })
        try {
          self.postMessage({
            type: 'slm-debug',
            data: { message: 'download_complete', model: modelUrl },
          })
        } catch {
          // ignore
        }
      }
    }

    await wllama.loadModelFromUrl(modelUrl, {
      n_ctx: MODEL_CTX,
      // Firefox MV3 does not expose SharedArrayBuffer without COOP/COEP, so multi-thread wasm is not reliable.
      n_threads: 1,
      progressCallback: ({ loaded, total }) => {
        const pct = total ? (loaded / total) * 100 : 0
        self.postMessage({
          type: 'slm-progress',
          data: {
            status: 'progress',
            file: 'gguf',
            progress: pct,
            loaded,
            total,
          },
        })
        if (pct === 100) {
          debugLog('download_complete', { loaded, total })
        }
      },
    })

    debugLog('ready')
    self.postMessage({ type: 'slm-ready' })
  }

  const errorMessage = (err: unknown) =>
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

  loadPromise = (async () => {
    // Attempt 1: native worker path first.
    // In modern manifests we allow `worker-src blob:`; this is usually the most stable path.
    try {
      await init({ forceWorkerOverride: false })
      return
    } catch (err) {
      const msg = errorMessage(err)
      if (!ENABLE_WLLAMA_WORKER_OVERRIDE_FALLBACK) throw err
      if (!isBlobCspError(msg) && !IS_FIREFOX) throw err
      if (!isBlobCspError(msg) && IS_FIREFOX) {
        // If it's Firefox but not clearly CSP-related, keep original error for diagnostics.
        throw err
      }
      debugLog('retry_with_override', {
        reason: 'csp_blob_worker_blocked',
        message: msg,
      })
      wllama = null
    }

    // Attempt 2: override blob workers to physical files.
    try {
      await init({ forceWorkerOverride: true })
      return
    } catch (err) {
      const msg = errorMessage(err)
      if (isOverrideNetworkError(msg)) {
        // Attempt 3: if override path cannot fetch wasm in this environment, retry native path once.
        debugLog('retry_without_override', { reason: 'override_network_error' })
        wllama = null
        await init({ forceWorkerOverride: false })
        return
      }
      throw err
    }
  })().finally(() => {
    loadPromise = null
  })

  await loadPromise
  if (!wllama) throw new Error('SLM init failed')
  return wllama
}

// ----------------------------------------------------------------------------
// SLM prompts
// ----------------------------------------------------------------------------

function historyToText(history: RewriteHistoryMessage[]): string {
  const turns = (history || []).slice(-MAX_HISTORY_TURNS)
  return turns
    .map(
      (m) =>
        `${m.role.toUpperCase()}: ${compactText(m.content).slice(
          0,
          MAX_HISTORY_CHARS_PER_TURN,
        )}`,
    )
    .join('\n')
    .trim()
}

async function runRewrite(
  llm: Wllama,
  query: string,
  history: RewriteHistoryMessage[],
): Promise<string> {
  const convo = historyToText(history)
  const userMsg = compactText(query)

  const system =
    'Rewrite the user message into a standalone question for retrieval.\n' +
    'Rules:\n' +
    '- Preserve the original language (respond in the SAME language as the user message).\n' +
    '- Use the conversation only to resolve pronouns/ellipses.\n' +
    '- Output ONLY the rewritten question (no quotes, no markdown).\n'

  const user =
    `Conversation (most recent last):\n${convo || '(empty)'}\n\n` +
    `User message:\n${userMsg}\n\n` +
    `Standalone question:`

  const out = await llm.createChatCompletion(
    [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    {
      nPredict: 96,
      sampling: { temp: 0.2, top_p: 0.9 },
    },
  )

  return String(out || '')
    .replace(/^["']|["']$/g, '')
    .trim()
}

async function runClassify(
  llm: Wllama,
  query: string,
  history: RewriteHistoryMessage[],
): Promise<IntentClassification> {
  const convo = historyToText(history)
  const userMsg = compactText(query)

  const system =
    'You are an intent router for an ebook reader RAG system.\n' +
    'Return ONLY valid JSON (no markdown) with this schema:\n' +
    '{ "primaryQuery": string, "intents": [ { "type": string, "query": string } ] }\n' +
    'Rules:\n' +
    '- Language: keep the SAME language as the user message.\n' +
    '- Multi-intent: include multiple intents if present.\n' +
    '- Allowed types: question, explain, summarize, define, analyze, concept, general.\n' +
    '- Each intent query MUST be standalone.\n'

  const user =
    `Conversation (most recent last):\n${convo || '(empty)'}\n\n` +
    `User message:\n${userMsg}\n\n` +
    `JSON:`

  const out = await llm.createChatCompletion(
    [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    {
      nPredict: 220,
      sampling: { temp: 0.2, top_p: 0.9 },
    },
  )

  const parsed = safeJsonParse<IntentClassification>(out)
  if (!parsed || !Array.isArray((parsed as any).intents)) {
    // Minimal fallback: treat as a single question.
    return {
      primaryQuery: userMsg,
      intents: [{ type: 'question', query: userMsg }],
    }
  }

  const intents = (parsed.intents || [])
    .map((i: any) => ({
      type: String(i?.type || 'general') as IntentLabel,
      query: String(i?.query || '').trim(),
    }))
    .filter((i: IntentQuery) => i.query.length > 0)

  const primaryQueryRaw =
    typeof (parsed as any).primaryQuery === 'string'
      ? String((parsed as any).primaryQuery)
      : ''
  const primaryQuery = (
    primaryQueryRaw.trim() ||
    intents[0]?.query ||
    userMsg
  ).trim()

  return {
    primaryQuery,
    intents: intents.length
      ? intents
      : [{ type: 'question', query: primaryQuery }],
  }
}

// ----------------------------------------------------------------------------
// Request serialization (llama.cpp contexts are not re-entrant)
// ----------------------------------------------------------------------------

let queue = Promise.resolve()
function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn)
  // keep queue alive even on errors
  queue = next.then(
    () => undefined,
    () => undefined,
  )
  return next
}

self.onmessage = (e: MessageEvent<Inbound>) => {
  const msg = e.data
  if (!msg || typeof (msg as any).id !== 'number') return

  const id = (msg as any).id as number

  // Preload is a UX trigger ("start warming up"), not a transactional request.
  // Reply immediately so the UI never flips to error just because init is slow.
  if (msg.type === 'preload') {
    void enqueue(async () => {
      try {
        // Important: await so preload failures surface as `slm-error`.
        // Without await, rejected init/download promises can be swallowed and
        // UI may stay forever in "downloading".
        await ensureLoaded(DEFAULT_MODEL_URL)
      } catch (err) {
        postError(null, err, 'preload', false)
      }
    })
    try {
      self.postMessage({ id, ok: true })
    } catch {
      // ignore
    }
    return
  }

  void enqueue(async () => {
    try {
      const llm = await ensureLoaded(DEFAULT_MODEL_URL)

      if (msg.type === 'rewrite') {
        const text = await runRewrite(llm, msg.query, msg.history || [])
        self.postMessage({ id, text })
        return
      }

      if (msg.type === 'classify') {
        const payload = await runClassify(llm, msg.query, msg.history || [])
        self.postMessage({ id, payload })
        return
      }
    } catch (err) {
      postError(id, err, msg.type, false)
    }
  })
}

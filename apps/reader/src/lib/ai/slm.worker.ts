/// <reference lib="webworker" />

import { Wllama } from '@wllama/wllama/esm'

type RewriteHistoryMessage = { role: 'user' | 'assistant'; content: string }

type IntentLabel =
    | 'question'
    | 'explain'
    | 'summarize'
    | 'analyze'
    | 'concept'
    | 'general'

type IntentQuery = { type: IntentLabel; query: string }
type IntentClassification = { intents: IntentQuery[]; primaryQuery: string }

type Inbound =
    | { type: 'rewrite'; id: number; query: string; history: RewriteHistoryMessage[] }
    | { type: 'classify'; id: number; query: string; history: RewriteHistoryMessage[] }
    | { type: 'preload'; id: number }

const DEBUG = process.env.NODE_ENV !== 'production'
const IS_FIREFOX =
    typeof navigator !== 'undefined' && /Firefox/i.test((navigator as any)?.userAgent || '')


// SOTA (2026): Gemma 3 270M Instruct (GGUF) - good quality/size tradeoff.
const DEFAULT_MODEL_URL =
    'https://huggingface.co/unsloth/gemma-3-270m-it-GGUF/resolve/main/gemma-3-270m-it-Q6_K.gguf'

// Cache-buster for local extension assets (workers/wasm). Firefox can keep old
// module-worker code around longer than you'd expect across reloads.
const WLLAMA_ASSET_VERSION = '20260204a'

const MODEL_CTX = 4096
const MAX_HISTORY_TURNS = 4
const MAX_HISTORY_CHARS_PER_TURN = 220

function debugLog(message: string, data?: Record<string, any>) {
    if (!DEBUG) return
    try {
        self.postMessage({ type: 'slm-debug', data: { message, ...(data || {}) } })
    } catch {
        // ignore
    }
}

function postError(id: number | null, err: unknown, stage: string, fatal = false) {
    const message = err instanceof Error ? err.message : String(err)
    const stack = err instanceof Error ? err.stack : undefined
    debugLog('error', { stage, message })
    try {
        self.postMessage({ type: 'slm-error', data: { stage, message, stack }, fatal })
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

let wllama: Wllama | null = null
let loadPromise: Promise<void> | null = null
let useWorkerOverride = false

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
    URL.createObjectURL = (blob: any) => {
        try {
            const blobType = String(blob?.type || '').toLowerCase()
            if (blob instanceof Blob && (blobType.includes('javascript') || blobType === '')) {
                let chosen: string
                try {
                    // Heuristic: OPFS helper code references OPFS APIs; llama worker contains llama.cpp glue.
                    const fr = typeof (self as any).FileReaderSync === 'function' ? new (self as any).FileReaderSync() : null
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
    const canUseMultiThread = typeof (self as any).SharedArrayBuffer !== 'undefined' && (self as any).crossOriginIsolated === true
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
        if (opts.forceWorkerOverride) {
            useWorkerOverride = true
            installWllamaWorkerOverride()
            debugLog('override_enabled', { workerOverride: true })
        }

        const wasmPaths = resolveWasmPaths()
        debugLog('wllama_wasm_paths', wasmPaths as any)
        debugLog('init_start', { model: modelUrl })

        wllama = new Wllama(wasmPaths, {
            allowOffline: true,
            logger: {
                debug: (...args) => debugLog('logger_debug', { args: args.map((a) => String(a)) }),
                log: (...args) => debugLog('logger_log', { args: args.map((a) => String(a)) }),
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
                error: (...args) => debugLog('logger_error', { args: args.map((a) => String(a)) }),
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

    const shouldRetryWithOverride = (err: unknown) => {
        if (useWorkerOverride) return false
        const msg = err instanceof Error ? err.message : String(err || '')
        // We retry only for failures that are commonly caused by MV3 CSP blocking blob workers.
        return (
            msg.includes('Content-Security-Policy') ||
            msg.includes('worker-src') ||
            msg.includes('blob:') ||
            msg.includes('unsafe-eval')
        )
    }

    loadPromise = (async () => {
        try {
            // Firefox MV3 often blocks Blob workers due to CSP.
            // We proactively use the override if we detect Firefox, avoiding the "HEAD only" crash.
            await init({ forceWorkerOverride: IS_FIREFOX })
        } catch (err) {
            // Retry once using the physical-worker override. This keeps us robust across CSP variations.
            if (shouldRetryWithOverride(err)) {
                debugLog('retry_with_override', { reason: 'csp_blob_worker_blocked' })
                wllama = null
                await init({ forceWorkerOverride: true })
            } else {
                throw err
            }
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
        .map((m) => `${m.role.toUpperCase()}: ${compactText(m.content).slice(0, MAX_HISTORY_CHARS_PER_TURN)}`)
        .join('\n')
        .trim()
}

async function runRewrite(llm: Wllama, query: string, history: RewriteHistoryMessage[]): Promise<string> {
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
        }
    )

    return String(out || '').replace(/^["']|["']$/g, '').trim()
}

async function runClassify(llm: Wllama, query: string, history: RewriteHistoryMessage[]): Promise<IntentClassification> {
    const convo = historyToText(history)
    const userMsg = compactText(query)

    const system =
        'You are an intent router for an ebook reader RAG system.\n' +
        'Return ONLY valid JSON (no markdown) with this schema:\n' +
        '{ "primaryQuery": string, "intents": [ { "type": string, "query": string } ] }\n' +
        'Rules:\n' +
        '- Language: keep the SAME language as the user message.\n' +
        '- Multi-intent: include multiple intents if present.\n' +
        '- Allowed types: question, explain, summarize, analyze, concept, general.\n' +
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
        }
    )

    const parsed = safeJsonParse<IntentClassification>(out)
    if (!parsed || !Array.isArray((parsed as any).intents)) {
        // Minimal fallback: treat as a single question.
        return { primaryQuery: userMsg, intents: [{ type: 'question', query: userMsg }] }
    }

    const intents = (parsed.intents || [])
        .map((i: any) => ({
            type: String(i?.type || 'general') as IntentLabel,
            query: String(i?.query || '').trim(),
        }))
        .filter((i: IntentQuery) => i.query.length > 0)

    const primaryQueryRaw = typeof (parsed as any).primaryQuery === 'string' ? String((parsed as any).primaryQuery) : ''
    const primaryQuery = (primaryQueryRaw.trim() || intents[0]?.query || userMsg).trim()

    return { primaryQuery, intents: intents.length ? intents : [{ type: 'question', query: primaryQuery }] }
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
        () => undefined
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
                void ensureLoaded(DEFAULT_MODEL_URL)
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

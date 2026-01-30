/// <reference lib="webworker" />
import { pipeline, env } from '@xenova/transformers'
import type { Voy as VoyType } from 'voy-search'

// SOTA 2026: Worker Configuration
env.allowLocalModels = false
env.useBrowserCache = true

const yieldToWorker = () => new Promise<void>(resolve => setTimeout(resolve, 0))

let embedder: any = null
let voyChunks: VoyType | null = null
let voyChapters: VoyType | null = null
let initialized = false
let cancelled = false
let itemsAdded = 0
let embeddingModel = ''
let hiddenDim = 384
let voyAcceptsTypedArrays = false
const skippedSections: { sectionIndex: number; reason: string }[] = []
let currentLocale = 'en'

/**
 * Message Types for Communication
 */
interface InboundMessage {
    type: 'init' | 'index' | 'finalize' | 'cancel'
    payload?: any
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
    return blocks.flatMap(b => b.match(/[^.!?]+(?:[.!?]+|$)/g)?.map(s => s.trim()) ?? [b]).filter(Boolean)
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
async function initialize(payload: { model: string, locale?: string }) {
    try {
        if (payload.locale) currentLocale = payload.locale

        if (initialized && embeddingModel === payload.model) {
            self.postMessage({ type: 'initialized', payload: { dim: hiddenDim } })
            return
        }

        // Load WASM modules
        const { Voy } = await import('voy-search')

        embedder = await pipeline('feature-extraction', payload.model, { quantized: true })

        // Detect Dimension
        try {
            const out = await embedder("dim_check", { pooling: 'mean', normalize: true })
            hiddenDim = out.data.length
        } catch {
            hiddenDim = 384
        }

        voyChunks = new Voy()
        voyChapters = new Voy()

        // SOTA: Voy Probe (Check for Float32Array support to save allocation)
        try {
            const testVoy = new Voy()
            testVoy.add({
                embeddings: [{ id: "probe", title: "", url: "", embeddings: new Float32Array(hiddenDim) as any }]
            } as any)
            voyAcceptsTypedArrays = true
        } catch (e) {
            voyAcceptsTypedArrays = false
        }

        embeddingModel = payload.model
        initialized = true
        skippedSections.length = 0

        self.postMessage({ type: 'initialized', payload: { dim: hiddenDim } })
    } catch (err: any) {
        const msg = String(err?.message || err)
        self.postMessage({ type: 'error', payload: { reason: `FAILED_INIT: ${msg}` } })
    }
}

/**
 * Optimized Section Processor
 */
async function processSection(bookId: string, markdown: string, metadata: any) {
    if (!initialized || !embedder || !voyChunks || !voyChapters) return

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

            tokenEmbeddings = new Float32Array(numTokens * hiddenDim)
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
                    const seqLen = Math.floor(data.length / hiddenDim)
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

                        const startOff = globalIdx * hiddenDim
                        const winOff = j * hiddenDim

                        for (let d = 0; d < hiddenDim; d++) {
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
                        const off = i * hiddenDim
                        for (let d = 0; d < hiddenDim; d++) tokenEmbeddings[off + d] /= weight
                    }
                }
            } else {
                // Ensure null if failed
                tokenEmbeddings = null
            }
        }

        // Chapter Embedding (v3.9): Mean pooling of all token embeddings (or sentence embeddings for large chapters)
        const sectionSumVec = new Float32Array(hiddenDim)

        if (useLateChunking && tokenEmbeddings) {
            for (let i = 0; i < numTokens; i++) {
                const off = i * hiddenDim
                for (let d = 0; d < hiddenDim; d++) sectionSumVec[d] += tokenEmbeddings[off + d]
            }
            if (numTokens > 0) {
                for (let d = 0; d < hiddenDim; d++) sectionSumVec[d] /= numTokens
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
                sentenceVectors.push(new Float32Array(hiddenDim))
                continue
            }
            currentPos = startIdx + sentence.length

            const vec = new Float32Array(hiddenDim)

            if (useLateChunking && tokenEmbeddings) {
                // SOTA: Late Chunking Mapping (Efficient reuse of token embeddings)
                const charStartRatio = startIdx / markdown.length
                const charEndRatio = (startIdx + sentence.length) / markdown.length
                const tStart = Math.floor(charStartRatio * numTokens)
                const tEnd = Math.ceil(charEndRatio * numTokens)

                let count = 0
                for (let t = tStart; t < tEnd && t < numTokens; t++) {
                    for (let d = 0; d < hiddenDim; d++) vec[d] += tokenEmbeddings[t * hiddenDim + d]
                    count++
                }
                if (count > 0) for (let d = 0; d < hiddenDim; d++) vec[d] /= count
            } else {
                // FALLBACK (v3.9.1): Standard mean pooling for large chapters (RAM Safe)
                const out = await embedder(sentence, { pooling: 'mean', normalize: true })
                vec.set(out.data)

                // Add to section sum for chapter embedding
                for (let d = 0; d < hiddenDim; d++) sectionSumVec[d] += vec[d]
            }

            normalizeInPlace(vec)
            sentenceVectors.push(vec)
        }

        // Finalize Chapter Embedding if it was rolling
        if (!useLateChunking) {
            if (sentences.length > 0) {
                for (let d = 0; d < hiddenDim; d++) sectionSumVec[d] /= sentences.length
            }
        }
        normalizeInPlace(sectionSumVec)

        // Save Chapter Vector
        if (voyChapters) {
            const chapterEmb = voyAcceptsTypedArrays ? new Float32Array(sectionSumVec) : Array.from(sectionSumVec)
            voyChapters.add({
                embeddings: [{
                    id: String(metadata.sectionIndex),
                    title: "",
                    url: "",
                    embeddings: chapterEmb as any
                }]
            } as any)
        }

        const currentChunkVecSum = new Float32Array(hiddenDim)
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

            const embToSend = voyAcceptsTypedArrays ? new Float32Array(currentChunkVecSum) : Array.from(currentChunkVecSum)

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
                const meanVec = new Float32Array(hiddenDim)
                for (let d = 0; d < hiddenDim; d++) {
                    meanVec[d] = currentChunkVecSum[d] / (currentChunkTokenCount || 1)
                }

                // Normalize mean for cosine similarity
                let mag = 0
                for (let d = 0; d < hiddenDim; d++) mag += meanVec[d] * meanVec[d]
                mag = Math.sqrt(mag)
                if (mag > 0) {
                    for (let d = 0; d < hiddenDim; d++) meanVec[d] /= mag
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
            for (let d = 0; d < hiddenDim; d++) currentChunkVecSum[d] += vec[d]
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

/**
 * Worker Listener
 */
self.onmessage = async (e: MessageEvent<InboundMessage>) => {
    const { type, payload } = e.data

    switch (type) {
        case 'init':
            cancelled = false
            itemsAdded = 0
            await initialize(payload)
            break

        case 'index':
            if (cancelled) return
            await processSection(payload.bookId, payload.markdown, payload.metadata)
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
                        dim: hiddenDim,
                        skippedSections
                    }
                })
            }
            break

        case 'cancel':
            cancelled = true
            break
    }
}

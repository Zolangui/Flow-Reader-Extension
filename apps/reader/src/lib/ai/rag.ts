import TurndownService from 'turndown'
import { gfm } from 'turndown-plugin-gfm'
import { v4 as uuidv4 } from 'uuid'
import type { Voy as VoyType } from 'voy-search' // CSP-safe WASM vector engine

// Utility to prevent main thread blocking (UI Freeze)
const yieldToMain = () => new Promise(resolve => requestAnimationFrame(resolve))

import { db, VectorRecord } from '../../db'
import { fileToEpub } from '../../file'

import { AI_CONFIG } from './config'
import { bm25Search, hybridSearch } from './retrieval'

/**
 * Custom error to signal UI when re-indexing is required.
 */
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
    private worker: Worker | null = null

    // SOTA v3.9.1: Optimization Caches
    private static embedderCache: any = null
    private static voyInstances = new Map<string, { chunks: VoyType; chapters?: VoyType }>()
    private static allChunksCache = new Map<string, VectorRecord[]>()
    private static cacheAccessTime = new Map<string, number>()
    private static MAX_BOOKS_IN_RAM = 2

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
            this.worker = new Worker(new URL('./rag.worker.ts', import.meta.url))
        }
        return this.worker
    }

    /**
     * SOTA: Indexing Pipeline (Hybrid Model)
     * 1. Main Thread: Extracts HTML -> Markdown from EPUB (DOM required)
     * 2. Worker: Handles Semantic Chunking, Embeddings, and Voy Indexing (CPU intense)
     */
    async indexBook(file: File, bookId: string, onProgress: (p: number) => void, locale = 'en') {
        const settings = AI_CONFIG
        const worker = this.getWorker()

        // 1. Clear existing index
        await db?.vectors.where('bookId').equals(bookId).delete()
        await db?.indices.where('bookId').equals(bookId).delete()

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

        // Initialize Worker
        worker.postMessage({ type: 'init', payload: { model: settings.embeddingModel, locale } })

        return new Promise<void>((resolve, reject) => {
            const cleanup = () => {
                if (flushTimer) clearTimeout(flushTimer)
                worker.removeEventListener('message', handleMessage)
                // Terminate and nullify to ensure fresh start/GC
                worker.terminate()
                this.worker = null
            }

            const handleMessage = async (e: MessageEvent) => {
                const { type, payload } = e.data

                try {
                    switch (type) {
                        case 'initialized':
                            detectedDim = payload.dim || 384
                            // Start processing first section
                            await this.feedSection(epub, turndown, bookId, worker, processedSpines)
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
                                await this.feedSection(epub, turndown, bookId, worker, processedSpines)
                            } else {
                                await flushRecords() // Final flush before finalize
                                worker.postMessage({ type: 'finalize', payload: { bookId } })
                            }
                            break

                        case 'finalized':
                            // Bulletproof Hardening v3.4: Final Sync Barrier
                            if (flushTimer) { clearTimeout(flushTimer); flushTimer = null }
                            await flushRecords()

                            if (payload.skippedSections?.length > 0) {
                                console.log(`Indexing finished. Skipped ${payload.skippedSections.length} sections:`, payload.skippedSections)
                            }

                            // SOTA v3.9: Dual Indexing (Hierarchical)
                            await db?.indices.put({
                                bookId,
                                kind: 'chunks',
                                model: settings.embeddingModel,
                                data: payload.chunks,
                                dim: payload.dim || detectedDim,
                                version: (AI_CONFIG as any).ragVersion
                            })

                            await db?.indices.put({
                                bookId,
                                kind: 'chapters',
                                model: settings.embeddingModel,
                                data: payload.chapters,
                                dim: payload.dim || detectedDim,
                                version: (AI_CONFIG as any).ragVersion
                            })

                            cleanup()
                            resolve()
                            break

                        case 'error':
                            // v3.4: Only fatal if no sectionIndex (init/finalize failure)
                            if (payload?.sectionIndex === undefined) {
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
                reject(new Error("Worker Error"))
            }
        })
    }

    private async feedSection(epub: any, turndown: TurndownService, bookId: string, worker: Worker, index: number) {
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
                    if (loader) await item.load(loader)
                    else await item.load()
                    loaded = true
                    break
                } catch (err) {
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
            const sectionTitle = item.label || `Section ${index}`

            worker.postMessage({
                type: 'index',
                payload: {
                    bookId,
                    markdown,
                    locale: (AI_CONFIG as any).locale || 'en', // SOTA: Pass current locale for segmentation
                    metadata: { sectionIndex: index, cfi, sectionTitle }
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
    } = {}) {
        const {
            expandContext = true,
            maxChars = 20000,
            useHybrid = true,
            chapterGateTopN = 3,
            softGateOutlierRank = 10,
            disableChapterGate = false
        } = options

        const chunkIndexRecord = await db?.indices.get({ bookId, kind: 'chunks' } as any)
        const chapterIndexRecord = await db?.indices.get({ bookId, kind: 'chapters' } as any)

        const activeIndex = chunkIndexRecord || await db?.indices.get(bookId)
        if (!activeIndex) return []

        // SOTA v3.12: Hard version guard for architecture changes
        if (activeIndex.version && activeIndex.version !== (AI_CONFIG as any).ragVersion) {
            throw new IndexCompatibilityError("RAG architecture mismatch. Re-indexing required.")
        }

        if (activeIndex.model && activeIndex.model !== AI_CONFIG.embeddingModel) {
            throw new IndexCompatibilityError("Embedding model mismatch. Re-indexing required.")
        }
        if (!activeIndex.data) throw new Error("Index data is empty.")

        const { Voy } = await import('voy-search')

        if (!RAGService.embedderCache) {
            const { pipeline } = await import('@xenova/transformers')
            RAGService.embedderCache = await pipeline('feature-extraction', AI_CONFIG.embeddingModel, { quantized: true })
        }
        const embedder = RAGService.embedderCache

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

        // ===== Chapter gating =====
        let allowedSections: Set<number> | null = null
        if (cached.chapters && !disableChapterGate) {
            const output = await embedder(query, { pooling: 'mean', normalize: true })
            const queryVector = (output.data instanceof Float32Array) ? output.data : new Float32Array(output.data as any)
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
            if (allChunks.length === 0) return []
            byIndex = new Map(allChunks.map(c => [c.index, c]))
        }

        // ===== BM25 subset (speed) =====
        const bm25Corpus = (useHybrid && allChunks)
            ? (allowedSections ? allChunks.filter(c => allowedSections!.has(c.metadata?.sectionIndex)) : allChunks)
            : []

        // ===== Vector Search =====
        const out = await embedder(query, { pooling: 'mean', normalize: true })
        const queryVector = (out.data instanceof Float32Array) ? out.data : new Float32Array(out.data as any)

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
            const bm25Results = bm25Search(query, bm25Corpus, topK * 3)
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
        return capped
    }
}

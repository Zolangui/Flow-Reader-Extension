import { useEffect, useRef } from 'react'

import { LLMService } from '../lib/ai/llm'
import { RAGService } from '../lib/ai/rag'
import {
    getRetrievalParams,
    estimateQueryComplexity,
    rerankChunks,
    deduplicateChunks,
    detectReadingIntent,
    autoEscalate,
    buildReadingSystemPrompt,
    buildReadingUserPrompt,
    buildSelectionActionPrompt,
    detectQueryLanguage,
    generateQueryVariations,
    normalizeCitationsToFooter,
} from '../lib/ai/retrieval'
import { preloadStopwords } from '../lib/ai/text'
import { reader } from '../models'
import { useChatbotState, useAISettings } from '../state'

import { useTranslation } from './useTranslation'

// ---- helper: RRF fuse determinístico por índice ----
function rrfFuse(
    lists: Array<{ items: Array<any>; weight: number }>,
    k = 60
): Array<any & { score: number }> {
    const scoreByIdx = new Map<number, number>()
    const itemByIdx = new Map<number, any>()

    for (const { items, weight } of lists) {
        items.forEach((it, i) => {
            const idx = it.index
            const rank = i + 1
            const add = weight * (1 / (k + rank))
            scoreByIdx.set(idx, (scoreByIdx.get(idx) || 0) + add)
            if (!itemByIdx.has(idx)) itemByIdx.set(idx, it)
        })
    }

    return Array.from(itemByIdx.entries())
        .map(([idx, it]) => ({ ...it, score: scoreByIdx.get(idx) || it.score || 0 }))
        .sort((a, b) => (b.score || 0) - (a.score || 0))
}

export function useChatbot() {
    const [state, setState] = useChatbotState()
    const [settings] = useAISettings()
    const t = useTranslation('ai')
    const abortControllerRef = useRef<AbortController | null>(null)
    const inFlightRef = useRef(false)

    // ✅ stateRef para evitar stale history
    const stateRef = useRef(state)
    useEffect(() => {
        stateRef.current = state
    }, [state])

    const stopGeneration = () => {
        if (abortControllerRef.current) {
            abortControllerRef.current.abort()
            abortControllerRef.current = null
        }
        inFlightRef.current = false
        setState(prev => ({ ...prev, isLoading: false }))
    }

    // Restoration Effect
    useEffect(() => {
        const book = reader.focusedBookTab?.book
        if (book?.chatHistory) {
            setState(prev => ({
                ...prev,
                messages: book.chatHistory || []
            }))
        }
    }, [reader.focusedBookTab?.book.id])

    const sendMessage = async (content: string, requestId?: string, options: { deeper?: boolean, action?: 'explain' | 'summarize' } = {}) => {
        if (!content.trim() || inFlightRef.current) return

        stopGeneration()
        inFlightRef.current = true

        const msgId = requestId || Date.now().toString()
        const rid = msgId

        // add user message
        setState(prev => ({
            ...prev,
            isOpen: true,
            messages: [...prev.messages, { role: 'user', content, id: msgId }],
            isLoading: true,
            meta: {
                ...prev.meta,
                lastQuery: content,
                lastWasDeeper: !!options.deeper,
            }
        }))

        const controller = new AbortController()
        abortControllerRef.current = controller

        try {
            const book = reader.focusedBookTab?.book
            if (!book) throw new Error('No active book')

            const isSelectionAction = !!options.action
            const lang = detectQueryLanguage(content)
            await preloadStopwords(lang)

            const intent = isSelectionAction
                ? (options.action === 'explain' ? 'explain' : 'summarize')
                : detectReadingIntent(content)

            const { depth, scope } = isSelectionAction
                ? { depth: 'short' as const, scope: 'book_only' as const }
                : autoEscalate(content, { depth: settings.answerDepth, scope: settings.aiScope })

            const complexity = estimateQueryComplexity(content)
            let retrievalParams = getRetrievalParams(content)

            // Ajuste para deeper e deep mode
            const isDeeper = !!options.deeper
            const isDeepMode = depth === 'deep'

            if (isDeeper) {
                retrievalParams = {
                    ...retrievalParams,
                    topK: retrievalParams.topK * 2,
                    maxChars: Math.min(retrievalParams.maxChars * 1.5, 30000)
                }
            } else if (isDeepMode && complexity !== 'simple') {
                retrievalParams = {
                    ...retrievalParams,
                    topK: Math.min(retrievalParams.topK + 3, 12),
                    maxChars: Math.min(retrievalParams.maxChars + 8000, 30000)
                }
            }

            const rag = RAGService.getInstance()

            // ===== Deterministic multi-query retrieval =====
            const variations = (isDeeper || isDeepMode)
                ? generateQueryVariations(content, lang, intent)
                : []

            const queries = [content, ...variations].slice(0, isDeeper ? 4 : 3)

            // pesos determinísticos: query original > variações
            const weightedLists: Array<{ items: any[]; weight: number }> = []

            // v3.11: Gather User Context
            const annotations = book.annotations.map(a => a.notes).filter(Boolean) as string[]
            const definitions = book.definitions || []

            for (let qi = 0; qi < queries.length; qi++) {
                const q = queries[qi]
                const w = qi === 0 ? 1.0 : 0.65

                const items = await rag.retrieveContext(book.id, q, retrievalParams.topK, {
                    expandContext: retrievalParams.expandContext,
                    maxChars: Math.floor(retrievalParams.maxChars / queries.length),
                    chapterGateTopN: isDeeper ? 8 : 3,
                    softGateOutlierRank: isDeeper ? 30 : 10,
                    disableChapterGate: isDeeper && complexity === 'complex'
                })

                weightedLists.push({ items, weight: w })
            }

            // fuse + rerank + dedupe
            const fused = rrfFuse(weightedLists, 60)
            const reranked = rerankChunks(fused, content, 0.7, lang)
            const dedupedContext = deduplicateChunks(reranked, 0.75)

            const hadContext = dedupedContext.length > 0
            const canSearchDeeper = !isDeeper && dedupedContext.length < 3

            // ✅ Atualiza meta SEM depender do texto do LLM
            setState(prev => ({
                ...prev,
                meta: {
                    ...prev.meta,
                    canSearchDeeper,
                    lastHadContext: hadContext,
                    lastLanguage: lang,
                    lastIntent: intent,
                    lastDepth: depth,
                    lastScope: scope,
                    lastWasDeeper: isDeeper,
                }
            }))

            // ===== Deterministic fallback: book_only + no context => pula LLM =====
            if (!hadContext && scope === 'book_only') {
                const msg = canSearchDeeper
                    ? (t('ai.no_context.can_search_deeper') || "I couldn't find a direct answer in the current excerpts. Would you like me to search deeper in other chapters?")
                    : (t('ai.no_context.final') || "I couldn't find a direct answer in the book for this question.")

                setState(prev => ({
                    ...prev,
                    messages: [...prev.messages, { role: 'assistant', content: msg, id: Date.now().toString() }],
                    isLoading: false
                }))
                abortControllerRef.current = null
                return
            }

            // build prompts
            const selectionPrompts = options.action
                ? buildSelectionActionPrompt(options.action, content, dedupedContext.map(c => c.content).join('\n'), lang)
                : null

            const systemPrompt = selectionPrompts
                ? selectionPrompts.system
                : buildReadingSystemPrompt(intent, {
                    depth,
                    scope,
                    persona: settings.autoPersona ? book.aiPersona : undefined,
                    customPrompt: settings.systemPrompt,
                    bookSubject: book.metadata?.subject
                })

            const userPrompt = selectionPrompts
                ? selectionPrompts.user
                : buildReadingUserPrompt(
                    content,
                    dedupedContext,
                    intent,
                    depth,
                    lang,
                    canSearchDeeper,
                    { annotations, definitions }
                )

            const needsKey = !['local', 'custom'].includes(settings.provider)
            if (needsKey && !settings.apiKey) throw new Error(`API Key required for ${settings.provider}.`)

            // ✅ history sem stale (usa stateRef)
            const history = stateRef.current.messages.map(m => ({
                role: m.role,
                content: m.content
            }))

            const llm = new LLMService(settings)
            const stream = llm.streamResponse(systemPrompt, userPrompt, controller.signal, history)

            let fullResponse = ''
            for await (const chunk of stream) {
                if (controller.signal.aborted) break
                fullResponse += chunk

                // opcional: scrub durante stream para não “piscar” inline citations
                const display = normalizeCitationsToFooter(fullResponse)

                window.dispatchEvent(new CustomEvent('chatbot-stream', {
                    detail: { requestId: rid, fullResponse: display }
                }))
            }

            // finalize + scrub final
            const final = normalizeCitationsToFooter(fullResponse)

            setState(prev => {
                const nextMessages = [...prev.messages, { role: 'assistant' as const, content: final, id: Date.now().toString() }]
                // v3.12: Persist for Sync using the full updated history
                const bookTab = reader.focusedBookTab
                if (bookTab) {
                    bookTab.updateBook({ chatHistory: nextMessages })
                }
                return { ...prev, messages: nextMessages, isLoading: false }
            })

            abortControllerRef.current = null

        } catch (e: any) {
            if (e.name === 'AbortError') return

            let message = `Error: ${e.message}`
            if (e.name === 'IndexCompatibilityError') {
                message = "🚨 **Index Compatibility Issue:** The AI model or embedding settings have changed. To ensure accurate context retrieval, please go to **Settings > General** and click **Re-index Book**."
            }

            setState(prev => ({
                ...prev,
                messages: [...prev.messages, { role: 'assistant', content: message, id: Date.now().toString() }],
                isLoading: false
            }))
        } finally {
            inFlightRef.current = false
            abortControllerRef.current = null
        }
    }

    return { state, sendMessage, stopGeneration }
}

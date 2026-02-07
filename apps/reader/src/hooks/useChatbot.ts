import { useEffect, useRef } from 'react'

import { db, type ChatMessageRecord, type ChatSessionRecord } from '../db'
import { detectQueryLanguage, normalizeLangForRAG } from '../lib/ai/language'
import { LLMService } from '../lib/ai/llm'
import { RAGService } from '../lib/ai/rag'
import {
    getRetrievalParamsForReading,
    rerankChunks,
    deduplicateChunks,
    buildReadingSystemPrompt,
    buildReadingUserPrompt,
    buildSelectionActionPrompt,
    normalizeCitationsToFooter,
    type ReadingIntent,
} from '../lib/ai/retrieval'
import { classifyQueryForRetrieval, type IntentLabel } from '../lib/ai/rewriter'
import { preloadStopwords } from '../lib/ai/text'
import { reader } from '../models'
import { useChatbotState, useAISettings, useSettings } from '../state'

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
    const [appSettings] = useSettings()
    const t = useTranslation('ai')
    const abortControllerRef = useRef<AbortController | null>(null)
    const inFlightRef = useRef(false)

    // ✅ stateRef para evitar stale history
    const stateRef = useRef(state)
    useEffect(() => {
        stateRef.current = state
    }, [state])

    const genChatId = () => {
        if (typeof crypto !== 'undefined' && (crypto as any).randomUUID) {
            return (crypto as any).randomUUID()
        }
        return Date.now().toString()
    }

    const deriveChatTitle = (messages: ChatMessageRecord[], existing?: string) => {
        if (existing && existing.trim().length > 0) return existing
        const firstUser = messages.find(m => m.role === 'user' && m.content.trim())
        if (!firstUser) return undefined
        return firstUser.content.trim().slice(0, 60)
    }

    const createChatSession = (messages: ChatMessageRecord[] = []): ChatSessionRecord => {
        const now = Date.now()
        return {
            id: genChatId(),
            title: deriveChatTitle(messages),
            messages,
            createdAt: now,
            updatedAt: now
        }
    }

    const applyChatToState = (messages: ChatMessageRecord[]) => {
        const lastUser = [...messages].reverse().find(m => m.role === 'user')
        setState(prev => ({
            ...prev,
            messages,
            isLoading: false,
            meta: {
                ...prev.meta,
                lastQuery: lastUser?.content || '',
                lastEffectiveQuery: lastUser?.content || '',
                canSearchDeeper: false,
                lastHadContext: messages.length > 0,
                lastWasDeeper: false
            }
        }))
    }

    const persistSessions = (sessions: ChatSessionRecord[], activeChatId: string, messages?: ChatMessageRecord[]) => {
        const bookTab = reader.focusedBookTab
        if (!bookTab) return
        const active = sessions.find(s => s.id === activeChatId)
        bookTab.updateBook({
            chatSessions: sessions,
            activeChatId,
            chatHistory: messages ?? active?.messages ?? []
        })
    }

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
        const bookTab = reader.focusedBookTab
        const book = bookTab?.book
        if (!bookTab || !book) return

        let sessions = Array.isArray(book.chatSessions) ? [...book.chatSessions] : []
        let activeChatId = book.activeChatId

        if (sessions.length === 0) {
            const legacyMessages = Array.isArray(book.chatHistory) ? book.chatHistory : []
            const seed = createChatSession(legacyMessages)
            sessions = [seed]
            activeChatId = seed.id
            persistSessions(sessions, activeChatId, seed.messages)
        } else if (!activeChatId || !sessions.some(s => s.id === activeChatId)) {
            activeChatId = sessions[0].id
            persistSessions(sessions, activeChatId, sessions[0].messages)
        }

        const activeSession = sessions.find(s => s.id === activeChatId)
        applyChatToState(activeSession?.messages || [])
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [reader.focusedBookTab?.book.id])

    const sendMessage = async (
        content: string,
        requestId?: string,
        options: { deeper?: boolean; action?: 'explain' | 'summarize'; skipUserMessage?: boolean } = {}
    ) => {
        if (!content.trim() || inFlightRef.current) return

        stopGeneration()
        inFlightRef.current = true

        const msgId = requestId || Date.now().toString()
        const rid = msgId

        // add user message
        setState(prev => ({
            ...prev,
            isOpen: true,
            messages: options.skipUserMessage
                ? prev.messages
                : [...prev.messages, { role: 'user', content, id: msgId }],
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
            const fallbackLang = normalizeLangForRAG(
                book.metadata?.language,
                appSettings.locale || 'en'
            )
            const lang = await detectQueryLanguage(content, fallbackLang)
            await preloadStopwords(lang)

            const { depth, scope } = isSelectionAction
                ? { depth: 'short' as const, scope: 'book_only' as const }
                : { depth: settings.answerDepth, scope: settings.aiScope }

            let classifiedIntents: { type: IntentLabel; query: string }[] = []

            const baseQuery = options.deeper
                ? (stateRef.current.meta?.lastEffectiveQuery || content)
                : content

            let effectiveQuery = baseQuery
            // SOTA: let the (local) SLM classify *every* user message (including the first turn),
            // and only fall back when SLM is unavailable.
            //
            // We intentionally skip classification on explicit "search deeper" actions to avoid extra latency.
            let intent: ReadingIntent = isSelectionAction
                ? (options.action === 'explain' ? 'explain' : 'summarize')
                : ((stateRef.current.meta?.lastIntent as ReadingIntent | undefined) || 'general')

            if (!options.deeper && !isSelectionAction) {
                const classification = await classifyQueryForRetrieval(baseQuery, stateRef.current.messages)
                if (classification?.intents?.length) {
                    classifiedIntents = classification.intents
                    effectiveQuery = classification.primaryQuery || baseQuery
                    intent = (classifiedIntents[0]?.type as ReadingIntent) || 'general'
                } else {
                    // Keep a single, explicit intent to reduce branching downstream.
                    classifiedIntents = [{ type: 'general', query: baseQuery }]
                }
                if (process.env.NODE_ENV === 'development') {
                    console.log('[RAG Intent Debug] input', baseQuery)
                    console.log('[RAG Intent Debug] classification', classification)
                }
            }

            // SOTA: retrieval params are intent/depth-driven (LLM-routed), not regex-driven.
            const isDeeper = !!options.deeper
            const retrievalParams = getRetrievalParamsForReading(intent, depth, {
                isDeeper,
                multiIntentCount: classifiedIntents.length || 1,
            })

            const rag = RAGService.getInstance()

            // ===== Deterministic multi-query retrieval =====
            const extraQueries = classifiedIntents
                .map(i => i.query)
                .filter(q => q && q !== effectiveQuery)

            const mergedQueries = [effectiveQuery, ...extraQueries]
            const uniqueQueries: string[] = []
            for (const q of mergedQueries) {
                const trimmed = q.trim()
                if (!trimmed) continue
                if (!uniqueQueries.some(existing => existing.toLowerCase() === trimmed.toLowerCase())) {
                    uniqueQueries.push(trimmed)
                }
            }

            const queries = uniqueQueries.slice(0, isDeeper ? 5 : 4)
            if (process.env.NODE_ENV === 'development') {
                console.log('[RAG Intent Debug] effectiveQuery', effectiveQuery)
                console.log('[RAG Intent Debug] queries', queries)
            }

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
                    // SOTA: avoid regex "complexity" routing; only relax chapter gate on explicit deep follow-ups.
                    disableChapterGate: isDeeper && depth === 'deep',
                    locale: lang
                })

                weightedLists.push({ items, weight: w })
            }

            // fuse + rerank + dedupe
            const fused = rrfFuse(weightedLists, 60)
            const reranked = rerankChunks(fused, effectiveQuery, 0.7, lang)
            const dedupedContext = deduplicateChunks(reranked, 0.75, lang)

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
                    lastEffectiveQuery: effectiveQuery,
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

            const multiIntentMode = classifiedIntents.length > 1 && !isSelectionAction
            const promptIntent = multiIntentMode ? 'general' : intent

            let systemPrompt = selectionPrompts
                ? selectionPrompts.system
                : buildReadingSystemPrompt(promptIntent as any, {
                    depth,
                    scope,
                    persona: settings.autoPersona ? book.aiPersona : undefined,
                    customPrompt: settings.systemPrompt,
                    bookSubject: book.metadata?.subject
                })

            if (multiIntentMode) {
                const order = classifiedIntents.map(i => i.type).join(', ')
                systemPrompt += `\n\nMulti-task request detected. Respond with separate sections in this order: ${order}. Use short headings in the user's language.`
            }

            let userPrompt = selectionPrompts
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

            if (multiIntentMode) {
                const intentLine = classifiedIntents.map(i => `${i.type}: ${i.query}`).join(' | ')
                userPrompt = `User intents: ${intentLine}\n\n${userPrompt}`
            }

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
                const bookTab = reader.focusedBookTab
                if (bookTab) {
                    const book = bookTab.book
                    const sessions = Array.isArray(book.chatSessions) ? [...book.chatSessions] : []
                    let activeChatId = book.activeChatId

                    if (!activeChatId && sessions.length > 0) activeChatId = sessions[0].id
                    if (!activeChatId) {
                        const seed = createChatSession([])
                        sessions.push(seed)
                        activeChatId = seed.id
                    }

                    const idx = sessions.findIndex(s => s.id === activeChatId)
                    const updatedSession: ChatSessionRecord = {
                        ...(idx >= 0 ? sessions[idx] : createChatSession([])),
                        id: activeChatId,
                        messages: nextMessages,
                        updatedAt: Date.now(),
                        title: deriveChatTitle(nextMessages, idx >= 0 ? sessions[idx].title : undefined)
                    }

                    if (idx >= 0) sessions[idx] = updatedSession
                    else sessions.push(updatedSession)

                    persistSessions(sessions, activeChatId, nextMessages)
                }
                return { ...prev, messages: nextMessages, isLoading: false }
            })

            abortControllerRef.current = null

        } catch (e: any) {
            if (e.name === 'AbortError') return

            let message = `Error: ${e.message}`

            // Handle I18N Errors from LLMService
            if (typeof e.message === 'string' && e.message.startsWith('I18N_ERR:')) {
                const parts = e.message.split(':')
                const key = parts[1]
                const val = parts[2]
                if (key === 'circuit_breaker') {
                    message = t('error.circuit_breaker', { seconds: val })
                } else if (key === 'rate_limit') {
                    message = t('error.rate_limit', { reason: val })
                } else {
                    message = t(`error.${key}`)
                }
            } else if (e.name === 'IndexCompatibilityError') {
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

    const clearChat = async () => {
        stopGeneration()
        setState(prev => ({
            ...prev,
            messages: [],
            meta: {
                ...prev.meta,
                lastQuery: '',
                lastWasDeeper: false,
                canSearchDeeper: false,
                lastHadContext: false,
                lastEffectiveQuery: ''
            }
        }))
        const bookTab = reader.focusedBookTab
        const book = bookTab?.book
        if (bookTab && book) {
            const sessions = Array.isArray(book.chatSessions) ? [...book.chatSessions] : []
            let activeChatId = book.activeChatId
            if (!activeChatId && sessions.length > 0) activeChatId = sessions[0].id
            if (activeChatId) {
                const idx = sessions.findIndex(s => s.id === activeChatId)
                if (idx >= 0) {
                    sessions[idx] = {
                        ...sessions[idx],
                        messages: [],
                        updatedAt: Date.now()
                    }
                    persistSessions(sessions, activeChatId, [])
                } else {
                    persistSessions(sessions, activeChatId, [])
                }
            } else {
                await db?.books.update(book.id, { chatHistory: [] })
            }
        }
    }

    const startNewChat = () => {
        stopGeneration()
        const bookTab = reader.focusedBookTab
        const book = bookTab?.book
        if (!bookTab || !book) return

        const sessions = Array.isArray(book.chatSessions) ? [...book.chatSessions] : []
        const next = createChatSession([])
        sessions.push(next)
        persistSessions(sessions, next.id, [])
        applyChatToState([])
    }

    const deleteCurrentChat = () => {
        stopGeneration()
        const bookTab = reader.focusedBookTab
        const book = bookTab?.book
        if (!bookTab || !book) return

        let sessions = Array.isArray(book.chatSessions) ? [...book.chatSessions] : []
        if (sessions.length === 0) {
            const seed = createChatSession([])
            sessions = [seed]
            persistSessions(sessions, seed.id, [])
            applyChatToState([])
            return
        }

        const activeChatId = book.activeChatId || sessions[0].id
        sessions = sessions.filter(s => s.id !== activeChatId)

        if (sessions.length === 0) {
            const seed = createChatSession([])
            sessions = [seed]
            persistSessions(sessions, seed.id, [])
            applyChatToState([])
            return
        }

        const nextActive = sessions[sessions.length - 1]
        persistSessions(sessions, nextActive.id, nextActive.messages)
        applyChatToState(nextActive.messages || [])
    }

    const setActiveChat = (chatId: string) => {
        stopGeneration()
        const bookTab = reader.focusedBookTab
        const book = bookTab?.book
        if (!bookTab || !book) return

        const sessions = Array.isArray(book.chatSessions) ? [...book.chatSessions] : []
        const target = sessions.find(s => s.id === chatId)
        if (!target) return
        persistSessions(sessions, chatId, target.messages || [])
        applyChatToState(target.messages || [])
    }

    return {
        state,
        sendMessage,
        stopGeneration,
        clearChat,
        startNewChat,
        deleteCurrentChat,
        setActiveChat,
        isOpen: state.isOpen,
        setOpen: (isOpen: boolean) => setState(prev => ({ ...prev, isOpen })),
    }
}

import clsx from 'clsx'
import { useLiveQuery } from 'dexie-react-hooks'
import React, { useEffect, useRef, useState } from 'react'
import { MdSend, MdSettings, MdSmartToy, MdStop, MdSearch, MdDelete, MdFlashOn, MdInfoOutline, MdAdd, MdStorage, MdTranslate } from 'react-icons/md'


import { db } from '../db'
import { useChatbot } from '../hooks'
import { useTranslation } from '../hooks/useTranslation'
import { getFastTextStatus, langLabel, normalizeLangForRAG, preloadFastText } from '../lib/ai/language'
import { LLMService } from '../lib/ai/llm'
import { RAGService } from '../lib/ai/rag'
import { getSlmStatus, getSlmWarning, preloadSlm } from '../lib/ai/rewriter'
import { reader, useReaderSnapshot } from '../models'
import { useAISettings } from '../state'

import { AISettingsPanel } from './AISettingsPanel'
import { IconButton } from './Button'
import { ChatMessage } from './ChatMessage'
import { StatusIndicator } from './StatusIndicator'
import { LumenSparkleIcon } from './icons/ProviderIcons'

export const ChatbotSidebar: React.FC<{ className?: string }> = ({ className }) => {
    const readerSnap = useReaderSnapshot()
    const { state, sendMessage, stopGeneration, startNewChat, deleteCurrentChat, setActiveChat } = useChatbot()
    const [settings] = useAISettings()
    const [input, setInput] = useState('')
    const t = useTranslation('ai')
    const msgsRef = useRef<HTMLDivElement>(null)
    const hasApiKey = React.useMemo(() => {
        const apiKey = settings.apiKey.trim()
        const baseUrl = settings.baseUrl?.trim() || ''
        if (settings.provider === 'local') return baseUrl.length > 0
        if (settings.provider === 'custom') return baseUrl.length > 0 && apiKey.length > 0
        return apiKey.length > 0
    }, [settings.apiKey, settings.baseUrl, settings.provider])
    const [showSettings, setShowSettings] = useState(false)
    const [forceSetup, setForceSetup] = useState(!hasApiKey)
    const [streamingContent, setStreamingContent] = useState('')
    const [activeRequestId, setActiveRequestId] = useState<string>('')
    const lastInsightAt = useRef<Record<string, number>>({})
    const [isIndexing, setIsIndexing] = useState(false)
    const [indexProgress, setIndexProgress] = useState(0)
    const [slmStatus, setSlmStatus] = useState<ReturnType<typeof getSlmStatus>>(getSlmStatus())
    const [slmError, setSlmError] = useState<string | null>(null)
    const [slmWarning, setSlmWarning] = useState<string | null>(getSlmWarning())
    const [embeddingStatus, setEmbeddingStatus] = useState<ReturnType<typeof RAGService.getEmbeddingStatus>>(RAGService.getEmbeddingStatus())
    const [embeddingError, setEmbeddingError] = useState<string | null>(null)
    const [embeddingWarning, setEmbeddingWarning] = useState<string | null>(RAGService.getEmbeddingWarning())
    const [fastTextStatus, setFastTextStatus] = useState<ReturnType<typeof getFastTextStatus>>(getFastTextStatus())
    const [fastTextError, setFastTextError] = useState<string | null>(null)
    const chatSessions = readerSnap.focusedBookTab?.book.chatSessions || []
    const activeChatId = readerSnap.focusedBookTab?.book.activeChatId || chatSessions[0]?.id
    const statusText = {
        ready: t('status.ready'),
        warning: t('status.warning'),
        downloading: t('status.downloading'),
        error: t('status.error'),
        clickToDownload: t('status.click_to_download'),
    }
    const formatChatLabel = (session: any, index: number) => {
        const title = (session?.title || '').trim()
        return title || `Chat ${index + 1}`
    }

    useEffect(() => {
        setForceSetup(!hasApiKey)
    }, [hasApiKey])

    useEffect(() => {
        const handler = (e: any) => {
            const next = e?.detail?.status
            if (next === 'unknown' || next === 'downloading' || next === 'ready' || next === 'warning' || next === 'error') {
                setSlmStatus(next)
            }
            const warning = e?.detail?.warning
            if (typeof warning === 'string') {
                setSlmWarning(warning)
            } else if (warning === null) {
                setSlmWarning(null)
            }
        }
        const errorHandler = (e: any) => {
            const message = e?.detail?.message
            if (typeof message === 'string' && message.length > 0) {
                setSlmError(message)
            }
        }
        const debugHandler = (e: any) => {
            console.log('[SLM Debug]', e?.detail)
        }
        window.addEventListener('slm-status', handler)
        window.addEventListener('slm-error', errorHandler)
        window.addEventListener('slm-debug', debugHandler)
        return () => {
            window.removeEventListener('slm-status', handler)
            window.removeEventListener('slm-error', errorHandler)
            window.removeEventListener('slm-debug', debugHandler)
        }
    }, [])

    useEffect(() => {
        const handler = (e: any) => {
            const next = e?.detail?.status
            if (next === 'unknown' || next === 'downloading' || next === 'ready' || next === 'warning' || next === 'error') {
                setEmbeddingStatus(next)
            }
            const warning = e?.detail?.warning
            if (typeof warning === 'string') {
                setEmbeddingWarning(warning)
            } else if (warning === null) {
                setEmbeddingWarning(null)
            }
        }
        const errorHandler = (e: any) => {
            const message = e?.detail?.message
            if (typeof message === 'string' && message.length > 0) {
                setEmbeddingError(message)
            }
        }
        const debugHandler = (e: any) => {
            console.log('[Embedding Debug]', e?.detail)
        }
        window.addEventListener('embedding-status', handler)
        window.addEventListener('embedding-error', errorHandler)
        window.addEventListener('embedding-debug', debugHandler)
        return () => {
            window.removeEventListener('embedding-status', handler)
            window.removeEventListener('embedding-error', errorHandler)
            window.removeEventListener('embedding-debug', debugHandler)
        }
    }, [])

    useEffect(() => {
        const handler = (e: any) => {
            const next = e?.detail?.status
            if (next === 'unknown' || next === 'downloading' || next === 'ready' || next === 'error') {
                setFastTextStatus(next)
            }
        }
        const errorHandler = (e: any) => {
            const message = e?.detail?.message
            if (typeof message === 'string' && message.length > 0) {
                setFastTextError(message)
            }
        }
        const debugHandler = (e: any) => {
            console.log('[FastText Debug]', e?.detail)
        }
        window.addEventListener('fasttext-status', handler)
        window.addEventListener('fasttext-error', errorHandler)
        window.addEventListener('fasttext-debug', debugHandler)
        return () => {
            window.removeEventListener('fasttext-status', handler)
            window.removeEventListener('fasttext-error', errorHandler)
            window.removeEventListener('fasttext-debug', debugHandler)
        }
    }, [])

    const currentBook = readerSnap.focusedBookTab?.book
    const isIndexed = useLiveQuery(async () => {
        if (!currentBook) return false
        try {
            // SOTA v6.3: Try new compound index first
            const idx = await db?.indices.where('[bookId+kind]').equals([currentBook.id, 'chunks']).first()
            return !!idx
        } catch (e: any) {
            // Fallback: Legacy schema support (SchemaError prevention)
            const errName = e?.name || e?._e?.name
            if (errName === 'SchemaError' || errName === 'DataError') {
                const idx = await db?.indices.get(currentBook.id as any)
                return !!idx
            }
            return false
        }
    }, [currentBook?.id])

    const [suggestedQuestions, setSuggestedQuestions] = useState<string[]>([])

    const scrollToBottom = () => {
        if (msgsRef.current) {
            msgsRef.current.scrollTop = msgsRef.current.scrollHeight
        }
    }

    // AUTO-PERSONA: Classify book once
    useEffect(() => {
        const classify = async () => {
            const focusedItem = reader.focusedBookTab
            if (!focusedItem || !settings.autoPersona) return

            const book = focusedItem.book
            if (book.aiPersona) return // Already classified

            try {
                const llm = new LLMService(settings)
                const persona = await llm.classifyBook(book.metadata)
                await db?.books.update(book.id, { aiPersona: persona })
            } catch (e) {
                console.error('Failed to auto-classify:', e)
            }
        }
        classify()
    }, [readerSnap.focusedBookTab?.book.id, settings.autoPersona, settings])

    // INSIGHT TRIGGERS: Generate suggestions when reading
    useEffect(() => {
        if (!settings.insightTriggers || !reader.focusedBookTab) return

        const timer = setTimeout(async () => {
            // Only if user is idle on a page/location
            try {
                const bookId = reader.focusedBookTab?.book.id
                if (!bookId) return

                // cooldown: 10 minutes per book
                const now = Date.now()
                if (lastInsightAt.current[bookId] && now - lastInsightAt.current[bookId] < 10 * 60_000) return

                lastInsightAt.current[bookId] = now

                const rag = RAGService.getInstance()
                const bookLang = normalizeLangForRAG(reader.focusedBookTab?.book.metadata.language, 'en')
                // Retrieve some context based on current location (simulated)
                // Patch: Explicit character budget for insight triggers (8k chars)
                const context = await rag.retrieveContext(bookId, "important themes", 6, {
                    expandContext: true,
                    maxChars: 8000,
                    locale: bookLang
                })

                const text = context.map(c => c.content).join('\n')

                const llm = new LLMService(settings)
                const langName = langLabel(reader.focusedBookTab?.book.metadata.language || 'en')
                const response = await llm.generateResponse(
                    `You are a helpful reading assistant. Generate 3 short, intriguing questions (max 10 words each) the reader could ask about this text. Return them as a JSON array of strings. Language: Respond in ${langName}.`,
                    `Text: ${text}`
                )

                try {
                    const questions = JSON.parse(response.match(/\[.*\]/s)?.[0] || '[]')
                    setSuggestedQuestions(questions.slice(0, 3))
                } catch {
                    setSuggestedQuestions([])
                }
            } catch (e) {
                console.error('Insight Trigger Error:', e)
            }
        }, 15000) // 15s debounce

        return () => clearTimeout(timer)
    }, [readerSnap.focusedBookTab?.book.id, settings.insightTriggers, settings])

    useEffect(() => {
        scrollToBottom()
    }, [state.messages, streamingContent])

    // Stream & Navigation Listeners
    useEffect(() => {
        const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

        const normHref = (h: string) =>
            (h || "").replace(/^(\.\/)+/, "").replace(/^\/+/, "");

        const normCfi = (cfi: string) => {
            if (!cfi) return "";
            if (cfi.startsWith("epubcfi(")) return cfi;
            if (cfi.startsWith("/")) return `epubcfi(${cfi})`;
            return cfi;
        };

        const resolveSpineHref = (tab: any, href: string) => {
            const spineItems =
                (tab?.book?.spine as any)?.spineItems ||
                (tab?.book?.spine as any)?.items ||
                [];
            const target = normHref(href);

            const hit = spineItems.find((s: any) => {
                const sh = normHref(s?.href);
                return sh === target || sh.endsWith(target) || target.endsWith(sh);
            });

            return hit?.href || href;
        };

        const displaySafe = async (tab: any, target: any) => {
            for (let i = 0; i < 10; i++) {
                if (tab?.rendition) break;
                await sleep(50);
            }

            const fn = tab?.display ? tab.display.bind(tab) : tab?.rendition?.display?.bind(tab.rendition);
            if (!fn) throw new Error("No display() available");

            return await fn(target);
        };

        const handleStream = (e: any) => {
            if (e.detail.requestId === activeRequestId) {
                setStreamingContent(e.detail.fullResponse)
            }
        }

        const handleNavigate = (e: any) => {
            void (async () => {
                try {
                    console.trace("[Citation Trace] handleNavigate Start");
                    const citation = e.detail.citation;
                    console.log("[Citation Trace] Payload:", citation);

                    const match = citation?.match(/S(\d+):C(\d+)/);
                    console.log("[Citation Trace] Match Result:", match);

                    const tab = reader.focusedBookTab;
                    console.log("[Citation Trace] Active Tab:", tab?.id, !!tab?.rendition);

                    if (!match || !tab) {
                        console.warn("[Citation Trace] Match or Tab missing. Aborting.");
                        return;
                    }

                    const bookId = tab.book?.id;
                    if (!bookId) return;

                    const sectionIndex = Number(match[1]);
                    const chunkIndex = Number(match[2]);
                    console.log("[Citation Trace] Indices:", { sectionIndex, chunkIndex });

                    let chunk: any = null;
                    try {
                        if (!Number.isNaN(chunkIndex)) {
                            chunk = await db.vectors
                                .where("[bookId+index]")
                                .equals([bookId, chunkIndex])
                                .first();
                            console.log("[Citation Trace] Chunk found:", !!chunk, chunk?.metadata?.cfi);
                        }
                    } catch (err) {
                        console.warn("[Citation] DB lookup failed:", err);
                    }

                    // 1. Try CFI
                    const cfi = normCfi(chunk?.metadata?.cfi || "");
                    if (cfi) {
                        try {
                            await displaySafe(tab, cfi);
                            window.dispatchEvent(
                                new CustomEvent("reader-highlight-chunk", {
                                    detail: { cfi, content: chunk?.content },
                                }),
                            );
                            return;
                        } catch (err) {
                            console.warn("[Citation] CFI navigation failed:", err);
                        }
                    }

                    // 2. Try metadata.href
                    const hrefRaw = chunk?.metadata?.href || "";
                    if (hrefRaw) {
                        const href = resolveSpineHref(tab, hrefRaw);
                        try {
                            await displaySafe(tab, href);
                            return;
                        } catch (err) {
                            console.warn("[Citation] Href navigation failed:", err);
                        }
                    }

                    // 3. Try sectionIndex with spine href
                    const spineItems =
                        ((tab?.book as any)?.spine as any)?.spineItems ||
                        ((tab?.book as any)?.spine as any)?.items ||
                        [];

                    if (Number.isFinite(sectionIndex) && spineItems.length) {
                        let idx = sectionIndex;
                        if (idx >= spineItems.length && idx - 1 >= 0 && idx - 1 < spineItems.length) {
                            idx = idx - 1;
                        }
                        const spineHref = spineItems[idx]?.href;
                        if (spineHref) {
                            try {
                                await displaySafe(tab, spineHref);
                                return;
                            } catch (err) {
                                console.warn("[Citation] Spine href navigation failed:", err);
                            }
                        }

                        // 4. Fallback to index (NUMBER)
                        try {
                            await displaySafe(tab, idx);
                            return;
                        } catch (err) {
                            console.error("[Citation] display(index) failed:", err);
                        }
                    }
                } catch (err) {
                    console.error("[Citation] Navigation handler crashed:", err);
                }
            })();
        };

        window.addEventListener('chatbot-stream', handleStream)
        window.addEventListener('reader-navigate-citation', handleNavigate)
        return () => {
            window.removeEventListener('chatbot-stream', handleStream)
            window.removeEventListener('reader-navigate-citation', handleNavigate)
        }
    }, [activeRequestId])

    // Clear streaming content when loading stops
    useEffect(() => {
        if (!state.isLoading) {
            setStreamingContent('')
        }
    }, [state.isLoading])

    const handleSend = () => {
        if (!input.trim() || state.isLoading) return
        const rid = Date.now().toString()
        setActiveRequestId(rid)
        sendMessage(input, rid)
        setInput('')
    }

    const handleReindex = async () => {
        if (!currentBook || isIndexing) return
        const fileRecord = await db?.files.get(currentBook.id)
        if (!fileRecord) return

        setIsIndexing(true)
        setIndexProgress(0)
        try {
            const bookLang = normalizeLangForRAG(currentBook.metadata.language, 'en')
            await RAGService.getInstance().indexBook(fileRecord.file, currentBook.id, (p) => setIndexProgress(p), bookLang)
        } catch (e) {
            console.error('Indexing failed:', e)
        } finally {
            setIsIndexing(false)
        }
    }

    const handleSearchDeeper = () => {
        const lastMsg = state.messages.filter(m => m.role === 'user').pop()
        if (!lastMsg || state.isLoading) return

        const rid = Date.now().toString()
        setActiveRequestId(rid)
        sendMessage(lastMsg.content, rid, { deeper: true, skipUserMessage: true })
    }

    const showDeeperButton =
        !state.isLoading &&
        !!state.meta?.canSearchDeeper &&
        state.messages.length > 0 &&
        state.messages[state.messages.length - 1].role === 'assistant'

    const deeperLabel = t('chatbot.search_deeper')


    if (forceSetup) {
        return (
            <div className={clsx('flex h-full flex-col bg-surface-1 border-l border-border-light dark:border-border-dark', className)}>
                <div className="flex-1 flex flex-col items-center justify-center p-8 text-center space-y-6 animate-in fade-in zoom-in duration-500">
                    <div className="w-20 h-20 bg-primary/10 rounded-3xl flex items-center justify-center text-primary shadow-inner">
                        <MdSmartToy size={48} />
                    </div>
                    <div>
                        <h2 className="text-2xl font-bold tracking-tight">{t('chatbot.welcome_title')}</h2>
                        <p className="text-sm text-subtle mt-2 leading-relaxed">
                            {t('chatbot.welcome_desc')}
                        </p>
                    </div>

                    <div className="w-full pt-4">
                        <AISettingsPanel
                            onClose={() => setForceSetup(false)}
                            isSetup={true}
                            className="rounded-2xl border border-border-light dark:border-border-dark shadow-2xl overflow-hidden max-h-[500px]"
                        />
                    </div>

                    <p className="text-[10px] text-subtle opacity-50 uppercase tracking-widest font-bold">
                        {t('chatbot.footer')}
                    </p>
                </div>
            </div>
        )
    }

    return (
        <div className={clsx('flex h-full flex-col bg-surface-2 !bg-opacity-100 border-l border-border-light dark:border-border-dark relative', className)}>
            {/* Header */}
            <div className="flex items-center justify-between border-b border-border-light dark:border-border-dark p-4 bg-surface-1 !bg-opacity-100 z-10 sticky top-0 shadow-sm">
                <h2 className="flex items-center gap-2 font-medium">
                    <MdSmartToy /> {t('title')}
                    <span className="text-[10px] text-primary font-bold ml-2 px-2 py-0.5 rounded-full bg-primary/10 uppercase tracking-wider border border-primary/10 shadow-sm">
                        {(settings.model || '').split('/').pop()?.replace('models/', '')}
                    </span>
                </h2>
                <div className="flex items-center gap-1.5 ml-2">
                    {/* Status Indicators & Download Triggers */}
                        <StatusIndicator
                            label="SLM"
                            status={slmStatus}
                            onClick={preloadSlm}
                            icon={<MdSmartToy className="text-[10px]" />}
                            tooltip={t('slm_tooltip')}
                            statusText={statusText}
                            errorMessage={slmError}
                            warningMessage={
                                slmWarning === 'single_thread'
                                    ? t('status.single_thread')
                                    : slmWarning === 'preload_timeout'
                                        ? t('status.preload_timeout')
                                        : null
                            }
                        />
                        <StatusIndicator
                            label="RAG"
                            status={embeddingStatus}
                            onClick={RAGService.preloadEmbeddings}
                            icon={<MdStorage className="text-[10px]" />}
                            tooltip={t('rag_tooltip')}
                            statusText={statusText}
                            errorMessage={embeddingError}
                            warningMessage={
                                embeddingWarning === 'single_thread'
                                    ? t('status.single_thread')
                                    : embeddingWarning === 'preload_timeout'
                                        ? t('status.preload_timeout')
                                        : null
                            }
                        />
                    <StatusIndicator
                        label="LID"
                        status={fastTextStatus}
                        onClick={preloadFastText}
                        icon={<MdTranslate className="text-[10px]" />}
                        tooltip={t('fasttext_tooltip')}
                        statusText={statusText}
                        errorMessage={fastTextError}
                    />
                </div>
                <div className="flex items-center gap-1 ml-auto">
                    <IconButton
                        Icon={MdDelete}
                        title={t('clear_history')}

                        onClick={() => {
                            if (confirm(t('confirm_clear'))) {
                                deleteCurrentChat()
                            }
                        }}
                        disabled={state.isLoading || chatSessions.length === 0}
                    />
                    <IconButton
                        Icon={MdSettings}
                        title={t('chatbot.settings_tooltip')}
                        onClick={() => setShowSettings(true)}
                    />
                </div>
            </div>

            {/* Chat Sessions */}
            {chatSessions.length > 0 && (
                <div className="flex items-center gap-2 px-4 py-2 border-b border-border-light dark:border-border-dark bg-surface-1">
                    <select
                        className="flex-1 text-[11px] font-semibold bg-white dark:bg-gray-900 border border-border-light dark:border-border-dark rounded-lg px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-primary/30"
                        value={activeChatId}
                        onChange={(e) => setActiveChat(e.target.value)}
                        disabled={state.isLoading}
                    >
                        {chatSessions.map((session: any, idx: number) => (
                            <option key={session.id} value={session.id}>
                                {formatChatLabel(session, idx)}
                            </option>
                        ))}
                    </select>
                    <IconButton
                        Icon={MdAdd}
                        title={t('new_chat_tooltip') || 'New Chat'}
                        onClick={startNewChat}
                        disabled={state.isLoading}
                        className="rounded-lg border border-primary/20 bg-primary/5 text-primary"
                    />
                </div>
            )}

            {/* Messages */}
            <div className="flex-1 overflow-y-auto p-4 space-y-5 custom-scrollbar" ref={msgsRef}>
                {state.messages.length === 0 && (
                    <div className="flex flex-col items-center justify-center min-h-[60%] text-center p-6 space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-700">
                        <div className="w-20 h-20 bg-surface-1 rounded-3xl flex items-center justify-center text-primary shadow-inner border border-border-light/50">
                            <MdSmartToy size={40} />
                        </div>

                        <div className="space-y-2">
                            <h3 className="text-xl font-bold tracking-tight">{t('chatbot.welcome_title')}</h3>
                            <p className="text-sm text-subtle leading-relaxed max-w-[240px] mx-auto">
                                {t('chatbot.empty_state_desc')}
                            </p>
                        </div>

                        {!isIndexed && !isIndexing && (
                            <div className="w-full p-6 bg-gradient-to-br from-primary/10 via-primary/5 to-transparent border border-primary/20 rounded-2xl space-y-5 animate-in zoom-in duration-500 delay-300 shadow-sm relative overflow-hidden group">
                                <div className="absolute -right-4 -top-4 opacity-5 group-hover:opacity-10 transition-opacity">
                                    <LumenSparkleIcon className="size-20" />
                                </div>
                                <div className="flex items-start gap-3 text-left relative z-10">
                                    <div className="p-2 bg-primary/10 rounded-lg text-primary">
                                        <MdInfoOutline size={20} />
                                    </div>
                                    <p className="text-xs font-semibold text-text leading-tight pt-1">
                                        {t('chatbot.index_description')}
                                    </p>
                                </div>
                                <button
                                    onClick={handleReindex}
                                    className="w-full py-3 bg-gradient-to-r from-primary to-primary-dark text-on-primary rounded-xl text-xs font-black shadow-xl shadow-primary/30 hover:shadow-2xl hover:scale-[1.02] active:scale-[0.98] transition-all flex items-center justify-center gap-2 group/btn relative overflow-hidden"
                                >
                                    <div className="absolute inset-0 bg-white/10 opacity-0 group-hover/btn:opacity-100 transition-opacity" />
                                    <MdFlashOn className="text-lg animate-pulse" />
                                    <span className="relative z-10">{t('chatbot.start_indexing')}</span>
                                </button>
                            </div>
                        )}

                        {isIndexing && (
                            <div className="w-full p-6 bg-surface-1 border border-primary/20 rounded-2xl space-y-5 shadow-2l ring-1 ring-primary/10 animate-pulse-subtle">
                                <div className="flex justify-between items-center text-[10px] font-black uppercase tracking-[0.2em] text-primary">
                                    <div className="flex items-center gap-2">
                                        <LumenSparkleIcon className="animate-spin-slow" />
                                        <span>{t('chatbot.indexing_knowledge')}</span>
                                    </div>
                                    <span className="bg-primary/10 px-2 py-0.5 rounded-full">{indexProgress}%</span>
                                </div>
                                <div className="h-2 w-full bg-primary/10 rounded-full overflow-hidden p-0.5 border border-primary/5">
                                    <div
                                        className="h-full bg-gradient-to-r from-primary via-primary-light to-primary rounded-full transition-all duration-500 ease-out shadow-[0_0_12px_rgba(var(--color-primary),0.5)]"
                                        style={{ width: `${indexProgress}%` }}
                                    />
                                </div>
                                <p className="text-[10px] text-subtle text-center font-medium opacity-80 italic">
                                    {t('chatbot.indexing_subtext')}
                                </p>
                            </div>
                        )}

                        <div className="pt-4 opacity-50 space-y-1">
                            <p className="text-[10px] uppercase tracking-widest font-bold">{t('chatbot.footer')}</p>
                            <p className="text-[10px] font-medium italic">{t('chatbot.connected_to')} {settings.provider}</p>
                        </div>
                    </div>
                )}

                {/* Historical Messages */}
                {state.messages.map(msg => (
                    <ChatMessage key={msg.id} role={msg.role} content={msg.content} />
                ))}

                {showDeeperButton && (
                    <div className="flex justify-center p-2 animate-in fade-in slide-in-from-bottom-2">
                        <button
                            className="text-[10px] font-bold uppercase tracking-wider gap-2 py-1.5 px-4 border border-primary/20 bg-primary/5 hover:bg-primary/10 text-primary rounded-full transition-all flex items-center group shadow-sm"
                            onClick={handleSearchDeeper}
                        >
                            <MdSearch className="text-sm group-hover:scale-110 transition-transform" />
                            {deeperLabel}
                        </button>
                    </div>
                )}

                {/* Live Streaming Message */}
                {streamingContent && (
                    <div className="animate-pulse">
                        <ChatMessage role="assistant" content={streamingContent} />
                    </div>
                )}

                {state.isLoading && !streamingContent && (
                    <div className="self-start text-subtle text-sm animate-pulse ml-2">{t('chatbot.status_context')}</div>
                )}
            </div>

            {/* Floating Input Area */}
            <div className="p-4 bg-surface-2 !bg-opacity-100 border-t border-border-light/40 dark:border-border-dark/40 space-y-3 shadow-[0_-12px_40px_rgba(0,0,0,0.03)] dark:shadow-[0_-8px_30px_rgba(0,0,0,0.2)]">

                {/* Insight Triggers (Bubbles) */}
                {settings.insightTriggers && suggestedQuestions.length > 0 && !input && (
                    <div className="flex flex-wrap gap-2 animate-in fade-in slide-in-from-bottom-2 duration-500 max-h-24 overflow-y-auto p-1 custom-scrollbar">
                        {suggestedQuestions.map((q, i) => (
                            <button
                                key={i}
                                onClick={() => setInput(q)}
                                className="text-[11px] bg-surface-1 hover:bg-primary hover:text-on-primary border border-border-light dark:border-border-dark px-3 py-2 rounded-xl transition-all text-left max-w-full truncate shadow-sm dark:bg-surface-3 group/q flex items-center gap-2 hover:-translate-y-0.5"
                            >
                                <span className="opacity-50 group-hover/q:opacity-100 transition-opacity">✨</span>
                                <span className="flex-1 truncate font-medium">{q}</span>
                            </button>
                        ))}
                    </div>
                )}

                <div className="relative shadow-xl ring-1 ring-border-light/30 dark:ring-border-dark/30 rounded-2xl bg-surface-1 overflow-hidden transition-all focus-within:ring-primary/40 focus-within:shadow-2xl">
                    <input
                        className="w-full bg-transparent py-4 pl-5 pr-12 border-none outline-none ring-0 focus:ring-0 shadow-none appearance-none placeholder:text-subtle/40 text-sm font-medium"
                        placeholder={t('chatbot.placeholder')}
                        disabled={state.isLoading}
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && handleSend()}
                    />

                    {state.isLoading ? (
                        <button
                            onClick={stopGeneration}
                            className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 text-red-500 hover:text-red-600 hover:bg-red-500/10 rounded-full transition-all animate-in zoom-in duration-200"
                            title="Stop Generating"
                        >
                            <MdStop size={20} />
                        </button>
                    ) : (
                        <button
                            onClick={handleSend}
                            disabled={!input.trim()}
                            className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 text-primary hover:text-primary-dark hover:bg-primary/10 rounded-full transition-all disabled:opacity-30 disabled:hover:bg-transparent"
                        >
                            <MdSend size={18} />
                        </button>
                    )}
                </div>
                <div className="text-[10px] text-center text-subtle mt-2 opacity-60">
                    {t('chatbot.disclaimer')}
                </div>
            </div>

            {/* Settings Overlay (Moved to bottom for correct stacking) */}
            {showSettings && (
                <div className="absolute inset-0 z-[200] bg-white dark:bg-gray-900 animate-in slide-in-from-right duration-200 flex flex-col shadow-2xl ai-settings-panel">
                    <AISettingsPanel onClose={() => setShowSettings(false)} className="h-full w-full" />
                </div>
            )}
        </div>
    )
}


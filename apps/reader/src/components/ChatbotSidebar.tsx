import clsx from 'clsx'
import React, { useEffect, useRef, useState } from 'react'
import { MdSend, MdSettings, MdSmartToy, MdStop, MdSearch } from 'react-icons/md'

import { db } from '../db'
import { useChatbot } from '../hooks'
import { useTranslation } from '../hooks/useTranslation'
import { langLabel } from '../lib/ai/language'
import { LLMService } from '../lib/ai/llm'
import { RAGService } from '../lib/ai/rag'
import { reader, useReaderSnapshot } from '../models'
import { useAISettings } from '../state'

import { AISettingsPanel } from './AISettingsPanel'
import { IconButton } from './Button'
import { ChatMessage } from './ChatMessage'
export const ChatbotSidebar: React.FC<{ className?: string }> = ({ className }) => {
    const readerSnap = useReaderSnapshot()
    const { state, sendMessage, stopGeneration } = useChatbot()
    const [settings] = useAISettings()
    const [input, setInput] = useState('')
    const t = useTranslation('ai')
    const msgsRef = useRef<HTMLDivElement>(null)
    const hasApiKey = settings.apiKey.trim().length > 0 || ['local', 'custom'].includes(settings.provider)
    const [showSettings, setShowSettings] = useState(false)
    const [forceSetup, setForceSetup] = useState(!hasApiKey)
    const [streamingContent, setStreamingContent] = useState('')
    const [activeRequestId, setActiveRequestId] = useState<string>('')
    const lastInsightAt = useRef<Record<string, number>>({})

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
                // Retrieve some context based on current location (simulated)
                // Patch: Explicit character budget for insight triggers (8k chars)
                const context = await rag.retrieveContext(bookId, "important themes", 6, {
                    expandContext: true,
                    maxChars: 8000
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
        const handleStream = (e: any) => {
            if (e.detail.requestId === activeRequestId) {
                setStreamingContent(e.detail.fullResponse)
            }
        }

        const handleNavigate = async (e: any) => {
            const citation = e.detail.citation // e.g. "S3:C120"
            const match = citation.match(/S(\d+):C(\d+)/)
            if (match && reader.focusedBookTab) {
                const bookId = reader.focusedBookTab.book.id
                const chunkIndex = parseInt(match[2])

                // SOTA v3.12: Pinpoint navigation using CFI from IDB
                const chunk = await db.vectors.where('[bookId+index]').equals([bookId, chunkIndex]).first()
                if (chunk?.metadata?.cfi) {
                    reader.focusedBookTab.display(chunk.metadata.cfi)

                    // Dispatch highlight event for the Viewlet to catch
                    window.dispatchEvent(new CustomEvent('reader-highlight-chunk', {
                        detail: { cfi: chunk.metadata.cfi, content: chunk.content }
                    }))
                } else {
                    // Fallback to section href if CFI is missing
                    const sectionIndex = parseInt(match[1])
                    const section = reader.focusedBookTab.sections?.[sectionIndex]
                    if (section) {
                        reader.focusedBookTab.display(section.href)
                    }
                }
            }
        }

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

    const handleSearchDeeper = () => {
        const lastMsg = state.messages.filter(m => m.role === 'user').pop()
        if (!lastMsg || state.isLoading) return

        const rid = Date.now().toString()
        setActiveRequestId(rid)
        sendMessage(lastMsg.content, rid, { deeper: true })
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
                        {settings.model.split('/').pop()?.replace('models/', '')}
                    </span>
                </h2>
                <IconButton
                    Icon={MdSettings}
                    title={t('chatbot.settings_tooltip')}
                    onClick={() => setShowSettings(true)}
                />
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto p-4 space-y-5 custom-scrollbar" ref={msgsRef}>
                {state.messages.length === 0 && (
                    <div className="flex flex-col items-center justify-center h-full text-center space-y-4 animate-in fade-in slide-in-from-bottom-4 duration-700">
                        <div className="w-16 h-16 bg-surface-1 rounded-2xl flex items-center justify-center text-primary shadow-sm border border-border-light/50 dark:border-border-dark/50">
                            <MdSmartToy size={32} />
                        </div>
                        <div className="space-y-1">
                            <p className="font-semibold text-text">{t('chatbot.placeholder').replace('...', '')}</p>
                            <p className="text-xs text-subtle opacity-70 italic capitalize">{t('chatbot.connected_to')} {settings.provider}</p>
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
                <div className="absolute inset-0 z-[200] bg-white dark:bg-gray-900 animate-in slide-in-from-right duration-200 flex flex-col shadow-2xl">
                    <AISettingsPanel onClose={() => setShowSettings(false)} className="h-full w-full" />
                </div>
            )}
        </div>
    )
}

import clsx from 'clsx'
import { useLiveQuery } from 'dexie-react-hooks'
import React, { useEffect, useRef, useState } from 'react'
import {
  MdSend,
  MdSettings,
  MdSmartToy,
  MdStop,
  MdSearch,
  MdDelete,
  MdFlashOn,
  MdInfoOutline,
  MdAdd,
  MdStorage,
  MdTranslate,
  MdClose,
} from 'react-icons/md'

import { db } from '../db'
import { useChatbot } from '../hooks'
import { useTranslation } from '../hooks/useTranslation'
import {
  shouldShowFirefoxMLModal,
  isFirefoxBrowser,
} from '../lib/ai/firefoxMLState'
import {
  getFastTextStatus,
  getFastTextWarning,
  langLabel,
  normalizeLangForRAG,
  preloadFastText,
} from '../lib/ai/language'
import { LLMService } from '../lib/ai/llm'
import { RAGService, resetFirefoxMLCache } from '../lib/ai/rag'
import { getSlmStatus, getSlmWarning, preloadSlm } from '../lib/ai/rewriter'
import { reader, useReaderSnapshot } from '../models'
import { useAISettings } from '../state'

import { AISettingsPanel } from './AISettingsPanel'
import { IconButton } from './Button'
import { ChatMessage } from './ChatMessage'
import { FirefoxMLModal } from './FirefoxMLModal'
import { StatusIndicator } from './StatusIndicator'
import { LumenSparkleIcon } from './icons/ProviderIcons'

export const ChatbotSidebar: React.FC<{ className?: string }> = ({
  className,
}) => {
  const readerSnap = useReaderSnapshot()
  const {
    state,
    sendMessage,
    stopGeneration,
    startNewChat,
    deleteCurrentChat,
    setActiveChat,
  } = useChatbot()
  const [settings, setSettings] = useAISettings()
  const [input, setInput] = useState('')
  const t = useTranslation('ai')
  const msgsRef = useRef<HTMLDivElement>(null)
  const hasApiKey = React.useMemo(() => {
    const apiKey = settings.apiKey.trim()
    const baseUrl = settings.baseUrl?.trim() || ''
    if (settings.provider === 'local') return baseUrl.length > 0
    if (settings.provider === 'custom')
      return baseUrl.length > 0 && apiKey.length > 0
    return apiKey.length > 0
  }, [settings.apiKey, settings.baseUrl, settings.provider])
  const [showSettings, setShowSettings] = useState(false)
  const [forceSetup, setForceSetup] = useState(!hasApiKey)
  const [streamingContent, setStreamingContent] = useState('')
  const [activeRequestId, setActiveRequestId] = useState<string>('')
  const lastInsightAt = useRef<Record<string, number>>({})
  const [isIndexing, setIsIndexing] = useState(false)
  const [indexProgress, setIndexProgress] = useState(0)
  const [slmStatus, setSlmStatus] = useState<ReturnType<typeof getSlmStatus>>(
    getSlmStatus(),
  )
  const [slmError, setSlmError] = useState<string | null>(null)
  const [slmWarning, setSlmWarning] = useState<string | null>(getSlmWarning())
  const [embeddingStatus, setEmbeddingStatus] = useState<
    ReturnType<typeof RAGService.getEmbeddingStatus>
  >(RAGService.getEmbeddingStatus())
  const [embeddingError, setEmbeddingError] = useState<string | null>(null)
  const [embeddingWarning, setEmbeddingWarning] = useState<string | null>(
    RAGService.getEmbeddingWarning(),
  )
  const [fastTextStatus, setFastTextStatus] = useState<
    ReturnType<typeof getFastTextStatus>
  >(getFastTextStatus())
  const [fastTextError, setFastTextError] = useState<string | null>(null)
  const [fastTextWarning, setFastTextWarning] = useState<string | null>(
    getFastTextWarning(),
  )
  const [showFirefoxMLModal, setShowFirefoxMLModal] = useState(false)
  const firefoxMLChecked = useRef(false)
  const chatSessions = readerSnap.focusedBookTab?.book.chatSessions || []
  const activeChatId =
    readerSnap.focusedBookTab?.book.activeChatId || chatSessions[0]?.id
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

  // SOTA: Show Firefox ML consent modal when sidebar opens
  useEffect(() => {
    if (
      isFirefoxBrowser() &&
      !firefoxMLChecked.current &&
      shouldShowFirefoxMLModal()
    ) {
      firefoxMLChecked.current = true
      setShowFirefoxMLModal(true)
    }
  }, []) // Run once on mount

  useEffect(() => {
    const handler = (e: any) => {
      const next = e?.detail?.status
      if (
        next === 'unknown' ||
        next === 'downloading' ||
        next === 'ready' ||
        next === 'warning' ||
        next === 'error'
      ) {
        setSlmStatus(next)
        if (next !== 'error') setSlmError(null)
      }
      const warning = e?.detail?.warning
      if (typeof warning === 'string') {
        setSlmWarning(warning)
      } else if (warning === null) {
        setSlmWarning(null)
      }
    }
    const errorHandler = (e: any) => {
      if (e?.detail?.status && e.detail.status !== 'error') return
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
      if (
        next === 'unknown' ||
        next === 'downloading' ||
        next === 'ready' ||
        next === 'warning' ||
        next === 'error'
      ) {
        setEmbeddingStatus(next)
        if (next !== 'error') setEmbeddingError(null)
      }
      const warning = e?.detail?.warning
      if (typeof warning === 'string') {
        setEmbeddingWarning(warning)
      } else if (warning === null) {
        setEmbeddingWarning(null)
      }
    }
    const errorHandler = (e: any) => {
      if (e?.detail?.status && e.detail.status !== 'error') return
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
      if (
        next === 'unknown' ||
        next === 'downloading' ||
        next === 'ready' ||
        next === 'warning' ||
        next === 'error'
      ) {
        setFastTextStatus(next)
        if (next !== 'error') setFastTextError(null)
      }
      const warning = e?.detail?.warning
      if (typeof warning === 'string') {
        setFastTextWarning(warning)
      } else if (warning === null) {
        setFastTextWarning(null)
      } else if (e?.detail?.reasonCode === 'preload_timeout') {
        setFastTextWarning('preload_timeout')
      }
    }
    const errorHandler = (e: any) => {
      if (e?.detail?.status && e.detail.status !== 'error') return
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
      const idx = await db?.indices
        .where('[bookId+kind]')
        .equals([currentBook.id, 'chunks'])
        .first()
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
        if (
          lastInsightAt.current[bookId] &&
          now - lastInsightAt.current[bookId] < 10 * 60_000
        )
          return

        lastInsightAt.current[bookId] = now

        const rag = RAGService.getInstance()
        const bookLang = normalizeLangForRAG(
          reader.focusedBookTab?.book.metadata.language,
          'en',
        )
        // Retrieve some context based on current location (simulated)
        // Patch: Explicit character budget for insight triggers (8k chars)
        const context = await rag.retrieveContext(
          bookId,
          'important themes',
          6,
          {
            expandContext: true,
            maxChars: 8000,
            locale: bookLang,
          },
        )

        const text = context.map((c) => c.content).join('\n')

        const llm = new LLMService(settings)
        const langName = langLabel(
          reader.focusedBookTab?.book.metadata.language || 'en',
        )
        const response = await llm.generateResponse(
          `You are a helpful reading assistant. Generate 3 short, intriguing questions (max 10 words each) the reader could ask about this text. Return them as a JSON array of strings. Language: Respond in ${langName}.`,
          `Text: ${text}`,
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
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

    const normHref = (h: string) =>
      (h || '').replace(/^(\.\/)+/, '').replace(/^\/+/, '')

    const normCfi = (cfi: string) => {
      if (!cfi) return ''
      if (cfi.startsWith('epubcfi(')) return cfi
      if (cfi.startsWith('/')) return `epubcfi(${cfi})`
      return cfi
    }
    const isDisplayableCfi = (cfi: string) =>
      !!cfi && cfi.startsWith('epubcfi(') && cfi.includes('!')

    const resolveSpineHref = (tab: any, href: string) => {
      const spineItems =
        (tab?.book?.spine as any)?.spineItems ||
        (tab?.book?.spine as any)?.items ||
        []
      const target = normHref(href)

      const hit = spineItems.find((s: any) => {
        const sh = normHref(s?.href)
        return sh === target || sh.endsWith(target) || target.endsWith(sh)
      })

      return hit?.href || href
    }

    const displaySafe = async (tab: any, target: any) => {
      for (let i = 0; i < 10; i++) {
        if (tab?.rendition) break
        await sleep(50)
      }

      const fn = tab?.display
        ? tab.display.bind(tab)
        : tab?.rendition?.display?.bind(tab.rendition)
      if (!fn) throw new Error('No display() available')

      return await fn(target)
    }

    const handleStream = (e: any) => {
      if (e.detail.requestId === activeRequestId) {
        setStreamingContent(e.detail.fullResponse)
      }
    }

    const handleNavigate = (e: any) => {
      void (async () => {
        try {
          const citation = e.detail.citation
          const match = citation?.match(/S(\d+):C(\d+)/)
          const tab = reader.focusedBookTab

          if (!match || !tab) {
            return
          }

          const bookId = tab.book?.id
          if (!bookId) return

          const sectionIndex = Number(match[1])
          const chunkIndex = Number(match[2])
          console.log('[Citation Trace] Indices:', { sectionIndex, chunkIndex })

          let chunk: any = null
          try {
            if (!Number.isNaN(chunkIndex)) {
              chunk = await db.vectors
                .where('[bookId+index]')
                .equals([bookId, chunkIndex])
                .first()
              // Guard against mismatched section/chunk reference.
              if (
                chunk &&
                Number.isFinite(sectionIndex) &&
                chunk?.metadata?.sectionIndex !== sectionIndex
              ) {
                const exact = await db.vectors
                  .where('bookId')
                  .equals(bookId)
                  .filter(
                    (v: any) =>
                      v.index === chunkIndex &&
                      v?.metadata?.sectionIndex === sectionIndex,
                  )
                  .first()
                if (exact) chunk = exact
              }
            }
          } catch (err) {
            console.warn('[Citation] DB lookup failed:', err)
          }

          // 1. Try CFI when it points to content inside the spine item.
          const cfi = normCfi(chunk?.metadata?.cfi || '')
          const emitHighlight = () => {
            window.dispatchEvent(
              new CustomEvent('reader-highlight-chunk', {
                detail: {
                  cfi,
                  content: chunk?.content,
                  href: chunk?.metadata?.href || '',
                  sectionIndex,
                  chunkIndex,
                  anchorStartNorm: Number.isFinite(
                    Number(chunk?.metadata?.anchorStartNorm),
                  )
                    ? Number(chunk?.metadata?.anchorStartNorm)
                    : undefined,
                  anchorEndNorm: Number.isFinite(
                    Number(chunk?.metadata?.anchorEndNorm),
                  )
                    ? Number(chunk?.metadata?.anchorEndNorm)
                    : undefined,
                  anchorAlgo: chunk?.metadata?.anchorAlgo || undefined,
                },
              }),
            )
          }
          if (isDisplayableCfi(cfi)) {
            try {
              await displaySafe(tab, cfi)
              emitHighlight()
              return
            } catch (err) {
              console.warn('[Citation] CFI navigation failed:', err)
            }
          }

          // 2. Try metadata.href
          const hrefRaw = chunk?.metadata?.href || ''
          if (hrefRaw) {
            const href = resolveSpineHref(tab, hrefRaw)
            try {
              await displaySafe(tab, href)
              emitHighlight()
              return
            } catch (err) {
              console.warn('[Citation] Href navigation failed:', err)
            }
          }

          // 3. Try sectionIndex with spine href
          const spineItems =
            ((tab?.book as any)?.spine as any)?.spineItems ||
            ((tab?.book as any)?.spine as any)?.items ||
            []

          if (Number.isFinite(sectionIndex) && spineItems.length) {
            let idx = sectionIndex
            if (
              idx >= spineItems.length &&
              idx - 1 >= 0 &&
              idx - 1 < spineItems.length
            ) {
              idx = idx - 1
            }
            const spineHref = spineItems[idx]?.href
            if (spineHref) {
              try {
                await displaySafe(tab, spineHref)
                emitHighlight()
                return
              } catch (err) {
                console.warn('[Citation] Spine href navigation failed:', err)
              }
            }

            // 4. Fallback to index (NUMBER)
            try {
              await displaySafe(tab, idx)
              emitHighlight()
              return
            } catch (err) {
              console.error('[Citation] display(index) failed:', err)
            }
          }
        } catch (err) {
          console.error('[Citation] Navigation handler crashed:', err)
        }
      })()
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

  const handleReindex = async () => {
    if (!currentBook || isIndexing) return

    // SOTA: Show Firefox ML consent modal before indexing if needed
    if (
      isFirefoxBrowser() &&
      !firefoxMLChecked.current &&
      shouldShowFirefoxMLModal()
    ) {
      firefoxMLChecked.current = true
      setShowFirefoxMLModal(true)
    }

    const fileRecord = await db?.files.get(currentBook.id)
    if (!fileRecord) return

    setIsIndexing(true)
    setIndexProgress(0)
    try {
      const bookLang = normalizeLangForRAG(currentBook.metadata.language, 'en')
      await RAGService.getInstance().indexBook(
        fileRecord.file,
        currentBook.id,
        (p) => setIndexProgress(p),
        bookLang,
      )
    } catch (e) {
      console.error('Indexing failed:', e)
    } finally {
      setIsIndexing(false)
    }
  }

  const handleSearchDeeper = () => {
    const lastMsg = state.messages.filter((m) => m.role === 'user').pop()
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
      <div
        className={clsx(
          'bg-surface-1 border-border-light dark:border-border-dark flex h-full flex-col border-l',
          className,
        )}
      >
        <div className="animate-in fade-in zoom-in flex flex-1 flex-col items-center justify-center space-y-6 p-8 text-center duration-500">
          <div className="bg-primary/10 text-primary flex h-20 w-20 items-center justify-center rounded-3xl shadow-inner">
            <MdSmartToy size={48} />
          </div>
          <div>
            <h2 className="text-2xl font-bold tracking-tight">
              {t('chatbot.welcome_title')}
            </h2>
            <p className="text-subtle mt-2 text-sm leading-relaxed">
              {t('chatbot.welcome_desc')}
            </p>
          </div>

          <div className="w-full pt-4">
            <AISettingsPanel
              onClose={() => setForceSetup(false)}
              isSetup={true}
              className="border-border-light dark:border-border-dark max-h-[500px] overflow-hidden rounded-2xl border shadow-2xl"
            />
          </div>

          <p className="text-subtle text-[10px] font-bold uppercase tracking-widest opacity-50">
            {t('chatbot.footer')}
          </p>
        </div>
      </div>
    )
  }

  return (
    <div
      className={clsx(
        'bg-surface-2 border-border-light dark:border-border-dark relative flex h-full min-w-[300px] flex-col border-l !bg-opacity-100',
        className,
      )}
    >
      {/* Header */}
      <div className="border-border-light dark:border-border-dark bg-surface-1 sticky top-0 z-10 flex items-center justify-between border-b !bg-opacity-100 p-4 shadow-sm">
        <h2 className="flex items-center gap-2 font-medium">
          <MdSmartToy /> {t('title')}
        </h2>
        <div className="ml-2 flex items-center gap-1.5">
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
            onClick={() =>
              RAGService.preloadEmbeddings(undefined, {
                downloadLocalModels: settings.downloadLocalModels,
              })
            }
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
            warningMessage={
              fastTextWarning === 'preload_timeout'
                ? t('status.preload_timeout')
                : null
            }
          />
        </div>
        <div className="ml-auto flex items-center gap-1">
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
        <div className="border-border-light dark:border-border-dark bg-surface-1 flex items-center gap-2 border-b px-4 py-2">
          <select
            className="border-border-light dark:border-border-dark focus:ring-primary/30 flex-1 rounded-lg border bg-white px-2 py-1.5 text-[11px] font-semibold focus:outline-none focus:ring-1 dark:bg-gray-900"
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
            title={t('chatbot.new_chat')}
            onClick={() => startNewChat()}
            disabled={state.isLoading}
          />
        </div>
      )}

      {/* Settings Panel embedded in Sidebar (if requested) or separate modal */}
      {showSettings && (
        <div className="border-border-light dark:border-border-dark animate-in fade-in slide-in-from-top-2 absolute top-12 right-4 z-50 w-72 rounded-xl border bg-white p-4 shadow-2xl dark:bg-gray-900">
          <div className="mb-4 flex items-center justify-between">
            <h3 className="text-sm font-bold">{t('settings.config_title')}</h3>
            <button
              onClick={() => setShowSettings(false)}
              className="text-subtle hover:text-text"
            >
              <MdClose />
            </button>
          </div>
          <div className="space-y-4">
            <label className="bg-surface-1 border-border-light dark:border-border-dark hover:border-primary/50 flex cursor-pointer items-center justify-between rounded-lg border p-2 transition-all">
              <div className="flex flex-col pr-2">
                <span className="text-xs font-semibold">
                  {t('settings.download_models')}
                </span>
                <span className="text-subtle text-[9px] leading-tight">
                  {t('settings.download_models_desc')}
                </span>
              </div>
              <div className="relative inline-flex shrink-0 cursor-pointer items-center self-center">
                <input
                  type="checkbox"
                  checked={settings.downloadLocalModels}
                  onChange={(e) => {
                    const newVal = e.target.checked
                    setSettings((prev) => ({
                      ...prev,
                      downloadLocalModels: newVal,
                    }))
                  }}
                  className="peer sr-only"
                />
                <div className="bg-surface-variant after:bg-surface-1 after:border-border-light dark:after:border-border-dark peer-checked:after:border-surface-1 peer-checked:bg-primary peer relative h-5 w-9 overflow-hidden rounded-full after:absolute after:top-[2px] after:left-[4px] after:box-border after:h-4 after:w-4 after:rounded-full after:border after:transition-all after:content-[''] peer-checked:after:left-[16px] peer-focus:outline-none"></div>
              </div>
            </label>
            <button
              onClick={() => {
                setShowSettings(false)
                setForceSetup(true)
              }}
              className="text-primary bg-primary/10 hover:bg-primary/20 w-full rounded-lg py-2 text-xs font-bold"
            >
              {t('settings.advanced_settings')}
            </button>
          </div>
        </div>
      )}

      {/* Messages */}
      <div
        className="custom-scrollbar flex-1 space-y-5 overflow-y-auto p-4"
        ref={msgsRef}
      >
        {state.messages.length === 0 && (
          <div className="animate-in fade-in slide-in-from-bottom-4 flex min-h-[60%] flex-col items-center justify-center space-y-6 p-6 text-center duration-700">
            <div className="bg-surface-1 text-primary border-border-light/50 flex h-20 w-20 items-center justify-center rounded-3xl border shadow-inner">
              <MdSmartToy size={40} />
            </div>

            <div className="space-y-2">
              <h3 className="text-xl font-bold tracking-tight">
                {t('chatbot.welcome_title')}
              </h3>
              <p className="text-subtle mx-auto max-w-[240px] text-sm leading-relaxed">
                {t('chatbot.empty_state_desc')}
              </p>
            </div>

            {!isIndexed && !isIndexing && (
              <div className="from-primary/10 via-primary/5 border-primary/20 animate-in zoom-in group relative w-full space-y-5 overflow-hidden rounded-2xl border bg-gradient-to-br to-transparent p-6 shadow-sm delay-300 duration-500">
                <div className="absolute -right-4 -top-4 opacity-5 transition-opacity group-hover:opacity-10">
                  <LumenSparkleIcon className="size-20" />
                </div>
                <div className="relative z-10 flex items-start gap-3 text-left">
                  <div className="bg-primary/10 text-primary rounded-lg p-2">
                    <MdInfoOutline size={20} />
                  </div>
                  <p className="text-text pt-1 text-xs font-semibold leading-tight">
                    {t('chatbot.index_description')}
                  </p>
                </div>
                <button
                  onClick={handleReindex}
                  className="from-primary to-primary-dark text-on-primary shadow-primary/30 group/btn relative flex w-full items-center justify-center gap-2 overflow-hidden rounded-xl bg-gradient-to-r py-3 text-xs font-black shadow-xl transition-all hover:scale-[1.02] hover:shadow-2xl active:scale-[0.98]"
                >
                  <div className="absolute inset-0 bg-white/10 opacity-0 transition-opacity group-hover/btn:opacity-100" />
                  <MdFlashOn className="animate-pulse text-lg" />
                  <span className="relative z-10">
                    {t('chatbot.start_indexing')}
                  </span>
                </button>
              </div>
            )}

            {isIndexing && (
              <div className="bg-surface-1 border-primary/20 shadow-2l ring-primary/10 animate-pulse-subtle w-full space-y-5 rounded-2xl border p-6 ring-1">
                <div className="text-primary flex items-center justify-between text-[10px] font-black uppercase tracking-[0.2em]">
                  <div className="flex items-center gap-2">
                    <LumenSparkleIcon className="animate-spin-slow" />
                    <span>{t('chatbot.indexing_knowledge')}</span>
                  </div>
                  <span className="bg-primary/10 rounded-full px-2 py-0.5">
                    {indexProgress}%
                  </span>
                </div>
                <div className="bg-primary/10 border-primary/5 h-2 w-full overflow-hidden rounded-full border p-0.5">
                  <div
                    className="from-primary via-primary-light to-primary h-full rounded-full bg-gradient-to-r shadow-[0_0_12px_rgba(var(--color-primary),0.5)] transition-all duration-500 ease-out"
                    style={{ width: `${indexProgress}%` }}
                  />
                </div>
                <p className="text-subtle text-center text-[10px] font-medium italic opacity-80">
                  {t('chatbot.indexing_subtext')}
                </p>
              </div>
            )}

            <div className="space-y-1 pt-4 opacity-50">
              <p className="text-[10px] font-bold uppercase tracking-widest">
                {t('chatbot.footer')}
              </p>
              <p className="text-[10px] font-medium italic">
                {t('chatbot.connected_to')} {settings.provider}
              </p>
            </div>
          </div>
        )}

        {/* Historical Messages */}
        {state.messages.map((msg) => (
          <ChatMessage key={msg.id} role={msg.role} content={msg.content} />
        ))}

        {showDeeperButton && (
          <div className="animate-in fade-in slide-in-from-bottom-2 flex justify-center p-2">
            <button
              className="border-primary/20 bg-primary/5 hover:bg-primary/10 text-primary group flex items-center gap-2 rounded-full border py-1.5 px-4 text-[10px] font-bold uppercase tracking-wider shadow-sm transition-all"
              onClick={handleSearchDeeper}
            >
              <MdSearch className="text-sm transition-transform group-hover:scale-110" />
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
          <div className="text-subtle ml-2 animate-pulse self-start text-sm">
            {t('chatbot.status_context')}
          </div>
        )}
      </div>

      {/* Floating Input Area */}
      <div className="bg-surface-2 border-border-light/40 dark:border-border-dark/40 space-y-3 border-t !bg-opacity-100 p-4 shadow-[0_-12px_40px_rgba(0,0,0,0.03)] dark:shadow-[0_-8px_30px_rgba(0,0,0,0.2)]">
        {/* Insight Triggers (Bubbles) */}
        {settings.insightTriggers && suggestedQuestions.length > 0 && !input && (
          <div className="animate-in fade-in slide-in-from-bottom-2 custom-scrollbar flex max-h-24 flex-wrap gap-2 overflow-y-auto p-1 duration-500">
            {suggestedQuestions.map((q, i) => (
              <button
                key={i}
                onClick={() => setInput(q)}
                className="bg-surface-1 hover:bg-primary hover:text-on-primary border-border-light dark:border-border-dark dark:bg-surface-3 group/q flex max-w-full items-center gap-2 truncate rounded-xl border px-3 py-2 text-left text-[11px] shadow-sm transition-all hover:-translate-y-0.5"
              >
                <span className="opacity-50 transition-opacity group-hover/q:opacity-100">
                  ✨
                </span>
                <span className="flex-1 truncate font-medium">{q}</span>
              </button>
            ))}
          </div>
        )}

        <div className="ring-border-light/30 dark:ring-border-dark/30 bg-surface-1 focus-within:ring-primary/40 relative overflow-hidden rounded-2xl shadow-xl ring-1 transition-all focus-within:shadow-2xl">
          <input
            className="placeholder:text-subtle/40 w-full appearance-none border-none bg-transparent py-4 pl-5 pr-12 text-sm font-medium shadow-none outline-none ring-0 focus:ring-0"
            placeholder={t('chatbot.placeholder')}
            disabled={state.isLoading}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSend()}
          />

          {state.isLoading ? (
            <button
              onClick={stopGeneration}
              className="animate-in zoom-in absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-1.5 text-red-500 transition-all duration-200 hover:bg-red-500/10 hover:text-red-600"
              title="Stop Generating"
            >
              <MdStop size={20} />
            </button>
          ) : (
            <button
              onClick={handleSend}
              disabled={!input.trim()}
              className="text-primary hover:text-primary-dark hover:bg-primary/10 absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-1.5 transition-all disabled:opacity-30 disabled:hover:bg-transparent"
            >
              <MdSend size={18} />
            </button>
          )}
        </div>
        <div className="text-subtle mt-2 text-center text-[10px] opacity-60">
          {t('chatbot.disclaimer')}
        </div>
      </div>

      {/* Settings Overlay (Moved to bottom for correct stacking) */}
      {showSettings && (
        <div className="animate-in slide-in-from-right ai-settings-panel absolute inset-0 z-[200] flex flex-col bg-white shadow-2xl duration-200 dark:bg-gray-900">
          <AISettingsPanel
            onClose={() => setShowSettings(false)}
            className="h-full w-full"
          />
        </div>
      )}

      {/* Firefox Native ML Consent Modal */}
      <FirefoxMLModal
        isOpen={showFirefoxMLModal}
        onClose={(enabled) => {
          setShowFirefoxMLModal(false)
          if (enabled) {
            // Reset cache to re-probe Firefox ML on next request
            resetFirefoxMLCache()
          }
        }}
      />
    </div>
  )
}

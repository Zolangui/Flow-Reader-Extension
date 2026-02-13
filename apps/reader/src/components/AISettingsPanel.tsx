import clsx from 'clsx'
import { useLiveQuery } from 'dexie-react-hooks'
import React, { useState } from 'react'
import {
  MdDeleteSweep as _MdDeleteSweep,
  MdLock as _MdLock,
  MdRefresh as _MdRefresh,
  MdSearch as _MdSearch,
  MdChevronRight as _MdChevronRight,
  MdCheck as _MdCheck,
  MdSmartToy as _MdSmartToy,
  MdComputer as _MdComputer,
  MdSettings as _MdSettings,
  MdClose as _MdClose,
  MdDns as _MdDns,
  MdVpnKey as _MdVpnKey,
  MdVisibility as _MdVisibility,
  MdVisibilityOff as _MdVisibilityOff,
  MdContentPaste as _MdContentPaste,
  MdStorage as _MdStorage,
  MdTranslate as _MdTranslate,
} from 'react-icons/md'

import { db } from '../db'
import { useTranslation } from '../hooks/useTranslation'
import {
  getFastTextStatus,
  getFastTextWarning,
  normalizeLangForRAG,
  preloadFastText,
} from '../lib/ai/language'
import { RAGService } from '../lib/ai/rag'
import { getSlmStatus, getSlmWarning, preloadSlm } from '../lib/ai/rewriter'
import { sanitizeErrorForLogs } from '../lib/security/redact'
import { reader } from '../models'
import {
  defaultAIConfig,
  type AIProvider,
  useAISettings,
  useChatbotState,
  useSettings,
} from '../state'

import { Button } from './Button'
import { TextField } from './Form'
import { StatusIndicator } from './StatusIndicator'
import {
  AnthropicIcon as _AnthropicIcon,
  GeminiIcon as _GeminiIcon,
  OpenAIIcon as _OpenAIIcon,
} from './icons/ProviderIcons'

const MdDeleteSweep = _MdDeleteSweep as any
const MdLock = _MdLock as any
const MdRefresh = _MdRefresh as any
const MdSearch = _MdSearch as any
const MdChevronRight = _MdChevronRight as any
const MdCheck = _MdCheck as any
const MdSmartToy = _MdSmartToy as any
const MdComputer = _MdComputer as any
const MdSettings = _MdSettings as any
const MdClose = _MdClose as any
const MdDns = _MdDns as any
const MdVpnKey = _MdVpnKey as any
const MdVisibility = _MdVisibility as any
const MdVisibilityOff = _MdVisibilityOff as any
const MdContentPaste = _MdContentPaste as any
const MdStorage = _MdStorage as any
const MdTranslate = _MdTranslate as any
const GeminiIcon = _GeminiIcon as any
const OpenAIIcon = _OpenAIIcon as any

const AnthropicIcon = _AnthropicIcon as any

// SOTA: Internal component for handling Firefox Permissions
const PermissionButton = () => {
  const [status, setStatus] = React.useState<
    'loading' | 'granted' | 'denied' | 'idle'
  >('loading')

  React.useEffect(() => {
    check()
  }, [])

  const check = async () => {
    try {
      const { isFirefoxBrowser, isTrialMLPermissionGranted } = await import(
        '../lib/ai/firefoxMLState'
      )
      if (!isFirefoxBrowser()) {
        setStatus('granted') // Not relevant for non-firefox, hide button
        return
      }
      const granted = await isTrialMLPermissionGranted()
      setStatus(granted ? 'granted' : 'idle')
    } catch {
      setStatus('idle')
    }
  }

  const request = async () => {
    try {
      setStatus('loading')
      const { requestTrialMLPermissionSync } = await import(
        '../lib/ai/firefoxMLState'
      )
      const granted = await requestTrialMLPermissionSync()
      setStatus(granted ? 'granted' : 'denied')
    } catch (e) {
      console.error(e)
      setStatus('denied')
    }
  }

  if (status === 'granted' || status === 'loading') return null

  return (
    <div className="bg-primary/5 border-primary/10 flex items-center justify-between gap-3 rounded-xl border p-3">
      <div className="text-primary flex items-center gap-2">
        <span className="text-lg">🚀</span>
        <span className="text-xs font-bold">Firefox Native AI</span>
      </div>
      <button
        onClick={request}
        className="bg-primary hover:bg-primary-dark rounded-lg px-3 py-1.5 text-[10px] font-bold text-white shadow-sm transition-colors"
      >
        {status === 'denied' ? 'Try Again' : 'Grant Permission'}
      </button>
    </div>
  )
}

const TABS = ['General', 'Persona', 'Advanced'] as const
type Tab = typeof TABS[number]

interface SelectOption {
  value: string
  label?: string
  icon?: React.ReactNode
}

interface SelectGroup {
  label: string
  options: SelectOption[]
}

interface ModelCacheEntry {
  fetchedAt: number
  groups: SelectGroup[]
}

const MODEL_FETCH_CACHE_TTL_MS = 10 * 60 * 1000
const MODEL_FETCH_CACHE = new Map<string, ModelCacheEntry>()

function buildModelCacheKey(provider: AIProvider, apiKey: string): string {
  const trimmed = apiKey.trim()
  if (!trimmed) return provider
  const keyFingerprint = `${trimmed.length}:${trimmed.slice(
    0,
    4,
  )}:${trimmed.slice(-2)}`
  return `${provider}:${keyFingerprint}`
}

interface PremiumSelectProps {
  label: string
  value: string
  options: string[] | SelectOption[] | SelectGroup[]
  onChange: (val: any) => void
  searchable?: boolean
  icon?: React.ReactNode
  placeholder?: string
}

const PremiumSelect: React.FC<PremiumSelectProps> = ({
  label,
  value,
  options,
  onChange,
  searchable,
  icon,
  placeholder,
}) => {
  const t = useTranslation('ai')
  const [isOpen, setIsOpen] = useState(false)
  const [search, setSearch] = useState('')
  const containerRef = React.useRef<HTMLDivElement>(null)

  const groups: SelectGroup[] = React.useMemo(() => {
    if (!options || options.length === 0) return []
    if (typeof options[0] === 'string') {
      return [
        {
          label: '',
          options: (options as string[]).map((o) => ({ value: o })),
        },
      ]
    }
    if ('options' in options[0]) {
      return options as SelectGroup[]
    }
    return [{ label: '', options: options as SelectOption[] }]
  }, [options])

  const filteredGroups = groups
    .map((group) => ({
      ...group,
      options: group.options.filter(
        (o) =>
          (o.value || '').toLowerCase().includes(search.toLowerCase()) ||
          (o.label && o.label.toLowerCase().includes(search.toLowerCase())),
      ),
    }))
    .filter((group) => group.options.length > 0)

  const selectedOption = React.useMemo(() => {
    for (const g of groups) {
      const found = g.options.find((o) => o.value === value)
      if (found) return found
    }
    return null
  }, [groups, value])

  React.useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as HTMLElement
      if (containerRef.current && !containerRef.current.contains(target)) {
        // SOTA UX: Don't close if clicking within the AI settings panel (e.g., scrollbars, padding)
        // This prevents accidental closing when dragging the main sidebar scrollbar.
        if (target.closest('.ai-settings-panel')) {
          // Check if it's a click that *should* close (like clicking another select or a button)
          // but for now, we prioritize allowing scrollbar interactions in the panel.

          // Detect scrollbar click via coordinate check (standard heuristic)
          const isScrollbar =
            target.clientWidth < target.offsetWidth ||
            target.clientHeight < target.offsetHeight
          if (isScrollbar) return

          // If the user clicked specifically on the scrollable container's background
          // (prevents closing when clicking the track of the scrollbar)
          if (target.classList.contains('ai-settings-panel-content')) return
          if (target.classList.contains('custom-scrollbar')) return
        }

        setIsOpen(false)
      }
    }

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside)
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [isOpen])

  return (
    <div
      className={clsx('relative space-y-1.5', isOpen && 'z-[100]')}
      ref={containerRef}
    >
      <label className="text-subtle ml-1 block text-[11px] font-bold uppercase tracking-wider">
        {label}
      </label>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="border-border-light dark:border-border-dark hover:border-primary/50 group flex w-full items-center justify-between rounded-xl border bg-white p-3 text-sm transition-all dark:bg-gray-900"
      >
        <div className="flex items-center gap-2.5 overflow-hidden text-left">
          <span className="text-primary flex-shrink-0 whitespace-nowrap opacity-70 transition-opacity group-hover:opacity-100 [&>svg]:block [&>svg]:h-4 [&>svg]:w-4">
            {selectedOption?.icon || icon}
          </span>
          <span className="truncate font-medium capitalize">
            {selectedOption?.label ||
              selectedOption?.value ||
              placeholder ||
              t('settings.select_model_placeholder')}
          </span>
        </div>
        {React.createElement(MdChevronRight as any, {
          className: clsx(
            'text-lg text-subtle transition-transform flex-shrink-0',
            isOpen && 'rotate-90',
          ),
        })}
      </button>

      {isOpen && (
        <div className="border-border-light dark:border-border-dark animate-in fade-in slide-in-from-top-2 absolute top-[calc(100%+4px)] left-0 z-[110] w-full overflow-hidden rounded-xl border bg-white shadow-2xl ring-4 ring-black/5 backdrop-blur-xl duration-200 dark:bg-gray-900">
          {searchable && (
            <div className="border-border-light dark:border-border-dark border-b bg-white/50 p-2 dark:bg-gray-900/50">
              <div className="relative flex items-center">
                <MdSearch className="text-subtle absolute left-3" />
                <input
                  autoFocus
                  className="border-border-light dark:border-border-dark focus:border-primary w-full rounded-lg border bg-white py-2 pl-9 pr-3 text-xs focus:outline-none dark:bg-gray-900"
                  placeholder={t('settings.search_placeholder')}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                />
              </div>
            </div>
          )}
          <div className="custom-scrollbar max-h-[250px] overflow-y-auto p-1">
            {filteredGroups.length === 0 && (
              <div className="text-subtle p-4 text-center text-xs italic">
                {t('settings.no_results')}
              </div>
            )}
            {filteredGroups.map((group, gIdx) => (
              <div key={group.label || gIdx} className="space-y-1">
                {group.label && (
                  <div className="text-subtle px-3 py-2 text-[10px] font-bold uppercase tracking-widest opacity-50">
                    {group.label}
                  </div>
                )}
                {group.options.map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() => {
                      onChange(opt.value)
                      setIsOpen(false)
                    }}
                    className={clsx(
                      'hover:bg-primary/5 flex w-full items-center justify-between rounded-lg px-3 py-2.5 text-left text-sm transition-colors',
                      value === opt.value
                        ? 'text-primary bg-primary/10 font-semibold'
                        : 'text-subtle hover:text-text',
                    )}
                  >
                    <div className="flex items-center gap-2.5 overflow-hidden">
                      {opt.icon && (
                        <span className="flex-shrink-0 opacity-70 [&>svg]:block [&>svg]:h-4 [&>svg]:w-4">
                          {opt.icon}
                        </span>
                      )}
                      <span className="truncate capitalize">
                        {opt.label || opt.value}
                      </span>
                    </div>
                    {value === opt.value && (
                      <MdCheck className="text-primary flex-shrink-0" />
                    )}
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

interface PremiumInputProps {
  label: string
  value: string
  onChange: (val: string) => void
  placeholder?: string
  type?: string
}

interface SwitchProps {
  checked: boolean
  onChange: (checked: boolean) => void
  label?: string
}

const Switch: React.FC<SwitchProps> = ({ checked, onChange }) => {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={(e) => {
        e.stopPropagation()
        onChange(!checked)
      }}
      className={clsx(
        'focus:ring-primary group relative inline-flex h-[24px] w-[44px] shrink-0 cursor-pointer rounded-full transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-offset-2 dark:focus:ring-offset-gray-900',
        checked ? 'bg-primary' : 'bg-surface-variant',
      )}
    >
      <span
        aria-hidden="true"
        className={clsx(
          'pointer-events-none absolute top-[2px] left-[2px] inline-block h-[20px] w-[20px] rounded-full bg-white shadow-sm ring-0 transition duration-200 ease-in-out',
          checked ? 'translate-x-[20px]' : 'translate-x-0',
        )}
      />
    </button>
  )
}

const PremiumInput: React.FC<PremiumInputProps> = ({
  label,
  value,
  onChange,
  placeholder,
  type = 'text',
}) => {
  const t = useTranslation('ai')
  const [isVisible, setIsVisible] = useState(false)
  const isPassword = type === 'password'

  // Auto-hide value if not password type but is a key
  const inputType = isPassword ? (isVisible ? 'text' : 'password') : type

  const handlePaste = async () => {
    try {
      const text = await navigator.clipboard.readText()
      if (text) onChange(text)
    } catch (e) {
      console.error('Failed to paste', e)
    }
  }

  return (
    <div className="space-y-1.5">
      <div className="ml-1 flex items-center justify-between">
        <label className="text-subtle block text-[11px] font-bold uppercase tracking-wider">
          {label}
        </label>
        {/* Optional Status Indicator */}
        {value.length > 5 && (
          <span className="text-primary flex items-center gap-1 text-[10px]">
            <MdCheck size={12} /> {t('settings.set_status')}
          </span>
        )}
      </div>
      <div className="group relative">
        <div className="text-subtle/50 group-focus-within:text-primary absolute left-3 top-1/2 -translate-y-1/2 transition-colors">
          <MdVpnKey className="text-lg" />
        </div>

        <input
          type={inputType}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="border-border-light dark:border-border-dark focus:border-primary focus:ring-primary/20 w-full rounded-xl border bg-white py-3 pl-10 pr-20 font-mono text-sm shadow-sm transition-all placeholder:font-sans focus:outline-none focus:ring-1 dark:bg-gray-900"
        />

        <div className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1">
          {!value && (
            <button
              onClick={handlePaste}
              className="text-subtle hover:text-text hover:bg-surface-variant rounded-lg p-1.5 transition-colors"
              title={t('settings.paste_tooltip')}
            >
              <MdContentPaste size={16} />
            </button>
          )}

          {isPassword && value && (
            <button
              onClick={() => setIsVisible(!isVisible)}
              className="text-subtle hover:text-text hover:bg-surface-variant rounded-lg p-1.5 transition-colors"
              title={
                isVisible
                  ? t('settings.hide_password')
                  : t('settings.show_password')
              }
            >
              {isVisible ? (
                <MdVisibilityOff size={16} />
              ) : (
                <MdVisibility size={16} />
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

export const AISettingsPanel: React.FC<{
  className?: string
  onClose: () => void
  isSetup?: boolean
}> = ({ className, onClose, isSetup }) => {
  const getDefaultModelForProvider = React.useCallback(
    (provider: AIProvider) => {
      if (provider === 'openai') return 'gpt-4o-mini'
      if (provider === 'anthropic') return 'claude-3-5-haiku-latest'
      if (provider === 'gemini') return 'gemini-1.5-flash'
      if (provider === 'local') return 'local-model'
      return 'gpt-4o-mini'
    },
    [],
  )

  const isModelCompatibleWithProvider = React.useCallback(
    (provider: AIProvider, model: string) => {
      const normalized = (model || '').trim().toLowerCase()
      if (!normalized) return false
      if (provider === 'openai')
        return (
          normalized.startsWith('gpt') ||
          normalized.startsWith('o1') ||
          normalized.startsWith('o3')
        )
      if (provider === 'gemini') return normalized.startsWith('gemini')
      if (provider === 'anthropic') return normalized.startsWith('claude')
      if (provider === 'local')
        return !/^(gpt|o1|o3|gemini|claude)/i.test(normalized)
      return true
    },
    [],
  )

  const [settings, setSettings] = useAISettings()
  const [appSettings] = useSettings()
  const [, setChatState] = useChatbotState()
  const [activeTab, setActiveTab] = useState<Tab>('General')
  const t = useTranslation('ai')

  const [loadingModels, setLoadingModels] = useState(false)
  const [availableModels, setAvailableModels] = useState<SelectGroup[]>([])
  const modelFetchAbortRef = React.useRef<AbortController | null>(null)
  const [slmStatus, setSlmStatus] = useState<ReturnType<typeof getSlmStatus>>(
    getSlmStatus(),
  )
  const [slmError, setSlmError] = useState<string | null>(null)
  const [slmProgress, setSlmProgress] = useState(0)
  const [slmWarning, setSlmWarning] = useState<string | null>(getSlmWarning())
  const [embeddingStatus, setEmbeddingStatus] = useState<
    ReturnType<typeof RAGService.getEmbeddingStatus>
  >(RAGService.getEmbeddingStatus())
  const [embeddingError, setEmbeddingError] = useState<string | null>(null)
  const [embeddingProgress, setEmbeddingProgress] = useState(0)
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
  const statusText = {
    ready: t('status.ready'),
    warning: t('status.warning'),
    downloading: t('status.downloading'),
    error: t('status.error'),
    clickToDownload: t('status.click_to_download'),
  }

  const [isIndexing, setIsIndexing] = useState(false)
  const [indexProgress, setIndexProgress] = useState(0)
  const [showReindexConfirm, setShowReindexConfirm] = useState(false)
  const isMounted = React.useRef(true)
  const activeBookId = reader.focusedBookTab?.book.id
  const hasChunkIndex = useLiveQuery(
    async () => {
      if (!activeBookId || !db) return false
      try {
        // Prefer modern schema with compound key.
        const idx = await db.indices
          .where('[bookId+kind]')
          .equals([activeBookId, 'chunks'])
          .first()
        return !!idx
      } catch (e: any) {
        // Legacy schema fallback.
        const errName = e?.name || e?._e?.name
        if (errName === 'SchemaError' || errName === 'DataError') {
          const idx = await db.indices.get(activeBookId as any)
          return !!idx
        }
        return false
      }
    },
    [activeBookId],
    false,
  )
  const indexedChunkCount = useLiveQuery(
    async () => {
      if (!activeBookId || !db) return 0
      try {
        return await db.vectors.where('bookId').equals(activeBookId).count()
      } catch {
        return 0
      }
    },
    [activeBookId],
    0,
  )
  const isBookIndexed = !!hasChunkIndex || (indexedChunkCount || 0) > 0

  React.useEffect(() => {
    isMounted.current = true
    return () => {
      isMounted.current = false
      modelFetchAbortRef.current?.abort()
      modelFetchAbortRef.current = null
    }
  }, [])

  React.useEffect(() => {
    const statusHandler = (e: any) => {
      const next = e?.detail?.status
      if (
        next === 'unknown' ||
        next === 'downloading' ||
        next === 'ready' ||
        next === 'warning' ||
        next === 'error'
      ) {
        setSlmStatus(next as any)
        if (next !== 'error') setSlmError(null)
      }
      const warning = e?.detail?.warning
      if (typeof warning === 'string') {
        setSlmWarning(warning)
      } else if (warning === null) {
        setSlmWarning(null)
      }
    }
    const progressHandler = (e: any) => {
      if (typeof e?.detail?.progress === 'number')
        setSlmProgress(e.detail.progress)
    }
    const errorHandler = (e: any) => {
      if (e?.detail?.status && e.detail.status !== 'error') return
      const message = e?.detail?.message
      if (typeof message === 'string' && message.length > 0) {
        setSlmError(message)
      }
    }
    window.addEventListener('slm-status', statusHandler)
    window.addEventListener('slm-progress', progressHandler)
    window.addEventListener('slm-error', errorHandler)
    return () => {
      window.removeEventListener('slm-status', statusHandler)
      window.removeEventListener('slm-progress', progressHandler)
      window.removeEventListener('slm-error', errorHandler)
    }
  }, [])

  React.useEffect(() => {
    const statusHandler = (e: any) => {
      const next = e?.detail?.status
      if (
        next === 'unknown' ||
        next === 'downloading' ||
        next === 'ready' ||
        next === 'warning' ||
        next === 'error'
      ) {
        setEmbeddingStatus(next as any)
        if (next !== 'error') setEmbeddingError(null)
      }
      const warning = e?.detail?.warning
      if (typeof warning === 'string') {
        setEmbeddingWarning(warning)
      } else if (warning === null) {
        setEmbeddingWarning(null)
      }
    }
    const progressHandler = (e: any) => {
      if (typeof e?.detail?.progress === 'number')
        setEmbeddingProgress(e.detail.progress)
    }
    const errorHandler = (e: any) => {
      if (e?.detail?.status && e.detail.status !== 'error') return
      const message = e?.detail?.message
      if (typeof message === 'string' && message.length > 0) {
        setEmbeddingError(message)
      }
    }
    window.addEventListener('embedding-status', statusHandler)
    window.addEventListener('embedding-progress', progressHandler)
    window.addEventListener('embedding-error', errorHandler)
    return () => {
      window.removeEventListener('embedding-status', statusHandler)
      window.removeEventListener('embedding-progress', progressHandler)
      window.removeEventListener('embedding-error', errorHandler)
    }
  }, [])

  React.useEffect(() => {
    const handler = (e: any) => {
      const next = e?.detail?.status
      if (
        next === 'unknown' ||
        next === 'downloading' ||
        next === 'ready' ||
        next === 'warning' ||
        next === 'error'
      ) {
        setFastTextStatus(next as any)
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
    window.addEventListener('fasttext-status', handler)
    window.addEventListener('fasttext-error', errorHandler)
    return () => {
      window.removeEventListener('fasttext-status', handler)
      window.removeEventListener('fasttext-error', errorHandler)
    }
  }, [])

  const handleChange = (key: keyof typeof settings, value: any) => {
    setSettings((prev) => ({ ...prev, [key]: value }))
  }

  const handleProviderChange = (nextProvider: AIProvider) => {
    setSettings((prev) => {
      const providerChanged = prev.provider !== nextProvider
      const next = { ...prev, provider: nextProvider }

      // Prevent stale local/custom endpoint from leaking into hosted providers.
      if (
        nextProvider === 'openai' ||
        nextProvider === 'gemini' ||
        nextProvider === 'anthropic'
      ) {
        next.baseUrl = ''
      }

      if (providerChanged) {
        const currentModel = prev.model || ''
        if (!isModelCompatibleWithProvider(nextProvider, currentModel)) {
          next.model = getDefaultModelForProvider(nextProvider)
        }
      }

      return next
    })
    setAvailableModels([])
  }

  const resetDefaults = () => {
    if (confirm(t('confirm_reset'))) {
      setSettings((prev) => ({
        ...defaultAIConfig,
        apiKey: prev.apiKey,
        provider: prev.provider,
        model: getDefaultModelForProvider(prev.provider),
        baseUrl:
          prev.provider === 'local' || prev.provider === 'custom'
            ? prev.baseUrl
            : '',
      }))
    }
  }

  const clearHistory = () => {
    if (confirm(t('confirm_clear'))) {
      setChatState((prev) => ({ ...prev, messages: [] }))
    }
  }

  const runReindexBook = async (bookId: string) => {
    if (!bookId) return
    if (isIndexing) return

    setIsIndexing(true)
    setIndexProgress(0)

    try {
      const fileRecord = await db?.files.get(bookId)
      if (!fileRecord) throw new Error('Book file not found in local database.')

      const rag = RAGService.getInstance()
      // SOTA: Pass normalized book language for accurate segmentation
      const bookLang = normalizeLangForRAG(
        reader.focusedBookTab?.book.metadata?.language,
        appSettings.locale || 'en',
      )

      await rag.indexBook(
        fileRecord.file,
        bookId,
        (p) => {
          if (isMounted.current) {
            setIndexProgress(p)
          }
        },
        bookLang,
      )
      if (isMounted.current) {
        alert(t('index.success'))
      }
    } catch (e: any) {
      if (isMounted.current) {
        alert(t('index.failed', { error: e.message }))
      }
    } finally {
      if (isMounted.current) {
        setIsIndexing(false)
        setIndexProgress(0)
      }
    }
  }

  const reindexBook = () => {
    const bookId = reader.focusedBookTab?.book.id
    if (!bookId) {
      alert(t('index.no_book'))
      return
    }

    if (isBookIndexed) {
      setShowReindexConfirm(true)
      return
    }

    void runReindexBook(bookId)
  }

  const confirmReindexBook = () => {
    setShowReindexConfirm(false)
    const bookId = reader.focusedBookTab?.book.id
    if (!bookId) return
    void runReindexBook(bookId)
  }

  const fetchModels = React.useCallback(
    async (options?: { force?: boolean }) => {
      const force = options?.force === true
      if (!settings.apiKey) return alert(t('settings.enter_api_key_first'))

      const cacheKey = buildModelCacheKey(settings.provider, settings.apiKey)
      if (!force) {
        const cached = MODEL_FETCH_CACHE.get(cacheKey)
        const isFresh =
          cached && Date.now() - cached.fetchedAt < MODEL_FETCH_CACHE_TTL_MS
        if (isFresh && cached) {
          setAvailableModels(cached.groups)
          return
        }
      }

      modelFetchAbortRef.current?.abort()
      const abortController = new AbortController()
      modelFetchAbortRef.current = abortController

      setLoadingModels(true)
      setAvailableModels([])

      try {
        let groups: SelectGroup[] = []

        if (settings.provider === 'gemini') {
          const res = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models`,
            {
              headers: { 'x-goog-api-key': settings.apiKey },
              signal: abortController.signal,
            },
          )
          if (!res.ok) throw new Error('Failed to fetch from Google')
          const data = await res.json()

          const blacklist =
            /(gemma|deep-research|computer-use|vision|aqa|embedding|imaging|imagen|image|text-|translator|metadata|attr|realtime|audio|instruct|nano|bison|gecko|tts|speech|sound|media)/i

          // 1. Initial Metadata Filter
          const candidates = data.models.filter((m: any) => {
            const methods = m.supportedGenerationMethods || []
            const name = m.name.toLowerCase()
            return methods.includes('generateContent') && !blacklist.test(name)
          })

          // Optional strict verification:
          // - Auto load: metadata-only (fast, no request storm).
          // - Manual refresh: verify accessibility via countTokens.
          let filtered = candidates
          if (force) {
            const verificationResults = await Promise.allSettled(
              candidates.map(async (m: any) => {
                const verifyRes = await fetch(
                  `https://generativelanguage.googleapis.com/v1beta/${m.name}:countTokens`,
                  {
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/json',
                      'x-goog-api-key': settings.apiKey,
                    },
                    body: JSON.stringify({
                      contents: [{ parts: [{ text: '' }] }],
                    }),
                    signal: abortController.signal,
                  },
                )
                if (!verifyRes.ok) throw new Error('Access Denied')
                return m
              }),
            )

            filtered = verificationResults
              .map((r) => (r.status === 'fulfilled' ? r.value : null))
              .filter((m): m is any => m !== null)
          }

          const powerhouse: SelectOption[] = []
          const reasoning: SelectOption[] = []
          const fast: SelectOption[] = []
          const experimental: SelectOption[] = []

          filtered.forEach((m: any) => {
            const id = m.name.replace('models/', '')
            const lowerId = id.toLowerCase()
            const option: SelectOption = {
              value: id,
              label: id,
              icon: <GeminiIcon />,
            }

            // Priority-based categorization

            // 1. Reasoning (Chain of Thought)
            if (
              lowerId.includes('deep-think') ||
              lowerId.includes('thinking') ||
              lowerId.startsWith('o1') ||
              lowerId.startsWith('o3')
            ) {
              reasoning.push(option)
            }
            // 2. Powerhouse (Frontier Intelligence)
            // Includes Gemini 2.5+, 3.0, Ultra
            else if (
              lowerId.includes('gemini-3') ||
              lowerId.includes('gemini-2.5') ||
              lowerId.includes('ultra')
            ) {
              powerhouse.push(option)
            }
            // 3. Fast / Efficient (Includes Legacy Frontier)
            // Includes 1.5 Pro, Flash, Mini, GPT-4
            else if (
              lowerId.includes('flash') ||
              lowerId.includes('mini') ||
              lowerId.includes('haiku') ||
              lowerId.includes('pro') ||
              lowerId.includes('gpt-4')
            ) {
              fast.push(option)
            }
            // 4. Other
            else {
              experimental.push(option)
            }
          })

          groups = [
            {
              label: `🧠 ${t('settings.model_category.reasoning')}`,
              options: reasoning.sort((a, b) =>
                b.value.localeCompare(a.value, undefined, { numeric: true }),
              ),
            },
            {
              label: `💪 ${t('settings.model_category.powerhouse')}`,
              options: powerhouse.sort((a, b) =>
                b.value.localeCompare(a.value, undefined, { numeric: true }),
              ),
            },
            {
              label: `⚡ ${t('settings.model_category.fast')}`,
              options: fast.sort((a, b) =>
                b.value.localeCompare(a.value, undefined, { numeric: true }),
              ),
            },
            {
              label: `🧪 ${t('settings.model_category.other')}`,
              options: experimental.sort((a, b) =>
                b.value.localeCompare(a.value, undefined, { numeric: true }),
              ),
            },
          ].filter((g) => g.options.length > 0)
        } else if (settings.provider === 'openai') {
          const res = await fetch('https://api.openai.com/v1/models', {
            headers: { Authorization: `Bearer ${settings.apiKey}` },
            signal: abortController.signal,
          })
          if (!res.ok) throw new Error('Failed to fetch from OpenAI')
          const data = await res.json()

          const blacklist =
            /(audio|realtime|instruct|vision|embedding|dall-e|tts|whisper)/i
          const filtered = data.data.filter((m: any) => {
            const id = m.id.toLowerCase()
            return (
              (id.startsWith('gpt') ||
                id.startsWith('o1') ||
                id.startsWith('o3')) &&
              !blacklist.test(id)
            )
          })

          const powerhouse: SelectOption[] = []
          const reasoning: SelectOption[] = []
          const fast: SelectOption[] = []
          const experimental: SelectOption[] = []

          filtered.forEach((m: any) => {
            const id = m.id
            const lowerId = id.toLowerCase()
            const option: SelectOption = {
              value: id,
              label: id,
              icon: <OpenAIIcon />,
            }

            if (lowerId.startsWith('o1') || lowerId.startsWith('o3')) {
              reasoning.push(option)
            } else if (lowerId.includes('gpt-5')) {
              powerhouse.push(option)
            } else if (lowerId.includes('gpt-4')) {
              // Per user, GPT-4 is now "outdated" / efficient compared to GPT-5
              fast.push(option)
            } else if (lowerId.includes('mini')) {
              fast.push(option)
            } else {
              experimental.push(option)
            }
          })

          groups = [
            {
              label: `🧠 ${t('settings.model_category.reasoning')}`,
              options: reasoning.sort((a, b) =>
                b.value.localeCompare(a.value, undefined, { numeric: true }),
              ),
            },
            {
              label: `💪 ${t('settings.model_category.powerhouse')}`,
              options: powerhouse.sort((a, b) =>
                b.value.localeCompare(a.value, undefined, { numeric: true }),
              ),
            },
            {
              label: `⚡ ${t('settings.model_category.fast')}`,
              options: fast.sort((a, b) =>
                b.value.localeCompare(a.value, undefined, { numeric: true }),
              ),
            },
            {
              label: `🧪 ${t('settings.model_category.other')}`,
              options: experimental.sort((a, b) =>
                b.value.localeCompare(a.value, undefined, { numeric: true }),
              ),
            },
          ].filter((g) => g.options.length > 0)
        } else if (settings.provider === 'anthropic') {
          const res = await fetch('https://api.anthropic.com/v1/models', {
            headers: {
              'x-api-key': settings.apiKey,
              'anthropic-version': '2023-06-01',
              'anthropic-dangerous-direct-browser-access': 'true',
            },
            signal: abortController.signal,
          })
          if (!res.ok) throw new Error('Failed to fetch from Anthropic')
          const data = await res.json()

          const options = data.data.map((m: any) => ({
            value: m.id,
            label: m.id,
            icon: <AnthropicIcon />,
          }))

          groups = [
            {
              label: t('settings.claude_series'),
              options: options.sort((a, b) =>
                b.value.localeCompare(a.value, undefined, { numeric: true }),
              ),
            },
          ]
        }

        if (abortController.signal.aborted) return
        setAvailableModels(groups)
        MODEL_FETCH_CACHE.set(cacheKey, {
          fetchedAt: Date.now(),
          groups,
        })
      } catch (e) {
        if ((e as any)?.name === 'AbortError') return
        alert(t('settings.fetch_models_error'))
        console.error('[Model Fetch Error]', sanitizeErrorForLogs(e))
      } finally {
        if (modelFetchAbortRef.current === abortController) {
          modelFetchAbortRef.current = null
        }
        if (!abortController.signal.aborted) {
          setLoadingModels(false)
        }
      }
    },
    [settings.apiKey, settings.provider, t],
  )

  React.useEffect(() => {
    if (
      settings.apiKey &&
      ['openai', 'gemini', 'anthropic'].includes(settings.provider)
    ) {
      void fetchModels()
    }
  }, [settings.provider, settings.apiKey, fetchModels])

  return (
    <div
      className={clsx(
        'ai-settings-panel relative flex h-full flex-col bg-white dark:bg-gray-900',
        className,
      )}
    >
      {/* Sticky Header Group */}
      <div className="border-border-light dark:border-border-dark sticky top-0 z-[50] border-b bg-white dark:bg-gray-900">
        {/* Header Title */}
        <div className="flex items-center justify-between bg-white p-4 dark:bg-gray-900">
          <div className="flex items-center gap-3">
            <div className="bg-primary/10 text-primary flex h-10 w-10 items-center justify-center rounded-xl">
              <MdSettings className="text-2xl" />
            </div>
            <h3 className="text-lg font-bold tracking-tight">
              {t('settings.config_title')}
            </h3>
          </div>
          {!isSetup && (
            <button
              onClick={onClose}
              className="hover:bg-surface-variant text-subtle hover:text-text group rounded-full p-2 transition-colors"
            >
              <MdClose className="text-2xl transition-transform duration-300 group-hover:rotate-90" />
            </button>
          )}
        </div>

        {/* Tabs */}
        <div className="flex bg-white dark:bg-gray-900">
          {TABS.map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={clsx(
                'flex-1 py-3 text-sm font-medium transition-colors',
                activeTab === tab
                  ? 'text-primary border-primary border-b-2'
                  : 'text-subtle hover:text-text',
              )}
            >
              {t(`tabs.${tab.toLowerCase()}`)}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div className="ai-settings-panel-content custom-scrollbar flex-1 space-y-6 overflow-y-auto bg-white p-4 dark:bg-gray-900">
        {/* GENERAL TAB */}
        {activeTab === 'General' && (
          <div className="space-y-4">
            <PremiumSelect
              label={t('provider')}
              value={settings.provider}
              options={[
                { value: 'gemini', label: 'Gemini', icon: <GeminiIcon /> },
                { value: 'openai', label: 'OpenAI', icon: <OpenAIIcon /> },
                {
                  value: 'anthropic',
                  label: 'Anthropic',
                  icon: <AnthropicIcon />,
                },
                { value: 'local', label: 'Local', icon: <MdComputer /> },
                { value: 'custom', label: 'Custom', icon: <MdDns /> },
              ]}
              onChange={(val) => handleProviderChange(val as AIProvider)}
              icon={
                settings.provider === 'openai' ? (
                  <OpenAIIcon />
                ) : settings.provider === 'gemini' ? (
                  <GeminiIcon />
                ) : settings.provider === 'anthropic' ? (
                  <AnthropicIcon />
                ) : settings.provider === 'local' ? (
                  <MdComputer />
                ) : (
                  <MdDns />
                )
              }
            />

            {settings.provider !== 'local' &&
              settings.provider !== 'custom' && (
                <PremiumInput
                  label={t('api_key')}
                  value={settings.apiKey}
                  onChange={(val) => handleChange('apiKey', val)}
                  placeholder={t('settings.api_key_placeholder')}
                  type="password"
                />
              )}

            {/* Local / Custom specific fields */}
            {(settings.provider === 'local' ||
              settings.provider === 'custom') && (
              <div className="bg-primary/5 border-primary/10 space-y-3 rounded-xl border p-3">
                <div className="text-primary/80 text-[11px] font-medium leading-relaxed">
                  {settings.provider === 'local'
                    ? t('settings.model_hint.local')
                    : t('settings.model_hint.custom')}
                </div>
                <div className="space-y-1.5">
                  <label className="text-subtle ml-1 block text-[11px] font-bold uppercase tracking-wider">
                    {t('base_url')}
                  </label>
                  <TextField
                    name="Base URL"
                    hideLabel
                    value={settings.baseUrl || ''}
                    onChange={(e) => handleChange('baseUrl', e.target.value)}
                    placeholder={
                      settings.provider === 'local'
                        ? 'http://localhost:11434/v1'
                        : 'https://api.proxy.com/v1'
                    }
                  />
                </div>
                {settings.provider === 'custom' && (
                  <PremiumInput
                    label={`${t('settings.proxy_api_key')} *`}
                    value={settings.apiKey}
                    onChange={(val) => handleChange('apiKey', val)}
                    type="password"
                    placeholder="sk-..."
                  />
                )}
              </div>
            )}

            <div className="space-y-2">
              <div className="ml-1 flex items-center justify-between">
                <label className="text-subtle block text-[11px] font-bold uppercase tracking-wider">
                  {t('model')}
                </label>
                {['openai', 'gemini', 'anthropic'].includes(
                  settings.provider,
                ) &&
                  settings.apiKey && (
                    <button
                      onClick={() => void fetchModels({ force: true })}
                      disabled={loadingModels}
                      className="text-primary flex items-center gap-1 text-[10px] font-medium hover:underline disabled:opacity-50"
                    >
                      <MdRefresh
                        className={clsx(loadingModels && 'animate-spin')}
                      />
                      {loadingModels
                        ? t('chatbot.thinking').replace('...', '')
                        : t('maintenance.refresh_list')}
                    </button>
                  )}
              </div>

              <PremiumSelect
                label=""
                value={settings.model}
                options={
                  availableModels.length > 0
                    ? availableModels
                    : [{ value: settings.model, icon: <MdSmartToy /> }]
                }
                onChange={(val) => handleChange('model', val)}
                searchable={
                  availableModels.reduce(
                    (acc, g) => acc + (g.options?.length || 0),
                    0,
                  ) > 5
                }
                placeholder={t('settings.select_model_placeholder')}
                icon={<MdSmartToy />}
              />

              <div className="grid grid-cols-2 gap-3 pt-2">
                <PremiumSelect
                  label={t('answer_depth')}
                  value={settings.answerDepth}
                  options={[
                    {
                      value: 'short',
                      label: t('answer_depth.short'),
                      icon: <MdChevronRight />,
                    },
                    {
                      value: 'balanced',
                      label: t('answer_depth.balanced'),
                      icon: <MdChevronRight />,
                    },
                    {
                      value: 'deep',
                      label: t('answer_depth.deep'),
                      icon: <MdChevronRight />,
                    },
                  ]}
                  onChange={(val) => handleChange('answerDepth', val)}
                />
                <PremiumSelect
                  label={t('scope')}
                  value={settings.aiScope}
                  options={[
                    {
                      value: 'book_only',
                      label: t('scope.book_only'),
                      icon: <MdLock />,
                    },
                    {
                      value: 'book_plus_discussion',
                      label: t('scope.plus_discussion'),
                      icon: <MdSmartToy />,
                    },
                  ]}
                  onChange={(val) => handleChange('aiScope', val)}
                />
              </div>

              <div className="bg-surface-1 border-border-light dark:border-border-dark space-y-3 rounded-xl border p-3">
                {/* Download Toggle & Permissions */}
                <div className="flex items-center justify-between">
                  <div className="flex flex-col">
                    <span className="text-subtle ml-1 text-[10px] font-bold uppercase tracking-wider">
                      {t('settings.download_models')}
                    </span>
                    <span className="text-subtle ml-1 block max-w-[200px] text-[9px] leading-tight opacity-70">
                      {t('settings.download_models_desc')}
                    </span>
                  </div>
                  <div className="relative inline-flex shrink-0 self-center">
                    <Switch
                      checked={settings.downloadLocalModels}
                      onChange={(checked) =>
                        handleChange('downloadLocalModels', checked)
                      }
                    />
                  </div>
                </div>

                {settings.downloadLocalModels && (
                  <div className="animate-in fade-in slide-in-from-top-1">
                    <PermissionButton />
                  </div>
                )}

                <div className="bg-border-light dark:bg-border-dark h-px opacity-50" />

                <label className="text-subtle ml-1 block text-[10px] font-bold uppercase tracking-wider">
                  {t('settings.local_models_status')}
                </label>
                <div className="flex items-center justify-center gap-4">
                  <StatusIndicator
                    label="SLM"
                    status={slmStatus}
                    progress={slmProgress}
                    onClick={preloadSlm}
                    icon={<MdSmartToy className="text-[14px]" />}
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
                    progress={embeddingProgress}
                    onClick={() =>
                      RAGService.preloadEmbeddings(undefined, {
                        downloadLocalModels: settings.downloadLocalModels,
                      })
                    }
                    icon={<MdStorage className="text-[14px]" />}
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
                    icon={<MdTranslate className="text-[14px]" />}
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
              </div>
            </div>
          </div>
        )}

        {/* PERSONA TAB */}
        {activeTab === 'Persona' && (
          <div className="flex h-full flex-col space-y-4">
            <div className="flex flex-1 flex-col">
              <label className="text-subtle mb-1 block text-xs font-bold uppercase tracking-wider">
                {t('system_prompt')}
              </label>
              <textarea
                className="text-text placeholder:text-subtle border-border-light dark:border-border-dark focus:border-primary min-h-[200px] w-full flex-1 resize-none rounded-xl border bg-white p-3 text-sm leading-relaxed shadow-inner focus:outline-none dark:bg-gray-900"
                value={settings.systemPrompt}
                onChange={(e) => handleChange('systemPrompt', e.target.value)}
                placeholder={t('settings.system_prompt_placeholder')}
              />
              <p className="text-subtle mt-2 text-[11px] leading-relaxed">
                {t('settings.adaptive_context_hint')}
              </p>
            </div>
          </div>
        )}

        {/* ADVANCED TAB */}
        {activeTab === 'Advanced' && (
          <div className="space-y-6">
            <div className="space-y-3 pt-0">
              <label className="text-subtle block text-xs font-bold uppercase tracking-wider">
                {t('maintenance')}
              </label>
              <div className="grid grid-cols-2 gap-3">
                <button
                  onClick={reindexBook}
                  disabled={isIndexing || !activeBookId}
                  className={clsx(
                    'group col-span-2 flex items-center justify-between gap-2 rounded-xl border p-3.5 shadow-sm transition-all disabled:opacity-50',
                    isBookIndexed
                      ? 'hover:bg-emerald-500/15 hover:border-emerald-500/35 border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                      : 'border-primary/20 bg-primary/5 hover:bg-primary/10 hover:border-primary/30 text-primary',
                  )}
                >
                  <div className="flex items-center gap-3">
                    {isBookIndexed && !isIndexing ? (
                      <MdCheck className="text-xl" />
                    ) : (
                      <MdStorage
                        className={clsx(
                          'text-xl',
                          isIndexing && 'animate-pulse',
                        )}
                      />
                    )}
                    <div className="flex flex-col items-start">
                      <span className="text-[10px] font-bold uppercase tracking-wider">
                        {isIndexing
                          ? t('chatbot.thinking').replace('...', '') + '...'
                          : isBookIndexed
                          ? t('status.ready')
                          : t('reindex')}
                      </span>
                      <span className="text-[9px] leading-tight opacity-70">
                        {isBookIndexed
                          ? t('reindex_desc')
                          : t('chatbot.index_description')}
                      </span>
                    </div>
                  </div>
                  {isIndexing && (
                    <span className="font-mono text-xs font-bold">
                      {indexProgress}%
                    </span>
                  )}
                  {!isIndexing && (
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] font-semibold opacity-80">
                        {isBookIndexed
                          ? (indexedChunkCount || 0) > 0
                            ? `${indexedChunkCount} chunks`
                            : t('status.ready')
                          : t('status.not_indexed')}
                      </span>
                      <MdChevronRight className="text-subtle transition-transform group-hover:translate-x-0.5" />
                    </div>
                  )}
                </button>
                <button
                  onClick={clearHistory}
                  className="border-border-light dark:border-border-dark bg-surface-1 hover:bg-error/5 hover:border-error/20 hover:text-error group flex flex-col items-center justify-center gap-2 rounded-xl border p-3 shadow-sm transition-all"
                >
                  <MdDeleteSweep className="text-subtle group-hover:text-error text-xl transition-colors" />
                  <span className="text-[10px] font-bold uppercase tracking-wider">
                    {t('clear_history')}
                  </span>
                </button>
                <button
                  onClick={resetDefaults}
                  className="border-border-light dark:border-border-dark bg-surface-1 hover:bg-primary/5 hover:border-primary/20 hover:text-primary group flex flex-col items-center justify-center gap-2 rounded-xl border p-3 shadow-sm transition-all"
                >
                  <MdRefresh className="text-subtle group-hover:text-primary text-xl transition-colors" />
                  <span className="text-[10px] font-bold uppercase tracking-wider">
                    {t('reset_defaults')}
                  </span>
                </button>
              </div>
            </div>

            <div className="space-y-4">
              <label className="text-subtle mb-1 block text-xs font-bold uppercase tracking-wider">
                {t('tabs.advanced')}
              </label>

              <div className="bg-surface-1 border-border-light dark:border-border-dark group flex items-center justify-between rounded-xl border p-3.5 transition-all">
                <div className="flex flex-col pr-4">
                  <span className="group-hover:text-primary text-sm font-semibold transition-colors">
                    {t('insight_triggers')}
                  </span>
                  <span className="text-subtle text-[10px] leading-tight">
                    {t('insight_triggers_desc')}
                  </span>
                </div>
                <div className="relative inline-flex shrink-0 self-center">
                  <Switch
                    checked={settings.insightTriggers}
                    onChange={(checked) =>
                      handleChange('insightTriggers', checked)
                    }
                  />
                </div>
              </div>

              <div className="bg-surface-1 border-border-light dark:border-border-dark group flex items-center justify-between rounded-xl border p-3.5 transition-all">
                <div className="flex flex-col pr-4">
                  <span className="group-hover:text-primary text-sm font-semibold transition-colors">
                    {t('auto_persona')}
                  </span>
                  <span className="text-subtle text-[10px] leading-tight">
                    {t('auto_persona_desc')}
                  </span>
                </div>
                <div className="relative inline-flex shrink-0 self-center">
                  <Switch
                    checked={settings.autoPersona}
                    onChange={(checked) => handleChange('autoPersona', checked)}
                  />
                </div>
              </div>

              <div className="bg-surface-1 border-border-light dark:border-border-dark group flex items-center justify-between rounded-xl border p-3.5 transition-all">
                <div className="flex flex-col pr-4">
                  <span className="group-hover:text-primary text-sm font-semibold transition-colors">
                    {t('deep_think')}
                  </span>
                  <span className="text-subtle text-[10px] leading-tight">
                    {t('deep_think_desc')}
                  </span>
                </div>
                <div className="relative inline-flex shrink-0 self-center">
                  <Switch
                    checked={settings.deepThink}
                    onChange={(checked) => handleChange('deepThink', checked)}
                  />
                </div>
              </div>

              <div className="bg-surface-1 border-border-light dark:border-border-dark group flex items-center justify-between rounded-xl border p-3.5 transition-all">
                <div className="flex flex-col pr-4">
                  <span className="group-hover:text-primary text-sm font-semibold transition-colors">
                    {t('selection.explain')}
                  </span>
                  <span className="text-subtle text-[10px] leading-tight">
                    {t('selection.explain_desc')}
                  </span>
                </div>
                <div className="relative inline-flex shrink-0 self-center">
                  <Switch
                    checked={settings.explainSelection}
                    onChange={(checked) =>
                      handleChange('explainSelection', checked)
                    }
                  />
                </div>
              </div>

              <div className="bg-surface-1 border-border-light dark:border-border-dark group flex items-center justify-between rounded-xl border p-3.5 transition-all">
                <div className="flex flex-col pr-4">
                  <span className="group-hover:text-primary text-sm font-semibold transition-colors">
                    {t('selection.summarize')}
                  </span>
                  <span className="text-subtle text-[10px] leading-tight">
                    {t('selection.summarize_desc')}
                  </span>
                </div>
                <div className="relative inline-flex shrink-0 self-center">
                  <Switch
                    checked={settings.summarizeSelection}
                    onChange={(checked) =>
                      handleChange('summarizeSelection', checked)
                    }
                  />
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ADVANCED TAB */}
        {activeTab === 'Advanced' && (
          <div className="space-y-6">
            <div className="py-2.5">
              <div className="mb-3 flex justify-between">
                <label className="text-subtle block text-xs font-bold uppercase tracking-wider">
                  {t('temperature')}
                </label>
                <span className="bg-surface-variant text-primary border-primary/10 rounded border px-2 py-0.5 font-mono text-xs shadow-inner">
                  {settings.temperature}
                </span>
              </div>
              <input
                type="range"
                min="0"
                max="2"
                step="0.1"
                className="premium-slider"
                value={settings.temperature}
                onChange={(e) =>
                  handleChange('temperature', parseFloat(e.target.value))
                }
              />
              <div className="text-subtle mt-1 flex justify-between px-0.5 text-[10px] font-bold uppercase tracking-tight">
                <span>{t('settings.temperature.precise')}</span>
                <span>{t('settings.temperature.balanced')}</span>
                <span>{t('settings.temperature.creative')}</span>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="border-border-light dark:border-border-dark sticky bottom-0 z-[50] mt-auto space-y-4 border-t bg-white p-4 shadow-[0_-4px_20px_rgba(0,0,0,0.05)] dark:bg-gray-900">
        <div className="bg-primary/5 border-primary/10 text-subtle flex items-center gap-3 rounded-xl border p-3">
          <MdLock className="text-primary flex-shrink-0 text-xl" />
          <p className="text-[10px] leading-relaxed">
            <strong className="text-primary mr-1 uppercase tracking-tighter">
              {t('settings.privacy_first')}
            </strong>
            {t('settings.privacy_desc')}
          </p>
        </div>

        <Button
          className="shadow-primary/20 flex w-full items-center justify-center gap-2 py-3.5 font-bold shadow-lg"
          onClick={onClose}
        >
          {isSetup ? t('settings.start_assistant') : t('settings.save_changes')}
        </Button>
      </div>

      {showReindexConfirm && !isIndexing && (
        <div className="absolute inset-0 z-[260] flex items-center justify-center p-4">
          <div
            className="bg-black/45 absolute inset-0 backdrop-blur-[1px]"
            onClick={() => setShowReindexConfirm(false)}
          />
          <div className="border-border-light dark:border-border-dark relative w-full max-w-md rounded-2xl border bg-white shadow-2xl dark:bg-gray-900">
            <div className="border-border-light dark:border-border-dark border-b p-5">
              <h4 className="text-text text-sm font-bold">
                {t('confirm_reindex_title')}
              </h4>
              <p className="text-subtle mt-2 text-xs leading-relaxed">
                {t('confirm_reindex_desc')}
              </p>
            </div>
            <div className="flex items-center justify-end gap-2 p-4">
              <button
                onClick={() => setShowReindexConfirm(false)}
                className="border-border-light dark:border-border-dark bg-surface-1 hover:bg-surface-variant text-subtle hover:text-text rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors"
              >
                {t('confirm_reindex_cancel')}
              </button>
              <button
                onClick={confirmReindexBook}
                className="bg-primary hover:bg-primary-dark rounded-lg px-3 py-1.5 text-xs font-semibold text-white transition-colors"
              >
                {t('confirm_reindex_action')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

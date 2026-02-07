import clsx from 'clsx'
import React, { useState } from 'react'
import { MdDeleteSweep as _MdDeleteSweep, MdLock as _MdLock, MdRefresh as _MdRefresh, MdSearch as _MdSearch, MdChevronRight as _MdChevronRight, MdCheck as _MdCheck, MdSmartToy as _MdSmartToy, MdComputer as _MdComputer, MdSettings as _MdSettings, MdClose as _MdClose, MdDns as _MdDns, MdVpnKey as _MdVpnKey, MdVisibility as _MdVisibility, MdVisibilityOff as _MdVisibilityOff, MdContentPaste as _MdContentPaste, MdStorage as _MdStorage, MdTranslate as _MdTranslate } from 'react-icons/md'
import { SiOpenai as _SiOpenai } from 'react-icons/si'

import { db } from '../db'
import { useTranslation } from '../hooks/useTranslation'
import { getFastTextStatus, normalizeLangForRAG, preloadFastText } from '../lib/ai/language'
import { RAGService } from '../lib/ai/rag'
import { getSlmStatus, getSlmWarning, preloadSlm } from '../lib/ai/rewriter'
import { reader } from '../models'
import { defaultAIConfig, useAISettings, useChatbotState, useSettings } from '../state'

import { Button } from './Button'
import { TextField } from './Form'
import { StatusIndicator } from './StatusIndicator'
import { AnthropicIcon as _AnthropicIcon, GeminiIcon as _GeminiIcon } from './icons/ProviderIcons'

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
const SiOpenai = _SiOpenai as any
const GeminiIcon = _GeminiIcon as any
const AnthropicIcon = _AnthropicIcon as any



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

interface PremiumSelectProps {
    label: string
    value: string
    options: string[] | SelectOption[] | SelectGroup[]
    onChange: (val: any) => void
    searchable?: boolean
    icon?: React.ReactNode
    placeholder?: string
}

const PremiumSelect: React.FC<PremiumSelectProps> = ({ label, value, options, onChange, searchable, icon, placeholder }) => {
    const t = useTranslation('ai')
    const [isOpen, setIsOpen] = useState(false)
    const [search, setSearch] = useState('')
    const containerRef = React.useRef<HTMLDivElement>(null)

    const groups: SelectGroup[] = React.useMemo(() => {
        if (!options || options.length === 0) return []
        if (typeof options[0] === 'string') {
            return [{ label: '', options: (options as string[]).map(o => ({ value: o })) }]
        }
        if ('options' in options[0]) {
            return options as SelectGroup[]
        }
        return [{ label: '', options: options as SelectOption[] }]
    }, [options])

    const filteredGroups = groups.map(group => ({
        ...group,
        options: group.options.filter(o =>
            (o.value || '').toLowerCase().includes(search.toLowerCase()) ||
            (o.label && o.label.toLowerCase().includes(search.toLowerCase()))
        )
    })).filter(group => group.options.length > 0)

    const selectedOption = React.useMemo(() => {
        for (const g of groups) {
            const found = g.options.find(o => o.value === value)
            if (found) return found
        }
        return null
    }, [groups, value])

    React.useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            const target = event.target as HTMLElement;
            if (containerRef.current && !containerRef.current.contains(target)) {
                // SOTA UX: Don't close if clicking within the AI settings panel (e.g., scrollbars, padding)
                // This prevents accidental closing when dragging the main sidebar scrollbar.
                if (target.closest('.ai-settings-panel')) {
                    // Check if it's a click that *should* close (like clicking another select or a button)
                    // but for now, we prioritize allowing scrollbar interactions in the panel.

                    // Detect scrollbar click via coordinate check (standard heuristic)
                    const isScrollbar = target.clientWidth < target.offsetWidth || target.clientHeight < target.offsetHeight;
                    if (isScrollbar) return;

                    // If the user clicked specifically on the scrollable container's background
                    // (prevents closing when clicking the track of the scrollbar)
                    if (target.classList.contains('ai-settings-panel-content')) return;
                    if (target.classList.contains('custom-scrollbar')) return;
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
        <div className={clsx('space-y-1.5 relative', isOpen && 'z-[100]')} ref={containerRef}>
            <label className="block text-[11px] font-bold text-subtle uppercase tracking-wider ml-1">{label}</label>
            <button
                onClick={() => setIsOpen(!isOpen)}
                className="w-full flex items-center justify-between p-3 rounded-xl bg-white dark:bg-gray-900 border border-border-light dark:border-border-dark hover:border-primary/50 transition-all text-sm group"
            >
                <div className="flex items-center gap-2.5 overflow-hidden text-left">
                    <span className="text-primary opacity-70 group-hover:opacity-100 transition-opacity whitespace-nowrap">
                        {selectedOption?.icon || icon}
                    </span>
                    <span className="truncate font-medium capitalize">
                        {selectedOption?.label || selectedOption?.value || placeholder || t('settings.select_model_placeholder')}
                    </span>
                </div>
                {React.createElement(MdChevronRight as any, { className: clsx('text-lg text-subtle transition-transform flex-shrink-0', isOpen && 'rotate-90') })}
            </button>

            {isOpen && (
                <div className="absolute top-[calc(100%+4px)] left-0 w-full bg-white dark:bg-gray-900 border border-border-light dark:border-border-dark rounded-xl shadow-2xl z-[110] overflow-hidden animate-in fade-in slide-in-from-top-2 duration-200 ring-4 ring-black/5 backdrop-blur-xl">
                    {searchable && (
                        <div className="p-2 border-b border-border-light dark:border-border-dark bg-white/50 dark:bg-gray-900/50">
                            <div className="relative flex items-center">
                                <MdSearch className="absolute left-3 text-subtle" />
                                <input
                                    autoFocus
                                    className="w-full pl-9 pr-3 py-2 bg-white dark:bg-gray-900 border border-border-light dark:border-border-dark rounded-lg text-xs focus:border-primary focus:outline-none"
                                    placeholder={t('settings.search_placeholder')}
                                    value={search}
                                    onChange={e => setSearch(e.target.value)}
                                    onClick={e => e.stopPropagation()}
                                />
                            </div>
                        </div>
                    )}
                    <div className="max-h-[250px] overflow-y-auto p-1 custom-scrollbar">
                        {filteredGroups.length === 0 && (
                            <div className="p-4 text-center text-xs text-subtle italic">{t('settings.no_results')}</div>
                        )}
                        {filteredGroups.map((group, gIdx) => (
                            <div key={group.label || gIdx} className="space-y-1">
                                {group.label && (
                                    <div className="px-3 py-2 text-[10px] font-bold text-subtle uppercase tracking-widest opacity-50">
                                        {group.label}
                                    </div>
                                )}
                                {group.options.map(opt => (
                                    <button
                                        key={opt.value}
                                        onClick={() => {
                                            onChange(opt.value)
                                            setIsOpen(false)
                                        }}
                                        className={clsx(
                                            'w-full flex items-center justify-between px-3 py-2.5 rounded-lg text-sm text-left transition-colors hover:bg-primary/5',
                                            value === opt.value ? 'text-primary bg-primary/10 font-semibold' : 'text-subtle hover:text-text'
                                        )}
                                    >
                                        <div className="flex items-center gap-2.5 overflow-hidden">
                                            {opt.icon && <span className="opacity-70 flex-shrink-0">{opt.icon}</span>}
                                            <span className="truncate capitalize">{opt.label || opt.value}</span>
                                        </div>
                                        {value === opt.value && <MdCheck className="text-primary flex-shrink-0" />}
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

const PremiumInput: React.FC<PremiumInputProps> = ({ label, value, onChange, placeholder, type = 'text' }) => {
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
            <div className="flex justify-between items-center ml-1">
                <label className="block text-[11px] font-bold text-subtle uppercase tracking-wider">{label}</label>
                {/* Optional Status Indicator */}
                {value.length > 5 && (
                    <span className="text-[10px] text-primary flex items-center gap-1">
                        <MdCheck size={12} /> {t('settings.set_status')}
                    </span>
                )}
            </div>
            <div className="relative group">
                <div className="absolute left-3 top-1/2 -translate-y-1/2 text-subtle/50 group-focus-within:text-primary transition-colors">
                    <MdVpnKey className="text-lg" />
                </div>

                <input
                    type={inputType}
                    value={value}
                    onChange={(e) => onChange(e.target.value)}
                    placeholder={placeholder}
                    className="w-full pl-10 pr-20 py-3 bg-white dark:bg-gray-900 border border-border-light dark:border-border-dark rounded-xl text-sm font-mono focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/20 transition-all shadow-sm placeholder:font-sans"
                />

                <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
                    {!value && (
                        <button
                            onClick={handlePaste}
                            className="p-1.5 text-subtle hover:text-text hover:bg-surface-variant rounded-lg transition-colors"
                            title={t('settings.paste_tooltip')}
                        >
                            <MdContentPaste size={16} />
                        </button>
                    )}

                    {isPassword && value && (
                        <button
                            onClick={() => setIsVisible(!isVisible)}
                            className="p-1.5 text-subtle hover:text-text hover:bg-surface-variant rounded-lg transition-colors"
                            title={isVisible ? t('settings.hide_password') : t('settings.show_password')}
                        >
                            {isVisible ? <MdVisibilityOff size={16} /> : <MdVisibility size={16} />}
                        </button>
                    )}
                </div>
            </div>
        </div>
    )
}

export const AISettingsPanel: React.FC<{ className?: string, onClose: () => void, isSetup?: boolean }> = ({ className, onClose, isSetup }) => {
    const [settings, setSettings] = useAISettings()
    const [appSettings] = useSettings()
    const [, setChatState] = useChatbotState()
    const [activeTab, setActiveTab] = useState<Tab>('General')
    const t = useTranslation('ai')

    const [loadingModels, setLoadingModels] = useState(false)
    const [availableModels, setAvailableModels] = useState<SelectGroup[]>([])
    const [slmStatus, setSlmStatus] = useState<ReturnType<typeof getSlmStatus>>(getSlmStatus())
    const [slmError, setSlmError] = useState<string | null>(null)
    const [slmProgress, setSlmProgress] = useState(0)
    const [slmWarning, setSlmWarning] = useState<string | null>(getSlmWarning())
    const [embeddingStatus, setEmbeddingStatus] = useState<ReturnType<typeof RAGService.getEmbeddingStatus>>(RAGService.getEmbeddingStatus())
    const [embeddingError, setEmbeddingError] = useState<string | null>(null)
    const [embeddingProgress, setEmbeddingProgress] = useState(0)
    const [embeddingWarning, setEmbeddingWarning] = useState<string | null>(RAGService.getEmbeddingWarning())
    const [fastTextStatus, setFastTextStatus] = useState<ReturnType<typeof getFastTextStatus>>(getFastTextStatus())
    const [fastTextError, setFastTextError] = useState<string | null>(null)
    const statusText = {
        ready: t('status.ready'),
        warning: t('status.warning'),
        downloading: t('status.downloading'),
        error: t('status.error'),
        clickToDownload: t('status.click_to_download'),
    }

    const [isIndexing, setIsIndexing] = useState(false)
    const [indexProgress, setIndexProgress] = useState(0)
    const isMounted = React.useRef(true)

    React.useEffect(() => {
        isMounted.current = true
        return () => { isMounted.current = false }
    }, [])

    React.useEffect(() => {
        const statusHandler = (e: any) => {
            const next = e?.detail?.status
            if (next === 'unknown' || next === 'downloading' || next === 'ready' || next === 'warning' || next === 'error') {
                setSlmStatus(next as any)
            }
            const warning = e?.detail?.warning
            if (typeof warning === 'string') {
                setSlmWarning(warning)
            } else if (warning === null) {
                setSlmWarning(null)
            }
        }
        const progressHandler = (e: any) => {
            if (typeof e?.detail?.progress === 'number') setSlmProgress(e.detail.progress)
        }
        const errorHandler = (e: any) => {
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
            if (next === 'unknown' || next === 'downloading' || next === 'ready' || next === 'warning' || next === 'error') {
                setEmbeddingStatus(next as any)
            }
            const warning = e?.detail?.warning
            if (typeof warning === 'string') {
                setEmbeddingWarning(warning)
            } else if (warning === null) {
                setEmbeddingWarning(null)
            }
        }
        const progressHandler = (e: any) => {
            if (typeof e?.detail?.progress === 'number') setEmbeddingProgress(e.detail.progress)
        }
        const errorHandler = (e: any) => {
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
            if (next === 'unknown' || next === 'downloading' || next === 'ready' || next === 'error') {
                setFastTextStatus(next as any)
            }
        }
        const errorHandler = (e: any) => {
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
        setSettings(prev => ({ ...prev, [key]: value }))
    }

    const resetDefaults = () => {
        if (confirm(t('confirm_reset'))) {
            setSettings(prev => ({
                ...defaultAIConfig,
                apiKey: prev.apiKey,
                baseUrl: prev.baseUrl,
                provider: prev.provider
            }))
        }
    }

    const clearHistory = () => {
        if (confirm(t('confirm_clear'))) {
            setChatState(prev => ({ ...prev, messages: [] }))
        }
    }

    const reindexBook = async () => {
        const bookId = reader.focusedBookTab?.book.id
        if (!bookId) return alert(t('index.no_book'))

        setIsIndexing(true)
        setIndexProgress(0)

        try {
            const fileRecord = await db?.files.get(bookId)
            if (!fileRecord) throw new Error('Book file not found in local database.')

            const rag = RAGService.getInstance()
            // SOTA: Pass normalized book language for accurate segmentation
            const bookLang = normalizeLangForRAG(
                reader.focusedBookTab?.book.metadata?.language,
                appSettings.locale || 'en'
            )

            await rag.indexBook(fileRecord.file, bookId, (p) => {
                if (isMounted.current) {
                    setIndexProgress(p)
                }
            }, bookLang)
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


    const fetchModels = React.useCallback(async () => {
        if (!settings.apiKey) return alert(t('settings.enter_api_key_first'))
        setLoadingModels(true)
        setAvailableModels([])

        try {
            let groups: SelectGroup[] = []

            if (settings.provider === 'gemini') {
                const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models`, {
                    headers: { 'x-goog-api-key': settings.apiKey }
                })
                if (!res.ok) throw new Error('Failed to fetch from Google')
                const data = await res.json()

                const blacklist = /(gemma|deep-research|computer-use|vision|aqa|embedding|imaging|imagen|image|text-|translator|metadata|attr|realtime|audio|instruct|nano|bison|gecko|tts|speech|sound|media)/i

                // 1. Initial Metadata Filter
                const candidates = data.models.filter((m: any) => {
                    const methods = m.supportedGenerationMethods || []
                    const name = m.name.toLowerCase()
                    return (
                        methods.includes('generateContent') &&
                        !blacklist.test(name)
                    )
                })

                // 2. Zero-Cost Verification (Parallel countTokens ping)
                // This filters out "ghost" models (like Gemma/Imagen) that appear in list_models 
                // but return 403 Forbidden when accessed without specific billing/permissions.
                const verificationResults = await Promise.allSettled(
                    candidates.map(async (m: any) => {
                        try {
                            // Use countTokens as a lightweight "ping". It's free and fast.
                            // If this fails (403/404), the user definitely can't use the model.
                            const verifyRes = await fetch(
                                `https://generativelanguage.googleapis.com/v1beta/${m.name}:countTokens`,
                                {
                                    method: 'POST',
                                    headers: {
                                        'Content-Type': 'application/json',
                                        'x-goog-api-key': settings.apiKey
                                    },
                                    body: JSON.stringify({ contents: [{ parts: [{ text: '' }] }] })
                                }
                            )
                            if (!verifyRes.ok) throw new Error('Access Denied')
                            return m
                        } catch (e) {
                            return null
                        }
                    })
                )

                const filtered = verificationResults
                    .map(r => r.status === 'fulfilled' ? r.value : null)
                    .filter((m): m is any => m !== null)

                const powerhouse: SelectOption[] = []
                const reasoning: SelectOption[] = []
                const fast: SelectOption[] = []
                const experimental: SelectOption[] = []

                filtered.forEach((m: any) => {
                    const id = m.name.replace('models/', '')
                    const lowerId = id.toLowerCase()
                    const option: SelectOption = { value: id, label: id, icon: <GeminiIcon /> }

                    // Priority-based categorization

                    // 1. Reasoning (Chain of Thought)
                    if (lowerId.includes('deep-think') || lowerId.includes('thinking') || lowerId.startsWith('o1') || lowerId.startsWith('o3')) {
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
                    { label: `🧠 ${t('settings.model_category.reasoning')}`, options: reasoning.sort((a, b) => b.value.localeCompare(a.value, undefined, { numeric: true })) },
                    { label: `💪 ${t('settings.model_category.powerhouse')}`, options: powerhouse.sort((a, b) => b.value.localeCompare(a.value, undefined, { numeric: true })) },
                    { label: `⚡ ${t('settings.model_category.fast')}`, options: fast.sort((a, b) => b.value.localeCompare(a.value, undefined, { numeric: true })) },
                    { label: `🧪 ${t('settings.model_category.other')}`, options: experimental.sort((a, b) => b.value.localeCompare(a.value, undefined, { numeric: true })) }
                ].filter(g => g.options.length > 0)

            } else if (settings.provider === 'openai') {
                const res = await fetch('https://api.openai.com/v1/models', {
                    headers: { Authorization: `Bearer ${settings.apiKey}` }
                })
                if (!res.ok) throw new Error('Failed to fetch from OpenAI')
                const data = await res.json()

                const blacklist = /(audio|realtime|instruct|vision|embedding|dall-e|tts|whisper)/i
                const filtered = data.data.filter((m: any) => {
                    const id = m.id.toLowerCase()
                    return (id.startsWith('gpt') || id.startsWith('o1') || id.startsWith('o3')) &&
                        !blacklist.test(id)
                })

                const powerhouse: SelectOption[] = []
                const reasoning: SelectOption[] = []
                const fast: SelectOption[] = []
                const experimental: SelectOption[] = []

                filtered.forEach((m: any) => {
                    const id = m.id
                    const lowerId = id.toLowerCase()
                    const option: SelectOption = { value: id, label: id, icon: <SiOpenai /> }

                    if (lowerId.startsWith('o1') || lowerId.startsWith('o3')) {
                        reasoning.push(option)
                    }
                    else if (lowerId.includes('gpt-5')) {
                        powerhouse.push(option)
                    }
                    else if (lowerId.includes('gpt-4')) {
                        // Per user, GPT-4 is now "outdated" / efficient compared to GPT-5
                        fast.push(option)
                    }
                    else if (lowerId.includes('mini')) {
                        fast.push(option)
                    }
                    else {
                        experimental.push(option)
                    }
                })

                groups = [
                    { label: `🧠 ${t('settings.model_category.reasoning')}`, options: reasoning.sort((a, b) => b.value.localeCompare(a.value, undefined, { numeric: true })) },
                    { label: `💪 ${t('settings.model_category.powerhouse')}`, options: powerhouse.sort((a, b) => b.value.localeCompare(a.value, undefined, { numeric: true })) },
                    { label: `⚡ ${t('settings.model_category.fast')}`, options: fast.sort((a, b) => b.value.localeCompare(a.value, undefined, { numeric: true })) },
                    { label: `🧪 ${t('settings.model_category.other')}`, options: experimental.sort((a, b) => b.value.localeCompare(a.value, undefined, { numeric: true })) }
                ].filter(g => g.options.length > 0)

            } else if (settings.provider === 'anthropic') {
                const res = await fetch('https://api.anthropic.com/v1/models', {
                    headers: {
                        'x-api-key': settings.apiKey,
                        'anthropic-version': '2023-06-01',
                        'anthropic-dangerous-direct-browser-access': 'true'
                    }
                })
                if (!res.ok) throw new Error('Failed to fetch from Anthropic')
                const data = await res.json()

                const options = data.data.map((m: any) => ({
                    value: m.id,
                    label: m.id,
                    icon: <AnthropicIcon />
                }))

                groups = [{ label: t('settings.claude_series'), options: options.sort((a, b) => b.value.localeCompare(a.value, undefined, { numeric: true })) }]
            }

            setAvailableModels(groups)
        } catch (e) {
            alert(t('settings.fetch_models_error'))
            console.error(e)
        } finally {
            setLoadingModels(false)
        }
    }, [settings.apiKey, settings.provider, t])

    React.useEffect(() => {
        if (settings.apiKey && ['openai', 'gemini', 'anthropic'].includes(settings.provider)) {
            fetchModels()
        }
    }, [settings.provider, settings.apiKey, fetchModels])

    return (
        <div className={clsx('flex flex-col h-full bg-white dark:bg-gray-900 ai-settings-panel', className)}>
            {/* Sticky Header Group */}
            <div className="sticky top-0 z-[50] bg-white dark:bg-gray-900 border-b border-border-light dark:border-border-dark">
                {/* Header Title */}
                <div className="flex items-center justify-between p-4 bg-white dark:bg-gray-900">
                    <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center text-primary">
                            <MdSettings className="text-2xl" />
                        </div>
                        <h3 className="font-bold text-lg tracking-tight">{t('settings.config_title')}</h3>
                    </div>
                    {!isSetup && (
                        <button
                            onClick={onClose}
                            className="p-2 rounded-full transition-colors hover:bg-surface-variant text-subtle hover:text-text group"
                        >
                            <MdClose className="text-2xl transition-transform duration-300 group-hover:rotate-90" />
                        </button>
                    )}
                </div>

                {/* Tabs */}
                <div className="flex bg-white dark:bg-gray-900">
                    {TABS.map(tab => <button
                        key={tab}
                        onClick={() => setActiveTab(tab)}
                        className={clsx(
                            'flex-1 py-3 text-sm font-medium transition-colors',
                            activeTab === tab
                                ? 'text-primary border-b-2 border-primary'
                                : 'text-subtle hover:text-text'
                        )}
                    >
                        {t(`tabs.${tab.toLowerCase()}`)}
                    </button>
                    )}
                </div>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto p-4 space-y-6 bg-white dark:bg-gray-900 ai-settings-panel-content custom-scrollbar">

                {/* GENERAL TAB */}
                {activeTab === 'General' && (
                    <div className="space-y-4">
                        <PremiumSelect
                            label={t('provider')}
                            value={settings.provider}
                            options={[
                                { value: 'gemini', label: 'Gemini', icon: <GeminiIcon /> },
                                { value: 'openai', label: 'OpenAI', icon: <SiOpenai /> },
                                { value: 'anthropic', label: 'Anthropic', icon: <AnthropicIcon /> },
                                { value: 'local', label: 'Local', icon: <MdComputer /> },
                                { value: 'custom', label: 'Custom', icon: <MdDns /> }
                            ]}
                            onChange={(val) => handleChange('provider', val)}
                            icon={
                                settings.provider === 'openai' ? <SiOpenai /> :
                                    settings.provider === 'gemini' ? <GeminiIcon /> :
                                        settings.provider === 'anthropic' ? <AnthropicIcon /> :
                                            settings.provider === 'local' ? <MdComputer /> : <MdDns />
                            }
                        />

                        {settings.provider !== 'local' && settings.provider !== 'custom' && (
                            <PremiumInput
                                label={t('api_key')}
                                value={settings.apiKey}
                                onChange={(val) => handleChange('apiKey', val)}
                                placeholder={t('settings.api_key_placeholder')}
                                type="password"
                            />
                        )}

                        {/* Local / Custom specific fields */}
                        {(settings.provider === 'local' || settings.provider === 'custom') && (
                            <div className="p-3 bg-primary/5 border border-primary/10 rounded-xl space-y-3">
                                <div className="text-[11px] text-primary/80 font-medium leading-relaxed">
                                    {settings.provider === 'local'
                                        ? t('settings.model_hint.local')
                                        : t('settings.model_hint.custom')
                                    }
                                </div>
                                <div className="space-y-1.5">
                                    <label className="block text-[11px] font-bold text-subtle uppercase tracking-wider ml-1">{t('base_url')}</label>
                                    <TextField
                                        name="Base URL"
                                        hideLabel
                                        value={settings.baseUrl || ''}
                                        onChange={(e) => handleChange('baseUrl', e.target.value)}
                                        placeholder={settings.provider === 'local' ? 'http://localhost:11434/v1' : 'https://api.proxy.com/v1'}
                                    />
                                </div>
                                {settings.provider === 'custom' && (
                                    <PremiumInput
                                        label={t('settings.proxy_api_key')}
                                        value={settings.apiKey}
                                        onChange={(val) => handleChange('apiKey', val)}
                                        type="password"
                                        placeholder="sk-..."
                                    />
                                )}
                            </div>
                        )}

                        <div className="space-y-2">
                            <div className="flex justify-between items-center ml-1">
                                <label className="block text-[11px] font-bold text-subtle uppercase tracking-wider">{t('model')}</label>
                                {['openai', 'gemini', 'anthropic'].includes(settings.provider) && settings.apiKey && (
                                    <button
                                        onClick={fetchModels}
                                        disabled={loadingModels}
                                        className="text-[10px] text-primary hover:underline disabled:opacity-50 flex items-center gap-1 font-medium"
                                    >
                                        <MdRefresh className={clsx(loadingModels && 'animate-spin')} />
                                        {loadingModels ? t('chatbot.thinking').replace('...', '') : t('maintenance.refresh_list')}
                                    </button>
                                )}
                            </div>

                            <PremiumSelect
                                label=""
                                value={settings.model}
                                options={availableModels.length > 0 ? availableModels : [{ value: settings.model, icon: <MdSmartToy /> }]}
                                onChange={(val) => handleChange('model', val)}
                                searchable={availableModels.reduce((acc, g) => acc + (g.options?.length || 0), 0) > 5}
                                placeholder={t('settings.select_model_placeholder')}
                                icon={<MdSmartToy />}
                            />

                            <div className="grid grid-cols-2 gap-3 pt-2">
                                <PremiumSelect
                                    label={t('answer_depth')}
                                    value={settings.answerDepth}
                                    options={[
                                        { value: 'short', label: t('answer_depth.short'), icon: <MdChevronRight /> },
                                        { value: 'balanced', label: t('answer_depth.balanced'), icon: <MdChevronRight /> },
                                        { value: 'deep', label: t('answer_depth.deep'), icon: <MdChevronRight /> }
                                    ]}
                                    onChange={(val) => handleChange('answerDepth', val)}
                                />
                                <PremiumSelect
                                    label={t('scope')}
                                    value={settings.aiScope}
                                    options={[
                                        { value: 'book_only', label: t('scope.book_only'), icon: <MdLock /> },
                                        { value: 'book_plus_discussion', label: t('scope.plus_discussion'), icon: <MdSmartToy /> }
                                    ]}
                                    onChange={(val) => handleChange('aiScope', val)}
                                />
                            </div>

                            <div className="p-3 bg-surface-1 border border-border-light dark:border-border-dark rounded-xl space-y-3">
                                <label className="block text-[10px] font-bold text-subtle uppercase tracking-wider ml-1">{t('settings.local_models_status')}</label>
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
                                        onClick={RAGService.preloadEmbeddings}
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
                                    />
                                </div>
                            </div>
                        </div>
                    </div>
                )}

                {/* PERSONA TAB */}
                {activeTab === 'Persona' && (
                    <div className="space-y-4 h-full flex flex-col">
                        <div className="flex-1 flex flex-col">
                            <label className="block text-xs font-bold text-subtle mb-1 uppercase tracking-wider">{t('system_prompt')}</label>
                            <textarea
                                className="flex-1 w-full p-3 rounded-xl bg-surface-1 border border-border-light dark:border-border-dark focus:border-primary focus:outline-none min-h-[200px] text-sm leading-relaxed resize-none shadow-inner"
                                value={settings.systemPrompt}
                                onChange={(e) => handleChange('systemPrompt', e.target.value)}
                                placeholder={t('settings.system_prompt_placeholder')}
                            />
                            <p className="text-[11px] text-subtle mt-2 leading-relaxed">
                                {t('settings.adaptive_context_hint')}
                            </p>
                        </div>
                    </div>
                )}

                {/* ADVANCED TAB */}
                {activeTab === 'Advanced' && (
                    <div className="space-y-6">
                        <div className="pt-0 space-y-3">
                            <label className="block text-xs font-bold text-subtle uppercase tracking-wider">{t('maintenance')}</label>
                            <div className="grid grid-cols-2 gap-3">
                                <button
                                    onClick={reindexBook}
                                    disabled={isIndexing}
                                    className="col-span-2 flex items-center justify-between gap-2 p-3.5 rounded-xl border border-primary/20 bg-primary/5 hover:bg-primary/10 hover:border-primary/30 text-primary transition-all group shadow-sm disabled:opacity-50"
                                >
                                    <div className="flex items-center gap-3">
                                        <MdStorage className={clsx('text-xl', isIndexing && 'animate-pulse')} />
                                        <div className="flex flex-col items-start">
                                            <span className="text-[10px] font-bold uppercase tracking-wider">{isIndexing ? t('chatbot.thinking').replace('...', '') + '...' : t('reindex')}</span>
                                            <span className="text-[9px] opacity-70 leading-tight">{t('reindex_desc')}</span>
                                        </div>
                                    </div>
                                    {isIndexing && (
                                        <span className="text-xs font-mono font-bold">{indexProgress}%</span>
                                    )}
                                    {!isIndexing && <MdChevronRight className="text-subtle group-hover:translate-x-0.5 transition-transform" />}
                                </button>
                                <button
                                    onClick={clearHistory}
                                    className="flex flex-col items-center justify-center gap-2 p-3 rounded-xl border border-border-light dark:border-border-dark bg-surface-1 hover:bg-error/5 hover:border-error/20 hover:text-error transition-all group shadow-sm"
                                >
                                    <MdDeleteSweep className="text-xl text-subtle group-hover:text-error transition-colors" />
                                    <span className="text-[10px] font-bold uppercase tracking-wider">{t('clear_history')}</span>
                                </button>
                                <button
                                    onClick={resetDefaults}
                                    className="flex flex-col items-center justify-center gap-2 p-3 rounded-xl border border-border-light dark:border-border-dark bg-surface-1 hover:bg-primary/5 hover:border-primary/20 hover:text-primary transition-all group shadow-sm"
                                >
                                    <MdRefresh className="text-xl text-subtle group-hover:text-primary transition-colors" />
                                    <span className="text-[10px] font-bold uppercase tracking-wider">{t('reset_defaults')}</span>
                                </button>
                            </div>
                        </div>

                        <div className="space-y-4">
                            <label className="block text-xs font-bold text-subtle mb-1 uppercase tracking-wider">{t('tabs.advanced')}</label>

                            <label className="flex items-center justify-between p-3.5 rounded-xl bg-surface-1 border border-border-light dark:border-border-dark cursor-pointer hover:border-primary/50 transition-all group">
                                <div className="flex flex-col pr-4">
                                    <span className="text-sm font-semibold group-hover:text-primary transition-colors">{t('insight_triggers')}</span>
                                    <span className="text-[10px] text-subtle leading-tight">{t('insight_triggers_desc')}</span>
                                </div>
                                <div className="relative inline-flex items-center cursor-pointer">
                                    <input
                                        type="checkbox"
                                        checked={settings.insightTriggers}
                                        onChange={(e) => handleChange('insightTriggers', e.target.checked)}
                                        className="sr-only peer"
                                    />
                                    <div className="w-11 h-6 bg-surface-variant peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-surface-1 after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-surface-1 after:border-border-light dark:border-border-dark after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-primary"></div>
                                </div>
                            </label>

                            <label className="flex items-center justify-between p-3.5 rounded-xl bg-surface-1 border border-border-light dark:border-border-dark cursor-pointer hover:border-primary/50 transition-all group">
                                <div className="flex flex-col pr-4">
                                    <span className="text-sm font-semibold group-hover:text-primary transition-colors">{t('auto_persona')}</span>
                                    <span className="text-[10px] text-subtle leading-tight">{t('auto_persona_desc')}</span>
                                </div>
                                <div className="relative inline-flex items-center cursor-pointer">
                                    <input
                                        type="checkbox"
                                        checked={settings.autoPersona}
                                        onChange={(e) => handleChange('autoPersona', e.target.checked)}
                                        className="sr-only peer"
                                    />
                                    <div className="w-11 h-6 bg-surface-variant peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-surface-1 after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-surface-1 after:border-border-light dark:after:border-border-dark after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-primary"></div>
                                </div>
                            </label>

                            <label className="flex items-center justify-between p-3.5 rounded-xl bg-surface-1 border border-border-light dark:border-border-dark cursor-pointer hover:border-primary/50 transition-all group">
                                <div className="flex flex-col pr-4">
                                    <span className="text-sm font-semibold group-hover:text-primary transition-colors">{t('deep_think')}</span>
                                    <span className="text-[10px] text-subtle leading-tight">{t('deep_think_desc')}</span>
                                </div>
                                <div className="relative inline-flex items-center cursor-pointer">
                                    <input
                                        type="checkbox"
                                        checked={settings.deepThink}
                                        onChange={(e) => handleChange('deepThink', e.target.checked)}
                                        className="sr-only peer"
                                    />
                                    <div className="w-11 h-6 bg-surface-variant peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-surface-1 after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-surface-1 after:border-border-light dark:after:border-border-dark after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-primary"></div>
                                </div>
                            </label>

                            <label className="flex items-center justify-between p-3.5 rounded-xl bg-surface-1 border border-border-light dark:border-border-dark cursor-pointer hover:border-primary/50 transition-all group">
                                <div className="flex flex-col pr-4">
                                    <span className="text-sm font-semibold group-hover:text-primary transition-colors">{t('selection.explain')}</span>
                                    <span className="text-[10px] text-subtle leading-tight">{t('selection.explain_desc')}</span>
                                </div>
                                <div className="relative inline-flex items-center cursor-pointer">
                                    <input
                                        type="checkbox"
                                        checked={settings.explainSelection}
                                        onChange={(e) => handleChange('explainSelection', e.target.checked)}
                                        className="sr-only peer"
                                    />
                                    <div className="w-11 h-6 bg-surface-variant peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-surface-1 after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-surface-1 after:border-border-light dark:after:border-border-dark after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-primary"></div>
                                </div>
                            </label>

                            <label className="flex items-center justify-between p-3.5 rounded-xl bg-surface-1 border border-border-light dark:border-border-dark cursor-pointer hover:border-primary/50 transition-all group">
                                <div className="flex flex-col pr-4">
                                    <span className="text-sm font-semibold group-hover:text-primary transition-colors">{t('selection.summarize')}</span>
                                    <span className="text-[10px] text-subtle leading-tight">{t('selection.summarize_desc')}</span>
                                </div>
                                <div className="relative inline-flex items-center cursor-pointer">
                                    <input
                                        type="checkbox"
                                        checked={settings.summarizeSelection}
                                        onChange={(e) => handleChange('summarizeSelection', e.target.checked)}
                                        className="sr-only peer"
                                    />
                                    <div className="w-11 h-6 bg-surface-variant peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-surface-1 after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-surface-1 after:border-border-light dark:after:border-border-dark after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-primary"></div>
                                </div>
                            </label>


                        </div>

                        <div className="py-2.5">
                            <div className="flex justify-between mb-3">
                                <label className="block text-xs font-bold text-subtle uppercase tracking-wider">{t('temperature')}</label>
                                <span className="text-xs font-mono bg-surface-variant px-2 py-0.5 rounded text-primary border border-primary/10 shadow-inner">{settings.temperature}</span>
                            </div>
                            <input
                                type="range"
                                min="0"
                                max="2"
                                step="0.1"
                                className="premium-slider"
                                value={settings.temperature}
                                onChange={(e) => handleChange('temperature', parseFloat(e.target.value))}
                            />
                            <div className="flex justify-between text-[10px] text-subtle mt-1 px-0.5 font-bold uppercase tracking-tight">
                                <span>{t('settings.temperature.precise')}</span>
                                <span>{t('settings.temperature.balanced')}</span>
                                <span>{t('settings.temperature.creative')}</span>
                            </div>
                        </div>


                    </div>
                )}
            </div>

            {/* Footer */}
            <div className="p-4 border-t border-border-light dark:border-border-dark bg-white dark:bg-gray-900 mt-auto shadow-[0_-4px_20px_rgba(0,0,0,0.05)] space-y-4 sticky bottom-0 z-[50]">
                <div className="flex items-center gap-3 p-3 bg-primary/5 border border-primary/10 rounded-xl text-subtle">
                    <MdLock className="text-primary text-xl flex-shrink-0" />
                    <p className="text-[10px] leading-relaxed">
                        <strong className="text-primary uppercase tracking-tighter mr-1">{t('settings.privacy_first')}</strong>
                        {t('settings.privacy_desc')}
                    </p>
                </div>

                <Button className="w-full py-3.5 flex items-center justify-center gap-2 font-bold shadow-lg shadow-primary/20" onClick={onClose}>
                    {isSetup ? t('settings.start_assistant') : t('settings.save_changes')}
                </Button>
            </div>
        </div>
    )
}


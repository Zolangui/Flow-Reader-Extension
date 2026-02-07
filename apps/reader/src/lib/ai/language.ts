/**
 * language.ts - International Language Support Utilities
 *
 * This module provides language detection, tokenization, and keyword extraction
 * for the AI assistant, designed to work across all languages with graceful
 * degradation for unsupported ones.
 */

import { franc } from 'franc-min'

import { storageGetString, storageSetString } from '../storage'

import { extractKeywordsWithStopwords, tokenizeWords } from './text'

// BCP-47 language tag type
export type LangTag = string

/**
 * Extracts the base language code from a BCP-47 tag.
 * e.g., 'pt-BR' -> 'pt', 'zh-Hans' -> 'zh'
 */
export function baseLang(tag: LangTag): string {
    return (tag || 'en').split(/[-_]/)[0].toLowerCase()
}

/**
 * Returns a human-readable label for a language tag using native Intl.DisplayNames.
 * Supports all ~600 IANA language tags automatically.
 */
export function langLabel(tag: LangTag): string {
    const base = baseLang(tag)
    try {
        // Uses native API - works for all IANA language tags
        const displayNames = new Intl.DisplayNames(['en'], { type: 'language' })
        return displayNames.of(base) || base
    } catch {
        return base
    }
}

/**
 * Determines the appropriate response language based on context.
 * This is the "single source of truth" for language selection.
 */
export function pickResponseLang(args: {
    userPref?: LangTag | 'auto'
    uiLocale: LangTag
    bookLang?: LangTag
    mode: 'chat' | 'selection'
    text?: string
}): LangTag {
    const { userPref, uiLocale, bookLang, mode } = args

    // 1. User explicitly set a language preference
    if (userPref && userPref !== 'auto') {
        return baseLang(userPref)
    }

    // 2. For selection actions (Explain/Summarize), prefer book language
    if (mode === 'selection' && bookLang) {
        return baseLang(bookLang)
    }

    // 3. Fallback to UI locale
    return baseLang(uiLocale)
}

/**
 * Tokenizes text into words using Intl.Segmenter when available.
 * Falls back to regex-based splitting for older browsers.
 */
export function segmentWords(text: string, lang: LangTag): string[] {
    return tokenizeWords(text, lang)
}

/**
 * Extracts keywords from text, filtering stopwords for supported languages.
 * For unsupported languages, returns all tokens (graceful degradation).
 */
export function extractKeywords(text: string, lang: LangTag): Set<string> {
    return extractKeywordsWithStopwords(text, lang)
}

/**
 * Detects query language with progressive enhancement:
 * - Chrome LanguageDetector (if available)
 * - fastText WASM worker (if available)
 * - franc-min fallback
 *
 * @param text - Text to analyze
 * @param fallback - Fallback language if detection fails (default: 'en')
 */
let chromeDetectorPromise: Promise<any> | null = null
let fastTextWorker: Worker | null = null
let fastTextUnavailable = false
let fastTextReqId = 0
const fastTextPending = new Map<number, (lang: string | null) => void>()
const FASTTEXT_CACHE_KEY = 'fasttext_ready_v1'
const loadFastTextReadySync = () => {
    if (typeof window === 'undefined') return false
    try {
        return window.localStorage.getItem(FASTTEXT_CACHE_KEY) === '1'
    } catch {
        return false
    }
}
let fastTextStatus: 'unknown' | 'downloading' | 'ready' | 'error' = loadFastTextReadySync() ? 'ready' : 'unknown'
let fastTextLastError: string | null = null
const FASTTEXT_DETECT_TIMEOUT_MS = 10000
// The first run may do a dynamic module import + wasm compile + model load.
// Avoid flipping the UI to "error" just because it is slow.
const FASTTEXT_PRELOAD_TIMEOUT_MS = 2 * 60_000

function emitFastTextStatus(status: typeof fastTextStatus) {
    fastTextStatus = status
    if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('fasttext-status', { detail: { status } }))
    }
    if (status === 'ready') {
        try {
            if (typeof window !== 'undefined') window.localStorage.setItem(FASTTEXT_CACHE_KEY, '1')
        } catch {
            // ignore
        }
        void storageSetString(FASTTEXT_CACHE_KEY, '1')
    }
}

function emitFastTextError(message: string, stage?: string) {
    fastTextLastError = message
    emitFastTextStatus('error')
    if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('fasttext-error', { detail: { message, stage } }))
    }
    // Always log errors in production builds too; it's critical for debugging extension-only failures.
    console.error('[FastText Error]', { message, stage })
}

async function getChromeLanguageDetector() {
    if (chromeDetectorPromise) return chromeDetectorPromise
    const Detector = (globalThis as any)?.LanguageDetector
    if (!Detector?.create) return null
    try {
        const availability = await Detector.availability?.()
        if (availability === 'unavailable') return null
        chromeDetectorPromise = Detector.create()
        return chromeDetectorPromise
    } catch {
        chromeDetectorPromise = null
        return null
    }
}

async function detectWithChromeAPI(text: string): Promise<string | null> {
    if (typeof globalThis === 'undefined') return null
    const detector = await getChromeLanguageDetector()
    if (!detector?.detect) return null
    try {
        const results = await detector.detect(text)
        const best = Array.isArray(results) ? results[0] : null
        const lang = best?.detectedLanguage || best?.language
        if (!lang || lang === 'und') return null
        return String(lang)
    } catch {
        return null
    }
}

function ensureFastTextWorker() {
    if (fastTextWorker || fastTextUnavailable || typeof Worker === 'undefined') return

    try {
        fastTextWorker = new Worker(new URL('./fasttext.worker.ts', import.meta.url), { type: 'module' })
    } catch {
        fastTextUnavailable = true
        emitFastTextError('worker_init_failed', 'init')
        return
    }
    if (fastTextStatus === 'unknown') emitFastTextStatus('downloading')
    fastTextWorker.onmessage = (e: MessageEvent) => {
        const { id, lang, error, type } = e.data || {}
        if (type === 'fasttext-ready') {
            emitFastTextStatus('ready')
            return
        }
        if (type === 'fasttext-debug') {
            if (typeof window !== 'undefined') {
                window.dispatchEvent(new CustomEvent('fasttext-debug', { detail: e.data.data }))
            }
            if (process.env.NODE_ENV !== 'production') {
                console.log('[FastText Debug]', e.data.data)
            }
            return
        }
        if (type === 'fasttext-error') {
            emitFastTextError(String(e?.data?.data?.message || 'fasttext_error'), e?.data?.data?.stage)
            return
        }
        if (typeof id !== 'number') return
        const resolver = fastTextPending.get(id)
        if (resolver) {
            fastTextPending.delete(id)
            resolver(error ? null : lang || null)
        }
        if (error) {
            fastTextUnavailable = true
            fastTextWorker?.terminate()
            fastTextWorker = null
            fastTextPending.forEach(res => res(null))
            fastTextPending.clear()
            emitFastTextError(String(error), 'detect')
        }
    }
    fastTextWorker.onerror = () => {
        fastTextUnavailable = true
        fastTextWorker?.terminate()
        fastTextWorker = null
        fastTextPending.forEach(resolver => resolver(null))
        fastTextPending.clear()
        emitFastTextError('worker_error', 'runtime')
    }
}

async function detectWithFastText(text: string): Promise<string | null> {
    if (fastTextUnavailable) return null
    ensureFastTextWorker()
    if (!fastTextWorker) return null
    if (fastTextStatus === 'unknown') emitFastTextStatus('downloading')

    return new Promise((resolve) => {
        const id = ++fastTextReqId
        const timeout = setTimeout(() => {
            fastTextPending.delete(id)
            resolve(null)
        }, FASTTEXT_DETECT_TIMEOUT_MS)

        fastTextPending.set(id, (lang) => {
            clearTimeout(timeout)
            resolve(lang)
        })

        fastTextWorker!.postMessage({ type: 'detect', id, text })
    })
}

export function getFastTextStatus() {
    return fastTextStatus
}

export function getFastTextLastError() {
    return fastTextLastError
}

async function hydrateFastTextReady() {
    if (typeof window === 'undefined') return
    try {
        const ready = (await storageGetString(FASTTEXT_CACHE_KEY)) === '1'
        if (ready && fastTextStatus === 'unknown') {
            emitFastTextStatus('ready')
        }
    } catch {
        // ignore hydration failures
    }
}

if (typeof window !== 'undefined') {
    void hydrateFastTextReady()
}

export async function preloadFastText(): Promise<void> {
    if (fastTextUnavailable) return
    ensureFastTextWorker()
    if (!fastTextWorker) return
    if (fastTextStatus === 'unknown') emitFastTextStatus('downloading')

    return new Promise((resolve) => {
        const id = ++fastTextReqId
        const timeout = setTimeout(() => {
            fastTextPending.delete(id)
            // Non-fatal: keep status as-is (usually "downloading") and let the user retry.
            fastTextLastError = 'timeout'
            if (typeof window !== 'undefined') {
                window.dispatchEvent(
                    new CustomEvent('fasttext-debug', {
                        detail: { message: 'preload_timeout', timeoutMs: FASTTEXT_PRELOAD_TIMEOUT_MS },
                    }),
                )
            }
            console.warn('[FastText]', { stage: 'preload', message: fastTextLastError })
            resolve()
        }, FASTTEXT_PRELOAD_TIMEOUT_MS)

        fastTextPending.set(id, () => {
            clearTimeout(timeout)
            resolve()
        })

        fastTextWorker!.postMessage({ type: 'detect', id, text: 'ping' })
    })
}

export async function detectQueryLanguage(text: string, fallback: LangTag = 'en'): Promise<LangTag> {
    const t = (text || '').trim()

    // Avoid unstable results on extremely short inputs
    if (t.length < 3) return fallback

    const chromeResult = await detectWithChromeAPI(t)
    if (chromeResult) return normalizeLangForRAG(chromeResult, fallback)

    const fastTextResult = await detectWithFastText(t)
    if (fastTextResult && fastTextResult !== 'und') {
        return normalizeLangForRAG(fastTextResult, fallback)
    }

    try {
        const iso3 = franc(t)
        if (iso3 === 'und') return fallback
        return normalizeLangForRAG(iso3, fallback)
    } catch {
        return fallback
    }
}

/**
 * Normalizes a language code for RAG indexing.
 * Handles various formats: pt-BR, pt_BR, por, pt → all become 'pt'
 * 
 * @param lang - Language code in any format
 * @param fallback - Fallback if normalization fails (default: 'en')
 * @returns Normalized ISO 639-1 code (2 letters)
 */
export function normalizeLangForRAG(lang: string | undefined, fallback: LangTag = 'en'): LangTag {
    if (!lang) return fallback

    // Extract base language (pt-BR, pt_BR → pt)
    const base = lang.split(/[-_]/)[0].toLowerCase()

    // Handle ISO 639-3 codes (por, eng, jpn, etc.)
    const iso3ToIso1: Record<string, string> = {
        eng: 'en', por: 'pt', spa: 'es', fra: 'fr', deu: 'de', ita: 'it',
        jpn: 'ja', zho: 'zh', cmn: 'zh', kor: 'ko', rus: 'ru', ara: 'ar',
        hin: 'hi', nld: 'nl', pol: 'pl', tur: 'tr', vie: 'vi', tha: 'th',
        ind: 'id', ukr: 'uk', ces: 'cs', ell: 'el', heb: 'he', swe: 'sv',
        dan: 'da', fin: 'fi', nor: 'no', hun: 'hu', ron: 'ro', cat: 'ca',
    }

    // If it's a 3-letter code, convert to 2-letter
    if (base.length === 3 && iso3ToIso1[base]) {
        return iso3ToIso1[base]
    }

    // If it's already 2 letters, return as-is
    if (base.length === 2) {
        return base
    }

    return fallback
}

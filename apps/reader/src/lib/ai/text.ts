/**
 * SOTA 2026: Text Processing Utilities
 * Centralizes language display, tokenization (Intl.Segmenter), and lazy stopword loading.
 */

const STOPWORDS_CACHE = new Map<string, Set<string>>()
const STOPWORDS_PROMISE = new Map<string, Promise<void>>()

export function baseLang(tag: string): string {
    // Support both pt-BR and pt_BR formats
    return (tag || 'en').toLowerCase().split(/[-_]/)[0]
}

/**
 * Normalizes text by removing diacritics/accents.
 * 'espaço' -> 'espaco', 'porquê' -> 'porque', 'naïve' -> 'naive'
 * Essential for matching accented and non-accented text in PT/FR/DE etc.
 * 
 * Uses Unicode property escapes with fallback for older engines.
 */
export function normalizeDiacritics(text: string): string {
    const n = (text || '').normalize('NFD')
    try {
        // Modern engines with Unicode property escapes
        return n.replace(/\p{Diacritic}/gu, '')
    } catch {
        // Fallback for older engines (Safari <15, etc)
        return n.replace(/[\u0300-\u036f]/g, '')
    }
}

export function displayLangName(tag: string): string {
    const b = baseLang(tag)
    try {
        // Display language name in its own language or user's locale if known
        // We use the tag itself as the locale to display its own name (e.g., 'fr' -> 'français')
        const dn = new Intl.DisplayNames([tag, 'en'], { type: 'language' })
        return dn.of(b) || tag
    } catch {
        return tag
    }
}

/**
 * Preloads stopwords without bundling them.
 * JSONs should be located in /public/stopwords/{lang}.json
 */
export async function preloadStopwords(tag: string): Promise<void> {
    const b = baseLang(tag)
    if (STOPWORDS_CACHE.has(b)) return
    if (STOPWORDS_PROMISE.has(b)) return STOPWORDS_PROMISE.get(b)!

    const p = (async () => {
        try {
            // Safe chrome/browser access for Firefox + Chrome extensions
            const g = globalThis as any
            const getURL = g.browser?.runtime?.getURL || g.chrome?.runtime?.getURL
            const baseUrl = getURL
                ? getURL(`stopwords/${b}.json`)
                : `/stopwords/${b}.json`

            const res = await fetch(baseUrl)
            if (!res.ok) throw new Error('no stopwords file')
            const arr = (await res.json()) as string[]
            // Normalize diacritics for consistent matching (porquê == porque)
            STOPWORDS_CACHE.set(b, new Set(arr.map(s => normalizeDiacritics(s.toLowerCase()))))
        } catch (e) {
            // fallback: empty set
            console.warn(`[AI] Failed to load stopwords for ${b}, using empty set.`)
            STOPWORDS_CACHE.set(b, new Set())
        }
    })()

    STOPWORDS_PROMISE.set(b, p)
    await p
}

export function getStopwordsSync(tag: string): Set<string> {
    return STOPWORDS_CACHE.get(baseLang(tag)) || new Set()
}

function hasCJK(text: string) {
    return /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff66-\uff9f]/u.test(text)
}

export function tokenizeWords(text: string, locale = 'en'): string[] {
    const t = (text || '').trim().toLowerCase()
    if (!t) return []

    // Use Intl.Segmenter for widely supported languages and CJK
    if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
        try {
            const seg = new Intl.Segmenter(locale, { granularity: 'word' })
            const out: string[] = []
            for (const part of seg.segment(t)) {
                if (!part.isWordLike) continue
                const w = part.segment.trim().toLowerCase()
                if (!w) continue
                // Filter out single punctuation marks - use ASCII-safe check first, fallback to Unicode
                try {
                    if (!/[\p{L}\p{N}]/u.test(w)) continue
                } catch {
                    if (!/[A-Za-z0-9\u00C0-\u024F\u1E00-\u1EFF]/u.test(w)) continue
                }
                out.push(w)
            }
            return out
        } catch {
            // Fallback to regex if locale is invalid or Segmenter fails
        }
    }

    // Fallback regex - doesn't use \p{} escapes that can crash older engines
    // Covers: Latin + Extended, CJK, Cyrillic, Greek, Arabic, Hebrew, Thai, Devanagari
    const tokens = t
        // eslint-disable-next-line no-misleading-character-class
        .replace(/[^A-Za-z0-9\u00C0-\u024F\u1E00-\u1EFF\u0370-\u03FF\u0400-\u04FF\u0590-\u05FF\u0600-\u06FF\u0E00-\u0E7F\u0900-\u097F\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\s]/gu, ' ')
        .split(/\s+/)
        .filter(Boolean)

    // Old rule (len > 1) breaks CJK; adjust
    const cjk = hasCJK(t)
    return tokens.filter(tok => (cjk ? tok.length >= 1 : tok.length > 1))
}

/**
 * Tokenizes and normalizes text (removes diacritics).
 * Use this for consistent matching across BM25, keywords, overlap, dedupe.
 */
export function tokenizeWordsNormalized(text: string, locale = 'en'): string[] {
    // Filter empty strings that could result from diacritic-only tokens
    return tokenizeWords(text, locale).map(w => normalizeDiacritics(w)).filter(Boolean)
}

/**
 * Checks if text contains any CJK characters.
 * Used to determine minimum token length (CJK allows single-char tokens).
 */
function containsCJK(text: string): boolean {
    return /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff66-\uff9f]/u.test(text)
}

export function extractKeywordsWithStopwords(text: string, langTag: string): Set<string> {
    const sw = getStopwordsSync(langTag)
    // Use normalized tokens for consistent stopword matching
    const words = tokenizeWordsNormalized(text, langTag)
    return new Set(words.filter(w => {
        const isLongEnough = containsCJK(w) ? w.length >= 1 : w.length > 2
        return isLongEnough && !sw.has(w)
    }))
}


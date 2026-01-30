/**
 * SOTA 2026: Text Processing Utilities
 * Centralizes language display, tokenization (Intl.Segmenter), and lazy stopword loading.
 */

const STOPWORDS_CACHE = new Map<string, Set<string>>()
const STOPWORDS_PROMISE = new Map<string, Promise<void>>()

export function baseLang(tag: string): string {
    return (tag || 'en').toLowerCase().split('-')[0]
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
            // Safe chrome access to avoid build errors if types are missing
            const g = globalThis as any
            const baseUrl = (g.chrome?.runtime?.getURL)
                ? g.chrome.runtime.getURL(`stopwords/${b}.json`)
                : `/stopwords/${b}.json`

            const res = await fetch(baseUrl)
            if (!res.ok) throw new Error('no stopwords file')
            const arr = (await res.json()) as string[]
            STOPWORDS_CACHE.set(b, new Set(arr.map(s => s.toLowerCase())))
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
                // Filter out single punctuation marks if Segmenter marked them as word-like (rare but possible)
                if (!/[\p{L}\p{N}]/u.test(w)) continue
                out.push(w)
            }
            return out
        } catch {
            // Fallback to regex if locale is invalid or Segmenter fails
        }
    }

    // Fallback regex
    const tokens = t
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .split(/\s+/)
        .filter(Boolean)

    // Old rule (len > 1) breaks CJK; adjust
    const cjk = hasCJK(t)
    return tokens.filter(tok => (cjk ? tok.length >= 1 : tok.length > 1))
}

export function extractKeywordsWithStopwords(text: string, langTag: string): Set<string> {
    const sw = getStopwordsSync(langTag)
    const words = tokenizeWords(text, langTag)
    return new Set(words.filter(w => {
        const isLongEnough = hasCJK(w) ? w.length >= 1 : w.length > 2
        return isLongEnough && !sw.has(w)
    }))
}

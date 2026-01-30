/**
 * language.ts - International Language Support Utilities
 *
 * This module provides language detection, tokenization, and keyword extraction
 * for the AI assistant, designed to work across all languages with graceful
 * degradation for unsupported ones.
 */

import { franc } from 'franc-min'

// BCP-47 language tag type
export type LangTag = string

/**
 * Stopwords for major languages. For unsupported languages, we skip filtering.
 */
const STOPWORDS: Record<string, Set<string>> = {
    en: new Set([
        'the', 'a', 'an', 'of', 'to', 'in', 'on', 'for', 'with', 'without', 'between',
        'what', 'why', 'how', 'when', 'where', 'which', 'who', 'is', 'are', 'was', 'were',
        'do', 'does', 'did', 'be', 'been', 'being', 'have', 'has', 'had', 'this', 'that',
        'these', 'those', 'it', 'its', 'and', 'or', 'but', 'if', 'then', 'so', 'as', 'at',
        'by', 'from', 'about', 'into', 'through', 'during', 'before', 'after', 'above',
        'below', 'again', 'further', 'once', 'here', 'there', 'all', 'each', 'few', 'more',
        'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own', 'same', 'than',
        'too', 'very', 'can', 'will', 'just', 'should', 'now',
    ]),
    pt: new Set([
        'o', 'a', 'os', 'as', 'um', 'uma', 'uns', 'umas', 'de', 'do', 'da', 'dos', 'das',
        'em', 'no', 'na', 'nos', 'nas', 'para', 'por', 'com', 'sem', 'sobre', 'entre',
        'que', 'qual', 'quais', 'quem', 'como', 'quando', 'onde', 'porque', 'porquê',
        'é', 'são', 'foi', 'foram', 'ser', 'estar', 'tem', 'têm', 'tinha', 'tinham',
        'este', 'esta', 'estes', 'estas', 'esse', 'essa', 'esses', 'essas', 'aquele',
        'aquela', 'aqueles', 'aquelas', 'isso', 'isto', 'aquilo', 'se', 'não', 'sim',
        'mas', 'ou', 'e', 'só', 'também', 'já', 'ainda', 'mais', 'menos', 'muito',
        'pouco', 'todo', 'toda', 'todos', 'todas', 'outro', 'outra', 'outros', 'outras',
    ]),
    es: new Set([
        'el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas', 'de', 'del', 'al', 'a',
        'en', 'con', 'sin', 'sobre', 'entre', 'por', 'para', 'que', 'cual', 'cuales',
        'quien', 'quienes', 'como', 'cuando', 'donde', 'porque', 'es', 'son', 'fue',
        'fueron', 'ser', 'estar', 'tiene', 'tienen', 'este', 'esta', 'estos', 'estas',
        'ese', 'esa', 'esos', 'esas', 'aquel', 'aquella', 'aquellos', 'aquellas', 'esto',
        'eso', 'aquello', 'se', 'no', 'sí', 'pero', 'o', 'y', 'también', 'ya', 'aún',
        'más', 'menos', 'muy', 'poco', 'todo', 'toda', 'todos', 'todas', 'otro', 'otra',
    ]),
    fr: new Set([
        'le', 'la', 'les', 'un', 'une', 'des', 'de', 'du', 'au', 'aux', 'à', 'en', 'dans',
        'sur', 'avec', 'sans', 'pour', 'par', 'que', 'qui', 'quoi', 'quel', 'quelle',
        'quels', 'quelles', 'comment', 'quand', 'où', 'pourquoi', 'est', 'sont', 'était',
        'étaient', 'être', 'avoir', 'a', 'ont', 'ce', 'cet', 'cette', 'ces', 'il', 'elle',
        'ils', 'elles', 'on', 'se', 'ne', 'pas', 'non', 'oui', 'mais', 'ou', 'et', 'aussi',
        'déjà', 'encore', 'plus', 'moins', 'très', 'peu', 'tout', 'toute', 'tous', 'toutes',
    ]),
    de: new Set([
        'der', 'die', 'das', 'ein', 'eine', 'eines', 'einer', 'einem', 'einen', 'von',
        'zu', 'in', 'an', 'auf', 'mit', 'ohne', 'über', 'unter', 'zwischen', 'für',
        'durch', 'um', 'bei', 'nach', 'vor', 'aus', 'was', 'wer', 'wie', 'wann', 'wo',
        'warum', 'ist', 'sind', 'war', 'waren', 'sein', 'haben', 'hat', 'hatte', 'hatten',
        'dieser', 'diese', 'dieses', 'jener', 'jene', 'jenes', 'es', 'er', 'sie', 'wir',
        'ihr', 'nicht', 'ja', 'nein', 'aber', 'oder', 'und', 'auch', 'schon', 'noch',
        'mehr', 'weniger', 'sehr', 'wenig', 'alle', 'alles', 'andere', 'anderer', 'anderes',
    ]),
    it: new Set([
        'il', 'lo', 'la', 'i', 'gli', 'le', 'un', 'uno', 'una', 'di', 'del', 'dello',
        'della', 'dei', 'degli', 'delle', 'a', 'al', 'allo', 'alla', 'ai', 'agli', 'alle',
        'da', 'dal', 'dallo', 'dalla', 'dai', 'dagli', 'dalle', 'in', 'nel', 'nello',
        'nella', 'nei', 'negli', 'nelle', 'con', 'su', 'per', 'tra', 'fra', 'che', 'chi',
        'quale', 'quali', 'come', 'quando', 'dove', 'perché', 'è', 'sono', 'era', 'erano',
        'essere', 'avere', 'ha', 'hanno', 'questo', 'questa', 'questi', 'queste', 'quello',
        'quella', 'quelli', 'quelle', 'si', 'non', 'sì', 'ma', 'o', 'e', 'anche', 'già',
        'ancora', 'più', 'meno', 'molto', 'poco', 'tutto', 'tutta', 'tutti', 'tutte',
    ]),
}

/**
 * Extracts the base language code from a BCP-47 tag.
 * e.g., 'pt-BR' -> 'pt', 'zh-Hans' -> 'zh'
 */
export function baseLang(tag: LangTag): string {
    return (tag || 'en').split('-')[0].toLowerCase()
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
    const t = (text || '').toLowerCase()
    if (!t) return []

    // Use Intl.Segmenter if available (modern browsers)
    if (typeof Intl !== 'undefined' && (Intl as any).Segmenter) {
        try {
            const segmenter = new (Intl as any).Segmenter(lang, { granularity: 'word' })
            const segments: string[] = []
            for (const segment of segmenter.segment(t)) {
                if (segment.isWordLike) {
                    segments.push(segment.segment)
                }
            }
            return segments
        } catch {
            // Fallback if Segmenter fails for this language
        }
    }

    // Fallback: Unicode-aware regex split
    return t
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .split(/\s+/)
        .filter(Boolean)
}

/**
 * Extracts keywords from text, filtering stopwords for supported languages.
 * For unsupported languages, returns all tokens (graceful degradation).
 */
export function extractKeywords(text: string, lang: LangTag): Set<string> {
    const base = baseLang(lang)
    const stopwords = STOPWORDS[base]

    const tokens = segmentWords(text, lang)

    const keywords = tokens.filter(w => {
        // Filter very short tokens
        if (w.length <= 2) return false
        // Filter pure numbers
        if (/^\d+$/.test(w)) return false
        // Filter stopwords (if available for this language)
        if (stopwords && stopwords.has(w)) return false
        return true
    })

    return new Set(keywords)
}

/**
 * Detects query language using franc-min library.
 * Supports ~82 languages with graceful fallback to English.
 *
 * @param text - Text to analyze
 * @param fallback - Fallback language if detection fails (default: 'en')
 * @returns ISO 639-3 language code (converted to 639-1 when possible)
 */
export function detectQueryLanguage(text: string, fallback: LangTag = 'en'): LangTag {
    const t = (text || '').trim()

    // Too short for reliable detection
    if (t.length < 10) return fallback

    try {
        // franc returns ISO 639-3 codes (e.g., 'eng', 'por', 'jpn')
        const iso3 = franc(t)

        // 'und' means undetermined
        if (iso3 === 'und') return fallback

        // Convert common ISO 639-3 to ISO 639-1 (BCP-47 base)
        const iso3ToIso1: Record<string, string> = {
            eng: 'en', por: 'pt', spa: 'es', fra: 'fr', deu: 'de', ita: 'it',
            jpn: 'ja', zho: 'zh', cmn: 'zh', kor: 'ko', rus: 'ru', ara: 'ar',
            hin: 'hi', nld: 'nl', pol: 'pl', tur: 'tr', vie: 'vi', tha: 'th',
            ind: 'id', ukr: 'uk', ces: 'cs', ell: 'el', heb: 'he', swe: 'sv',
            dan: 'da', fin: 'fi', nor: 'no', hun: 'hu', ron: 'ro', cat: 'ca',
        }

        return iso3ToIso1[iso3] || iso3.slice(0, 2) || fallback
    } catch {
        return fallback
    }
}

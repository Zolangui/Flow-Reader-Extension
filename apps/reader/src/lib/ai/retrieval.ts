/**
 * SOTA 2026: Smart Retrieval Utilities
 * Adaptive context budgeting, keyword reranking, deduplication, and hybrid search
 */

import type { VectorRecord } from '../../db'

import { displayLangName, extractKeywordsWithStopwords, tokenizeWords } from './text'

// ============================================================================
// BM25 IMPLEMENTATION
// Best Matching 25 algorithm for keyword-based search
// ============================================================================

/**
 * BM25 parameters (tuned for book content)
 */
const BM25_K1 = 1.2  // Term frequency saturation
const BM25_B = 0.75  // Length normalization

type DocStats = { tokens: string[]; tf: Map<string, number>; len: number }
const bm25Cache = new WeakMap<VectorRecord, DocStats>()

/**
 * Gets cached document statistics for BM25
 */
function getDocStats(text: string, chunk?: VectorRecord): DocStats {
    if (chunk) {
        const c = bm25Cache.get(chunk)
        if (c) return c
    }

    const tokens = tokenizeWords(text)
    const tf = new Map<string, number>()
    for (const tok of tokens) tf.set(tok, (tf.get(tok) || 0) + 1)

    const stats = { tokens, tf, len: tokens.length }
    if (chunk) bm25Cache.set(chunk, stats)
    return stats
}

/**
 * BM25 score for a single document
 */
function bm25Score(
    queryTokens: string[],
    doc: DocStats,
    avgDocLength: number,
    idf: Map<string, number>
): number {
    const docLength = doc.len
    let score = 0

    for (const term of queryTokens) {
        const tf = doc.tf.get(term) || 0
        if (!tf) continue

        const termIdf = idf.get(term) || 0
        const numerator = tf * (BM25_K1 + 1)
        const denominator = tf + BM25_K1 * (1 - BM25_B + BM25_B * (docLength / avgDocLength))

        score += termIdf * (numerator / denominator)
    }

    return score
}

/**
 * Calculate IDF (Inverse Document Frequency) for terms
 */
function calculateIDF(queryTokens: string[], documents: DocStats[]): Map<string, number> {
    const N = documents.length
    const idf = new Map<string, number>()

    for (const term of queryTokens) {
        let df = 0
        for (const doc of documents) if (doc.tf.has(term)) df++
        const v = Math.log((N - df + 0.5) / (df + 0.5) + 1)
        idf.set(term, Math.max(0, v))
    }
    return idf
}

/**
 * Performs BM25 search on chunks
 * Returns chunks sorted by BM25 relevance score
 */
export function bm25Search(
    query: string,
    chunks: VectorRecord[],
    topK = 10
): (VectorRecord & { bm25Score: number })[] {
    if (chunks.length === 0) return []

    const queryTokens = tokenizeWords(query)
    if (queryTokens.length === 0) return chunks.slice(0, topK).map(c => ({ ...c, bm25Score: 0 }))

    // Get stats for all documents (cached)
    const docs = chunks.map(c => getDocStats(c.content, c))
    const avgDocLength = docs.reduce((sum, doc) => sum + doc.len, 0) / docs.length

    // Calculate IDF
    const idf = calculateIDF(queryTokens, docs)

    // Score
    const scored = chunks.map((chunk, i) => ({
        ...chunk,
        bm25Score: bm25Score(queryTokens, docs[i], avgDocLength, idf)
    }))

    return scored
        .sort((a, b) => b.bm25Score - a.bm25Score)
        .slice(0, topK)
}

/**
 * Hybrid search combining vector similarity and BM25
 * Uses Reciprocal Rank Fusion (RRF) to combine rankings
 */
export function hybridSearch(
    vectorResults: (VectorRecord & { score: number })[],
    bm25Results: (VectorRecord & { bm25Score: number })[],
    vectorWeight = 0.6,
    k = 60
): (VectorRecord & { hybridScore: number; vectorRank: number; bm25Rank: number })[] {
    // Create rank maps
    const vectorRanks = new Map<number, number>()
    const bm25Ranks = new Map<number, number>()

    const byIndex = new Map<number, VectorRecord>()

    vectorResults.forEach((r, i) => {
        vectorRanks.set(r.index, i + 1)
        byIndex.set(r.index, r)
    })
    bm25Results.forEach((r, i) => {
        bm25Ranks.set(r.index, i + 1)
        if (!byIndex.has(r.index)) byIndex.set(r.index, r)
    })

    const results: (VectorRecord & { hybridScore: number; vectorRank: number; bm25Rank: number })[] = []

    for (const [idx, chunk] of byIndex.entries()) {
        const vectorRank = vectorRanks.get(idx) || vectorResults.length + 1
        const bm25Rank = bm25Ranks.get(idx) || bm25Results.length + 1

        const vectorRRF = 1 / (k + vectorRank)
        const bm25RRF = 1 / (k + bm25Rank)

        const hybridScore = vectorWeight * vectorRRF + (1 - vectorWeight) * bm25RRF

        results.push({
            ...chunk,
            hybridScore,
            vectorRank,
            bm25Rank
        })
    }

    return results.sort((a, b) => b.hybridScore - a.hybridScore)
}

/**
 * Query complexity levels for adaptive retrieval
 */
export type QueryComplexity = 'simple' | 'medium' | 'complex'

/**
 * Retrieval parameters based on query complexity
 */
export interface RetrievalParams {
    topK: number
    maxChars: number
    expandContext: boolean
    // New integration features
    userAnnotations?: string[]
    userDefinitions?: string[]
}

/**
 * Retrieval configuration per complexity level
 */
export const RETRIEVAL_CONFIG: Record<QueryComplexity, RetrievalParams> = {
    simple: { topK: 3, maxChars: 4000, expandContext: false },
    medium: { topK: 5, maxChars: 10000, expandContext: true },
    complex: { topK: 8, maxChars: 18000, expandContext: true }
}

/**
 * Patterns that indicate complex queries requiring more context
 */
const COMPLEX_PATTERNS = [
    /compare|contrast|difference|similar/i,
    /explain.*detail|in depth|thoroughly/i,
    /analyze|analysis|examine/i,
    /why.*happen|how.*work|what.*cause/i,
    /relationship|connection|between/i,
    /summarize|overview|main.*point/i,
    /all.*about|everything.*about/i,
    /pros.*cons|advantages.*disadvantages/i
]

/**
 * Patterns that indicate simple factual queries
 */
const SIMPLE_PATTERNS = [
    /^(who|what|when|where) (is|was|are|were)\b/i,
    /^(what|which) (year|date|time|place|name)/i,
    /^(how many|how much|how old)/i,
    /^(define|definition of)/i,
    /^(is|was|are|were|did|does|do)\b.{0,30}\?$/i
]

/**
 * Estimates query complexity to determine optimal retrieval parameters
 * 
 * @param query - The user's question
 * @returns Complexity level: 'simple', 'medium', or 'complex'
 */
export function estimateQueryComplexity(query: string): QueryComplexity {
    const normalizedQuery = query.trim()
    const wordCount = normalizedQuery.split(/\s+/).length
    const charCount = normalizedQuery.length

    // Check for simple patterns first
    if (SIMPLE_PATTERNS.some(p => p.test(normalizedQuery))) {
        return 'simple'
    }

    // Check for complex patterns
    const complexMatches = COMPLEX_PATTERNS.filter(p => p.test(normalizedQuery)).length

    // Heuristics based on query characteristics
    if (complexMatches >= 2 || wordCount > 25 || charCount > 150) {
        return 'complex'
    }

    if (complexMatches >= 1 || wordCount > 12) {
        return 'medium'
    }

    if (wordCount <= 6) {
        return 'simple'
    }

    return 'medium'
}

/**
 * Gets optimal retrieval parameters based on query complexity
 * 
 * @param query - The user's question
 * @returns Retrieval parameters (topK, maxChars, expandContext)
 */
export function getRetrievalParams(query: string): RetrievalParams {
    const complexity = estimateQueryComplexity(query)
    return RETRIEVAL_CONFIG[complexity]
}

/**
 * Extracts meaningful keywords from a query for reranking
 * Filters out common stop words and short words
 */
function extractKeywords(text: string, langTag = 'en'): Set<string> {
    return extractKeywordsWithStopwords(text, langTag)
}

/**
 * Calculates keyword overlap score between chunk content and query keywords
 * 
 * @param content - The chunk content
 * @param queryKeywords - Set of keywords from the query
 * @returns Score between 0 and 1
 */
function calculateKeywordOverlap(content: string, queryKeywords: Set<string>): number {
    if (queryKeywords.size === 0) return 0

    const contentLower = content.toLowerCase()
    let matchCount = 0
    let weightedScore = 0

    for (const keyword of queryKeywords) {
        // Count occurrences
        const regex = new RegExp(`\\b${keyword}\\b`, 'gi')
        const matches = contentLower.match(regex)
        if (matches) {
            matchCount++
            // Diminishing returns for multiple occurrences
            weightedScore += Math.min(matches.length, 3) / 3
        }
    }

    // Combine coverage (how many keywords found) with density (how often)
    const coverage = matchCount / queryKeywords.size
    const density = weightedScore / queryKeywords.size

    return coverage * 0.7 + density * 0.3
}

/**
 * Chunk with reranking score
 */
export interface RankedChunk extends VectorRecord {
    score: number
    rerankScore: number
}

/**
 * Reranks chunks using a combination of vector similarity and keyword overlap
 * 
 * @param chunks - Chunks with vector similarity scores
 * @param query - The original query
 * @param vectorWeight - Weight for vector similarity (0-1), keyword weight is 1 - vectorWeight
 * @returns Reranked chunks sorted by combined score
 */
export function rerankChunks(
    chunks: (VectorRecord & { score: number })[],
    query: string,
    vectorWeight = 0.7,
    langTag = 'en'
): RankedChunk[] {
    const queryKeywords = extractKeywords(query, langTag)
    const keywordWeight = 1 - vectorWeight

    return chunks
        .map(chunk => {
            const keywordScore = calculateKeywordOverlap(chunk.content, queryKeywords)
            const rerankScore = chunk.score * vectorWeight + keywordScore * keywordWeight

            return {
                ...chunk,
                rerankScore
            }
        })
        .sort((a, b) => b.rerankScore - a.rerankScore)
}

/**
 * Calculates simple text similarity using Jaccard index
 * Used for deduplication
 */
function textSimilarity(text1: string, text2: string): number {
    const words1 = new Set(text1.toLowerCase().split(/\s+/))
    const words2 = new Set(text2.toLowerCase().split(/\s+/))

    const intersection = new Set([...words1].filter(w => words2.has(w)))
    const union = new Set([...words1, ...words2])

    return intersection.size / union.size
}

/**
 * Removes chunks that are too similar to each other
 * Keeps the chunk with higher score when duplicates are found
 * 
 * @param chunks - Ranked chunks to deduplicate
 * @param similarityThreshold - Threshold above which chunks are considered duplicates (0-1)
 * @returns Deduplicated chunks
 */
export function deduplicateChunks(
    chunks: RankedChunk[],
    similarityThreshold = 0.75
): RankedChunk[] {
    if (chunks.length <= 1) return chunks

    const unique: RankedChunk[] = []

    for (const chunk of chunks) {
        const dupIdx = unique.findIndex(existing =>
            textSimilarity(existing.content, chunk.content) > similarityThreshold
        )

        if (dupIdx === -1) {
            unique.push(chunk)
        } else {
            // keep the better one
            if ((chunk.rerankScore ?? 0) > (unique[dupIdx].rerankScore ?? 0)) {
                unique[dupIdx] = chunk
            }
        }
    }

    return unique
}

/**
 * Builds an optimized prompt with context
 * Places question before context for better model attention
 * 
 * @param query - User's question
 * @param context - Retrieved context text
 * @param language - Language for instructions ('en' or 'pt')
 * @returns Formatted user prompt
 */
export function buildOptimizedPrompt(
    query: string,
    context: string,
    language = 'en'
): string {
    // v4.0: Unified English template with language directive
    const langName = displayLangName(language)
    const instructions = `Instructions:
- Answer ONLY based on the excerpts above.
- Quote relevant passages when helpful.
- Use "USER'S NOTES" to personalize the answer if applicable.
- If the answer is not found in the context, say so clearly.
- Be concise and direct.
- Language: Answer in ${langName} (${language}).`

    // Single English fallback (model will translate/understand based on language directive)
    const noContextMessage = `[No context found. The book may not be indexed. Please go to Settings > Advanced and click "Re-index Book".]`

    const effectiveContext = context.trim() || noContextMessage

    // SOTA: Question-first format for better model attention
    return `Question: ${query}

Relevant excerpts from the book:
---
${effectiveContext}
---

${instructions}`
}

/**
 * Detects query language (Portuguese, English, Japanese, Chinese) based on heuristics
 */
export function detectQueryLanguage(text: string): 'pt' | 'en' | 'ja' | 'zh' {
    const t = (text || '').trim().toLowerCase()
    if (!t) return 'en'

    // Strong Global signals: Unicode script ranges
    const isJapanese = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff66-\uff9f]/u.test(t)
    const isChinese = /[\u4e00-\u9fa5]/u.test(t) && !isJapanese // Narrow Chinese vs Japanese

    if (isJapanese) return 'ja'
    if (isChinese) return 'zh'

    // Strong PT signals: accents and common stopwords
    const hasAccent = /[áàâãéêíóôõúç]/i.test(t)
    const ptHits = (t.match(/\b(o|a|os|as|de|do|da|dos|das|em|no|na|nos|nas|para|por|com|sem|sobre|entre|que|como|quando|onde|porque|porquê|qual|quais|quem|isso|essa|este|esta)\b/g) || []).length
    const enHits = (t.match(/\b(the|a|an|of|to|in|on|for|with|without|between|what|why|how|when|where|which|who|this|that)\b/g) || []).length

    if (hasAccent) return 'pt'
    if (ptHits >= enHits + 2) return 'pt'
    return 'en'
}

/**
 * Builds a no-context message in the correct language.
 * SOTA: Uses unified English template - AI model translates based on conversation context.
 * Works for ALL languages automatically, not just PT/EN/JA/ZH.
 */
export function buildNoContextMessage(lang: string, canSearchDeeper: boolean): string {
    // The AI model will naturally respond in the user's language based on the conversation
    // This message is embedded in the context, and the language directive in the main prompt
    // ensures the response language matches
    return canSearchDeeper
        ? `[No direct answer found in current excerpts. Offer to search deeper in other chapters.]`
        : `[No direct answer found in the book for this question, even after deeper search.]`
}

/**
 * Extracts core keywords for variation generation
 */
function extractCoreKeywords(q: string): string[] {
    const STOP = new Set([
        // en
        'the', 'a', 'an', 'of', 'to', 'in', 'on', 'for', 'with', 'without', 'between', 'what', 'why', 'how', 'when', 'where', 'which', 'who', 'is', 'are', 'was', 'were', 'do', 'does', 'did',
        // pt
        'o', 'a', 'os', 'as', 'de', 'do', 'da', 'dos', 'das', 'em', 'no', 'na', 'nos', 'nas', 'para', 'por', 'com', 'sem', 'sobre', 'entre', 'que', 'como', 'quando', 'onde', 'porque', 'porquê', 'qual', 'quais', 'quem', 'é', 'são', 'foi', 'foram', 'ser', 'estar', 'tem', 'têm'
    ])

    return (q || '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .split(/\s+/)
        .filter(w => w.length >= 3 && !STOP.has(w))
        .slice(0, 8)
}

/**
 * Generates deterministic query variations without extra tokens (RAG-Fusion)
 * SOTA: Uses English keywords for vector search - works for all languages
 * because embeddings capture semantic meaning regardless of surface language.
 */
export function generateQueryVariations(
    query: string,
    lang: string,  // Now accepts any language
    intent?: string
): string[] {
    const q = (query || '').trim()
    if (!q) return []

    const keywords = extractCoreKeywords(q)
    const core = keywords.join(' ')
    const variations: string[] = []

    // Var 1: keywords only
    if (core) variations.push(core)

    // Var 2: Intent-based pattern (English keywords work universally for vector search)
    // The embedding model captures semantic similarity regardless of language
    const intentKeyword = intent === 'define' ? 'definition'
        : intent === 'summarize' ? 'summary'
            : intent === 'analyze' ? 'relationship'
                : 'explain'
    variations.push(`${intentKeyword} ${core || q}`)

    // Var 3: Quoted term if present
    const quoted = q.match(/"([^"]{2,60})"/)?.[1]
    if (quoted) variations.push(quoted)

    const uniq: string[] = []
    for (const v of variations) {
        const vv = v.trim()
        if (!vv) continue
        if (!uniq.some(x => x.toLowerCase() === vv.toLowerCase())) uniq.push(vv)
    }

    return uniq.slice(0, 3)
}

/**
 * Scrubs citations from body and formats them cleanly into a single footer
 */
export function normalizeCitationsToFooter(text: string): string {
    if (!text) return text

    // 1) Remove existing footer if present (idempotency)
    let cleaned = text.replace(/\n\s*Sources:\s*[\s\S]*$/i, '').trimEnd()

    // 2) Protect code blocks
    const parts = cleaned.split(/```/g)
    const collected = new Set<string>()

    for (let i = 0; i < parts.length; i++) {
        const isCode = i % 2 === 1
        if (isCode) continue

        const matches = parts[i].match(/\[S\d+:C\d+\]/g) || []
        for (const m of matches) collected.add(m)

        parts[i] = parts[i].replace(/\s*\[S\d+:C\d+\]/g, '')

        // Clean punctuation/spacing anomalies
        parts[i] = parts[i]
            .replace(/[ \t]{2,}/g, ' ')
            .replace(/\s+\n/g, '\n')
            .replace(/\n{3,}/g, '\n\n')
            .replace(/\s+([.,;:!?])/g, '$1')
    }

    cleaned = parts.join('```').trim()

    if (collected.size === 0) return cleaned

    const sources = Array.from(collected)
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
        .map(s => {
            const id = s.replace(/[[\]]/g, '')
            return `[${id}](cfi://${id})`
        })

    return `${cleaned}\n\nSources: ${sources.join(', ')}`
}

/**
 * Estimates token count from character count
 * Rough approximation: ~4 chars per token for English, ~3 for other languages
 * 
 * @param text - Text to estimate
 * @returns Estimated token count
 */
export function estimateTokens(text: string): number {
    // Check if text contains significant non-ASCII (likely non-English)
    // Using charCodeAt to avoid ESLint no-control-regex warning
    let nonAsciiCount = 0
    for (let i = 0; i < text.length; i++) {
        if (text.charCodeAt(i) > 127) nonAsciiCount++
    }
    const nonAsciiRatio = text.length > 0 ? nonAsciiCount / text.length : 0
    const charsPerToken = nonAsciiRatio > 0.1 ? 3 : 4

    return Math.ceil(text.length / charsPerToken)
}

/**
 * Logs retrieval statistics for debugging and optimization
 */
export function logRetrievalStats(
    query: string,
    complexity: QueryComplexity,
    params: RetrievalParams,
    chunksRetrieved: number,
    finalContextChars: number
): void {
    if (process.env.NODE_ENV === 'development') {
        console.log('[RAG Stats]', {
            query: query.slice(0, 50) + (query.length > 50 ? '...' : ''),
            complexity,
            params,
            chunksRetrieved,
            finalContextChars,
            estimatedTokens: estimateTokens(query) + Math.ceil(finalContextChars / 4)
        })
    }
}

// ============================================================================
// READING-FOCUSED PROMPTS
// Optimized for ebook reading productivity
// ============================================================================

/**
 * Intent types for reading assistance
 */
export type ReadingIntent = 'explain' | 'summarize' | 'define' | 'analyze' | 'concept' | 'question' | 'general'

/**
 * Detects the user's intent from their query
 */
export function detectReadingIntent(query: string): ReadingIntent {
    const q = query.toLowerCase()

    // Concept intent - deep conceptual questions
    if (/o qu[eê] [eé]|what is the|what are the|como funciona|how does.*work|qual [eé] o conceito|concept of|teoria d[eao]|theory of|princ[ií]pio|principle of|espa[cç]o d|space of|lei d[eao]|law of|entenda|me explique|fale sobre/i.test(q)) {
        return 'concept'
    }

    // Explain intent
    if (/^explain|what does.*mean|what is.*about|clarify|elaborate|explique|o que significa|o que quer dizer|me diga sobre/i.test(q)) {
        return 'explain'
    }

    // Summarize intent
    if (/^summar|recap|overview|main point|key takeaway|tl;?dr|resuma|resumo|pontos principais|principais ideias|s[ií]ntese/i.test(q)) {
        return 'summarize'
    }

    // Define intent
    if (/^define|meaning of|definition|defina|defini[cç][aã]o|\bo que [eé]\b/i.test(q)) {
        const wc = q.trim().split(/\s+/).length
        return wc <= 6 ? 'define' : 'concept'
    }

    // Analyze intent
    if (/analyze|compare|contrast|relationship|significance|why did|how does.*relate|analise|compare|rela[cç][aã]o|significado|por que|impacto/i.test(q)) {
        return 'analyze'
    }

    // Direct question
    if (/^(who|what|when|where|which|how many|how much|did|does|is|are|was|were|quem|quando|onde|qual|quais|quantos?|como)\b/i.test(q)) {
        return 'question'
    }

    return 'general'
}

/**
 * Response length guidelines per intent and depth
 */
export function getResponseLimits(intent: ReadingIntent, depth: 'short' | 'balanced' | 'deep'): {
    maxSentences: number;
    style: string;
    useBullets: boolean;
} {
    const limits: Record<ReadingIntent, Record<'short' | 'balanced' | 'deep', number>> = {
        question: { short: 1, balanced: 2, deep: 5 },
        define: { short: 1, balanced: 2, deep: 5 },
        explain: { short: 2, balanced: 4, deep: 10 },
        summarize: { short: 3, balanced: 5, deep: 10 },
        analyze: { short: 3, balanced: 6, deep: 12 },
        concept: { short: 3, balanced: 7, deep: 14 },
        general: { short: 2, balanced: 4, deep: 8 },
    }

    const styleMap: Record<ReadingIntent, string> = {
        explain: 'clear and educational',
        summarize: 'bullet points or brief paragraph',
        define: 'concise definition',
        analyze: 'structured analysis',
        concept: 'thorough explanation with examples',
        question: 'direct answer',
        general: 'concise and helpful'
    }

    return {
        maxSentences: limits[intent][depth],
        style: styleMap[intent],
        useBullets: (intent === 'summarize' || depth === 'deep')
    }
}

/**
 * System prompts optimized for reading assistance
 */
export const READING_SYSTEM_PROMPTS: Record<ReadingIntent, string> = {
    explain: `You are a reading assistant helping someone understand a book passage.
Rules:
- Base your answer ONLY on the provided excerpts.
- Do NOT place citations inline. Collect chunk IDs like [S3:C120] and list them ONLY at the very end of your response as "Sources: ID, ID".
- If the answer isn't in the excerpts, say so clearly.
Style: Clear, educational, but concise.`,

    summarize: `You are a reading assistant helping someone quickly grasp content.
Rules:
- Base your summary ONLY on the provided excerpts.
- No inline citations. Add a single "Sources:" footer at the very end.
Style: Bullet points when helpful.`,

    define: `You are a reading assistant helping with vocabulary and concepts.
Rules:
- Define terms using ONLY the excerpts when possible.
- No inline citations. Add a single "Sources:" footer at the very end.`,

    analyze: `You are a reading assistant helping with deeper understanding.
Rules:
- Every insight must be backed by the provided text.
- No inline citations. Add a single "Sources:" footer at the very end.`,

    concept: `You are a reading assistant helping someone deeply understand a core concept from the book.
Rules:
- Structure: Definition → Explanation → Significance → Examples.
- No inline citations. Add a single "Sources:" footer at the very end.`,

    question: `You are a reading assistant answering questions about a book.
Rules:
- Be extremely factual.
- No inline citations. Add a single "Sources:" footer at the very end.
- If not found, say "Information not found in current context".`,

    general: `You are a helpful reading assistant for an ebook reader app.
Rules:
- Always prioritize information from the book excerpts.
- No inline citations. Add a single "Sources:" footer at the very end.`
}

/**
 * Automatically escalates depth and scope if query suggests complexity
 */
export function autoEscalate(query: string, current: { depth: 'short' | 'balanced' | 'deep'; scope: 'book_only' | 'book_plus_discussion' }): typeof current {
    const q = query.toLowerCase()
    const exploratory = /discuss|explain|detail|example|context|apply|world|compare|analy|contrast|aprofundar|detalhes|exemplo|contexto|aplicar|real|comparar|analis|por qu[eê]/i.test(q)

    let depth = current.depth
    let scope = current.scope

    if (exploratory) {
        if (depth === 'short') depth = 'balanced'
        else if (depth === 'balanced') depth = 'deep'

        // Auto-allow application if they ask for real world examples/context
        if (current.scope === 'book_only' && /apply|world|real|context|exemplo|contexto|aplicar/i.test(q)) {
            scope = 'book_plus_discussion'
        }
    }

    return { depth, scope }
}

/**
 * Builds a reading-optimized system prompt with depth and scope awareness
 */
export function buildReadingSystemPrompt(
    intent: ReadingIntent,
    settings: {
        depth: 'short' | 'balanced' | 'deep';
        scope: 'book_only' | 'book_plus_discussion';
        persona?: string;
        customPrompt?: string;
        // v3.11: Metadata integration
        bookSubject?: string | string[];
    }
): string {
    const limits = getResponseLimits(intent, settings.depth)
    const base = READING_SYSTEM_PROMPTS[intent]

    // v3.11: Adaptive Persona based on Genre
    let adaptivePersona = "helpful reading assistant"
    let subjectInstruction = ""

    if (settings.bookSubject) {
        const subjects = Array.isArray(settings.bookSubject)
            ? settings.bookSubject.join(' ').toLowerCase()
            : settings.bookSubject.toLowerCase()

        if (subjects.includes('fiction') || subjects.includes('literature')) {
            adaptivePersona = "literary companion"
            subjectInstruction = "Focus on narrative arcs, character development, and themes."
        } else if (subjects.includes('science') || subjects.includes('technology')) {
            adaptivePersona = "technical tutor"
            subjectInstruction = "Be precise, analytical, and explain technical terms clearly."
        } else if (subjects.includes('philosophy') || subjects.includes('psychology')) {
            adaptivePersona = "discussion partner"
            subjectInstruction = "Encourage critical thinking and explore underlying concepts."
        } else if (subjects.includes('history')) {
            adaptivePersona = "historian assistant"
            subjectInstruction = "Contextualize events and focus on chronology and cause-effect."
        }
    }

    let prompt = `
${base}

## Constraints:
- Language: Respond strictly in the SAME language as the question.
- Length: Maximum ${limits.maxSentences} ${limits.useBullets ? 'bullets/sentences' : 'sentences'}.
- Citations: NO inline citations. Collect chunk IDs like [SX:CX] and list them ONLY at the very end of your response as a single "Sources: ID, ID" list.
- Persona: You are a ${settings.persona || adaptivePersona}. ${subjectInstruction}
`

    if (settings.scope === 'book_plus_discussion') {
        prompt += `
- Scope: You are ENCOURAGED to provide analogies, practical examples, and outside-book context. 
- Structure: Always separate your answer into two clear blocks:
  1. "Based on the book": Strict RAG answer with Sources.
  2. "Discussion & Application": Broad context (labeled as extrapolation).
`
    } else {
        prompt += `- Scope: STRICT RAG. Base your answer ONLY on the excerpts provided. If not found, say "Information not found in current context".`
    }

    if (settings.customPrompt?.trim()) {
        prompt += `\n\nAdditional Instructions: ${settings.customPrompt}`
    }

    return prompt
}

/**
 * Builds an optimized user prompt for reading assistance
 * Groups excerpts by section for better reading context
 */
export function buildReadingUserPrompt(
    query: string,
    chunks: any[],
    intent: ReadingIntent,
    _depth: 'short' | 'balanced' | 'deep' = 'balanced',
    lang = 'en',
    canSearchDeeper = false,
    extras?: {
        annotations?: string[],
        definitions?: string[]
    }
): string {
    // Group and Sort by Reading Order
    const sorted = [...chunks].sort((a, b) => {
        const aSec = a.metadata?.sectionIndex ?? 0
        const bSec = b.metadata?.sectionIndex ?? 0
        if (aSec !== bSec) return aSec - bSec
        return a.index - b.index
    })

    let excerpts = ""
    let currentSection = -1

    for (const c of sorted) {
        const sec = typeof c.metadata?.sectionIndex === 'number' && c.metadata.sectionIndex >= 0
            ? c.metadata.sectionIndex
            : 0

        if (sec !== currentSection) {
            currentSection = sec
            const title = c.metadata?.sectionTitle || `Section ${currentSection}`
            excerpts += `\n[--- ${title} ---]\n`
        }
        excerpts += `[S${currentSection}:C${c.index}]: ${c.content}\n\n`
    }

    // v3.11: Inject User Context
    let userContextBlock = ""
    if (extras?.annotations?.length || extras?.definitions?.length) {
        userContextBlock = `
USER'S NOTES & VOCABULARY (Prioritize these if relevant):
---
${extras.definitions?.map(d => `[Defined Term]: ${d}`).join('\n') || ''}
${extras.annotations?.map(a => `[User Note]: ${a}`).join('\n') || ''}
---
`
    }

    const noContextMessage = buildNoContextMessage(lang, canSearchDeeper)
    const effectiveContext = excerpts.trim() || `[${noContextMessage}]`

    // SOTA: Unified English guidelines with language directive
    // Works for ALL languages - the AI model will translate naturally
    const langName = displayLangName(lang)
    const guidelines = `Guidelines:
- Respond in ${langName} (the user's language).
- Use "USER'S NOTES" to personalize the answer if applicable.
- Do NOT put IDs inside sentences.
- End with one line: "Sources: Sx:Cx, Sx:Cx".
- If you add "Discussion", explicitly label it as outside the book.`

    return `Question: ${query}

${userContextBlock}

Book excerpts:
---
${effectiveContext}
---

${guidelines}`
}

/**
 * Builds system and user prompts for text selection actions (explain/summarize).
 * SOTA: Unified English template with language directive.
 * Works for ALL languages automatically via langLabel().
 *
 * @param action - The action type (explain or summarize)
 * @param selectedText - The text the user selected
 * @param context - Additional context from the book
 * @param lang - Target response language (any BCP-47 tag)
 * @returns Formatted prompt for selection action
 */
export function buildSelectionActionPrompt(
    action: 'explain' | 'summarize',
    selectedText: string,
    context: string,
    lang = 'en'  // Now accepts any language
): { system: string; user: string } {
    const langName = displayLangName(lang)

    // Unified English system prompt with language directive
    const system = action === 'explain'
        ? `You are a reading assistant. Explain the selected text clearly and concisely (2-3 sentences). Focus on what the reader needs to understand. Respond in ${langName}.`
        : `You are a reading assistant. Summarize the selected text in 1-2 sentences. Capture only the essential meaning. Respond in ${langName}.`

    // Unified English user prompt structure
    const user = `Selected text: "${selectedText}"

${context ? `Surrounding context:\n---\n${context}\n---\n\n` : ''}${action === 'explain' ? 'Explain this briefly:' : 'Summarize in 1-2 sentences:'}`

    return { system, user }
}

/**
 * Estimates if a response is too long and should be truncated
 * 
 * @param response - The AI response
 * @param intent - The original intent
 * @returns Whether the response exceeds recommended length
 */
export function isResponseTooLong(response: string, intent: ReadingIntent, depth: 'short' | 'balanced' | 'deep'): boolean {
    const limits = getResponseLimits(intent, depth)
    const sentenceCount = (response.match(/[.!?]+/g) || []).length
    return sentenceCount > limits.maxSentences * 1.5
}

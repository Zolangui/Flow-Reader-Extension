export const AI_CONFIG = {
    embeddingModel: 'Xenova/all-MiniLM-L6-v2', // Good balance of speed/quality for browser
    chunkSize: 1000,
    chunkOverlap: 200,
    vectorStoreName: 'flow-vectors',
    ragVersion: 3.10, // v3.10 introduces UX Hardening (Depth/Scope)
}

export type AIProvider = 'openai' | 'gemini' | 'anthropic' | 'local' | 'custom'

export interface AISettings {
    provider: AIProvider
    apiKey: string
    model: string
    temperature: number
    systemPrompt: string
    baseUrl?: string
    autoPersona: boolean
    insightTriggers: boolean
    deepThink: boolean
    explainSelection: boolean
    summarizeSelection: boolean
    answerDepth: 'short' | 'balanced' | 'deep'
    aiScope: 'book_only' | 'book_plus_discussion'
}

export const DEFAULT_AI_SETTINGS: AISettings = {
    provider: 'gemini',
    apiKey: '',
    model: 'gemini-3.0-flash',
    temperature: 0.7,
    systemPrompt: 'You are a helpful assistant answering questions about the book. Use the provided context to answer accurately.',
    autoPersona: false,
    insightTriggers: false,
    deepThink: false,
    explainSelection: true,
    summarizeSelection: true,
    answerDepth: 'balanced',
    aiScope: 'book_only',
}

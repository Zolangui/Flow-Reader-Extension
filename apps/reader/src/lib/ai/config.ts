export const AI_CONFIG = {
  embeddingModel: 'Xenova/all-MiniLM-L6-v2', // Good balance of speed/quality for browser
  // Firefox MV3 SOTA: wllama + E5-Large-Instruct (Best Multilingual)
  embeddingModelFirefox: 'Ralriki/multilingual-e5-large-instruct-GGUF@q6_k',
  embeddingModelFirefoxUrl:
    'https://huggingface.co/Ralriki/multilingual-e5-large-instruct-GGUF/resolve/main/multilingual-e5-large-instruct-q6_k.gguf',
  embeddingModelFirefoxPrefixes: {
    query: 'query: ',
    document: 'passage: ',
  },
  embeddingDimFirefox: 768, // Aligned with multilingual-e5-base default output dim
  embeddingDim: 384, // Truncation target (set < model dim only if MRL-capable)
  chunkSize: 1000,
  chunkOverlap: 200,
  vectorStoreName: 'lumen-vectors',
  ragVersion: 3.1, // v3.10 introduces UX Hardening (Depth/Scope)
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
  downloadLocalModels: boolean
}

export const DEFAULT_AI_SETTINGS: AISettings = {
  provider: 'gemini',
  apiKey: '',
  model: 'gemini-1.5-flash',
  temperature: 0.7,
  systemPrompt:
    'You are a helpful assistant answering questions about the book. Use the provided context to answer accurately.',
  autoPersona: false,
  insightTriggers: false,
  deepThink: false,
  explainSelection: true,
  summarizeSelection: true,
  answerDepth: 'balanced',
  aiScope: 'book_only',
  downloadLocalModels: true, // SOTA: Explicit consent for local downloads
}

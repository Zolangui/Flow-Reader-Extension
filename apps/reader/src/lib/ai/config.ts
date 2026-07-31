export const AI_CONFIG = {
  embeddingModel: 'Xenova/all-MiniLM-L6-v2', // Good balance of speed/quality for browser
  // Firefox MV3 SOTA: wllama + E5-Large-Instruct (Best Multilingual)
  embeddingModelFirefox:
    'Ralriki/multilingual-e5-large-instruct-GGUF@8738f8d:q6_k',
  embeddingModelFirefoxUrl:
    'https://huggingface.co/Ralriki/multilingual-e5-large-instruct-GGUF/resolve/8738f8d3d8f311808479ecd5756607e24c6ca811/multilingual-e5-large-instruct-q6_k.gguf',
  embeddingModelFirefoxBytes: 467958912,
  embeddingModelFirefoxSha256:
    '971b20b033a555f920bad72941123f48b470a2fa676abdb713e5dc8605ea15a4',
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

// Bump this whenever local model consent needs to be re-collected. It makes
// upgrades safe even when an older version had downloads enabled by default.
export const LOCAL_MODEL_CONSENT_VERSION = 1

export function isCloudAIProvider(provider: AIProvider): boolean {
  return provider !== 'local'
}

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
  localModelConsentVersion: number
  remoteDataConsent: boolean
  remoteDataConsentProvider: AIProvider | ''
  includeAnnotationsInRemotePrompts: boolean
  includeDefinitionsInRemotePrompts: boolean
  autoRepairCitations: boolean
}

export const DEFAULT_AI_SETTINGS: AISettings = {
  provider: 'gemini',
  apiKey: '',
  model: '',
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
  downloadLocalModels: false,
  localModelConsentVersion: 0,
  remoteDataConsent: false,
  remoteDataConsentProvider: '',
  includeAnnotationsInRemotePrompts: false,
  includeDefinitionsInRemotePrompts: false,
  autoRepairCitations: false,
}

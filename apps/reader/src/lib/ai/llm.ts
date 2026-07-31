import { ChatAnthropic } from '@langchain/anthropic'
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  BaseMessage,
} from '@langchain/core/messages'
import { ChatGoogleGenerativeAI } from '@langchain/google-genai'
import { ChatOpenAI } from '@langchain/openai'

import { sanitizeErrorForLogs } from '../security/redact'

import { type AIProvider, type AISettings } from './config'
import { validateProviderBaseUrl } from './permissions'

/**
 * Chat message format for conversation history
 */
export interface ChatHistoryMessage {
  role: 'user' | 'assistant'
  content: string
}

/**
 * Provider limits differ by account and model. Instead of inventing a global
 * daily quota, only back off the provider that actually returned a quota error.
 */
const CIRCUIT_BACKOFF_MS = 60_000
const circuitOpenUntilByProvider = new Map<AIProvider, number>()

function isQuotaError(error: unknown): boolean {
  const candidate: any = error
  const message = String(candidate?.message || candidate || '').toLowerCase()
  return (
    candidate?.status === 429 ||
    message.includes('429') ||
    message.includes('quota') ||
    message.includes('resource exhausted')
  )
}

function ensureProviderCircuit(provider: AIProvider): void {
  const until = circuitOpenUntilByProvider.get(provider) || 0
  if (Date.now() < until) {
    const waitSec = Math.ceil((until - Date.now()) / 1000)
    throw new Error(`I18N_ERR:circuit_breaker:${waitSec}`)
  }
}

function recordProviderFailure(provider: AIProvider, error: unknown): void {
  if (!isQuotaError(error)) return
  console.warn('Provider quota encountered. Opening provider circuit breaker.')
  circuitOpenUntilByProvider.set(provider, Date.now() + CIRCUIT_BACKOFF_MS)
}

async function guardedCall<T>(
  provider: AIProvider,
  fn: () => Promise<T>,
): Promise<T> {
  ensureProviderCircuit(provider)
  try {
    return await fn()
  } catch (error) {
    recordProviderFailure(provider, error)
    throw error
  }
}
export class LLMService {
  private settings: AISettings

  constructor(settings: AISettings) {
    this.settings = settings
  }

  private ensureProviderConfiguration() {
    const provider = this.settings.provider
    const apiKey = this.settings.apiKey?.trim()
    const baseUrl = this.settings.baseUrl?.trim()

    if (provider === 'local' || provider === 'custom') {
      const endpoint = validateProviderBaseUrl(provider, baseUrl)
      if (endpoint.ok === false) throw new Error(`I18N_ERR:${endpoint.reason}`)
    }

    if (provider !== 'local' && !apiKey) {
      throw new Error('I18N_ERR:api_key_missing')
    }
    if (!this.settings.model?.trim()) {
      throw new Error('I18N_ERR:model_required')
    }
  }

  private getModel() {
    this.ensureProviderConfiguration()
    const modelName = this.settings.model.trim()

    if (
      this.settings.provider === 'openai' ||
      this.settings.provider === 'local' ||
      this.settings.provider === 'custom'
    ) {
      const isOpenAIProvider = this.settings.provider === 'openai'
      const modelConfig = {
        apiKey:
          this.settings.provider === 'local'
            ? this.settings.apiKey || 'not-needed'
            : this.settings.apiKey,
        modelName,
        temperature: this.settings.temperature,
      }

      return new ChatOpenAI({
        ...modelConfig,
        // Keep official OpenAI endpoint for "openai" provider.
        ...(isOpenAIProvider
          ? {}
          : {
              configuration: {
                baseURL: this.settings.baseUrl?.trim(),
              },
            }),
      })
    } else if (this.settings.provider === 'gemini') {
      return new ChatGoogleGenerativeAI({
        apiKey: this.settings.apiKey,
        model: modelName,
        maxOutputTokens: 2048,
        temperature: this.settings.temperature,
      })
    } else if (this.settings.provider === 'anthropic') {
      return new ChatAnthropic({
        anthropicApiKey: this.settings.apiKey,
        modelName,
        temperature: this.settings.temperature,
      })
    }
    throw new Error('I18N_ERR:unsupported_provider')
  }

  async generateResponse(
    systemPrompt: string,
    userQuery: string,
    history: ChatHistoryMessage[] = [],
  ): Promise<string> {
    if (!this.settings.apiKey && this.settings.provider !== 'local') {
      throw new Error('I18N_ERR:api_key_missing')
    }

    let effectivePrompt = systemPrompt
    if (this.settings.deepThink) {
      effectivePrompt = `[SYSTEM: ADVANCED REASONING MODE ACTIVE]
- Think step-by-step privately.
- Output ONLY the final answer.
- Add a short "Rationale" section with 2-4 bullets (no hidden chain-of-thought).

${effectivePrompt}`
    }

    return guardedCall(this.settings.provider, async () => {
      try {
        const model = this.getModel()
        const response = await model.invoke([
          new SystemMessage(effectivePrompt),
          ...this.historyToMessages(history),
          new HumanMessage(userQuery),
        ])

        if (typeof response.content === 'string') {
          return response.content
        }
        return JSON.stringify(response.content)
      } catch (error) {
        console.error('LLM Generation Error:', sanitizeErrorForLogs(error))
        throw new Error('I18N_ERR:generation_failed')
      }
    })
  }

  /**
   * Converts chat history to LangChain message format
   */
  private historyToMessages(history: ChatHistoryMessage[]): BaseMessage[] {
    return history.map((msg) =>
      msg.role === 'user'
        ? new HumanMessage(msg.content)
        : new AIMessage(msg.content),
    )
  }

  async *streamResponse(
    systemPrompt: string,
    userQuery: string,
    signal?: AbortSignal,
    history?: ChatHistoryMessage[],
  ): AsyncGenerator<string, void, unknown> {
    if (!this.settings.apiKey && this.settings.provider !== 'local') {
      throw new Error('I18N_ERR:api_key_missing')
    }

    let effectivePrompt = systemPrompt
    if (this.settings.deepThink) {
      effectivePrompt = `[SYSTEM: ADVANCED REASONING MODE ACTIVE]
- Think step-by-step privately.
- Output ONLY the final answer.
- Add a short "Rationale" section with 2-4 bullets (no hidden chain-of-thought).

${effectivePrompt}`
    }

    const model = this.getModel()

    ensureProviderCircuit(this.settings.provider)

    try {
      // Build messages array with optional history
      const messages: BaseMessage[] = [new SystemMessage(effectivePrompt)]

      // Add conversation history (limited to last N turns to control context size)
      if (history && history.length > 0) {
        // Keep last 6 messages (3 turns) to balance context vs tokens
        const recentHistory = history.slice(-6)
        messages.push(...this.historyToMessages(recentHistory))
      }

      // Add current user query
      messages.push(new HumanMessage(userQuery))

      const stream = await model.stream(messages, { signal })

      for await (const chunk of stream) {
        if (typeof chunk.content === 'string') {
          yield chunk.content
        }
      }
    } catch (error: any) {
      if (error.name === 'AbortError') {
        console.log('Stream aborted')
        return
      }
      console.error('LLM Streaming Error:', sanitizeErrorForLogs(error))

      let message = 'Failed to stream response.'
      const errMsg = String(error?.message || error).toLowerCase()

      if (
        errMsg.includes('429') ||
        error.status === 429 ||
        errMsg.includes('resource exhausted') ||
        errMsg.includes('quota')
      ) {
        recordProviderFailure(this.settings.provider, error)
        message = `I18N_ERR:circuit_breaker:${CIRCUIT_BACKOFF_MS / 1000}`
      }

      throw new Error(message)
    }
  }

  async classifyBook(metadata: any): Promise<string> {
    const prompt = `Analyze this book metadata and choose the most appropriate AI persona from: 
        "Literary Critic" (for novels/poetry), 
        "Technical Expert" (for coding/engineering), 
        "Academic Researcher" (for science/history/essays), 
        "Compassionate Mentor" (for self-help/philosophy), 
        "Historical Analyst" (for biographies/history).
        
        Metadata:
        Title: ${metadata.title}
        Creator: ${metadata.creator}
        Subject: ${metadata.subject}
        Description: ${metadata.description}
        
        Return ONLY the name of the persona.`

    return guardedCall(this.settings.provider, async () => {
      try {
        const model = this.getModel()
        const response = await model.invoke([
          new SystemMessage('You are a metadata classifier.'),
          new HumanMessage(prompt),
        ])
        return typeof response.content === 'string'
          ? response.content.trim()
          : 'Helpful Assistant'
      } catch (e) {
        console.error('Classification Error:', sanitizeErrorForLogs(e))
        return 'Helpful Assistant'
      }
    })
  }
}

import { ChatAnthropic } from '@langchain/anthropic'
import { AIMessage, HumanMessage, SystemMessage, BaseMessage } from '@langchain/core/messages'
import { ChatGoogleGenerativeAI } from '@langchain/google-genai'
import { ChatOpenAI } from '@langchain/openai'

import { AISettings } from './config'

/**
 * Chat message format for conversation history
 */
export interface ChatHistoryMessage {
    role: 'user' | 'assistant'
    content: string
}

/**
 * TOKEN BUCKET RATE LIMITER
 * Prevents "429 Too Many Requests" by tracking local usage.
 * Shared globally across all LLMService instances.
 */
class RateGate {
    private minuteWindow: number[] = []
    private dayCount = 0
    private dayKey = this.todayKey()

    constructor(private rpmLimit: number, private rpdLimit: number) {
        // Load persisted daily usage if available
        if (typeof localStorage !== 'undefined') {
            const saved = localStorage.getItem('llm_daily_usage')
            if (saved) {
                try {
                    const parsed = JSON.parse(saved)
                    if (parsed.key === this.dayKey) {
                        this.dayCount = parsed.count
                    }
                } catch { }
            }
        }
    }

    private todayKey() {
        const d = new Date()
        return `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}-${d.getUTCDate()}`
    }

    private rotateDayIfNeeded() {
        const k = this.todayKey()
        if (k !== this.dayKey) {
            this.dayKey = k
            this.dayCount = 0
            this.persist()
        }
    }

    private persist() {
        if (typeof localStorage !== 'undefined') {
            localStorage.setItem('llm_daily_usage', JSON.stringify({ key: this.dayKey, count: this.dayCount }))
        }
    }

    canSendNow() {
        this.rotateDayIfNeeded()

        const now = Date.now()
        // Filter requests older than 1 minute
        this.minuteWindow = this.minuteWindow.filter(t => now - t < 60_000)

        const rpmOk = this.minuteWindow.length < this.rpmLimit
        const rpdOk = this.dayCount < this.rpdLimit

        return { ok: rpmOk && rpdOk, reason: !rpmOk ? 'RPM' : !rpdOk ? 'RPD' : null }
    }

    markSent() {
        this.rotateDayIfNeeded()
        this.minuteWindow.push(Date.now())
        this.dayCount++
        this.persist()
    }
}

// Global Gate: 15 RPM, 1500 RPD (Conservative free tier defaults)
// We use a singleton to enforce limits across the entire app.
const GLOBAL_RATE_GATE = new RateGate(12, 1400) // Slightly below 15/1500 to be safe

/**
 * CIRCUIT BREAKER
 * Opens when a 429 is received, blocking all requests for a backoff period.
 */
let circuitOpenUntil = 0
const CIRCUIT_BACKOFF_MS = 60_000 // 1 minute penalty

async function guardedCall<T>(fn: () => Promise<T>): Promise<T> {
    const now = Date.now()
    if (now < circuitOpenUntil) {
        const waitSec = Math.ceil((circuitOpenUntil - now) / 1000)
        throw new Error(`Circuit Breaker Open: Quota exceeded. Please wait ${waitSec}s.`)
    }

    const gateStatus = GLOBAL_RATE_GATE.canSendNow()
    if (!gateStatus.ok) {
        throw new Error(`Rate Limit Exceeded (${gateStatus.reason}). Please slow down.`)
    }

    try {
        GLOBAL_RATE_GATE.markSent()
        return await fn()
    } catch (e: any) {
        const msg = String(e?.message || e)
        if (msg.includes("429") || msg.toLowerCase().includes("quota") || msg.toLowerCase().includes("resource exhausted")) {
            console.warn("429 Encountered. Opening Circuit Breaker.")
            circuitOpenUntil = Date.now() + CIRCUIT_BACKOFF_MS
        }
        throw e
    }
}

export class LLMService {
    private settings: AISettings

    constructor(settings: AISettings) {
        this.settings = settings
    }

    private getModel() {
        let modelName = this.settings.model

        if (this.settings.deepThink) {
            if (this.settings.provider === 'openai' && (!modelName || modelName.includes('gpt-4o'))) {
                modelName = 'o1-preview'
            } else if (this.settings.provider === 'gemini' && (!modelName || modelName.includes('gemini-1.5'))) {
                modelName = 'gemini-1.5-pro'
            } else if (this.settings.provider === 'anthropic' && (!modelName || modelName.includes('claude-3'))) {
                modelName = 'claude-3-5-sonnet-latest'
            }
        }

        if (this.settings.provider === 'openai' || this.settings.provider === 'local' || this.settings.provider === 'custom') {
            return new ChatOpenAI({
                apiKey: this.settings.provider === 'openai' ? this.settings.apiKey : (this.settings.apiKey || 'not-needed'),
                modelName: modelName || (this.settings.provider === 'openai' ? 'gpt-4o-mini' : 'local-model'),
                temperature: this.settings.temperature,
                configuration: {
                    baseURL: this.settings.baseUrl
                }
            })
        } else if (this.settings.provider === 'gemini') {
            return new ChatGoogleGenerativeAI({
                apiKey: this.settings.apiKey,
                model: modelName || 'gemini-1.5-flash',
                maxOutputTokens: 2048,
                temperature: this.settings.temperature,
            })
        } else if (this.settings.provider === 'anthropic') {
            return new ChatAnthropic({
                anthropicApiKey: this.settings.apiKey,
                modelName: modelName || 'claude-3-5-haiku-latest',
                temperature: this.settings.temperature,
            })
        }
        throw new Error('Unsupported provider')
    }

    async generateResponse(
        systemPrompt: string,
        userQuery: string,
        history: ChatHistoryMessage[] = []
    ): Promise<string> {
        if (!this.settings.apiKey && !['local', 'custom'].includes(this.settings.provider)) {
            throw new Error('API Key is missing')
        }

        let effectivePrompt = systemPrompt
        if (this.settings.deepThink) {
            effectivePrompt = `[SYSTEM: ADVANCED REASONING MODE ACTIVE]
- Think step-by-step privately.
- Output ONLY the final answer.
- Add a short "Rationale" section with 2-4 bullets (no hidden chain-of-thought).

${effectivePrompt}`
        }

        return guardedCall(async () => {
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
                console.error('LLM Generation Error:', error)
                throw new Error('Failed to generate response from AI provider.')
            }
        })
    }

    /**
     * Converts chat history to LangChain message format
     */
    private historyToMessages(history: ChatHistoryMessage[]): BaseMessage[] {
        return history.map(msg =>
            msg.role === 'user'
                ? new HumanMessage(msg.content)
                : new AIMessage(msg.content)
        )
    }

    async *streamResponse(
        systemPrompt: string,
        userQuery: string,
        signal?: AbortSignal,
        history?: ChatHistoryMessage[]
    ): AsyncGenerator<string, void, unknown> {
        if (!this.settings.apiKey && !['local', 'custom'].includes(this.settings.provider)) {
            throw new Error('API Key is missing')
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

        // We can't easily wrap a generator in guardedCall, so we manually check
        const now = Date.now()
        if (now < circuitOpenUntil) {
            const waitSec = Math.ceil((circuitOpenUntil - now) / 1000)
            throw new Error(`Circuit Breaker Open: Quota exceeded. Please wait ${waitSec}s.`)
        }
        const gateStatus = GLOBAL_RATE_GATE.canSendNow()
        if (!gateStatus.ok) throw new Error(`Rate Limit Exceeded (${gateStatus.reason}). Please slow down.`)

        try {
            GLOBAL_RATE_GATE.markSent()

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
            console.error('LLM Streaming Error:', error)

            let message = 'Failed to stream response.'
            const errMsg = String(error?.message || error).toLowerCase()

            if (errMsg.includes('429') || error.status === 429 || errMsg.includes('resource exhausted') || errMsg.includes('quota')) {
                console.warn("429 Encountered in Stream. Opening Circuit Breaker.")
                circuitOpenUntil = Date.now() + CIRCUIT_BACKOFF_MS
                message = "🚨 **Quota Exceeded (429):** You've reached your API limit. Please wait a minute or check your plan."
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

        return guardedCall(async () => {
            try {
                const model = this.getModel()
                const response = await model.invoke([
                    new SystemMessage("You are a metadata classifier."),
                    new HumanMessage(prompt),
                ])
                return typeof response.content === 'string' ? response.content.trim() : "Helpful Assistant"
            } catch (e) {
                console.error('Classification Error:', e)
                return "Helpful Assistant"
            }
        })
    }
}

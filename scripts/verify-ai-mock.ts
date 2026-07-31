import assert from 'node:assert/strict'

import { LLMService } from '../apps/reader/src/lib/ai/llm'

import { startMockServer } from './ai-mock-server.cjs'

async function run() {
  const mock = (await startMockServer({ port: 0 })) as {
    baseUrl: string
    close: () => Promise<void>
  }

  try {
    const modelsResponse = await fetch(`${mock.baseUrl}/models`)
    assert.equal(modelsResponse.status, 200)
    const models = await modelsResponse.json()
    assert.equal(models.data[0].id, 'lumen-mock-1')

    const service = new LLMService({
      provider: 'local',
      apiKey: '',
      model: 'lumen-mock-1',
      temperature: 0.2,
      systemPrompt: 'You are a local test assistant.',
      baseUrl: mock.baseUrl,
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
    })

    let streamed = ''
    for await (const chunk of service.streamResponse(
      'You are a local test assistant.',
      'hello from the smoke test',
    )) {
      streamed += chunk
    }
    assert.match(
      streamed,
      /Mock streaming is working\. Received: hello from the smoke test/,
    )

    const rateLimitResponse = await fetch(`${mock.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'lumen-mock-1',
        messages: [{ role: 'user', content: '[mock:rate-limit]' }],
      }),
    })
    assert.equal(rateLimitResponse.status, 429)

    console.log('AI mock compatibility checks passed.')
  } finally {
    await mock.close()
  }
}

void run()

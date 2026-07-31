/* eslint-disable no-console */
import assert from 'node:assert/strict'

import type { AISettings } from '../apps/reader/src/lib/ai/config'
import { LLMService } from '../apps/reader/src/lib/ai/llm'

function baseSettings(): AISettings {
  return {
    provider: 'gemini',
    apiKey: '',
    model: 'gemini-test-model',
    temperature: 0.3,
    systemPrompt:
      'You are a helpful assistant answering questions about the book.',
    baseUrl: '',
    autoPersona: false,
    insightTriggers: false,
    deepThink: false,
    explainSelection: true,
    summarizeSelection: true,
    answerDepth: 'balanced',
    aiScope: 'book_only',
    downloadLocalModels: true,
  }
}

function makeSettings(overrides: Partial<AISettings>): AISettings {
  return { ...baseSettings(), ...overrides }
}

function getModelUnsafe(settings: AISettings): any {
  const service = new LLMService(settings) as any
  return service.getModel()
}

function expectThrows(
  fn: () => unknown,
  label: string,
  messageIncludes: string,
) {
  try {
    fn()
    throw new Error(`[${label}] expected to throw`)
  } catch (err: any) {
    const msg = String(err?.message || err)
    assert(
      msg.includes(messageIncludes),
      `[${label}] wrong error message: ${msg}`,
    )
  }
}

function run() {
  console.log('Running provider verification (offline)...')

  {
    const model = getModelUnsafe(
      makeSettings({
        provider: 'openai',
        apiKey: 'sk-test',
        model: 'openai-test-model',
        baseUrl: 'http://localhost:11434/v1',
      }),
    )
    const hasBaseUrl = !!model?.clientConfig?.baseURL
    assert.equal(
      hasBaseUrl,
      false,
      '[openai] must not inherit baseURL from local/custom endpoint',
    )
  }

  {
    const model = getModelUnsafe(
      makeSettings({
        provider: 'local',
        apiKey: '',
        model: 'local-test-model',
        baseUrl: 'http://localhost:11434/v1',
      }),
    )
    assert.equal(
      model?.clientConfig?.baseURL,
      'http://localhost:11434/v1',
      '[local] must use baseURL',
    )
  }

  {
    const model = getModelUnsafe(
      makeSettings({
        provider: 'custom',
        apiKey: 'sk-proxy',
        model: 'openai-test-model',
        baseUrl: 'https://openrouter.ai/api/v1',
      }),
    )
    assert.equal(
      model?.clientConfig?.baseURL,
      'https://openrouter.ai/api/v1',
      '[custom] must use baseURL',
    )
  }

  expectThrows(
    () =>
      getModelUnsafe(
        makeSettings({
          provider: 'local',
          apiKey: '',
          model: 'local-test-model',
          baseUrl: '',
        }),
      ),
    'local-missing-base-url',
    'I18N_ERR:base_url_required',
  )

  expectThrows(
    () =>
      getModelUnsafe(
        makeSettings({
          provider: 'custom',
          apiKey: '',
          model: 'openai-test-model',
          baseUrl: 'https://openrouter.ai/api/v1',
        }),
      ),
    'custom-missing-api-key',
    'I18N_ERR:api_key_missing',
  )

  expectThrows(
    () =>
      getModelUnsafe(
        makeSettings({
          provider: 'anthropic',
          apiKey: '',
          model: 'anthropic-test-model',
        }),
      ),
    'anthropic-missing-api-key',
    'I18N_ERR:api_key_missing',
  )

  expectThrows(
    () =>
      getModelUnsafe(
        makeSettings({
          provider: 'gemini',
          apiKey: '',
          model: 'gemini-test-model',
        }),
      ),
    'gemini-missing-api-key',
    'I18N_ERR:api_key_missing',
  )

  console.log('All provider verification checks passed.')
}

run()

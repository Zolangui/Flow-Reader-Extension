/* eslint-disable no-undef */
// A generic browser action handler for both Chrome and Firefox,
// and for both Manifest V2 and V3.

// Check if the 'browser' namespace is available, otherwise fall back to 'chrome'.
const api = typeof browser !== 'undefined' ? browser : chrome

// In Manifest V3, the 'action' API replaced 'browserAction'.
const actionApi = api.action || api.browserAction

actionApi.onClicked.addListener((tab) => {
  api.tabs.create({
    url: 'index.html',
    index: tab.index + 1,
  })
})

// ============================================================================
// SOTA 2026: Firefox Native ML Handler (browser.trial.ml)
// CRITICAL: The API uses createEngine() + runEngine() pattern, NOT engine.run()
// See: https://firefox-source-docs.mozilla.org/toolkit/components/ml/extensions.html
// ============================================================================

let engineKey = null
let engineBusy = Promise.resolve() // Mutex - Firefox doesn't allow parallel engines
let batchRequestSeq = 0
let singleRequestSeq = 0

function isEngineAlreadyCreatedError(err) {
  const msg = String(err?.message || err || '')
  return /engine already created/i.test(msg)
}

function nowMs() {
  if (
    typeof performance !== 'undefined' &&
    typeof performance.now === 'function'
  ) {
    return performance.now()
  }
  return Date.now()
}

function summarizeTexts(texts) {
  const safe = Array.isArray(texts) ? texts : []
  if (safe.length === 0) {
    return { count: 0, totalChars: 0, avgChars: 0, minChars: 0, maxChars: 0 }
  }
  let totalChars = 0
  let minChars = Number.POSITIVE_INFINITY
  let maxChars = 0
  for (const t of safe) {
    const len = String(t || '').length
    totalChars += len
    if (len < minChars) minChars = len
    if (len > maxChars) maxChars = len
  }
  return {
    count: safe.length,
    totalChars,
    avgChars: Math.round(totalChars / safe.length),
    minChars: Number.isFinite(minChars) ? minChars : 0,
    maxChars,
  }
}

// Check if browser.trial.ml is available (only appears after permission granted)
function hasFirefoxML() {
  return !!(api.trial?.ml?.createEngine && api.trial?.ml?.runEngine)
}

// Ensure engine is created with specific config
async function ensureEngine({
  taskName,
  modelHub = 'huggingface',
  modelId,
  device,
  dtype,
}) {
  const key = JSON.stringify({ taskName, modelHub, modelId, device, dtype })
  if (engineKey === key) return

  console.log('[Background] Creating Firefox ML engine:', { taskName, modelId })

  try {
    // NOTE: createEngine does NOT return an engine object!
    // It creates the engine internally, then use runEngine() to execute
    await api.trial.ml.createEngine({
      taskName,
      modelHub,
      ...(modelId ? { modelId } : {}),
      ...(device ? { device } : {}),
      ...(dtype ? { dtype } : {}),
    })

    engineKey = key
    console.log('[Background] Engine created for:', key)
  } catch (err) {
    if (isEngineAlreadyCreatedError(err)) {
      engineKey = key
      console.warn(
        '[Background] Engine already exists, reusing current engine for:',
        key,
      )
      return
    }
    console.error('[Background] createEngine failed:', err)
    throw err
  }
}

// Helper: Safely extract inner array if nested (Firefox ML sometimes returns [[...]])
function unwrapVector(v) {
  if (Array.isArray(v) && Array.isArray(v[0])) return v[0]
  return v
}

// Helper: Convert to Float32Array regardless of input type
function toFloat32(v) {
  const u = unwrapVector(v)
  if (ArrayBuffer.isView(u)) return Float32Array.from(u)
  if (Array.isArray(u)) return Float32Array.from(u)
  return new Float32Array(0) // Should probably be error, but safe fallback
}

function requireEmbeddingModelId(modelId) {
  const value = String(modelId || '').trim()
  if (!value) {
    throw new Error('Missing embedding modelId')
  }
  return value
}

// Embed text using feature-extraction task
async function embedText(text, { modelId } = {}) {
  const resolvedModelId = requireEmbeddingModelId(modelId)
  await ensureEngine({
    taskName: 'feature-extraction',
    modelHub: 'huggingface',
    modelId: resolvedModelId,
  })

  // Use runEngine (NOT engine.run)
  const res = await api.trial.ml.runEngine({
    args: [text],
    options: { pooling: 'mean', normalize: true },
  })

  // Safe normalization
  return toFloat32(res)
}

/**
 * SOTA: Batch Embedding Handler
 * Uses native array support if available, otherwise falls back to loop.
 */
async function embedBatch(texts, { modelId, batchId = '?' } = {}) {
  const resolvedModelId = requireEmbeddingModelId(modelId)
  const stats = summarizeTexts(texts)
  const startedAt = nowMs()
  console.log(`[Background][Batch#${batchId}] start`, {
    modelId: resolvedModelId,
    ...stats,
  })

  const ensureStartedAt = nowMs()
  await ensureEngine({
    taskName: 'feature-extraction',
    modelHub: 'huggingface',
    modelId: resolvedModelId,
  })
  const ensureMs = Math.round(nowMs() - ensureStartedAt)

  console.log(
    `[Background] Processing batch of ${
      Array.isArray(texts) ? texts.length : 0
    } texts`,
  )

  try {
    const nativeStartedAt = nowMs()
    const res = await api.trial.ml.runEngine({
      args: [texts],
      options: { pooling: 'mean', normalize: true },
    })
    const nativeMs = Math.round(nowMs() - nativeStartedAt)

    if (!Array.isArray(res)) {
      throw new Error(`Batch runEngine did not return an array: ${typeof res}`)
    }

    const convertStartedAt = nowMs()
    const vectors = res.map(toFloat32)
    const convertMs = Math.round(nowMs() - convertStartedAt)
    const totalMs = Math.round(nowMs() - startedAt)
    const outputCount = vectors.length
    const dim = outputCount > 0 ? vectors[0].length : 0

    console.log(`[Background][Batch#${batchId}] native_batch_done`, {
      ensureMs,
      nativeMs,
      convertMs,
      totalMs,
      outputCount,
      dim,
      msPerItem:
        outputCount > 0 ? Number((totalMs / outputCount).toFixed(1)) : 0,
      charsPerItem:
        stats.count > 0
          ? Number((stats.totalChars / stats.count).toFixed(1))
          : 0,
      mode: 'native_batch',
    })

    return vectors
  } catch (err) {
    console.warn(
      '[Background] Native batch failed, falling back to sequential loop:',
      err?.message || err,
    )
    const vectors = []
    const sequentialStartedAt = nowMs()
    try {
      let i = 0
      for (const text of texts) {
        const itemStartedAt = nowMs()
        const res = await api.trial.ml.runEngine({
          args: [text],
          options: { pooling: 'mean', normalize: true },
        })
        vectors.push(toFloat32(res))
        i += 1
        if (i === 1 || i % 8 === 0 || i === texts.length) {
          console.log(`[Background][Batch#${batchId}] sequential_progress`, {
            done: i,
            total: texts.length,
            lastItemMs: Math.round(nowMs() - itemStartedAt),
          })
        }
      }
    } catch (loopErr) {
      console.error('[Background] Sequential loop fallback failed:', loopErr)
      throw loopErr
    }

    const sequentialMs = Math.round(nowMs() - sequentialStartedAt)
    const totalMs = Math.round(nowMs() - startedAt)
    const outputCount = vectors.length
    const dim = outputCount > 0 ? vectors[0].length : 0
    console.warn(`[Background][Batch#${batchId}] sequential_done`, {
      ensureMs,
      sequentialMs,
      totalMs,
      outputCount,
      dim,
      msPerItem:
        outputCount > 0 ? Number((totalMs / outputCount).toFixed(1)) : 0,
      charsPerItem:
        stats.count > 0
          ? Number((stats.totalChars / stats.count).toFixed(1))
          : 0,
      mode: 'sequential_fallback',
    })
    return vectors
  }
}

// Handle messages from extension pages
api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Permission/availability check
  if (message.type === 'firefox-ml-check') {
    // Also log permission status for debugging
    api.permissions.contains({ permissions: ['trialML'] }).then((granted) => {
      console.log('[Background] trialML permission granted:', granted)
      console.log('[Background] browser.trial exists:', !!api.trial)
      console.log('[Background] browser.trial.ml exists:', !!api.trial?.ml)
      sendResponse({
        available: hasFirefoxML(),
        permission: granted,
        trialExists: !!api.trial,
        mlExists: !!api.trial?.ml,
      })
    })
    return true // Async response
  }

  // Batch Embedding Request (SOTA)
  if (message.type === 'firefox-ml-embed-batch') {
    if (!hasFirefoxML()) {
      sendResponse({ error: 'Firefox ML not available' })
      return false
    }

    const { texts, modelId } = message.payload || {}
    const batchId = ++batchRequestSeq
    const enqueuedAt = nowMs()
    console.log(`[Background][Batch#${batchId}] enqueued`, {
      count: Array.isArray(texts) ? texts.length : 0,
    })

    engineBusy = engineBusy
      .then(async () => {
        try {
          const queueWaitMs = Math.round(nowMs() - enqueuedAt)
          console.log(`[Background][Batch#${batchId}] dequeue`, { queueWaitMs })
          const vectors = await embedBatch(texts, { modelId, batchId })
          // Convert to regular arrays for serialization over JSON-RPC (standard for sendMessage)
          sendResponse(vectors.map((v) => Array.from(v)))
        } catch (err) {
          console.error(
            `[Background][Batch#${batchId}] ML batch embed error:`,
            err,
          )
          sendResponse({ error: err?.message || String(err) })
        }
      })
      .catch((err) => {
        console.error(`[Background][Batch#${batchId}] queue error:`, err)
        sendResponse({ error: err?.message || String(err) })
      })

    return true
  }

  // Embedding request
  if (message.type === 'firefox-ml-embed') {
    if (!hasFirefoxML()) {
      sendResponse({
        error:
          'Firefox ML not available (trialML not granted or prefs/version missing)',
      })
      return false
    }

    const { text, modelId, prefix } = message.payload || {}
    const input = prefix ? `${prefix}${text}` : text
    const singleId = ++singleRequestSeq
    const enqueuedAt = nowMs()
    console.log(`[Background][Single#${singleId}] enqueued`, {
      chars: input.length,
    })

    // Serialize calls - Firefox doesn't allow parallel engines
    engineBusy = engineBusy
      .then(async () => {
        try {
          const queueWaitMs = Math.round(nowMs() - enqueuedAt)
          const startedAt = nowMs()
          const vec = await embedText(input, { modelId })
          const totalMs = Math.round(nowMs() - startedAt)
          console.log(`[Background][Single#${singleId}] done`, {
            queueWaitMs,
            totalMs,
            chars: input.length,
            dim: vec.length,
            msPer1kChars:
              input.length > 0
                ? Number((totalMs / (input.length / 1000)).toFixed(1))
                : 0,
          })
          sendResponse({ embedding: Array.from(vec) })
        } catch (err) {
          console.error(`[Background][Single#${singleId}] ML embed error:`, err)
          sendResponse({ error: err?.message || String(err) })
        }
      })
      .catch((err) => {
        console.error(`[Background][Single#${singleId}] queue error:`, err)
        sendResponse({ error: err?.message || String(err) })
      })

    return true // Async response
  }

  return false
})

// Progress listener for model downloads
if (api.trial?.ml?.onProgress) {
  api.trial.ml.onProgress.addListener((progress) => {
    console.log('[Background] ML progress:', progress)
  })
}

console.log('[Background] Firefox ML handler initialized')
console.log('[Background] hasFirefoxML:', hasFirefoxML())

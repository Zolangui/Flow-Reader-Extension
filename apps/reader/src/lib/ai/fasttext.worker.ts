/// <reference lib="webworker" />

// CSP-safe FastText WASM language identification worker.
// Protocol consumed by `apps/reader/src/lib/ai/language.ts`:
// - inbound: { type: 'detect', id, text }
// - outbound: { type: 'fasttext-ready' } once model is loaded
// - outbound: { type: 'fasttext-debug', data }
// - outbound: { type: 'fasttext-error', data: { message, stage } }
// - outbound: { id, lang } or { id, error }

const DEBUG = process.env.NODE_ENV !== 'production'
const FASTTEXT_ASSET_VERSION = '20260204b'

type LidModel = {
  load: () => Promise<any>
  identify: (
    text: string,
  ) => Promise<{ alpha2?: string | null; alpha3?: string | null }>
}

function debugLog(message: string, data?: Record<string, any>) {
  if (!DEBUG) return
  try {
    self.postMessage({
      type: 'fasttext-debug',
      data: { message, ...(data || {}) },
    })
  } catch {
    // ignore
  }
}

function emitError(message: string, stage: string) {
  try {
    self.postMessage({ type: 'fasttext-error', data: { message, stage } })
  } catch {
    // ignore
  }
}

function resolveAssetURL(path: string) {
  const g: any = self as any
  const getURL = g.browser?.runtime?.getURL || g.chrome?.runtime?.getURL
  const origin = g?.location?.origin || ''
  const raw =
    typeof getURL === 'function'
      ? getURL(path)
      : `${origin}/${path.replace(/^\//, '')}`
  return `${raw}${raw.includes('?') ? '&' : '?'}v=${FASTTEXT_ASSET_VERSION}`
}

let modelPromise: Promise<LidModel> | null = null
let readySent = false

async function getModel(): Promise<LidModel> {
  if (modelPromise) return modelPromise

  modelPromise = (async () => {
    // Import the LID module directly (avoid broad re-export entrypoints that may trigger
    // Firefox MV3 module-graph quirks like duplicate default export collisions).
    debugLog('init_start', {
      module: '/fastText/models/language-identification/common.mjs',
    })

    const moduleUrl = resolveAssetURL(
      'fastText/models/language-identification/common.mjs',
    )
    debugLog('fetch', { url: moduleUrl })
    // IMPORTANT: keep this as a native dynamic import (not a webpack context module),
    // otherwise Firefox MV3 can fail to resolve the generated chunk URL.
    const mod: any = await import(/* webpackIgnore: true */ moduleUrl)

    const getLIDModel = mod?.getLIDModel || mod?.getLanguageIdentificationModel
    if (typeof getLIDModel !== 'function') {
      throw new Error('fasttext_module_missing_getLIDModel')
    }

    const wasmPath = resolveAssetURL('fastText/fastText.common.wasm')
    const modelPath = resolveAssetURL('fastText/models/lid.176.ftz')

    debugLog('model_loading', { wasmPath, modelPath })

    const lidModel: LidModel = await getLIDModel({ wasmPath, modelPath })
    await lidModel.load()

    if (!readySent) {
      readySent = true
      self.postMessage({ type: 'fasttext-ready' })
    }

    debugLog('model_ready')
    return lidModel
  })().catch((err) => {
    const msg = err instanceof Error ? err.message : String(err)
    debugLog('init_error', { message: msg })
    emitError(msg, 'init')
    throw err
  })

  return modelPromise
}

self.onmessage = (e: MessageEvent) => {
  const { type, id, text } = (e as any).data || {}
  if (type !== 'detect' || typeof id !== 'number') return

  void (async () => {
    try {
      const input =
        typeof text === 'string' ? text.trim() : String(text || '').trim()
      debugLog('detect_start', { length: input.length })

      // Avoid unstable results on extremely short inputs.
      if (input.length < 3) {
        self.postMessage({ id, lang: 'und' })
        return
      }

      const model = await getModel()
      const result = await model.identify(input)
      const lang = result?.alpha2 || result?.alpha3 || 'und'
      self.postMessage({ id, lang })
    } catch (err: any) {
      const message = String(err?.message || err)
      debugLog('detect_error', { message })
      emitError(message, 'detect')
      self.postMessage({ id, error: message })
    }
  })()
}

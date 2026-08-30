import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import {
  AI_CONFIG,
  DEFAULT_AI_SETTINGS,
} from '../apps/reader/src/lib/ai/config'
import {
  CLOUD_PROVIDER_HOST_PERMISSIONS,
  CUSTOM_PROVIDER_HOST_PERMISSIONS,
  LOCAL_MODEL_HOST_PERMISSIONS,
  LOOPBACK_HOST_PERMISSIONS,
  validateProviderBaseUrl,
} from '../apps/reader/src/lib/ai/permissions'

const root = path.resolve(__dirname, '..')

assert.equal(
  validateProviderBaseUrl('local', 'http://localhost:11434/v1').ok,
  true,
)
assert.equal(DEFAULT_AI_SETTINGS.temperature, 0.3)
assert.equal(AI_CONFIG.embeddingDimFirefoxLocal, 1024)
assert.equal(AI_CONFIG.embeddingDimFirefoxNative, 768)
assert(
  AI_CONFIG.embeddingIndexDimFirefox <= AI_CONFIG.embeddingDimFirefoxLocal,
  'Firefox index dimension cannot exceed the local model output',
)
assert.equal(
  validateProviderBaseUrl('local', 'https://api.example.com/v1').ok,
  false,
)
assert.equal(
  validateProviderBaseUrl('custom', 'https://openrouter.ai/api/v1').ok,
  true,
)
assert.equal(
  validateProviderBaseUrl('custom', 'https://unreviewed.example/v1').ok,
  false,
)
assert.equal(
  validateProviderBaseUrl('custom', 'http://openrouter.ai/api/v1').ok,
  false,
)

for (const manifestName of [
  'chrome_manifest_v3.json',
  'firefox_manifest_v3.json',
]) {
  const manifestPath = path.join(
    root,
    'apps',
    'extension',
    'manifests',
    manifestName,
  )
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  const optionalHosts: string[] = manifest.optional_host_permissions || []
  const requiredOptionalHosts = new Set([
    ...CLOUD_PROVIDER_HOST_PERMISSIONS,
    ...CUSTOM_PROVIDER_HOST_PERMISSIONS,
    ...LOCAL_MODEL_HOST_PERMISSIONS,
    ...LOOPBACK_HOST_PERMISSIONS,
  ])
  for (const host of requiredOptionalHosts) {
    assert(optionalHosts.includes(host), `${manifestName} is missing ${host}`)
  }
}

const stateSource = fs.readFileSync(
  path.join(root, 'apps', 'reader', 'src', 'state.ts'),
  'utf8',
)
assert(stateSource.includes('function aiSettingsStorageEffect'))
assert(stateSource.includes('delete stored.apiKey'))

const backgroundSource = fs.readFileSync(
  path.join(root, 'apps', 'extension', 'public', 'background.js'),
  'utf8',
)
assert(backgroundSource.includes('requireEmbeddingModelId'))
assert(
  !/modelId\s*\|\|\s*['"][^'"]+['"]/.test(backgroundSource),
  'background must not choose a hidden fallback embedding model',
)

const modelSources = [
  path.join(root, 'apps', 'reader', 'src', 'lib', 'ai', 'config.ts'),
  path.join(root, 'apps', 'reader', 'src', 'lib', 'ai', 'slm.worker.ts'),
].map((file) => fs.readFileSync(file, 'utf8'))
for (const source of modelSources) {
  assert(
    !source.includes('/resolve/main/'),
    'local model URL must be immutable',
  )
}

console.log('AI release safety checks passed.')

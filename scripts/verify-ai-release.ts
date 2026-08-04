import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { validateProviderBaseUrl } from '../apps/reader/src/lib/ai/permissions'

const root = path.resolve(__dirname, '..')

assert.equal(
  validateProviderBaseUrl('local', 'http://localhost:11434/v1').ok,
  true,
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
  for (const host of [
    'https://api.openai.com/*',
    'https://generativelanguage.googleapis.com/*',
    'https://api.anthropic.com/*',
    'https://huggingface.co/*',
    'https://cdn-lfs.huggingface.co/*',
    'https://hf.co/*',
    'http://localhost/*',
  ]) {
    assert(optionalHosts.includes(host), `${manifestName} is missing ${host}`)
  }
}

const stateSource = fs.readFileSync(
  path.join(root, 'apps', 'reader', 'src', 'state.ts'),
  'utf8',
)
assert(stateSource.includes('function aiSettingsStorageEffect'))
assert(stateSource.includes('delete stored.apiKey'))

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

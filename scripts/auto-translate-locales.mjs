import fs from 'node:fs'
import path from 'node:path'

function loadLocale(filePath) {
  let src = fs.readFileSync(filePath, 'utf8')
  src = src.replace(/export default\s*/, 'return ')
  src = src.replace(/}\s+as const\s*;?\s*$/m, '}')
  // eslint-disable-next-line no-new-func
  return new Function(src)()
}

function formatAsTsObject(obj, orderedKeys) {
  const lines = []
  lines.push('export default {')
  for (const k of orderedKeys) {
    const v = obj[k]
    if (typeof v !== 'string') throw new Error(`Non-string value for key ${k}`)
    lines.push(`  ${JSON.stringify(k)}: ${JSON.stringify(v)},`)
  }
  lines.push('} as const')
  lines.push('')
  return lines.join('\n')
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function protectPlaceholders(s) {
  const vars = []
  const out = s.replace(/\{[^}]+\}/g, (m) => {
    const idx = vars.length
    vars.push(m)
    return `__VAR_${idx}__`
  })
  return { out, vars }
}

function restorePlaceholders(s, vars) {
  let out = s
  for (let i = 0; i < vars.length; i++) {
    out = out.replaceAll(`__VAR_${i}__`, vars[i])
  }
  return out
}

function decodeHtml(s) {
  return s
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
}

async function translateMyMemory(text, toLang) {
  const base = 'https://api.mymemory.translated.net/get'
  const url = `${base}?q=${encodeURIComponent(text)}&langpair=en|${encodeURIComponent(toLang)}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`translate http ${res.status}`)
  const json = await res.json()
  const best = json?.responseData?.translatedText
  if (typeof best !== 'string') throw new Error('translate missing translatedText')
  return decodeHtml(best)
}

async function mapLimit(items, limit, fn) {
  const ret = new Array(items.length)
  let i = 0
  async function worker() {
    while (true) {
      const idx = i++
      if (idx >= items.length) return
      ret[idx] = await fn(items[idx], idx)
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker())
  await Promise.all(workers)
  return ret
}

const root = process.cwd()
const localesDir = path.join(root, 'apps/reader/locales')
const enPath = path.join(localesDir, 'en-US.ts')
const en = loadLocale(enPath)
const orderedKeys = Object.keys(en)

const cachePath = path.join(root, 'scripts/.translate-cache.json')
let cache = {}
if (fs.existsSync(cachePath)) {
  try {
    cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'))
  } catch {
    cache = {}
  }
}

const targets = [
  { file: 'fr-FR.ts', lang: 'fr' },
  { file: 'es-ES.ts', lang: 'es' },
  { file: 'de-DE.ts', lang: 'de' },
]

for (const t of targets) {
  const p = path.join(localesDir, t.file)
  const obj = loadLocale(p)

  const toTranslate = []
  for (const k of orderedKeys) {
    if (!(k in obj) || obj[k] === en[k]) {
      toTranslate.push(k)
    }
  }

  console.log(`[i18n] ${t.file}: ${toTranslate.length} strings to translate (en fallback)`)

  await mapLimit(toTranslate, 4, async (k) => {
    const src = en[k]
    if (typeof src !== 'string') return

    // Keep some strings as-is (brand / acronyms)
    if (k === 'details.epub_format') {
      obj[k] = src
      return
    }

    const { out, vars } = protectPlaceholders(src)
    const cacheKey = `${t.lang}::${out}`
    if (cache[cacheKey]) {
      obj[k] = restorePlaceholders(cache[cacheKey], vars)
      return
    }

    // Retry with small backoff
    let translated = ''
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        translated = await translateMyMemory(out, t.lang)
        break
      } catch (e) {
        if (attempt === 3) throw e
        await sleep(300 + attempt * 400)
      }
    }

    translated = restorePlaceholders(translated, vars)

    // MyMemory sometimes returns identical English; keep but don't cache aggressively.
    cache[cacheKey] = translated
    obj[k] = translated
  })

  fs.writeFileSync(p, formatAsTsObject(obj, orderedKeys), 'utf8')
  fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2), 'utf8')
  console.log(`[i18n] wrote ${t.file}`)
}

console.log('[i18n] done')

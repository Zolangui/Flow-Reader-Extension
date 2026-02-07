import fs from 'node:fs'
import path from 'node:path'

function loadLocale(filePath) {
  let src = fs.readFileSync(filePath, 'utf8')
  src = src.replace(/export default\s*/, 'return ')
  src = src.replace(/}\s+as const\s*;?\s*$/m, '}')
  // eslint-disable-next-line no-new-func
  return new Function(src)()
}

const dir = path.join(process.cwd(), 'apps/reader/locales')
const en = loadLocale(path.join(dir, 'en-US.ts'))

for (const lang of ['de-DE', 'es-ES', 'fr-FR']) {
  const o = loadLocale(path.join(dir, `${lang}.ts`))
  const missing = {}
  for (const k of Object.keys(en)) {
    if (o[k] === en[k]) missing[k] = en[k]
  }
  const outPath = path.join(process.cwd(), 'scripts', `missing-${lang}.json`)
  fs.writeFileSync(outPath, JSON.stringify(missing, null, 2))
  console.log(`${lang}: ${Object.keys(missing).length} untranslated -> ${outPath}`)
}

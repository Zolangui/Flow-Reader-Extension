import fs from 'node:fs'
import path from 'node:path'

function loadLocale(filePath) {
  let src = fs.readFileSync(filePath, 'utf8')
  // Strip UTF-8 BOM if present.
  if (src.charCodeAt(0) === 0xfeff) src = src.slice(1)
  src = src.replace(/export default\s*/, 'return ')
  src = src.replace(/}\s+as const\s*;?\s*$/m, '}')
  // eslint-disable-next-line no-new-func
  return new Function(src)()
}

const dir = path.join(process.cwd(), 'apps/reader/locales')
const en = loadLocale(path.join(dir, 'en-US.ts'))

const localeFiles = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith('.ts') && f !== 'index.ts')
  .map((f) => f.replace(/\.ts$/, ''))
  .sort()

const enKeys = Object.keys(en)

for (const lang of localeFiles) {
  const o = loadLocale(path.join(dir, `${lang}.ts`))
  const missingKeys = enKeys.filter((k) => !(k in o))
  const sameAsEn = enKeys.filter((k) => o[k] === en[k])

  console.log(
    `${lang}: missingKeys=${missingKeys.length} sameAsEn=${sameAsEn.length}`,
  )

  if (missingKeys.length) {
    console.log(`  missing: ${missingKeys.slice(0, 20).join(', ')}`)
  }
}


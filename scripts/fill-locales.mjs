import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const localesDir = path.join(root, 'apps/reader/locales');

function readFile(p) {
  return fs.readFileSync(p, 'utf8');
}

function extractObjectLiteral(ts, { marker }) {
  const idx = ts.indexOf(marker);
  if (idx === -1) throw new Error(`marker not found: ${marker}`);
  const after = ts.slice(idx + marker.length);

  // Find first '{'
  const firstBrace = after.indexOf('{');
  if (firstBrace === -1) throw new Error('no { after marker');

  let i = firstBrace;
  let depth = 0;
  let inStr = false;
  let strQuote = '';
  let escaped = false;

  for (; i < after.length; i++) {
    const ch = after[i];

    if (inStr) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === strQuote) {
        inStr = false;
        strQuote = '';
        continue;
      }
      continue;
    }

    if (ch === '\'' || ch === '"') {
      inStr = true;
      strQuote = ch;
      continue;
    }

    if (ch === '{') depth++;
    if (ch === '}') {
      depth--;
      if (depth === 0) {
        // include closing brace
        return after.slice(firstBrace, i + 1);
      }
    }
  }

  throw new Error('unbalanced braces while extracting object');
}

function evalObjectLiteral(objText) {
  // Evaluate as JS object. Assumes it's data-only.
  // eslint-disable-next-line no-new-func
  const fn = new Function(`return (${objText});`);
  return fn();
}

function formatAsTsObject(obj, orderedKeys) {
  const lines = [];
  lines.push('export default {');
  for (const k of orderedKeys) {
    const v = obj[k];
    if (typeof v !== 'string') {
      throw new Error(`Non-string value for key ${k}: ${typeof v}`);
    }
    const kk = JSON.stringify(k);
    const vv = JSON.stringify(v);
    lines.push(`  ${kk}: ${vv},`);
  }
  lines.push('} as const');
  lines.push('');
  return lines.join('\n');
}

const enPath = path.join(localesDir, 'en-US.ts');
const enTs = readFile(enPath);
const enObjText = extractObjectLiteral(enTs, { marker: 'export default' });
const en = evalObjectLiteral(enObjText);
const orderedKeys = Object.keys(en);

const targets = ['de-DE.ts', 'es-ES.ts', 'fr-FR.ts'];

for (const file of targets) {
  const p = path.join(localesDir, file);
  const ts = readFile(p);

  // Reconstructed locales currently define `const xx = { ... } as const`.
  // We'll merge that over en-US and then write a full explicit dictionary.
  let localeObj = {};

  const constMatch = ts.match(/const\s+\w+\s*=\s*\{/);
  if (constMatch?.index != null) {
    const marker = constMatch[0].replace(/\{\s*$/, '');
    const objText = extractObjectLiteral(ts, { marker });
    localeObj = evalObjectLiteral(objText);
  } else {
    // Fallback: maybe it already has export default
    const objText = extractObjectLiteral(ts, { marker: 'export default' });
    localeObj = evalObjectLiteral(objText);
  }

  const merged = { ...en, ...localeObj };

  // Sanity: ensure no keys missing
  for (const k of orderedKeys) {
    if (!(k in merged)) throw new Error(`${file}: missing key ${k}`);
  }

  const out = formatAsTsObject(merged, orderedKeys);
  fs.writeFileSync(p, out, 'utf8');
  console.log(`wrote ${file} (${orderedKeys.length} keys)`);
}

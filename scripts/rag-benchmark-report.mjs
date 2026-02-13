import fs from 'node:fs'
import path from 'node:path'

function printUsage() {
  console.log(`Usage:
  node scripts/rag-benchmark-report.mjs --page <page.log> --background <background.log> [--out <dir>] [--label <name>]
  node scripts/rag-benchmark-report.mjs --log <combined.log> [--out <dir>] [--label <name>]

Examples:
  node scripts/rag-benchmark-report.mjs --page logs/a-page.log --background logs/a-bg.log --out logs/a-report --label A
  node scripts/rag-benchmark-report.mjs --log logs/b-combined.log --out logs/b-report --label B
`)
}

function parseArgs(argv) {
  const out = {
    page: [],
    background: [],
    log: [],
    outDir: 'benchmark-output',
    label: 'run',
    help: false,
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') {
      out.help = true
      continue
    }
    if (arg === '--page') {
      out.page.push(argv[++i])
      continue
    }
    if (arg === '--background' || arg === '--bg') {
      out.background.push(argv[++i])
      continue
    }
    if (arg === '--log') {
      out.log.push(argv[++i])
      continue
    }
    if (arg === '--out') {
      out.outDir = argv[++i]
      continue
    }
    if (arg === '--label') {
      out.label = argv[++i]
      continue
    }
    throw new Error(`Unknown argument: ${arg}`)
  }

  return out
}

function readMany(paths) {
  return paths
    .filter(Boolean)
    .map((p) => fs.readFileSync(path.resolve(p), 'utf8'))
    .join('\n')
}

function pickNumber(block, key) {
  const re = new RegExp(`${key}:\\s*(-?\\d+(?:\\.\\d+)?)`, 'i')
  const m = block.match(re)
  return m ? Number(m[1]) : null
}

function collectEntries(text, markerRe, valueKeys, lookAhead = 600) {
  const out = []
  markerRe.lastIndex = 0
  let m
  while ((m = markerRe.exec(text)) !== null) {
    const start = m.index
    const chunk = text.slice(start, start + lookAhead)
    const item = {
      match: m[0],
      index: start,
      groups: m.slice(1),
    }
    for (const key of valueKeys) {
      item[key] = pickNumber(chunk, key)
    }
    out.push(item)
  }
  return out
}

function percentile(values, p) {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  if (sorted.length === 1) return sorted[0]
  const idx = (sorted.length - 1) * p
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  if (lo === hi) return sorted[lo]
  const t = idx - lo
  return sorted[lo] * (1 - t) + sorted[hi] * t
}

function sum(arr, key) {
  let total = 0
  for (const row of arr) {
    const v = row[key]
    if (typeof v === 'number' && Number.isFinite(v)) total += v
  }
  return total
}

function countNum(arr, key) {
  let n = 0
  for (const row of arr) {
    const v = row[key]
    if (typeof v === 'number' && Number.isFinite(v)) n++
  }
  return n
}

function avg(arr, key) {
  const n = countNum(arr, key)
  if (n === 0) return null
  return sum(arr, key) / n
}

function toCsv(rows, columns) {
  const head = columns.join(',')
  const body = rows.map((row) => {
    return columns
      .map((col) => {
        const v = row[col]
        if (v === null || v === undefined) return ''
        const s = String(v)
        if (s.includes(',') || s.includes('"') || s.includes('\n')) {
          return `"${s.replaceAll('"', '""')}"`
        }
        return s
      })
      .join(',')
  })
  return [head, ...body].join('\n')
}

function byId(entries, idIdx = 0) {
  const map = new Map()
  for (const e of entries) {
    const raw = e.groups[idIdx]
    if (raw === undefined) continue
    const id = Number(raw)
    if (!Number.isFinite(id)) continue
    map.set(id, e)
  }
  return map
}

function round(value, digits = 2) {
  if (value === null || value === undefined) return null
  if (!Number.isFinite(value)) return null
  const p = 10 ** digits
  return Math.round(value * p) / p
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    printUsage()
    return
  }

  if (args.page.length === 0 && args.background.length === 0 && args.log.length === 0) {
    printUsage()
    throw new Error('No input logs provided')
  }

  const combined = readMany(args.log)
  const pageText = readMany(args.page) + '\n' + combined
  const bgText = readMany(args.background) + '\n' + combined

  const sectionToken = collectEntries(
    pageText,
    /Section\s+(\d+)\s*:\s*token-aware pre-chunking/gi,
    ['sentences', 'chunks', 'avgTokens', 'overlapTokens'],
  )
  const sectionEmbed = collectEntries(
    pageText,
    /Section\s+(\d+)\s*:\s*embedding batch timing/gi,
    ['chunks', 'ms', 'msPerChunk'],
  )
  const sectionMerge = collectEntries(
    pageText,
    /Section\s+(\d+)\s*:\s*topic-shift merge/gi,
    ['preChunks', 'semanticChunks', 'threshold', 'mergeMaxTokens'],
  )
  const progress = collectEntries(
    pageText,
    /Index progress timing/gi,
    ['processedSpines', 'totalSpines', 'elapsedMs', 'avgMsPerSection', 'etaMs'],
  )

  const batchStart = collectEntries(
    bgText,
    /\[Background\]\[Batch#(\d+)\]\s+start/gi,
    ['count', 'totalChars', 'avgChars', 'minChars', 'maxChars'],
  )
  const batchDequeue = collectEntries(
    bgText,
    /\[Background\]\[Batch#(\d+)\]\s+dequeue/gi,
    ['queueWaitMs'],
  )
  const batchDoneNative = collectEntries(
    bgText,
    /\[Background\]\[Batch#(\d+)\]\s+native_batch_done/gi,
    ['ensureMs', 'nativeMs', 'convertMs', 'totalMs', 'outputCount', 'dim', 'msPerItem', 'charsPerItem'],
  )
  const batchDoneSeq = collectEntries(
    bgText,
    /\[Background\]\[Batch#(\d+)\]\s+sequential_done/gi,
    ['ensureMs', 'sequentialMs', 'totalMs', 'outputCount', 'dim', 'msPerItem', 'charsPerItem'],
  )
  const singleDone = collectEntries(
    bgText,
    /\[Background\]\[Single#(\d+)\]\s+done/gi,
    ['queueWaitMs', 'totalMs', 'chars', 'dim', 'msPer1kChars'],
  )

  const tokenMap = byId(sectionToken)
  const embedMap = byId(sectionEmbed)
  const mergeMap = byId(sectionMerge)
  const sectionIds = new Set([
    ...[...tokenMap.keys()],
    ...[...embedMap.keys()],
    ...[...mergeMap.keys()],
  ])

  const sectionRows = [...sectionIds]
    .sort((a, b) => a - b)
    .map((id) => {
      const t = tokenMap.get(id) || {}
      const e = embedMap.get(id) || {}
      const m = mergeMap.get(id) || {}
      return {
        section: id,
        sentences: t.sentences ?? null,
        pre_chunks: t.chunks ?? null,
        avg_tokens: t.avgTokens ?? null,
        overlap_tokens: t.overlapTokens ?? null,
        embed_chunks: e.chunks ?? null,
        embed_ms: e.ms ?? null,
        embed_ms_per_chunk: e.msPerChunk ?? null,
        semantic_chunks: m.semanticChunks ?? null,
        merge_threshold: m.threshold ?? null,
      }
    })

  const startMap = byId(batchStart)
  const deqMap = byId(batchDequeue)
  const doneNativeMap = byId(batchDoneNative)
  const doneSeqMap = byId(batchDoneSeq)
  const batchIds = new Set([
    ...[...startMap.keys()],
    ...[...deqMap.keys()],
    ...[...doneNativeMap.keys()],
    ...[...doneSeqMap.keys()],
  ])

  const batchRows = [...batchIds]
    .sort((a, b) => a - b)
    .map((id) => {
      const s = startMap.get(id) || {}
      const q = deqMap.get(id) || {}
      const n = doneNativeMap.get(id)
      const z = doneSeqMap.get(id)
      const d = n || z || {}
      return {
        batch_id: id,
        mode: n ? 'native_batch' : z ? 'sequential_fallback' : '',
        count: s.count ?? d.outputCount ?? null,
        total_chars: s.totalChars ?? null,
        avg_chars: s.avgChars ?? null,
        queue_wait_ms: q.queueWaitMs ?? null,
        total_ms: d.totalMs ?? null,
        native_ms: n?.nativeMs ?? null,
        ensure_ms: d.ensureMs ?? null,
        ms_per_item: d.msPerItem ?? null,
        chars_per_item: d.charsPerItem ?? null,
      }
    })

  const embedMsValues = sectionRows.map((r) => r.embed_ms).filter((v) => Number.isFinite(v))
  const queueMsValues = batchRows.map((r) => r.queue_wait_ms).filter((v) => Number.isFinite(v))
  const batchMsValues = batchRows.map((r) => r.total_ms).filter((v) => Number.isFinite(v))
  const batchItemValues = batchRows.map((r) => r.count).filter((v) => Number.isFinite(v))

  const totalSectionEmbedMs = sum(sectionRows, 'embed_ms')
  const totalSectionEmbedChunks = sum(sectionRows, 'embed_chunks')
  const totalBatchMs = sum(batchRows, 'total_ms')
  const totalBatchItems = sum(batchRows, 'count')
  const lastProgress = progress.length > 0 ? progress[progress.length - 1] : null

  const summary = {
    label: args.label,
    source: {
      page_logs: args.page,
      background_logs: args.background,
      combined_logs: args.log,
    },
    sections: {
      count: sectionRows.length,
      total_embed_ms: round(totalSectionEmbedMs),
      total_embed_chunks: round(totalSectionEmbedChunks),
      weighted_ms_per_chunk:
        totalSectionEmbedChunks > 0 ? round(totalSectionEmbedMs / totalSectionEmbedChunks, 3) : null,
      p50_embed_ms: round(percentile(embedMsValues, 0.5), 3),
      p95_embed_ms: round(percentile(embedMsValues, 0.95), 3),
      avg_pre_chunks_per_section: round(avg(sectionRows, 'pre_chunks'), 3),
      avg_semantic_chunks_per_section: round(avg(sectionRows, 'semantic_chunks'), 3),
      avg_merge_threshold: round(avg(sectionRows, 'merge_threshold'), 4),
    },
    background_batches: {
      count: batchRows.length,
      total_ms: round(totalBatchMs),
      total_items: round(totalBatchItems),
      weighted_ms_per_item: totalBatchItems > 0 ? round(totalBatchMs / totalBatchItems, 3) : null,
      p50_batch_ms: round(percentile(batchMsValues, 0.5), 3),
      p95_batch_ms: round(percentile(batchMsValues, 0.95), 3),
      p50_queue_wait_ms: round(percentile(queueMsValues, 0.5), 3),
      p95_queue_wait_ms: round(percentile(queueMsValues, 0.95), 3),
      p95_batch_items: round(percentile(batchItemValues, 0.95), 3),
    },
    index_progress: lastProgress
      ? {
          processed_spines: lastProgress.processedSpines ?? null,
          total_spines: lastProgress.totalSpines ?? null,
          elapsed_ms: round(lastProgress.elapsedMs),
          avg_ms_per_section: round(lastProgress.avgMsPerSection, 3),
          eta_ms: round(lastProgress.etaMs),
        }
      : null,
    warmup: {
      single_calls_seen: singleDone.length,
      first_single_total_ms: singleDone.length ? round(singleDone[0].totalMs, 3) : null,
      avg_single_total_ms: round(avg(singleDone, 'totalMs'), 3),
    },
  }

  const outDir = path.resolve(args.outDir)
  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8')
  fs.writeFileSync(
    path.join(outDir, 'sections.csv'),
    toCsv(sectionRows, [
      'section',
      'sentences',
      'pre_chunks',
      'avg_tokens',
      'overlap_tokens',
      'embed_chunks',
      'embed_ms',
      'embed_ms_per_chunk',
      'semantic_chunks',
      'merge_threshold',
    ]),
    'utf8',
  )
  fs.writeFileSync(
    path.join(outDir, 'batches.csv'),
    toCsv(batchRows, [
      'batch_id',
      'mode',
      'count',
      'total_chars',
      'avg_chars',
      'queue_wait_ms',
      'total_ms',
      'native_ms',
      'ensure_ms',
      'ms_per_item',
      'chars_per_item',
    ]),
    'utf8',
  )

  console.log(JSON.stringify(summary, null, 2))
  console.log(`\nReport written to: ${outDir}`)
}

main()

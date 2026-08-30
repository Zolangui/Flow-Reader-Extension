import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const workspaceRoot = path.resolve(scriptDirectory, '..')
const fixtureRoot = path.join(
  workspaceRoot,
  'packages',
  'epub-engine',
  'browser-fixtures',
)
const fixtureBookRoot = path.join(fixtureRoot, 'fixtures', 'pink-callout')
const privateCorpusRoot = path.join(
  workspaceRoot,
  'packages',
  'epub-engine',
  'test-corpus',
  'private',
)
const artifactsRoot = path.join(
  workspaceRoot,
  'artifacts',
  'presentation-fixtures',
)
const allFixtureCases = [
  'pink-callout',
  'wide-table',
  'author-theme',
  'dark-foreground',
  'default-foreground',
  'large-index',
  'chapter-boundary',
  'pseudo-noise',
  'pseudo-dropcap',
  'forged-location-ignore',
  'many-color-roots',
  'clipped-prose',
  'occluded-callout',
  'lazy-image-section',
]
const privateFixtureCases = [
  'private-large-index',
  'private-cover',
  'private-dark-audit',
  'private-chapter-boundary',
]

const LARGE_INDEX_ENTRY_COUNT = 1370

function generatedLargeIndexXhtml() {
  const entries = Array.from(
    { length: LARGE_INDEX_ENTRY_COUNT },
    (_, index) => {
      const page = index + 1
      return `<div class="index-entry">Termo ${page}, <a href="pink.xhtml">${page}</a>, <a href="pink.xhtml">${
        page + 1
      }</a></div>`
    },
  ).join('')
  return `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <head>
    <title>Large inherited-colour index</title>
    <style>
      html, body { margin: 0; background: transparent; font: 15px/1.2 Georgia, serif; }
      body { padding: 24px; }
      a { color: #4b9fff; }
    </style>
  </head>
  <body><h1>Indice remissivo sintetico</h1>${entries}</body>
</html>`
}

if (
  process.env.LUMEN_PRESENTATION_FIXTURES !== 'true' ||
  process.env.NODE_ENV === 'production'
) {
  throw new Error(
    'Presentation browser fixtures are development-only. Use the repository scripts; production is refused.',
  )
}

const args = new Set(process.argv.slice(2))
const shouldOpen = args.has('--open')
const shouldCheck = args.has('--check')
const requestedFixtureCase = process.argv
  .slice(2)
  .find((argument) => argument.startsWith('--case='))
  ?.slice('--case='.length)
const privateEpubArgument = process.argv
  .slice(2)
  .find((argument) => argument.startsWith('--private-epub='))
  ?.slice('--private-epub='.length)
const requestedSpineArgument = process.argv
  .slice(2)
  .find((argument) => argument.startsWith('--spine='))
  ?.slice('--spine='.length)
const requestedSpine = requestedSpineArgument
  ? Number.parseInt(requestedSpineArgument, 10)
  : undefined
if (
  requestedSpineArgument !== undefined &&
  (!Number.isInteger(requestedSpine) || requestedSpine < 0)
) {
  throw new Error(`Invalid fixture spine: ${requestedSpineArgument}`)
}
const privateEpubPath = privateEpubArgument
  ? path.resolve(workspaceRoot, privateEpubArgument)
  : undefined
const privateEpubRelativePath = privateEpubPath
  ? path.relative(path.resolve(privateCorpusRoot), privateEpubPath)
  : undefined
if (
  privateEpubPath &&
  (!privateEpubRelativePath ||
    privateEpubRelativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(privateEpubRelativePath) ||
    !existsSync(privateEpubPath))
) {
  throw new Error('Private EPUB must exist inside test-corpus/private')
}
if (
  requestedFixtureCase &&
  !allFixtureCases.includes(requestedFixtureCase) &&
  !privateFixtureCases.includes(requestedFixtureCase)
) {
  throw new Error(`Unknown presentation fixture: ${requestedFixtureCase}`)
}
if (
  requestedFixtureCase &&
  privateFixtureCases.includes(requestedFixtureCase) &&
  !privateEpubPath
) {
  throw new Error(`${requestedFixtureCase} requires --private-epub=...`)
}
const fixtureCases = requestedFixtureCase
  ? [requestedFixtureCase]
  : allFixtureCases
const requestedBrowser =
  process.argv
    .slice(2)
    .find((argument) => argument.startsWith('--browser='))
    ?.slice('--browser='.length) ?? 'all'
if (!['all', 'edge', 'firefox'].includes(requestedBrowser)) {
  throw new Error(`Unknown fixture browser: ${requestedBrowser}`)
}
if (!shouldOpen && !shouldCheck) {
  throw new Error('Choose --open or --check')
}

function existingExecutable(candidates) {
  for (const candidate of candidates) {
    if (path.isAbsolute(candidate)) {
      if (existsSync(candidate)) return candidate
      continue
    }
    const locator = process.platform === 'win32' ? 'where.exe' : 'which'
    const probe = spawnSync(locator, [candidate], {
      encoding: 'utf8',
      windowsHide: true,
    })
    if (!probe.error && probe.status === 0) {
      const resolved = probe.stdout
        .split(/\r?\n/)
        .map((value) => value.trim())
        .find(Boolean)
      if (resolved && existsSync(resolved)) return resolved
    }
  }
  return undefined
}

const edge = existingExecutable([
  'msedge',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
])
const firefox = existingExecutable([
  'firefox',
  'C:\\Program Files\\Mozilla Firefox\\firefox.exe',
  'C:\\Program Files\\Firefox Developer Edition\\firefox.exe',
])

async function bundleHarness(outputDirectory) {
  const esnoPackage = require.resolve('esno/package.json')
  const esbuildPath = require.resolve('esbuild', {
    paths: [path.dirname(esnoPackage)],
  })
  const imported = await import(pathToFileURL(esbuildPath).href)
  const esbuild = imported.default ?? imported
  await esbuild.build({
    entryPoints: [path.join(fixtureRoot, 'presentation-harness.ts')],
    outfile: path.join(outputDirectory, 'presentation-harness.js'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: ['chrome120', 'firefox115'],
    sourcemap: 'inline',
    logLevel: 'warning',
  })
}

function contentType(filePath) {
  switch (path.extname(filePath).toLowerCase()) {
    case '.css':
      return 'text/css; charset=utf-8'
    case '.html':
      return 'text/html; charset=utf-8'
    case '.xhtml':
      return 'application/xhtml+xml; charset=utf-8'
    case '.js':
      return 'text/javascript; charset=utf-8'
    case '.opf':
    case '.xml':
      return 'application/xml; charset=utf-8'
    case '.epub':
      return 'application/epub+zip'
    case '.svg':
      return 'image/svg+xml'
    default:
      return 'application/octet-stream'
  }
}

function safeFixturePath(urlPath) {
  const relative = decodeURIComponent(
    urlPath.slice('/fixtures/pink-callout/'.length),
  )
  const resolved = path.resolve(fixtureBookRoot, relative)
  const normalizedRoot = path.resolve(fixtureBookRoot)
  const rootWithSeparator = `${normalizedRoot}${path.sep}`
  if (resolved !== normalizedRoot && !resolved.startsWith(rootWithSeparator)) {
    return undefined
  }
  return resolved
}

async function startServer(bundleDirectory) {
  const htmlPath = path.join(fixtureRoot, 'presentation-harness.html')
  const cssPath = path.join(fixtureRoot, 'presentation-harness.css')
  const bootstrapPath = path.join(fixtureRoot, 'presentation-bootstrap.js')
  const bundlePath = path.join(bundleDirectory, 'presentation-harness.js')
  const resultQueue = []
  const resultWaiters = []
  const publishBrowserResult = (result) => {
    const waiter = resultWaiters.shift()
    if (waiter) waiter.resolve(result)
    else resultQueue.push(result)
  }
  const nextBrowserResult = (timeoutMs = 90_000) =>
    new Promise((resolve, reject) => {
      const queued = resultQueue.shift()
      if (queued) {
        resolve(queued)
        return
      }
      const waiter = { resolve, reject }
      resultWaiters.push(waiter)
      const timeout = setTimeout(() => {
        const index = resultWaiters.indexOf(waiter)
        if (index >= 0) resultWaiters.splice(index, 1)
        reject(new Error('Browser fixture result timed out'))
      }, timeoutMs)
      waiter.resolve = (value) => {
        clearTimeout(timeout)
        resolve(value)
      }
    })
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (url.pathname === '/fixture-result' && request.method === 'POST') {
        const chunks = []
        let length = 0
        for await (const chunk of request) {
          length += chunk.length
          if (length > 256_000) throw new Error('Fixture result is too large')
          chunks.push(chunk)
        }
        const result = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        publishBrowserResult(result)
        response.writeHead(204)
        response.end()
        return
      }
      let filePath
      let generatedBody
      if (
        url.pathname === '/' ||
        url.pathname === '/presentation-harness.html'
      ) {
        filePath = htmlPath
      } else if (url.pathname === '/presentation-harness.css') {
        filePath = cssPath
      } else if (url.pathname === '/presentation-bootstrap.js') {
        filePath = bootstrapPath
      } else if (url.pathname === '/presentation-harness.js') {
        filePath = bundlePath
      } else if (
        url.pathname === '/fixtures/pink-callout/OPS/large-index.xhtml'
      ) {
        generatedBody = Buffer.from(generatedLargeIndexXhtml(), 'utf8')
      } else if (
        url.pathname === '/fixtures/pink-callout/OPS/delayed-tall.svg'
      ) {
        await new Promise((resolve) => setTimeout(resolve, 900))
        filePath = safeFixturePath(url.pathname)
      } else if (url.pathname === '/fixtures/private.epub' && privateEpubPath) {
        filePath = privateEpubPath
      } else if (url.pathname.startsWith('/fixtures/pink-callout/')) {
        filePath = safeFixturePath(url.pathname)
        if (filePath && url.pathname.endsWith('/')) {
          filePath = path.join(filePath, 'META-INF', 'container.xml')
        }
      }
      if (!filePath && !generatedBody) {
        response.writeHead(404).end('Not found')
        return
      }
      const body = generatedBody ?? (await readFile(filePath))
      response.writeHead(200, {
        'Cache-Control': 'no-store',
        'Content-Type': generatedBody
          ? 'application/xhtml+xml; charset=utf-8'
          : contentType(filePath),
        'Content-Security-Policy':
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; frame-src 'self' blob:; connect-src 'self'",
      })
      response.end(body)
    } catch (error) {
      response
        .writeHead(500)
        .end(error instanceof Error ? error.message : String(error))
    }
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('No fixture server address')
  }
  return {
    server,
    url: `http://127.0.0.1:${address.port}/presentation-harness.html`,
    nextBrowserResult,
  }
}

async function collectBrowserResult(
  executable,
  browserArgs,
  nextBrowserResult,
) {
  const child = spawn(executable, browserArgs, {
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  })
  let stderr = ''
  child.stderr?.on('data', (chunk) => {
    stderr += chunk
  })
  const closed = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  })
  const prematureExit = closed.then((code) => {
    throw new Error(
      `Browser exited before reporting a result (exit ${code}). ${stderr.slice(
        -1000,
      )}`,
    )
  })
  try {
    return await Promise.race([nextBrowserResult(), prematureExit])
  } finally {
    if (!child.killed) child.kill()
    await Promise.race([
      closed.catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ])
  }
}

async function writeBrowserResult(name, result) {
  await writeFile(
    path.join(artifactsRoot, `${name}-result.json`),
    `${JSON.stringify(result, null, 2)}\n`,
    'utf8',
  )
  if (result.status !== 'passed') {
    throw new Error(`${name} fixture failed: ${JSON.stringify(result)}`)
  }
  return result
}

function caseUrl(url, fixtureCase) {
  const value = new URL(url)
  value.searchParams.set('case', fixtureCase)
  if (requestedSpine !== undefined) {
    value.searchParams.set('spine', String(requestedSpine))
  }
  return value.href
}

async function checkEdge(url, temporaryRoot, nextBrowserResult, fixtureCase) {
  if (!edge) throw new Error('Microsoft Edge was not found')
  const profile = path.join(temporaryRoot, `edge-${fixtureCase}-profile`)
  const result = await collectBrowserResult(
    edge,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      `--user-data-dir=${profile}`,
      '--window-size=1440,1000',
      caseUrl(url, fixtureCase),
    ],
    nextBrowserResult,
  )
  if (result.fixture !== fixtureCase) {
    throw new Error(
      `Edge reported fixture ${String(
        result.fixture,
      )} while ${fixtureCase} was requested`,
    )
  }
  return writeBrowserResult(`edge-${fixtureCase}`, result)
}

async function checkFirefox(
  url,
  temporaryRoot,
  nextBrowserResult,
  fixtureCase,
) {
  if (!firefox) return undefined
  const profile = path.join(temporaryRoot, `firefox-${fixtureCase}-profile`)
  await mkdir(profile, { recursive: true })
  const result = await collectBrowserResult(
    firefox,
    [
      '--headless',
      '--no-remote',
      '--profile',
      profile,
      '--width',
      '1440',
      '--height',
      '1000',
      caseUrl(url, fixtureCase),
    ],
    nextBrowserResult,
  )
  if (result.fixture !== fixtureCase) {
    throw new Error(
      `Firefox reported fixture ${String(
        result.fixture,
      )} while ${fixtureCase} was requested`,
    )
  }
  return writeBrowserResult(`firefox-${fixtureCase}`, result)
}

async function openBrowsers(url) {
  const available = [edge, firefox].filter(Boolean)
  if (available.length === 0) throw new Error('Edge and Firefox were not found')
  for (const executable of available) {
    const child = spawn(executable, [url], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    child.unref()
  }
  console.log(`Presentation fixture: ${url}`)
  console.log('Press Ctrl+C to stop the local server.')
}

const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'lumen-presentation-'))
let fixtureServer
try {
  await bundleHarness(temporaryRoot)
  fixtureServer = await startServer(temporaryRoot)
  if (shouldCheck) {
    await mkdir(artifactsRoot, { recursive: true })
    for (const fixtureCase of fixtureCases) {
      if (requestedBrowser === 'all' || requestedBrowser === 'edge') {
        const edgeResult = await checkEdge(
          fixtureServer.url,
          temporaryRoot,
          fixtureServer.nextBrowserResult,
          fixtureCase,
        )
        console.log(
          `Edge (${fixtureCase}): fixture passed (${edgeResult.checks.length} checks)`,
        )
      }
      if (requestedBrowser === 'all' || requestedBrowser === 'firefox') {
        const firefoxResult = await checkFirefox(
          fixtureServer.url,
          temporaryRoot,
          fixtureServer.nextBrowserResult,
          fixtureCase,
        )
        if (firefoxResult) {
          console.log(
            `Firefox (${fixtureCase}): fixture passed (${firefoxResult.checks.length} checks)`,
          )
        } else {
          console.log(
            `Firefox (${fixtureCase}): executable not found; check skipped`,
          )
        }
      }
    }
  } else {
    await openBrowsers(fixtureServer.url)
    await new Promise((resolve) => {
      process.once('SIGINT', resolve)
      process.once('SIGTERM', resolve)
    })
  }
} finally {
  if (fixtureServer) {
    await new Promise((resolve) => fixtureServer.server.close(resolve))
  }
  const resolvedTemporaryRoot = path.resolve(temporaryRoot)
  if (resolvedTemporaryRoot.startsWith(path.resolve(tmpdir()))) {
    try {
      await rm(resolvedTemporaryRoot, {
        recursive: true,
        force: true,
        maxRetries: 8,
        retryDelay: 150,
      })
    } catch (error) {
      console.warn(
        `Temporary browser profile could not be removed yet: ${resolvedTemporaryRoot}`,
        error instanceof Error ? error.message : error,
      )
    }
  }
}

import fs from 'node:fs'
import { writeFileSync, mkdirSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import JSZip from 'jszip'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES_DIR = path.resolve(__dirname, 'fixtures')
const PORT_FILE = path.join(tmpdir(), 'epub-ts-test-port')

const MIME_TYPES: Record<string, string> = {
  '.opf': 'text/xml',
  '.xml': 'text/xml',
  '.xhtml': 'application/xhtml+xml',
  '.html': 'text/html',
  '.epub': 'application/epub+zip',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ncx': 'text/xml',
}

let server: http.Server
const generatedFixtures = new Set<string>()

const NO_COVER_PACKAGE = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" xml:lang="en" unique-identifier="pub-id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="pub-id">edu.nyu.itp.future-of-publishing.alice-without-cover</dc:identifier>
    <dc:title>Alice's Adventures in Wonderland</dc:title>
    <dc:creator>Lewis Carroll</dc:creator>
    <dc:language>en-US</dc:language>
    <meta property="dcterms:modified">2020-05-22T09:04:27Z</meta>
  </metadata>
  <manifest>
    <item id="toc" properties="nav" href="toc.xhtml" media-type="application/xhtml+xml"/>
    <item id="style" href="css/stylesheet.css" media-type="text/css"/>
    <item id="titlepage" href="titlepage.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="toc" linear="no"/>
    <itemref idref="titlepage"/>
  </spine>
</package>`

async function addDirectory(
  zip: JSZip,
  root: string,
  relative = '',
): Promise<void> {
  const directory = path.join(root, relative)
  const entries = await fs.promises.readdir(directory, { withFileTypes: true })
  entries.sort((left, right) => left.name.localeCompare(right.name))
  for (const entry of entries) {
    const child = path.join(relative, entry.name)
    if (entry.isDirectory()) {
      await addDirectory(zip, root, child)
    } else if (child !== 'mimetype') {
      zip.file(
        child.replaceAll(path.sep, '/'),
        await fs.promises.readFile(path.join(root, child)),
      )
    }
  }
}

async function writeArchiveIfMissing(
  name: string,
  build: (zip: JSZip) => Promise<void>,
): Promise<void> {
  const target = path.join(FIXTURES_DIR, name)
  try {
    await fs.promises.access(target)
    return
  } catch {
    // A clean checkout intentionally has no binary EPUB fixtures.
  }

  const zip = new JSZip()
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' })
  await build(zip)
  const archive = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  })
  await fs.promises.writeFile(target, archive)
  generatedFixtures.add(target)
}

async function ensureBinaryFixtures(): Promise<void> {
  const aliceRoot = path.join(FIXTURES_DIR, 'alice')
  await writeArchiveIfMissing('alice.epub', (zip) =>
    addDirectory(zip, aliceRoot),
  )
  await writeArchiveIfMissing('alice_without_cover.epub', async (zip) => {
    for (const resource of [
      'META-INF/container.xml',
      'OPS/titlepage.xhtml',
      'OPS/toc.xhtml',
      'OPS/css/stylesheet.css',
    ]) {
      zip.file(
        resource,
        await fs.promises.readFile(path.join(aliceRoot, resource)),
      )
    }
    zip.file('OPS/package.opf', NO_COVER_PACKAGE)
  })
}

export async function setup() {
  await ensureBinaryFixtures()
  return new Promise<void>((resolve, reject) => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url || '/', 'http://localhost')
      const filePath = path.join(FIXTURES_DIR, decodeURIComponent(url.pathname))

      if (!filePath.startsWith(FIXTURES_DIR)) {
        res.writeHead(403)
        res.end('Forbidden')
        return
      }

      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(404)
          res.end('Not Found')
          return
        }

        const ext = path.extname(filePath).toLowerCase()
        const contentType = MIME_TYPES[ext] || 'application/octet-stream'
        res.writeHead(200, { 'Content-Type': contentType })
        res.end(data)
      })
    })

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (typeof addr === 'object' && addr) {
        writeFileSync(PORT_FILE, String(addr.port))
      }
      resolve()
    })

    server.on('error', reject)
  })
}

export async function teardown() {
  if (server) {
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
    })
  }
  await Promise.all(
    [...generatedFixtures].map((fixture) =>
      fs.promises.rm(fixture, { force: true }),
    ),
  )
}

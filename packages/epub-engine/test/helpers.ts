import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT_FILE = join(tmpdir(), 'epub-ts-test-port')

let cachedPort: string | undefined

export function getFixtureUrl(filepath: string): string {
  if (!cachedPort) {
    cachedPort = readFileSync(PORT_FILE, 'utf-8').trim()
  }
  return `http://127.0.0.1:${cachedPort}${filepath}`
}

export function parseXML(
  xml: string,
  mime: DOMParserSupportedType = 'application/xml',
): Document {
  return new DOMParser().parseFromString(xml, mime)
}

/** jsdom has no layout; presentation tests opt into a deterministic visible box. */
export function installVisibleLayout(document: Document): void {
  const view = document.defaultView
  if (!view) return
  const rect = {
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 100,
    bottom: 20,
    width: 100,
    height: 20,
    toJSON: () => ({}),
  }
  Object.defineProperty(view.Element.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: () => rect,
  })
  Object.defineProperty(view.Element.prototype, 'getClientRects', {
    configurable: true,
    value: () => [rect],
  })
}

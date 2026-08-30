import { describe, it, expect } from 'vitest'

import Section from '../src/section'
import type { SpineItem } from '../src/types'
import {
  handleResponse,
  mediaTypeToRequestType,
  isKnownRequestType,
} from '../src/utils/core'

function makeSection(href: string, mediaType?: string): Section {
  const item = {
    idref: 'id',
    linear: 'yes',
    properties: [],
    index: 0,
    href,
    url: href,
    canonical: '',
    cfiBase: '',
    mediaType,
    next: (): undefined => undefined,
    prev: (): undefined => undefined,
  } as unknown as SpineItem
  return new Section(item)
}

// A request that parses its argument exactly like the real request layer does,
// so we exercise the type token Section.load() actually chooses.
const requestReturning =
  (body: string) =>
  (_url: string, type?: string): Promise<unknown> =>
    Promise.resolve(handleResponse(body, type))

const XHTML = `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body><p id="c">hi</p></body></html>`
// Invalid XML (bare "&", unclosed <br>) but valid, lenient HTML.
const LOOSE_HTML = `<html><body><p id="c">A & B<br></p></body></html>`
// Well-formed XHTML whose self-closing <title/> the HTML parser treats as an
// unterminated RCDATA start tag, swallowing the rest of the document.
const SELF_CLOSING_TITLE = `<html xmlns="http://www.w3.org/1999/xhtml"><head><title/></head><body><p id="c">Hello world</p></body></html>`

describe('mediaTypeToRequestType', () => {
  it('maps document media-types to parse tokens', () => {
    expect(mediaTypeToRequestType('application/xhtml+xml')).toBe('xhtml')
    expect(mediaTypeToRequestType('text/html')).toBe('html')
    expect(mediaTypeToRequestType('application/x-dtbncx+xml')).toBe('xml')
    expect(mediaTypeToRequestType('application/oebps-package+xml')).toBe('xml')
    expect(mediaTypeToRequestType('text/html; charset=utf-8')).toBe('html')
    expect(mediaTypeToRequestType('image/png')).toBeUndefined()
    expect(mediaTypeToRequestType(undefined)).toBeUndefined()
  })

  it('recognizes known extension tokens', () => {
    expect(isKnownRequestType('xhtml')).toBe(true)
    expect(isKnownRequestType('html')).toBe(true)
    expect(isKnownRequestType('html_split_001')).toBe(false)
    expect(isKnownRequestType(undefined)).toBe(false)
  })
})

describe('Section.load resource typing', () => {
  it('loads canonical source without retaining it or running presentation hooks', async () => {
    const section = makeSection('chapter.xhtml', 'application/xhtml+xml')
    let hookCalls = 0
    section.hooks!.content.register(() => {
      hookCalls += 1
    })

    const source = await section.loadSource(requestReturning(XHTML))

    expect(source.querySelector('#c')?.textContent).toBe('hi')
    expect(section.document).toBeUndefined()
    expect(section.contents).toBeUndefined()
    expect(hookCalls).toBe(0)
  })

  it('loads raw source text without parsing or retaining a document', async () => {
    const section = makeSection('chapter.xhtml', 'application/xhtml+xml')
    const request = (_url: string, type?: string): Promise<unknown> => {
      expect(type).toBe('text')
      return Promise.resolve(XHTML)
    }

    const source = await section.loadSourceText(request)

    expect(source).toBe(XHTML)
    expect(section.document).toBeUndefined()
    expect(section.contents).toBeUndefined()
  })

  it('rejects a late source response after cancellation', async () => {
    const section = makeSection('chapter.xhtml', 'application/xhtml+xml')
    const controller = new AbortController()
    let resolveRequest: ((value: unknown) => void) | undefined
    const request = () =>
      new Promise<unknown>((resolve) => {
        resolveRequest = resolve
      })

    const loading = section.loadSource(request, controller.signal)
    controller.abort()
    resolveRequest!(handleResponse(XHTML, 'xhtml'))

    await expect(loading).rejects.toMatchObject({ name: 'AbortError' })
    expect(section.document).toBeUndefined()
    expect(section.contents).toBeUndefined()
  })

  it('parses an extensionless resource by its manifest media-type', async () => {
    const section = makeSection(
      'chapter.html_split_001',
      'application/xhtml+xml',
    )
    const el = await section.load(requestReturning(XHTML))
    expect(el.nodeType).toBe(1)
    expect(el.querySelector('#c')?.textContent).toBe('hi')
  })

  it('still fails (raw string) for an unknown extension with no media-type', async () => {
    const section = makeSection('chapter.html_split_001')
    const el = await section.load(requestReturning(XHTML))
    expect(el).toBeUndefined()
  })

  it("falls back to the lenient parser when an xhtml-declared .html file isn't well-formed", async () => {
    const section = makeSection('chapter.html', 'application/xhtml+xml')
    const el = await section.load(requestReturning(LOOSE_HTML))
    expect(el.querySelector('parsererror')).toBeNull()
    expect(el.querySelector('#c')?.textContent).toContain('A & B')
  })

  it("parses an xhtml-declared .htm file strictly so <title/> doesn't swallow the body", async () => {
    const section = makeSection('chapter.htm', 'application/xhtml+xml')
    const el = await section.load(requestReturning(SELF_CLOSING_TITLE))
    expect(el.querySelector('#c')?.textContent).toBe('Hello world')
  })

  it('still parses an html-declared .html file leniently', async () => {
    const section = makeSection('chapter.html', 'text/html')
    const el = await section.load(requestReturning(LOOSE_HTML))
    expect(el.querySelector('#c')?.textContent).toContain('A & B')
  })
})

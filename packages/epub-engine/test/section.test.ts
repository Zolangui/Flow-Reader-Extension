import { describe, it, expect, vi } from 'vitest'

import ePub from '../src/epub'
import Section from '../src/section'
import type { SpineItem, GlobalLayout, RequestFunction } from '../src/types'
import Hook from '../src/utils/hook'

import { getFixtureUrl, parseXML } from './helpers'

function createMockSpineItem(overrides?: Partial<SpineItem>): SpineItem {
  return {
    index: 0,
    cfiBase: '/6/4',
    idref: 'ch1',
    href: 'ch1.xhtml',
    url: 'http://example.com/ch1.xhtml',
    canonical: 'ch1.xhtml',
    properties: [],
    linear: 'yes',
    next: () => undefined,
    prev: () => undefined,
    ...overrides,
  }
}

describe('section', () => {
  it('finds a single result in a section', async () => {
    const book = ePub(getFixtureUrl('/alice/'), { width: 400, height: 400 })

    await book.ready
    const section = book.section('chapter_001.xhtml')
    await section.load()

    const queryString = 'they were filled with cupboards and book-shelves'
    const findResults = section.find(queryString)
    const searchResults = section.search(queryString)

    for (const results of [findResults, searchResults]) {
      expect(results.length).toBe(1)
      expect(results[0].cfi).toBe('epubcfi(/6/8!/4/2/16,/1:275,/1:323)')
      expect(results[0].excerpt).toBe(
        '... see anything; then she looked at the sides of the well and\n\t\tnoticed that they were filled with cupboards and book-shelves; here and there she saw\n\t\t...',
      )
    }
  })

  it('finds multiple results in a section', async () => {
    const book = ePub(getFixtureUrl('/alice/'), { width: 400, height: 400 })

    await book.ready
    const section = book.section('chapter_001.xhtml')
    await section.load()

    const queryString = 'white rabbit'
    const findResults = section.find(queryString)
    const searchResults = section.search(queryString)

    for (const results of [findResults, searchResults]) {
      expect(results.length).toBe(2)
      expect(results[0].cfi).toBe('epubcfi(/6/8!/4/2/8,/1:240,/1:252)')
      expect(results[0].excerpt).toBe(
        '...e worth the trouble of getting up and picking the daisies, when suddenly a White Rabbit with pink eyes ran close by her....',
      )
      expect(results[1].cfi).toBe('epubcfi(/6/8!/4/2/20,/1:148,/1:160)')
      expect(results[1].excerpt).toBe(
        '...ut it was\n\t\tall dark overhead; before her was another long passage and the White Rabbit was still\n\t\tin sight, hurrying down it. There was not a moment...',
      )
    }
  })

  it('finds result spanning multiple document nodes, tag at ending', async () => {
    const book = ePub(getFixtureUrl('/alice/'), { width: 400, height: 400 })

    await book.ready
    const section = book.section('chapter_010.xhtml')
    await section.load()

    const queryString = 'I beg'
    const findResult = section.find(queryString)
    expect(findResult.length).toBe(0)

    const searchResults = section.search(queryString)
    expect(searchResults.length).toBe(1)
    expect(searchResults[0].cfi).toBe('epubcfi(/6/26!/4/2/6,/1:5,/2/1:3)')
    expect(searchResults[0].excerpt).toBe('"Oh, I beg')
  })

  it('finds result spanning multiple document nodes, tag at middle', async () => {
    const book = ePub(getFixtureUrl('/alice/'), { width: 400, height: 400 })

    await book.ready
    const section = book.section('chapter_010.xhtml')
    await section.load()

    const queryString = 'I beg your pardon'
    const findResult = section.find(queryString)
    expect(findResult.length).toBe(0)

    const searchResults = section.search(queryString)
    expect(searchResults.length).toBe(1)
    expect(searchResults[0].cfi).toBe('epubcfi(/6/26!/4/2/6,/1:5,/3:12)')
    expect(searchResults[0].excerpt).toBe(
      '"Oh, I beg your pardon!" she exclaimed in a tone of great dismay.',
    )
  })

  describe('constructor', () => {
    it('sets idref, linear, properties, index, href, url, canonical', () => {
      const item = createMockSpineItem({
        idref: 'ch5',
        index: 4,
        href: 'ch5.xhtml',
        url: 'http://x/ch5.xhtml',
        canonical: 'ch5.xhtml',
      })
      const section = new Section(item)
      expect(section.idref).toBe('ch5')
      expect(section.index).toBe(4)
      expect(section.href).toBe('ch5.xhtml')
      expect(section.url).toBe('http://x/ch5.xhtml')
      expect(section.canonical).toBe('ch5.xhtml')
    })

    it("converts linear 'yes' to true", () => {
      const section = new Section(createMockSpineItem({ linear: 'yes' }))
      expect(section.linear).toBe(true)
    })

    it("converts linear 'no' to false", () => {
      const section = new Section(createMockSpineItem({ linear: 'no' }))
      expect(section.linear).toBe(false)
    })

    it('sets cfiBase, next, prev', () => {
      const nextFn = () => undefined
      const prevFn = () => undefined
      const section = new Section(
        createMockSpineItem({ cfiBase: '/6/10', next: nextFn, prev: prevFn }),
      )
      expect(section.cfiBase).toBe('/6/10')
      expect(section.next).toBe(nextFn)
      expect(section.prev).toBe(prevFn)
    })

    it('creates default hooks when none provided', () => {
      const section = new Section(createMockSpineItem())
      expect(section.hooks).toBeDefined()
      expect(section.hooks!.serialize).toBeInstanceOf(Hook)
      expect(section.hooks!.content).toBeInstanceOf(Hook)
    })

    it('uses provided hooks when given', () => {
      const hooks = { serialize: new Hook(), content: new Hook() }
      const section = new Section(createMockSpineItem(), hooks)
      expect(section.hooks!.serialize).toBe(hooks.serialize)
      expect(section.hooks!.content).toBe(hooks.content)
    })

    it('initializes document/contents/output as undefined', () => {
      const section = new Section(createMockSpineItem())
      expect(section.document).toBeUndefined()
      expect(section.contents).toBeUndefined()
      expect(section.output).toBeUndefined()
    })
  })

  describe('cloneForMeasurement()', () => {
    it('creates an independent section with a snapshot of source hooks and no navigation', () => {
      const contentHook = vi.fn()
      const serializeHook = vi.fn()
      const context = { name: 'live-spine' }
      const hooks = {
        content: new Hook(context),
        serialize: new Hook(context),
      }
      hooks.content.register(contentHook)
      hooks.serialize.register(serializeHook)

      const next = vi.fn()
      const prev = vi.fn()
      const original = new Section(
        createMockSpineItem({
          properties: ['rendition:layout-reflowable'],
          next,
          prev,
        }),
        hooks,
      )
      const request = vi.fn() as unknown as RequestFunction
      original.request = request

      const clone = original.cloneForMeasurement()

      expect(clone).not.toBe(original)
      expect(clone.index).toBe(original.index)
      expect(clone.href).toBe(original.href)
      expect(clone.cfiBase).toBe(original.cfiBase)
      expect(clone.properties).toEqual(original.properties)
      expect(clone.properties).not.toBe(original.properties)
      expect(clone.request).toBe(request)
      expect(clone.next?.()).toBeUndefined()
      expect(clone.prev?.()).toBeUndefined()
      expect(next).not.toHaveBeenCalled()
      expect(prev).not.toHaveBeenCalled()

      expect(clone.hooks!.content).not.toBe(hooks.content)
      expect(clone.hooks!.serialize).not.toBe(hooks.serialize)
      expect(clone.hooks!.content.list()).toEqual([contentHook])
      expect(clone.hooks!.serialize.list()).toEqual([serializeHook])
    })

    it('can be destroyed without clearing live hooks or releasing the live document', () => {
      const liveCallback = vi.fn()
      const hooks = { content: new Hook(), serialize: new Hook() }
      hooks.content.register(liveCallback)
      const original = new Section(createMockSpineItem(), hooks)
      const liveDocument = parseXML(
        '<html><body>live</body></html>',
        'application/xhtml+xml',
      )
      original.document = liveDocument
      original.contents = liveDocument.documentElement

      const clone = original.cloneForMeasurement()
      clone.destroy()

      expect(original.document).toBe(liveDocument)
      expect(original.contents).toBe(liveDocument.documentElement)
      expect(hooks.content.list()).toEqual([liveCallback])
      expect(hooks.serialize.list()).toEqual([])
    })

    it('rebinds standalone Section hook callbacks to the measurement clone', async () => {
      const original = new Section(createMockSpineItem())
      let callbackContext: Section | undefined
      original.hooks!.content.register(function (this: Section) {
        callbackContext = this
        this.output = 'measurement-only'
      })

      const clone = original.cloneForMeasurement()
      await clone.hooks!.content.trigger()

      expect(callbackContext).toBe(clone)
      expect(clone.output).toBe('measurement-only')
      expect(original.output).toBeUndefined()
    })

    it('does not retain a bare live Hook as a callback context', async () => {
      const hooks = { content: new Hook(), serialize: new Hook() }
      let callbackContext: Hook | undefined
      hooks.content.register(function (this: Hook) {
        callbackContext = this
        this.clear()
      })
      const original = new Section(createMockSpineItem(), hooks)
      const clone = original.cloneForMeasurement()

      await clone.hooks!.content.trigger()

      expect(callbackContext).toBe(clone.hooks!.content)
      expect(hooks.content.list()).toHaveLength(1)
    })

    it('rejects a clone request after the source section was destroyed', () => {
      const section = new Section(createMockSpineItem())
      section.destroy()

      expect(() => section.cloneForMeasurement()).toThrow(
        'Cannot clone a destroyed section for measurement',
      )
    })
  })

  describe('load()', () => {
    it('returns cached contents if already loaded (no request call)', async () => {
      const doc = parseXML(
        '<html><body>cached</body></html>',
        'application/xhtml+xml',
      )
      const section = new Section(createMockSpineItem())
      section.document = doc
      section.contents = doc.documentElement

      const request = vi.fn()
      const result = await section.load(request)
      expect(result).toBe(doc.documentElement)
      expect(request).not.toHaveBeenCalled()
    })

    it('calls request with url when not cached', async () => {
      const doc = parseXML(
        '<html><body>hello</body></html>',
        'application/xhtml+xml',
      )
      const request = vi.fn(() =>
        Promise.resolve(doc),
      ) as unknown as RequestFunction
      const section = new Section(
        createMockSpineItem({ url: 'http://test/ch1.xhtml' }),
      )

      const result = await section.load(request)
      // Section resolves the parse type from the .xhtml extension
      expect(request).toHaveBeenCalledWith(
        'http://test/ch1.xhtml',
        'xhtml',
        undefined,
        undefined,
        undefined,
      )
      expect(result).toBe(doc.documentElement)
      expect(section.document).toBe(doc)
      expect(section.contents).toBe(doc.documentElement)
    })

    it('abandons a content hook that ignores AbortSignal and clears the partial cache', async () => {
      const doc = parseXML(
        '<html><body>pending hook</body></html>',
        'application/xhtml+xml',
      )
      const request = vi.fn(() =>
        Promise.resolve(doc),
      ) as unknown as RequestFunction
      const section = new Section(createMockSpineItem())
      let hookStarted!: () => void
      const started = new Promise<void>((resolve) => {
        hookStarted = resolve
      })
      section.hooks!.content.register(() => {
        hookStarted()
        return new Promise<void>(() => undefined)
      })
      const controller = new AbortController()
      const loading = section.load(request, controller.signal)
      await started

      controller.abort()

      await expect(loading).rejects.toMatchObject({ name: 'AbortError' })
      expect(section.document).toBeUndefined()
      expect(section.contents).toBeUndefined()
    })

    it('does not cache a document whose asynchronous content hook failed', async () => {
      const doc = parseXML(
        '<html><body>failed hook</body></html>',
        'application/xhtml+xml',
      )
      const request = vi.fn(() =>
        Promise.resolve(doc),
      ) as unknown as RequestFunction
      const section = new Section(createMockSpineItem())
      section.hooks!.content.register(() =>
        Promise.reject(new Error('hook failed')),
      )

      await expect(section.load(request)).rejects.toThrow('hook failed')
      expect(section.document).toBeUndefined()
      expect(section.contents).toBeUndefined()
    })
  })

  describe('loadSource()', () => {
    it('abandons a requester that does not cooperate with AbortSignal', async () => {
      const section = new Section(createMockSpineItem())
      const controller = new AbortController()
      const request = vi.fn(
        () => new Promise<Document>(() => undefined),
      ) as unknown as RequestFunction
      const loading = section.loadSource(request, controller.signal)

      controller.abort()

      await expect(loading).rejects.toMatchObject({ name: 'AbortError' })
      expect(section.document).toBeUndefined()
      expect(section.contents).toBeUndefined()
    })
  })

  describe('render()', () => {
    it('calls load, serializes, and resolves with serialized string', async () => {
      const doc = parseXML(
        '<html><body>render me</body></html>',
        'application/xhtml+xml',
      )
      const request = vi.fn(() =>
        Promise.resolve(doc),
      ) as unknown as RequestFunction
      const section = new Section(createMockSpineItem())

      const result = await section.render(request)
      expect(typeof result).toBe('string')
      expect(result).toContain('render me')
      expect(section.output).toBe(result)
    })

    it('abandons a serialize hook that ignores AbortSignal', async () => {
      const doc = parseXML(
        '<html><body>pending serialization</body></html>',
        'application/xhtml+xml',
      )
      const request = vi.fn(() =>
        Promise.resolve(doc),
      ) as unknown as RequestFunction
      const section = new Section(createMockSpineItem())
      let hookStarted!: () => void
      const started = new Promise<void>((resolve) => {
        hookStarted = resolve
      })
      section.hooks!.serialize.register(() => {
        hookStarted()
        return new Promise<void>(() => undefined)
      })
      const controller = new AbortController()
      const rendering = section.render(request, controller.signal)
      await started

      controller.abort()

      await expect(rendering).rejects.toMatchObject({ name: 'AbortError' })
      expect(section.output).toBeUndefined()
    })
  })

  describe('unload()', () => {
    it('sets document/contents/output to undefined', () => {
      const section = new Section(createMockSpineItem())
      const doc = parseXML(
        '<html><body>x</body></html>',
        'application/xhtml+xml',
      )
      section.document = doc
      section.contents = doc.documentElement
      section.output = '<html><body>x</body></html>'

      section.unload()
      expect(section.document).toBeUndefined()
      expect(section.contents).toBeUndefined()
      expect(section.output).toBeUndefined()
    })
  })

  describe('reconcileLayoutSettings()', () => {
    const globalLayout: GlobalLayout = {
      layout: 'reflowable',
      spread: 'auto',
      orientation: 'auto',
      flow: 'paginated',
      viewport: '',
      minSpreadWidth: 800,
      direction: 'ltr',
    }

    it('uses global layout defaults', () => {
      const section = new Section(createMockSpineItem({ properties: [] }))
      const result = section.reconcileLayoutSettings(globalLayout)
      expect(result.layout).toBe('reflowable')
      expect(result.spread).toBe('auto')
      expect(result.orientation).toBe('auto')
    })

    it('overrides with chapter properties', () => {
      const section = new Section(
        createMockSpineItem({
          properties: [
            'rendition:layout-pre-paginated',
            'rendition:spread-none',
          ],
        }),
      )
      const result = section.reconcileLayoutSettings(globalLayout)
      expect(result.layout).toBe('pre-paginated')
      expect(result.spread).toBe('none')
      expect(result.orientation).toBe('auto')
    })
  })

  describe('cfiFromRange()', () => {
    it('creates EpubCFI from range and cfiBase', () => {
      const doc = parseXML(
        "<html xmlns='http://www.w3.org/1999/xhtml'><body><p>Hello world</p></body></html>",
        'application/xhtml+xml',
      )
      const section = new Section(createMockSpineItem({ cfiBase: '/6/4' }))
      section.document = doc
      section.contents = doc.documentElement

      const range = doc.createRange()
      const textNode = doc.querySelector('p')!.firstChild!
      range.setStart(textNode, 0)
      range.setEnd(textNode, 5)

      const cfi = section.cfiFromRange(range)
      expect(cfi).toMatch(/^epubcfi\(/)
    })
  })

  describe('cfiFromElement()', () => {
    it('creates EpubCFI from element and cfiBase', () => {
      const doc = parseXML(
        "<html xmlns='http://www.w3.org/1999/xhtml'><body><p>Hello</p></body></html>",
        'application/xhtml+xml',
      )
      const section = new Section(createMockSpineItem({ cfiBase: '/6/4' }))
      section.document = doc
      section.contents = doc.documentElement

      const el = doc.querySelector('p')!
      const cfi = section.cfiFromElement(el)
      expect(cfi).toMatch(/^epubcfi\(/)
    })
  })

  describe('destroy()', () => {
    it('calls unload, clears hooks, nullifies all properties', () => {
      const section = new Section(createMockSpineItem())
      const doc = parseXML(
        '<html><body>x</body></html>',
        'application/xhtml+xml',
      )
      section.document = doc
      section.contents = doc.documentElement
      section.output = '<html><body>x</body></html>'

      section.destroy()

      // unload was called
      expect(section.document).toBeUndefined()
      expect(section.contents).toBeUndefined()
      expect(section.output).toBeUndefined()

      // hooks cleared and nullified
      expect(section.hooks).toBeUndefined()

      // all properties nullified
      expect(section.idref).toBeUndefined()
      expect(section.linear).toBeUndefined()
      expect(section.properties).toBeUndefined()
      expect(section.index).toBeUndefined()
      expect(section.href).toBeUndefined()
      expect(section.url).toBeUndefined()
      expect(section.next).toBeUndefined()
      expect(section.prev).toBeUndefined()
      expect(section.cfiBase).toBeUndefined()
    })
  })
})

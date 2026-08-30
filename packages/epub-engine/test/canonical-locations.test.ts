import { describe, expect, it, vi } from 'vitest'
import Book from '../src/book'
import CanonicalLocations from '../src/canonical-locations'
import Section from '../src/section'
import { getFixtureUrl, parseXML } from './helpers'
import type Spine from '../src/spine'
import type { RequestFunction, SpineItem } from '../src/types'

function makeSection(
  index: number,
  href: string,
  linear = 'yes',
  properties: string[] = [],
): Section {
  const item: SpineItem = {
    index,
    cfiBase: `/6/${index * 2 + 2}`,
    idref: `item-${index}`,
    href,
    url: `https://book.invalid/${href}`,
    canonical: href,
    properties,
    linear,
    next: () => undefined,
    prev: () => undefined,
  }
  return new Section(item)
}

function documentFor(body: string): Document {
  return parseXML(
    `<html xmlns="http://www.w3.org/1999/xhtml"><body>${body}</body></html>`,
    'application/xhtml+xml',
  )
}

function spineWith(...sections: Section[]): Spine {
  return {
    spineItems: sections,
    get: (target?: string | number) =>
      typeof target === 'number'
        ? sections[target] ?? null
        : sections[0] ?? null,
  } as unknown as Spine
}

describe('CanonicalLocations', () => {
  it('works through Book without retaining every section document', async () => {
    const book = new Book(getFixtureUrl('/alice/OPS/package.opf'))
    await book.ready

    try {
      const generated = await book.canonicalLocations.generate({
        markerCodePointInterval: 500,
      })
      expect(generated.index.sections.length).toBeGreaterThan(1)
      expect(generated.index.totalCodePoints).toBeGreaterThan(0)
      expect(
        book.spine.spineItems.every(
          (section) => !section.document && !section.contents,
        ),
      ).toBe(true)

      const marker = generated.index.markers.find(
        (candidate) => candidate.canonicalPosition.kind === 'text',
      )
      if (!marker)
        throw new Error('Expected a text marker from the fixture book')
      const position = await book.canonicalLocations.positionFromCfi(marker.cfi)
      expect(position).toMatchObject({
        spineIndex: marker.canonicalPosition.spineIndex,
        cfi: marker.cfi,
      })
    } finally {
      book.destroy()
    }
  })

  it('scans linear spine occurrences sequentially without retaining presentation DOM', async () => {
    const first = makeSection(0, 'chapter.xhtml')
    const nonLinear = makeSection(1, 'notes.xhtml', 'no')
    const duplicate = makeSection(2, 'chapter.xhtml')
    let hookCalls = 0
    first.hooks!.content.register(() => {
      hookCalls += 1
    })

    let activeRequests = 0
    let peakRequests = 0
    const requestedUrls: string[] = []
    const request = vi.fn((url: string) => {
      requestedUrls.push(url)
      activeRequests += 1
      peakRequests = Math.max(peakRequests, activeRequests)
      const source = url.endsWith('chapter.xhtml')
        ? requestedUrls.length === 1
          ? documentFor('<p>A\u{1F600}B</p>')
          : documentFor('<p>second</p><img src="plate.png"/>')
        : documentFor('<p>skip me</p>')
      return Promise.resolve().then(() => {
        activeRequests -= 1
        return source
      })
    }) as unknown as RequestFunction

    const progress: number[] = []
    const locations = new CanonicalLocations(
      spineWith(first, nonLinear, duplicate),
      request,
    )
    const generated = await locations.generate({
      markerCodePointInterval: 2,
      onSection: ({ completedSections }) => progress.push(completedSections),
    })

    expect(requestedUrls).toEqual([
      'https://book.invalid/chapter.xhtml',
      'https://book.invalid/chapter.xhtml',
    ])
    expect(peakRequests).toBe(1)
    expect(progress).toEqual([1, 2])
    expect(generated.models.map((model) => model.spineIndex)).toEqual([0, 2])
    expect(
      generated.index.sections.map((section) => section.spineIndex),
    ).toEqual([0, 2])
    expect(generated.index.totalCodePoints).toBe(9)
    expect(
      generated.index.markers.every((marker) =>
        marker.cfi.startsWith('epubcfi('),
      ),
    ).toBe(true)
    expect(first.document).toBeUndefined()
    expect(first.contents).toBeUndefined()
    expect(hookCalls).toBe(0)
  })

  it('gives visible rendering priority before the first and each later source scan', async () => {
    const first = makeSection(0, 'first.xhtml')
    const second = makeSection(1, 'second.xhtml')
    const idleCallbacks: IdleRequestCallback[] = []
    const originalRequestIdleCallback = globalThis.requestIdleCallback
    const originalCancelIdleCallback = globalThis.cancelIdleCallback
    const request = vi.fn(() =>
      Promise.resolve(documentFor('<p>chapter</p>')),
    ) as unknown as RequestFunction

    globalThis.requestIdleCallback = vi.fn((callback: IdleRequestCallback) => {
      idleCallbacks.push(callback)
      return idleCallbacks.length
    })
    globalThis.cancelIdleCallback = vi.fn()

    try {
      const locations = new CanonicalLocations(
        spineWith(first, second),
        request,
      )
      const generated = locations.generate()

      await Promise.resolve()
      expect(request).not.toHaveBeenCalled()
      expect(idleCallbacks).toHaveLength(1)

      idleCallbacks.shift()!({ didTimeout: false, timeRemaining: () => 8 })
      await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1))
      await vi.waitFor(() => expect(idleCallbacks).toHaveLength(1))

      idleCallbacks.shift()!({ didTimeout: false, timeRemaining: () => 8 })
      await expect(generated).resolves.toMatchObject({
        models: [{ spineIndex: 0 }, { spineIndex: 1 }],
      })
      expect(request).toHaveBeenCalledTimes(2)
    } finally {
      if (originalRequestIdleCallback) {
        globalThis.requestIdleCallback = originalRequestIdleCallback
      } else {
        Reflect.deleteProperty(globalThis, 'requestIdleCallback')
      }
      if (originalCancelIdleCallback) {
        globalThis.cancelIdleCallback = originalCancelIdleCallback
      } else {
        Reflect.deleteProperty(globalThis, 'cancelIdleCallback')
      }
    }
  })

  it('cancels promptly while the first background scan is waiting for idle time', async () => {
    const section = makeSection(0, 'chapter.xhtml')
    const originalRequestIdleCallback = globalThis.requestIdleCallback
    const originalCancelIdleCallback = globalThis.cancelIdleCallback
    const cancelIdle = vi.fn()
    const request = vi.fn(() =>
      Promise.resolve(documentFor('<p>too late</p>')),
    ) as unknown as RequestFunction

    globalThis.requestIdleCallback = vi.fn(() => 42)
    globalThis.cancelIdleCallback = cancelIdle

    try {
      const controller = new AbortController()
      const locations = new CanonicalLocations(spineWith(section), request)
      const generated = locations.generate({ signal: controller.signal })

      controller.abort()

      await expect(generated).rejects.toMatchObject({ name: 'AbortError' })
      expect(cancelIdle).toHaveBeenCalledWith(42)
      expect(request).not.toHaveBeenCalled()
    } finally {
      if (originalRequestIdleCallback) {
        globalThis.requestIdleCallback = originalRequestIdleCallback
      } else {
        Reflect.deleteProperty(globalThis, 'requestIdleCallback')
      }
      if (originalCancelIdleCallback) {
        globalThis.cancelIdleCallback = originalCancelIdleCallback
      } else {
        Reflect.deleteProperty(globalThis, 'cancelIdleCallback')
      }
    }
  })

  it('uses the section layout override for a fixed-layout occurrence', async () => {
    const fixed = makeSection(0, 'cover.xhtml', 'yes', [
      'rendition:layout-pre-paginated',
    ])
    const locations = new CanonicalLocations(spineWith(fixed), () =>
      Promise.resolve(documentFor('<img src="cover.png"/>')),
    )

    const generated = await locations.generate({
      progressMetric: { fixedPageUnitWeight: 7 },
    })

    expect(generated.models[0]!.segments).toMatchObject([
      { kind: 'atomic', atomicKind: 'fixed-page' },
    ])
    expect(generated.progressMetric.totalUnits).toBe(7)
    expect(generated.index.markers).toHaveLength(2)
    expect(generated.index.markers[1]).toMatchObject({ terminal: true })
  })

  it('does not publish a late source response after cancellation', async () => {
    const section = makeSection(0, 'chapter.xhtml')
    let resolveRequest: ((value: unknown) => void) | undefined
    const request = () =>
      new Promise<unknown>((resolve) => {
        resolveRequest = resolve
      })
    const locations = new CanonicalLocations(spineWith(section), request)
    const controller = new AbortController()

    const generated = locations.generate({ signal: controller.signal })
    await vi.waitFor(() => expect(resolveRequest).toBeTypeOf('function'))
    controller.abort()
    resolveRequest!(documentFor('<p>late</p>'))

    await expect(generated).rejects.toMatchObject({ name: 'AbortError' })
    expect(section.document).toBeUndefined()
  })

  it('resolves a CFI to an exact canonical position and caches only its active source section', async () => {
    const section = makeSection(0, 'chapter.xhtml')
    const request = vi.fn(() =>
      Promise.resolve(documentFor('<p>A\u{1F600}B</p>')),
    ) as unknown as RequestFunction
    const locations = new CanonicalLocations(spineWith(section), request)
    const generated = await locations.generate({ markerCodePointInterval: 1 })
    const marker = generated.index.markers.find(
      (candidate) =>
        candidate.canonicalPosition.kind === 'text' &&
        candidate.canonicalPosition.codePointOffset === 2,
    )
    if (!marker)
      throw new Error('Expected a text marker at code-point offset two')

    const exact = await locations.positionFromCfi(marker.cfi)
    expect(exact).toMatchObject({
      kind: 'text',
      spineIndex: 0,
      codePointOffset: 2,
      domUtf16Offset: 3,
      isCodePointBoundary: true,
      cfi: marker.cfi,
    })
    expect(request).toHaveBeenCalledTimes(2)

    await locations.positionFromCfi(marker.cfi)
    expect(request).toHaveBeenCalledTimes(2)
    locations.clearPositionCache()
    await locations.positionFromCfi(marker.cfi)
    expect(request).toHaveBeenCalledTimes(3)
  })

  it('preserves a CFI that lands inside a surrogate pair without corrupting progress units', async () => {
    const section = makeSection(0, 'chapter.xhtml')
    const source = documentFor('<p>A\u{1F600}B</p>')
    const text = source.querySelector('p')!.firstChild!
    const range = source.createRange()
    range.setStart(text, 2)
    range.collapse(true)
    const cfi = section.cfiFromRange(range)
    const locations = new CanonicalLocations(spineWith(section), () =>
      Promise.resolve(documentFor('<p>A\u{1F600}B</p>')),
    )

    const position = await locations.positionFromCfi(cfi)

    expect(position).toMatchObject({
      kind: 'text',
      codePointOffset: 1,
      domUtf16Offset: 2,
      isCodePointBoundary: false,
      cfi,
    })
  })

  it('resolves element CFIs to their canonical atomic segment', async () => {
    const section = makeSection(0, 'chapter.xhtml')
    const markup = '<p>before<img src="plate.png"/>after</p>'
    const source = documentFor(markup)
    const cfi = section.cfiFromElement(source.querySelector('img')!)
    const locations = new CanonicalLocations(spineWith(section), () =>
      Promise.resolve(documentFor(markup)),
    )

    const position = await locations.positionFromCfi(cfi)

    expect(position).toMatchObject({
      kind: 'atomic',
      atomIndex: 0,
      edge: 'before',
      cfi,
    })
  })

  it('deduplicates concurrent source loads for positions in the same section', async () => {
    const section = makeSection(0, 'chapter.xhtml')
    const source = documentFor('<p>text</p>')
    const range = source.createRange()
    range.setStart(source.querySelector('p')!.firstChild!, 1)
    range.collapse(true)
    const cfi = section.cfiFromRange(range)
    let resolveRequest: ((document: Document) => void) | undefined
    const request = vi.fn(
      () =>
        new Promise<Document>((resolve) => {
          resolveRequest = resolve
        }),
    ) as unknown as RequestFunction
    const locations = new CanonicalLocations(spineWith(section), request)

    const first = locations.positionFromCfi(cfi)
    const second = locations.positionFromCfi(cfi)
    resolveRequest!(documentFor('<p>text</p>'))

    await expect(Promise.all([first, second])).resolves.toHaveLength(2)
    expect(request).toHaveBeenCalledTimes(1)
  })
})

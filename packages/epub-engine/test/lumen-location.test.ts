import { describe, expect, it } from 'vitest'

import {
  buildCanonicalLocationIndex,
  codePointLength,
  codePointOffsetToUtf16,
  createAtomicPosition,
  createMediaPosition,
  createProgressMetric,
  createTextPosition,
  parseCanonicalContent,
  utf16OffsetToCodePoint,
} from '../src/lumen-location'

import { parseXML } from './helpers'

function sourceDocument(body: string): Document {
  return parseXML(
    `<html xmlns="http://www.w3.org/1999/xhtml"><body>${body}</body></html>`,
    'application/xhtml+xml',
  )
}

function textCfi(
  spineIndex: number,
): (node: Text, utf16Offset: number) => string {
  return (_node, offset) => `epubcfi(/6/${spineIndex + 2}!/4/2/1:${offset})`
}

function elementCfi(
  spineIndex: number,
): (node: Element, edge: 'before' | 'after') => string {
  return (_node, edge) =>
    `epubcfi(/6/${spineIndex + 2}!/4/2[;s=${edge === 'before' ? 'b' : 'a'}])`
}

describe('Lumen Location Engine', () => {
  describe('Unicode bridge', () => {
    it('keeps Unicode code-point progress separate from CFI UTF-16 offsets', () => {
      const text = 'A😀B'
      expect(codePointLength(text)).toBe(3)
      expect(text.length).toBe(4)
      expect(codePointOffsetToUtf16(text, 0)).toBe(0)
      expect(codePointOffsetToUtf16(text, 1)).toBe(1)
      expect(codePointOffsetToUtf16(text, 2)).toBe(3)
      expect(codePointOffsetToUtf16(text, 3)).toBe(4)
      expect(utf16OffsetToCodePoint(text, 2)).toEqual({
        codePointOffset: 1,
        isCodePointBoundary: false,
      })
      expect(utf16OffsetToCodePoint(text, 3)).toEqual({
        codePointOffset: 2,
        isCodePointBoundary: true,
      })
    })

    it('handles combining characters and ZWJ sequences without treating graphemes as code points', () => {
      const combining = 'e\u0301'
      const developer = '👩‍💻'
      expect(codePointLength(combining)).toBe(2)
      expect(codePointLength(developer)).toBe(3)
      expect(codePointOffsetToUtf16(developer, 1)).toBe(2)
      expect(codePointOffsetToUtf16(developer, 2)).toBe(3)
      expect(codePointOffsetToUtf16(developer, 3)).toBe(5)
    })

    it('rejects invalid coordinate conversions instead of silently clamping them', () => {
      expect(() => codePointOffsetToUtf16('A', 2)).toThrow(RangeError)
      expect(() => utf16OffsetToCodePoint('A', -1)).toThrow(RangeError)
    })
  })

  describe('canonical source parsing', () => {
    it('uses the XHTML body, preserves source whitespace, and applies only deterministic exclusions', () => {
      const document = parseXML(
        '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Not reading content</title></head><body><span>A</span> <span aria-hidden="true">B</span><span data-lumen-location-ignore="true">C</span><span inert="">ignored</span></body></html>',
        'application/xhtml+xml',
      )
      const parsed = parseCanonicalContent(document, {
        spineIndex: 0,
        resourceHref: 'chapter.xhtml',
      })

      expect(
        parsed.segments.filter((segment) => segment.kind === 'text'),
      ).toHaveLength(4)
      expect(parsed.model.totalCodePoints).toBe(4)
      expect(
        parsed.segments.some(
          (segment) => segment.kind === 'text' && segment.node.data === ' ',
        ),
      ).toBe(true)
    })

    it('creates deterministic source segments and excludes presentation-only content', () => {
      const parsed = parseCanonicalContent(
        sourceDocument(
          '<p>A😀B</p><script>ignore()</script><span hidden="hidden">hidden</span><img src="plate.png"/><video src="clip.mp4"/><span data-reader-owned="true">reader wrapper</span>',
        ),
        {
          spineIndex: 4,
          spineItemId: 'chapter',
          resourceHref: 'chapter.xhtml',
          isReaderOwnedElement: (element) =>
            element.hasAttribute('data-reader-owned'),
        },
      )

      expect(parsed.model).toMatchObject({
        spineIndex: 4,
        spineItemId: 'chapter',
        resourceHref: 'chapter.xhtml',
        totalCodePoints: 3,
      })
      expect(parsed.segments.map((segment) => segment.kind)).toEqual([
        'text',
        'atomic',
        'media',
      ])
      expect(parsed.segments[0]).toMatchObject({
        kind: 'text',
        codePointLength: 3,
        utf16Length: 4,
      })
      expect(parsed.segments[1]).toMatchObject({
        kind: 'atomic',
        atomicKind: 'image',
      })
      expect(parsed.segments[2]).toMatchObject({
        kind: 'media',
        mediaKind: 'video',
      })
    })

    it('preserves canonical segment IDs across real source-tree slots', () => {
      const parsed = parseCanonicalContent(
        sourceDocument(
          '<p>A</p><!-- comment --><img src="plate.png"/><span> </span><video src="clip.mp4"/>',
        ),
        {
          spineIndex: 0,
          resourceHref: 'chapter.xhtml',
        },
      )

      expect(parsed.segments.map((segment) => segment.id)).toEqual([
        'text:0.0',
        'atomic:2',
        'text:3.0',
        'media:4',
      ])
    })

    it('models a fixed-layout spine occurrence as one atomic leaf', () => {
      const parsed = parseCanonicalContent(
        sourceDocument('<p>Accessible text</p><img src="page.png"/>'),
        {
          spineIndex: 1,
          resourceHref: 'page.xhtml',
          fixedLayout: true,
        },
      )

      expect(parsed.model.totalCodePoints).toBe(0)
      expect(parsed.segments).toHaveLength(1)
      expect(parsed.segments[0]).toMatchObject({
        kind: 'atomic',
        atomicKind: 'fixed-page',
      })
    })
  })

  describe('positions, markers, and metrics', () => {
    it('creates a text position with both coordinate systems', () => {
      const content = parseCanonicalContent(sourceDocument('<p>A😀B</p>'), {
        spineIndex: 0,
        spineItemId: 'first',
        resourceHref: 'chapter.xhtml',
      })
      const segment = content.segments[0]!
      if (segment.kind !== 'text') throw new Error('Expected a text segment')

      const position = createTextPosition(content, segment, 2, textCfi(0))
      expect(position).toMatchObject({
        kind: 'text',
        spineIndex: 0,
        resourceHref: 'chapter.xhtml',
        codePointOffset: 2,
        domUtf16Offset: 3,
        cfi: 'epubcfi(/6/2!/4/2/1:3)',
      })
    })

    it('keeps duplicate spine occurrences distinct even when their href is identical', () => {
      const first = parseCanonicalContent(sourceDocument('<p>abc</p>'), {
        spineIndex: 0,
        spineItemId: 'chapter-first',
        resourceHref: 'chapter.xhtml',
      })
      const second = parseCanonicalContent(sourceDocument('<p>def</p>'), {
        spineIndex: 2,
        spineItemId: 'chapter-second',
        resourceHref: 'chapter.xhtml',
      })

      const index = buildCanonicalLocationIndex(
        [
          {
            content: first,
            cfiForText: textCfi(0),
            cfiForElement: elementCfi(0),
          },
          {
            content: second,
            cfiForText: textCfi(2),
            cfiForElement: elementCfi(2),
          },
        ],
        { markerCodePointInterval: 2 },
      )

      expect(index.totalCodePoints).toBe(6)
      expect(index.sections.map((section) => section.spineIndex)).toEqual([
        0, 2,
      ])
      expect(
        index.markers.some(
          (marker) => marker.canonicalPosition.spineIndex === 0,
        ),
      ).toBe(true)
      expect(
        index.markers.some(
          (marker) => marker.canonicalPosition.spineIndex === 2,
        ),
      ).toBe(true)
      expect(
        new Set(index.markers.map((marker) => marker.cfi)).size,
      ).toBeGreaterThan(1)
    })

    it('gives text and fixed pages explicit, versioned metric units', () => {
      const textContent = parseCanonicalContent(sourceDocument('<p>abc</p>'), {
        spineIndex: 0,
        resourceHref: 'text.xhtml',
      })
      const pageContent = parseCanonicalContent(
        sourceDocument('<img src="page.png"/>'),
        {
          spineIndex: 1,
          resourceHref: 'page.xhtml',
          fixedLayout: true,
        },
      )
      const textSegment = textContent.segments[0]!
      const fixedSegment = pageContent.segments[0]!
      if (textSegment.kind !== 'text' || fixedSegment.kind !== 'atomic') {
        throw new Error('Expected text and atomic segments')
      }

      const metric = createProgressMetric(
        [textContent.model, pageContent.model],
        {
          fixedPageUnitWeight: 10,
        },
      )
      const middle = createTextPosition(textContent, textSegment, 2, textCfi(0))
      const afterPage = createAtomicPosition(
        pageContent,
        fixedSegment,
        0,
        'after',
        elementCfi(1),
      )

      expect(metric.totalUnits).toBe(13)
      expect(metric.snapshotAt(middle)).toMatchObject({
        completedUnits: 2,
        totalUnits: 13,
      })
      expect(metric.snapshotAt(afterPage)).toMatchObject({
        completedUnits: 13,
        totalUnits: 13,
      })
      expect(() => metric.unitsAt({ ...middle, codePointOffset: 4 })).toThrow(
        RangeError,
      )
      expect(() =>
        metric.unitsAt({ ...middle, resourceHref: 'other.xhtml' }),
      ).toThrow(RangeError)
      expect(() => metric.unitsAt({ ...afterPage, atomIndex: 1 })).toThrow(
        RangeError,
      )
      expect(() =>
        metric.unitsAt({ ...middle, canonicalModelVersion: 999 } as never),
      ).toThrow(RangeError)
      expect(() => metric.unitsAt({ ...middle, domUtf16Offset: 999 })).toThrow(
        RangeError,
      )
      expect(() =>
        createProgressMetric([{ ...textContent.model, totalCodePoints: 999 }]),
      ).toThrow(RangeError)
    })

    it('gives media an explicit before/after metric boundary until duration-aware metrics exist', () => {
      const content = parseCanonicalContent(
        sourceDocument('<audio src="chapter.mp3"/>'),
        {
          spineIndex: 0,
          resourceHref: 'audio.xhtml',
        },
      )
      const segment = content.segments[0]!
      if (segment.kind !== 'media') throw new Error('Expected a media segment')

      const metric = createProgressMetric([content.model], {
        mediaUnitWeight: 10,
      })
      const before = createMediaPosition(
        content,
        segment,
        0,
        'before',
        elementCfi(0),
      )
      const after = createMediaPosition(
        content,
        segment,
        0,
        'after',
        elementCfi(0),
      )

      expect(metric.snapshotAt(before)).toMatchObject({
        completedUnits: 0,
        totalUnits: 10,
      })
      expect(metric.snapshotAt(after)).toMatchObject({
        completedUnits: 10,
        totalUnits: 10,
      })
    })
  })
})

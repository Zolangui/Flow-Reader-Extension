import fs from 'fs'
import path from 'path'

import { describe, it, expect } from 'vitest'

import EpubCFI from '../src/epubcfi'

const fixturesDir = path.resolve(__dirname, 'fixtures')

describe('EpubCFI', () => {
  it('parse a cfi on init', () => {
    const cfi = new EpubCFI('epubcfi(/6/2[cover]!/6)')
    expect(cfi.spinePos).toBe(0)
  })

  it('parse a cfi and ignore the base if present', () => {
    const cfi = new EpubCFI('epubcfi(/6/2[cover]!/6)', '/6/6[end]')
    expect(cfi.spinePos).toBe(0)
  })

  describe('#parse()', () => {
    const cfi = new EpubCFI()

    it('parse a cfi on init', () => {
      const parsed = cfi.parse('epubcfi(/6/2[cover]!/6)')
      expect(parsed.spinePos).toBe(0)
    })

    it('parse a cfi and ignore the base if present', () => {
      const parsed = cfi.parse('epubcfi(/6/2[cover]!/6)', '/6/6[end]')
      expect(parsed.spinePos).toBe(0)
    })

    it('parse a cfi with a character offset', () => {
      const parsed = cfi.parse(
        'epubcfi(/6/4[chap01ref]!/4[body01]/10[para05]/2/1:3)',
      )
      expect(parsed.path.terminal.offset).toBe(3)
    })

    it('parse a cfi with a range', () => {
      const parsed = cfi.parse(
        'epubcfi(/6/4[chap01ref]!/4[body01]/10[para05],/2/1:1,/3:4)',
      )

      expect(parsed.range).toBe(true)
      expect(parsed.start.steps.length).toBe(2)
      expect(parsed.end.steps.length).toBe(1)
      expect(parsed.start.terminal.offset).toBe(1)
      expect(parsed.end.terminal.offset).toBe(4)
    })
  })

  describe('#toString()', () => {
    it('parse a cfi and write it back', () => {
      expect(new EpubCFI('epubcfi(/6/2[cover]!/6)').toString()).toBe(
        'epubcfi(/6/2[cover]!/6)',
      )
      expect(
        new EpubCFI(
          'epubcfi(/6/4[chap01ref]!/4[body01]/10[para05]/2/1:3)',
        ).toString(),
      ).toBe('epubcfi(/6/4[chap01ref]!/4[body01]/10[para05]/2/1:3)')
      expect(
        new EpubCFI(
          'epubcfi(/6/4[chap01ref]!/4[body01]/10[para05],/2/1:1,/3:4)',
        ).toString(),
      ).toBe('epubcfi(/6/4[chap01ref]!/4[body01]/10[para05],/2/1:1,/3:4)')
    })
  })

  describe('#checkType()', () => {
    it('determine the type of a cfi string', () => {
      const cfi = new EpubCFI()

      expect(cfi.checkType('epubcfi(/6/2[cover]!/6)')).toBe('string')
      expect(cfi.checkType('/6/2[cover]!/6')).toBe(false)
    })

    it('determine the type of a cfi', () => {
      const ogcfi = new EpubCFI(
        'epubcfi(/6/4[chap01ref]!/4[body01]/10[para05]/2/1:3)',
      )
      const cfi = new EpubCFI()

      expect(cfi.checkType(ogcfi)).toBe('EpubCFI')
    })

    it('determine the type of a node', () => {
      const cfi = new EpubCFI()
      const el = document.createElement('div')

      expect(cfi.checkType(el)).toBe('node')
    })

    it('determine the type of a range', () => {
      const cfi = new EpubCFI()
      const range = document.createRange()

      expect(cfi.checkType(range)).toBe('range')
    })
  })

  describe('#compare()', () => {
    it('compare CFIs', () => {
      const epubcfi = new EpubCFI()

      // Spines
      expect(
        epubcfi.compare('epubcfi(/6/4[cover]!/4)', 'epubcfi(/6/2[cover]!/4)'),
      ).toBe(1)
      expect(
        epubcfi.compare('epubcfi(/6/4[cover]!/4)', 'epubcfi(/6/6[cover]!/4)'),
      ).toBe(-1)

      // First is deeper
      expect(
        epubcfi.compare('epubcfi(/6/2[cover]!/8/2)', 'epubcfi(/6/2[cover]!/6)'),
      ).toBe(1)
      expect(
        epubcfi.compare('epubcfi(/6/2[cover]!/4/2)', 'epubcfi(/6/2[cover]!/6)'),
      ).toBe(-1)

      // Second is deeper
      expect(
        epubcfi.compare(
          'epubcfi(/6/2[cover]!/8/2)',
          'epubcfi(/6/2[cover]!/6/4/2/2)',
        ),
      ).toBe(1)
      expect(
        epubcfi.compare(
          'epubcfi(/6/2[cover]!/4/4)',
          'epubcfi(/6/2[cover]!/6/4/2/2)',
        ),
      ).toBe(-1)
      expect(
        epubcfi.compare(
          'epubcfi(/6/2[cover]!/4/6)',
          'epubcfi(/6/2[cover]!/4/6/8/1:0)',
        ),
      ).toBe(-1)

      // Same Depth
      expect(
        epubcfi.compare(
          'epubcfi(/6/2[cover]!/6/8)',
          'epubcfi(/6/2[cover]!/6/2)',
        ),
      ).toBe(1)
      expect(
        epubcfi.compare(
          'epubcfi(/6/2[cover]!/4/20)',
          'epubcfi(/6/2[cover]!/6/10)',
        ),
      ).toBe(-1)

      // Text nodes
      expect(
        epubcfi.compare(
          'epubcfi(/6/2[cover]!/4/5)',
          'epubcfi(/6/2[cover]!/4/3)',
        ),
      ).toBe(1)
      expect(
        epubcfi.compare(
          'epubcfi(/6/2[cover]!/4/7)',
          'epubcfi(/6/2[cover]!/4/13)',
        ),
      ).toBe(-1)

      // Char offset
      expect(
        epubcfi.compare(
          'epubcfi(/6/2[cover]!/4/5:1)',
          'epubcfi(/6/2[cover]!/4/5:0)',
        ),
      ).toBe(1)
      expect(
        epubcfi.compare(
          'epubcfi(/6/2[cover]!/4/5:2)',
          'epubcfi(/6/2[cover]!/4/5:30)',
        ),
      ).toBe(-1)

      // Normal example
      expect(
        epubcfi.compare(
          'epubcfi(/6/2[cover]!/4/8/5:1)',
          'epubcfi(/6/2[cover]!/4/6/15:2)',
        ),
      ).toBe(1)
      expect(
        epubcfi.compare(
          'epubcfi(/6/2[cover]!/4/8/1:0)',
          'epubcfi(/6/2[cover]!/4/8/1:0)',
        ),
      ).toBe(0)

      // Different Lengths
      expect(
        epubcfi.compare(
          'epubcfi(/6/16[id42]!/4[5N3C0-8c483216e03a4ff49927fc1a97dc7b2c]/10/1:317)',
          'epubcfi(/6/16[id42]!/4[5N3C0-8c483216e03a4ff49927fc1a97dc7b2c]/10/2[page18]/1:0)',
        ),
      ).toBe(-1)
      expect(
        epubcfi.compare(
          'epubcfi(/6/16[id42]!/4[5N3C0-8c483216e03a4ff49927fc1a97dc7b2c]/12/1:0)',
          'epubcfi(/6/16[id42]!/4[5N3C0-8c483216e03a4ff49927fc1a97dc7b2c]/12/2/1:9)',
        ),
      ).toBe(-1)
      expect(
        epubcfi.compare(
          'epubcfi(/6/16!/4/12/1:0)',
          'epubcfi(/6/16!/4/12/2/1:9)',
        ),
      ).toBe(-1)
    })
  })

  describe('#fromNode()', () => {
    const base = '/6/4[chap01ref]'
    const contents = fs.readFileSync(
      path.join(fixturesDir, 'chapter1-highlights.xhtml'),
      'utf8',
    )
    const doc = new DOMParser().parseFromString(contents, 'application/xhtml+xml')

    it('get a cfi from a p node', () => {
      const span = doc.getElementById('c001p0004')
      const cfi = new EpubCFI(span, base)

      expect(span!.nodeType).toBe(Node.ELEMENT_NODE)
      expect(cfi.toString()).toBe(
        'epubcfi(/6/4[chap01ref]!/4/2/10/2[c001p0004])',
      )
    })

    it('get a cfi from a text node', () => {
      const t = doc.getElementById('c001p0004')!.childNodes[0]
      const cfi = new EpubCFI(t, base)

      expect(t.nodeType).toBe(Node.TEXT_NODE)
      expect(cfi.toString()).toBe(
        'epubcfi(/6/4[chap01ref]!/4/2/10/2[c001p0004]/1)',
      )
    })

    it('get a cfi from a text node inside a highlight', () => {
      const t = doc.getElementById('highlight-1')!.childNodes[0]
      const cfi = new EpubCFI(t, base, 'annotator-hl')

      expect(t.nodeType).toBe(Node.TEXT_NODE)
      expect(cfi.toString()).toBe(
        'epubcfi(/6/4[chap01ref]!/4/2/32/2[c001p0017]/1)',
      )
    })

    it('get a cfi from a highlight node', () => {
      const t = doc.getElementById('highlight-1')!
      const cfi = new EpubCFI(t, base, 'annotator-hl')

      expect(t.nodeType).toBe(Node.ELEMENT_NODE)
      expect(cfi.toString()).toBe(
        'epubcfi(/6/4[chap01ref]!/4/2/32/2[c001p0017])',
      )
    })
  })

  describe('#fromRange()', () => {
    const base = '/6/4[chap01ref]'

    const contentsClean = fs.readFileSync(
      path.join(fixturesDir, 'chapter1.xhtml'),
      'utf8',
    )
    const doc = new DOMParser().parseFromString(
      contentsClean,
      'application/xhtml+xml',
    )

    const contentsHighlights = fs.readFileSync(
      path.join(fixturesDir, 'chapter1-highlights.xhtml'),
      'utf8',
    )
    const docHighlights = new DOMParser().parseFromString(
      contentsHighlights,
      'application/xhtml+xml',
    )

    const highlightContents = fs.readFileSync(
      path.join(fixturesDir, 'highlight.xhtml'),
      'utf8',
    )
    const docHighlightsAlice = new DOMParser().parseFromString(
      highlightContents,
      'application/xhtml+xml',
    )

    it('get a cfi from a collapsed range', () => {
      const t1 = doc.getElementById('c001p0004')!.childNodes[0]
      const range = doc.createRange()

      range.setStart(t1, 6)

      const cfi = new EpubCFI(range, base)

      expect(cfi.range).toBe(false)
      expect(cfi.toString()).toBe(
        'epubcfi(/6/4[chap01ref]!/4/2/10/2[c001p0004]/1:6)',
      )
    })

    it('get a cfi from a range', () => {
      const t1 = doc.getElementById('c001p0004')!.childNodes[0]
      const t2 = doc.getElementById('c001p0007')!.childNodes[0]
      const range = doc.createRange()

      range.setStart(t1, 6)
      range.setEnd(t2, 27)

      const cfi = new EpubCFI(range, base)

      expect(cfi.range).toBe(true)
      expect(cfi.toString()).toBe(
        'epubcfi(/6/4[chap01ref]!/4/2,/10/2[c001p0004]/1:6,/16/2[c001p0007]/1:27)',
      )
    })

    it('get a cfi from a range with offset 0', () => {
      const t1 = doc.getElementById('c001p0004')!.childNodes[0]
      const range = doc.createRange()

      range.setStart(t1, 0)
      range.setEnd(t1, 1)

      const cfi = new EpubCFI(range, base)

      expect(cfi.range).toBe(true)
      expect(cfi.toString()).toBe(
        'epubcfi(/6/4[chap01ref]!/4/2/10/2[c001p0004],/1:0,/1:1)',
      )
    })

    it('get a cfi from a range inside a highlight', () => {
      const t1 = docHighlights.getElementById('highlight-1')!.childNodes[0]
      const range = docHighlights.createRange()

      range.setStart(t1, 6)

      const cfi = new EpubCFI(range, base, 'annotator-hl')

      expect(cfi.toString()).toBe(
        'epubcfi(/6/4[chap01ref]!/4/2/32/2[c001p0017]/1:43)',
      )
    })

    it('get a cfi from a range past a highlight', () => {
      const t1 = docHighlights.getElementById('c001s0001')!.childNodes[1]
      const range = docHighlights.createRange()

      range.setStart(t1, 25)

      const cfi = new EpubCFI(range, base, 'annotator-hl')

      expect(cfi.toString()).toBe(
        'epubcfi(/6/4[chap01ref]!/4/2/4/2[c001s0001]/1:41)',
      )
    })

    it('get a cfi from a range in between two highlights', () => {
      const t1 = docHighlightsAlice.getElementById('p2')!.childNodes[1]
      const range = docHighlightsAlice.createRange()

      range.setStart(t1, 4)

      const cfi = new EpubCFI(range, base, 'annotator-hl')

      expect(cfi.toString()).toBe('epubcfi(/6/4[chap01ref]!/4/4[p2]/1:123)')
    })

    it('correctly count text nodes, independent of any elements present inbetween', () => {
      const t1 = docHighlightsAlice.getElementById('p3')!.childNodes[2]
      const range = docHighlightsAlice.createRange()

      range.setStart(t1, 4)

      const cfi = new EpubCFI(range, base)

      expect(cfi.toString()).toBe('epubcfi(/6/4[chap01ref]!/4/6[p3]/3:4)')
    })
  })

  describe('#toRange()', () => {
    const base = '/6/4[chap01ref]'
    const contents = fs.readFileSync(
      path.join(fixturesDir, 'chapter1-highlights.xhtml'),
      'utf8',
    )
    const doc = new DOMParser().parseFromString(contents, 'application/xhtml+xml')

    it('get a range from a cfi', () => {
      const t1 = doc.getElementById('c001p0004')!.childNodes[0]
      const ogRange = doc.createRange()

      ogRange.setStart(t1, 6)

      const cfi = new EpubCFI(ogRange, base)

      expect(cfi.toString()).toBe(
        'epubcfi(/6/4[chap01ref]!/4/2/10/2[c001p0004]/1:6)',
      )

      const newRange = cfi.toRange(doc)

      expect(newRange.startContainer).toBe(t1)
      expect(newRange.startOffset).toBe(6)
      expect(newRange.collapsed).toBe(true)
    })

    it('get a range from a cfi with a range', () => {
      const t1 = doc.getElementById('c001p0004')!.childNodes[0]
      const t2 = doc.getElementById('c001p0007')!.childNodes[0]
      const ogRange = doc.createRange()

      ogRange.setStart(t1, 6)
      ogRange.setEnd(t2, 27)

      const cfi = new EpubCFI(ogRange, base)

      expect(cfi.toString()).toBe(
        'epubcfi(/6/4[chap01ref]!/4/2,/10/2[c001p0004]/1:6,/16/2[c001p0007]/1:27)',
      )

      const newRange = cfi.toRange(doc)

      expect(newRange.startContainer).toBe(t1)
      expect(newRange.startOffset).toBe(6)
      expect(newRange.endContainer).toBe(t2)
      expect(newRange.endOffset).toBe(27)
      expect(newRange.collapsed).toBe(false)
    })

    it('get a cfi from a range inside a highlight', () => {
      const t1 = doc.getElementById('highlight-1')!.childNodes[0]
      const ogRange = doc.createRange()

      ogRange.setStart(t1, 6)

      const cfi = new EpubCFI(ogRange, base, 'annotator-hl')

      expect(cfi.toString()).toBe(
        'epubcfi(/6/4[chap01ref]!/4/2/32/2[c001p0017]/1:43)',
      )

      const newRange = cfi.toRange(doc, 'annotator-hl')

      expect(newRange.startContainer).toBeTruthy()
      expect(newRange.startContainer).toBe(t1)
      expect(newRange.startOffset).toBe(6)
    })

    it('get a cfi from a range inside a highlight range', () => {
      const t1 = doc.getElementById('highlight-2')!.childNodes[0]
      const t2 = doc.getElementById('c001s0001')!.childNodes[1]
      const ogRange = doc.createRange()

      ogRange.setStart(t1, 5)
      ogRange.setEnd(t2, 25)

      const cfi = new EpubCFI(ogRange, base, 'annotator-hl')

      expect(cfi.toString()).toBe(
        'epubcfi(/6/4[chap01ref]!/4/2/4/2[c001s0001],/1:5,/1:41)',
      )

      const newRange = cfi.toRange(doc, 'annotator-hl')

      expect(newRange.startContainer.textContent).toBe(t1.textContent)
    })
  })
})

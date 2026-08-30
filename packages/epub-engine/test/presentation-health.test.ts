import { describe, expect, it, vi } from 'vitest'

import {
  createPresentationHealthMap,
  summarizePresentationLegibility,
} from '../src/presentation-health'
import { markPresentationRuntimeNode } from '../src/presentation-marker'
import { resolveSourceTreeAddress } from '../src/source-tree'

import { installVisibleLayout } from './helpers'

function renderedDocument(markup: string): {
  document: Document
  iframe: HTMLIFrameElement
} {
  const iframe = document.createElement('iframe')
  document.body.appendChild(iframe)
  const rendered = iframe.contentDocument!
  rendered.documentElement.innerHTML = markup
  installVisibleLayout(rendered)
  return { document: rendered, iframe }
}

describe('presentation health map', () => {
  it('marks a zero-budget observation as truncated', () => {
    const { document: rendered, iframe } = renderedDocument(
      '<head></head><body><p>Text</p></body>',
    )

    const health = createPresentationHealthMap({
      renderedDocument: rendered,
      spineIndex: 0,
      canvasColor: '#ffffff',
      maxInspectedElements: 0,
    })

    expect(health.observations).toEqual([])
    expect(health.truncated).toBe(true)
    iframe.remove()
  })

  it('records an opaque text/surface relationship through transparent ancestors', () => {
    const { document: rendered, iframe } = renderedDocument(`
      <head><style>
        body { color: rgb(20, 20, 20); background: rgb(250, 250, 250); }
        div, p { background: transparent; }
      </style></head>
      <body><div><p id="prose">Readable prose</p></div></body>
    `)

    const health = createPresentationHealthMap({
      renderedDocument: rendered,
      spineIndex: 3,
      canvasColor: '#111827',
    })
    const prose = health.observations.find(
      (observation) => observation.element.id === 'prose',
    )!

    expect(prose.address.spineIndex).toBe(3)
    expect(prose.role).toBe('text')
    expect(prose.directTextCodePoints).toBe(14)
    expect(prose.textPaintEligible).toBe(true)
    expect(prose.paint).toMatchObject({
      kind: 'known',
      confidence: 'high',
      transparentAncestorCount: 2,
      surface: { kind: 'element' },
    })
    if (prose.paint.kind === 'known') {
      expect(prose.paint.contrast).toBeGreaterThan(10)
      expect(
        health.observations[
          prose.paint.surface.kind === 'element'
            ? prose.paint.surface.observationIndex
            : -1
        ]?.role,
      ).toBe('root')
    }
    iframe.remove()
  })

  it('marks image, blend, filter, and text-effect paint as unknown', () => {
    const { document: rendered, iframe } = renderedDocument(`
      <head><style>
        body { color: #111; background: #fff; }
        #image { background-image: linear-gradient(#fff, #ddd); }
        #blend { mix-blend-mode: multiply; }
        #filter { filter: contrast(1); }
        #shadow { text-shadow: 0 0 1px #fff; }
      </style></head>
      <body>
        <p id="image">Image paint</p><p id="blend">Blend paint</p>
        <p id="filter">Filtered paint</p><p id="shadow">Shadow paint</p>
      </body>
    `)

    const health = createPresentationHealthMap({
      renderedDocument: rendered,
      spineIndex: 0,
      canvasColor: '#ffffff',
    })
    const paintReason = (id: string): string | undefined => {
      const paint = health.observations.find(
        (observation) => observation.element.id === id,
      )!.paint
      return paint.kind === 'unknown' ? paint.reason : undefined
    }

    expect(paintReason('image')).toBe('background-image')
    expect(paintReason('blend')).toBe('composited-paint')
    expect(paintReason('filter')).toBe('composited-paint')
    expect(paintReason('shadow')).toBe('text-effect')
    expect(
      health.observations.find(
        (observation) => observation.element.id === 'filter',
      )!.textPaintEligible,
    ).toBe(false)
    iframe.remove()
  })

  it('uses the opaque html canvas before the surrounding reader canvas', () => {
    const { document: rendered, iframe } = renderedDocument(`
      <head><style>
        html { background: rgb(255, 255, 255); }
        body { color: rgb(20, 20, 20); background: transparent; }
      </style></head>
      <body><p id="prose">Dark text remains readable on authored white.</p></body>
    `)
    const health = createPresentationHealthMap({
      renderedDocument: rendered,
      spineIndex: 0,
      canvasColor: '#111827',
    })
    const paint = health.observations.find(
      (observation) => observation.element.id === 'prose',
    )!.paint
    expect(paint).toMatchObject({
      kind: 'known',
      surface: { kind: 'document' },
    })
    if (paint.kind === 'known') expect(paint.contrast).toBeGreaterThan(10)
    iframe.remove()
  })

  it('fails closed for clipped, collapsed, and boxless text paint', () => {
    const { document: rendered, iframe } = renderedDocument(`
      <head><style>
        body { color:#111; background:#fff; }
        #clip { clip-path: inset(20%); }
        #collapsed { visibility: collapse; }
      </style></head>
      <body><p id="clip">Clipped</p><p id="collapsed">Collapsed</p><p id="boxless">Boxless</p></body>
    `)
    const boxless = rendered.querySelector('#boxless')!
    vi.spyOn(boxless, 'getClientRects').mockReturnValue([] as any)
    vi.spyOn(boxless, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      width: 0,
      height: 0,
      toJSON: () => ({}),
    })
    const health = createPresentationHealthMap({
      renderedDocument: rendered,
      spineIndex: 0,
      canvasColor: '#fff',
    })
    const reason = (id: string) => {
      const paint = health.observations.find(
        (observation) => observation.element.id === id,
      )!.paint
      return paint.kind === 'unknown' ? paint.reason : undefined
    }
    expect(reason('clip')).toBe('clipped-paint')
    expect(reason('collapsed')).toBe('hidden-content')
    expect(reason('boxless')).toBe('no-rendered-box')
    iframe.remove()
  })

  it('treats paint under a clipped ancestor as unproven', () => {
    const { document: rendered, iframe } = renderedDocument(`
      <head><style>
        body { color:#111; background:#fff; }
        #clipped-parent { clip-path: inset(1px); }
      </style></head>
      <body>
        <div id="clipped-parent"><p id="clipped-child">Clipped child</p></div>
      </body>
    `)
    const health = createPresentationHealthMap({
      renderedDocument: rendered,
      spineIndex: 0,
      canvasColor: '#fff',
    })
    const reason = (id: string) => {
      const paint = health.observations.find(
        (observation) => observation.element.id === id,
      )!.paint
      return paint.kind === 'unknown' ? paint.reason : undefined
    }

    expect(reason('clipped-child')).toBe('clipped-paint')
    iframe.remove()
  })

  it('returns a fail-closed diagnostic for a detached document realm', () => {
    const detached = document.implementation.createHTMLDocument('detached')
    detached.body.innerHTML = '<p>Detached text</p>'

    expect(detached.defaultView).toBeNull()
    const health = createPresentationHealthMap({
      renderedDocument: detached,
      spineIndex: 0,
      canvasColor: '#fff',
    })

    expect(health.observations).toHaveLength(0)
    expect(health.diagnostics).toContain('missing-render-view')
  })

  it('batches a bounded cross-realm snapshot and records geometry as evidence', () => {
    const { document: rendered, iframe } = renderedDocument(`
      <head></head><body style="color:#111;background:#fff">
        <p id="one">One</p><p id="two">Two</p><p id="three">Three</p>
      </body>
    `)
    const one = rendered.querySelector('#one')!
    vi.spyOn(one, 'getBoundingClientRect').mockReturnValue({
      x: 4,
      y: 8,
      width: 120,
      height: 30,
      top: 8,
      right: 124,
      bottom: 38,
      left: 4,
      toJSON: () => ({}),
    })
    Object.defineProperty(one, 'scrollWidth', {
      configurable: true,
      value: 160,
    })

    expect(rendered.defaultView).not.toBe(window)
    const complete = createPresentationHealthMap({
      renderedDocument: rendered,
      spineIndex: 1,
      canvasColor: '#fff',
      maxInspectedElements: 4,
    })
    const observedOne = complete.observations.find(
      (observation) => observation.element === one,
    )!
    expect(Object.isFrozen(complete)).toBe(true)
    expect(Object.isFrozen(complete.observations)).toBe(true)
    expect(Object.isFrozen(observedOne)).toBe(true)
    expect(Object.isFrozen(observedOne.address)).toBe(true)
    expect(Object.isFrozen(observedOne.address.sourcePath)).toBe(true)
    expect(Object.isFrozen(observedOne.style)).toBe(true)
    expect(Object.isFrozen(observedOne.paint)).toBe(true)
    expect(observedOne.geometry).toMatchObject({
      x: 4,
      y: 8,
      width: 120,
      height: 30,
      scrollWidth: 160,
    })
    expect('findings' in complete).toBe(false)
    expect('patches' in complete).toBe(false)

    const bounded = createPresentationHealthMap({
      renderedDocument: rendered,
      spineIndex: 1,
      canvasColor: '#fff',
      maxInspectedElements: 2,
    })
    expect(bounded.observations).toHaveLength(2)
    expect(bounded.truncated).toBe(true)
    iframe.remove()
  })

  it('observes authored descendants through a Lumen overflow wrapper', () => {
    const source = document.implementation.createHTMLDocument('source')
    source.body.innerHTML = `<table><tbody><tr>
      <td id="cell">Authored table text remains observable after containment.</td>
    </tr></tbody></table>`
    const { document: rendered, iframe } = renderedDocument(`
      <head><style>body { color:#111; background:#fff; }</style></head>
      <body><div data-lumen-overflow-wrapper="g0"><table><tbody><tr>
        <td id="cell">Authored table text remains observable after containment.</td>
      </tr></tbody></table></div></body>
    `)
    markPresentationRuntimeNode(
      rendered.querySelector('[data-lumen-overflow-wrapper]')!,
    )
    const health = createPresentationHealthMap({
      renderedDocument: rendered,
      spineIndex: 0,
      canvasColor: '#111827',
    })
    const cell = health.observations.find(
      (observation) => observation.element.id === 'cell',
    )

    expect(
      health.observations.some((observation) =>
        observation.element.hasAttribute('data-lumen-overflow-wrapper'),
      ),
    ).toBe(false)
    expect(cell?.directTextCodePoints).toBeGreaterThan(0)
    expect(cell?.paint).toMatchObject({
      kind: 'known',
      surface: { kind: 'element' },
    })
    expect(resolveSourceTreeAddress(source, cell!.address, 0)).toBe(
      source.querySelector('#cell'),
    )
    iframe.remove()
  })

  it('does not trust author-planted Lumen ownership attributes', () => {
    const { document: rendered, iframe } = renderedDocument(`
      <head></head><body style="color:#111;background:#fff">
        <p id="authored" data-lumen-presentation-layer="author-content" data-lumen-location-ignore="true">
          Authored text must remain observable.
        </p>
      </body>
    `)
    const health = createPresentationHealthMap({
      renderedDocument: rendered,
      spineIndex: 0,
      canvasColor: '#ffffff',
    })

    expect(
      health.observations.some(
        (observation) => observation.element.id === 'authored',
      ),
    ).toBe(true)
    iframe.remove()
  })

  it('fails closed for invalid canvases and can be cancelled', () => {
    const { document: rendered, iframe } = renderedDocument(
      '<head></head><body style="color:#111"><p>Text</p></body>',
    )
    const invalid = createPresentationHealthMap({
      renderedDocument: rendered,
      spineIndex: 0,
      canvasColor: 'not-a-color',
    })
    expect(invalid.diagnostics).toContain('invalid-canvas')
    expect(invalid.observations[1]!.paint).toMatchObject({
      kind: 'unknown',
      reason: 'invalid-canvas',
    })

    const controller = new AbortController()
    controller.abort()
    expect(() =>
      createPresentationHealthMap({
        renderedDocument: rendered,
        spineIndex: 0,
        canvasColor: '#fff',
        signal: controller.signal,
      }),
    ).toThrow(/abort/i)
    iframe.remove()
  })

  it('keeps known low contrast and unknown paint as separate legibility debt', () => {
    const { document: rendered, iframe } = renderedDocument(`
      <head><style>
        body { color: #f8fafc; background: #111827; }
        #low { color: #172033; }
        #unknown { background-image: linear-gradient(#111827, #1f2937); }
      </style></head>
      <body>
        <p id="readable">Readable text</p>
        <p id="low">Known low contrast</p>
        <p id="unknown">Unknown painted surface</p>
      </body>
    `)
    const summary = summarizePresentationLegibility({
      healthMap: createPresentationHealthMap({
        renderedDocument: rendered,
        spineIndex: 0,
        canvasColor: '#111827',
      }),
      minimumTextContrast: 4.5,
    })

    expect(summary).toMatchObject({
      complete: false,
      truncated: false,
      visibleTextSamples: 3,
      provenReadableSamples: 1,
      knownLowContrastSamples: 1,
      unknownPaintSamples: 1,
      unknownPaintByReason: { 'background-image': 1 },
    })
    iframe.remove()
  })

  it('separates fully overflow-clipped prose from visible legibility debt', () => {
    const { document: rendered, iframe } = renderedDocument(`
      <head><style>
        body { color:#f8fafc; background:#111827; }
        #clipped-parent { height:0; overflow:hidden; }
        #clipped-prose { background-image:linear-gradient(#111827,#1f2937); }
      </style></head>
      <body>
        <p id="visible-prose">Visible prose</p>
        <div id="clipped-parent"><p id="clipped-prose">Clipped prose</p></div>
      </body>
    `)
    const parent = rendered.querySelector('#clipped-parent')!
    vi.spyOn(parent, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 40,
      top: 40,
      left: 0,
      right: 100,
      bottom: 40,
      width: 100,
      height: 0,
      toJSON: () => ({}),
    })
    const summary = summarizePresentationLegibility({
      healthMap: createPresentationHealthMap({
        renderedDocument: rendered,
        spineIndex: 0,
        canvasColor: '#111827',
      }),
    })

    expect(summary).toMatchObject({
      complete: true,
      visibleTextSamples: 1,
      provenReadableSamples: 1,
      nonVisibleTextSamples: 1,
      unknownPaintSamples: 0,
    })
    iframe.remove()
  })

  it('never reports complete evidence from a truncated health snapshot', () => {
    const { document: rendered, iframe } = renderedDocument(`
      <head></head><body style="color:#fff;background:#111827">
        <p>First readable sample</p><p>Uninspected sample</p>
      </body>
    `)
    const summary = summarizePresentationLegibility({
      healthMap: createPresentationHealthMap({
        renderedDocument: rendered,
        spineIndex: 0,
        canvasColor: '#111827',
        maxInspectedElements: 1,
      }),
    })

    expect(summary.truncated).toBe(true)
    expect(summary.complete).toBe(false)
    iframe.remove()
  })

  it('declares source-unaddressable pseudo text as dedicated debt', () => {
    const { document: rendered, iframe } = renderedDocument(`
      <head><style>
        body { color:#fff; background:#111827; }
        p::first-line { color:#111827; }
        p::before { content:"Prefix"; }
      </style></head>
      <body><p>Visible authored paragraph</p></body>
    `)
    const health = createPresentationHealthMap({
      renderedDocument: rendered,
      spineIndex: 0,
      canvasColor: '#111827',
    })
    const summary = summarizePresentationLegibility({ healthMap: health })

    expect(health.pseudoTextSamples).toBe(2)
    expect(summary.complete).toBe(false)
    expect(summary.unknownPaintByReason['pseudo-element']).toBe(2)
    iframe.remove()
  })

  it('ignores inactive or paint-neutral pseudo rules and covers first-letter paint', () => {
    const { document: rendered, iframe } = renderedDocument(`
      <head><style>
        body { color:#fff; background:#111827; }
        *::before { box-sizing:border-box; }
        p::first-line { font-weight:bold; }
        p::first-letter { color:#111827; }
        @media (min-width: 99999px) {
          p::after { content:"Inactive"; }
        }
      </style></head>
      <body><p>Visible authored paragraph</p><ul><li>List item</li></ul></body>
    `)
    Object.defineProperty(rendered.defaultView, 'matchMedia', {
      configurable: true,
      value: vi.fn((query: string) => ({
        matches: !query.includes('99999px'),
        media: query,
      })),
    })

    const health = createPresentationHealthMap({
      renderedDocument: rendered,
      spineIndex: 0,
      canvasColor: '#111827',
    })
    const summary = summarizePresentationLegibility({ healthMap: health })

    expect(health.pseudoTextSamples).toBe(1)
    expect(health.pseudoTextTruncated).toBe(false)
    expect(summary.unknownPaintByReason['pseudo-element']).toBe(1)
    iframe.remove()
  })

  it('counts a default list marker separately when its list item stays dark', () => {
    const { document: rendered, iframe } = renderedDocument(`
      <head><style>
        body { color:#dce4e8; background:#111827; }
        li { color:#000000; list-style-type:disc; }
        li > p { color:#dce4e8; }
      </style></head>
      <body><ul><li><p>Readable prose with a separately inherited marker.</p></li></ul></body>
    `)
    const health = createPresentationHealthMap({
      renderedDocument: rendered,
      spineIndex: 12,
      canvasColor: '#111827',
    })
    const summary = summarizePresentationLegibility({ healthMap: health })

    expect(health.listMarkers).toHaveLength(1)
    expect(health.listMarkers[0]?.paint.kind).toBe('known')
    expect(summary.complete).toBe(false)
    expect(summary.knownLowContrastSamples).toBe(1)
    expect(summary.knownLowContrastCodePoints).toBe(1)
    iframe.remove()
  })
})

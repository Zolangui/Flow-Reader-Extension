import { webcrypto } from 'node:crypto'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { hashCanonicalJson } from '../src/canonical-json'
import {
  analyzeWideTableOverflow,
  applyContainOverflowPlan,
  CONTAIN_OVERFLOW_OPERATION_VALIDATORS,
  restoreGeometryPresentationLayer,
  validateContainedOverflowPlan,
} from '../src/presentation-geometry'
import { createPresentationHealthMap } from '../src/presentation-health'
import {
  createPresentationPlan,
  PRESENTATION_PLAN_SCHEMA_VERSION,
} from '../src/presentation-plan'

import { installVisibleLayout, parseXML } from './helpers'

const markup = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Wide table</title></head>
<body><p>Before.</p><table id="wide"><tbody><tr><th>A</th><th>B</th></tr>
<tr><td>One</td><td>Two</td></tr></tbody></table><p>After.</p></body></html>`

function documents(): {
  source: Document
  rendered: Document
  table: Element
  iframe: HTMLIFrameElement
} {
  const source = parseXML(markup, 'application/xhtml+xml')
  const iframe = document.createElement('iframe')
  document.body.appendChild(iframe)
  const rendered = iframe.contentDocument!
  rendered.documentElement.innerHTML = source.documentElement.innerHTML
  installVisibleLayout(rendered)
  const table = rendered.querySelector('#wide')!
  Object.defineProperty(table, 'scrollWidth', {
    configurable: true,
    value: 720,
  })
  vi.spyOn(table, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 40,
    width: 720,
    height: 120,
    top: 40,
    right: 720,
    bottom: 160,
    left: 0,
    toJSON: () => ({}),
  })
  return { source, rendered, table, iframe }
}

async function analysisAndPlan() {
  const { source, rendered, table, iframe } = documents()
  const analysis = await analyzeWideTableOverflow({
    sourceDocument: source,
    renderedDocument: rendered,
    spineIndex: 2,
    pageInlineSize: 400,
    pageBlockSize: 600,
    layout: 'reflowable',
    flow: 'paginated',
    axis: 'horizontal',
    writingMode: 'horizontal-tb',
  })
  const plan = (await createPresentationPlan(
    {
      schemaVersion: PRESENTATION_PLAN_SCHEMA_VERSION,
      engineVersion: 'test-phase5',
      mode: 'adaptive',
      publicationRevision: 'wide-table-v1',
      analysisFingerprint: 'wide-table-analyzer-v1',
      renderingContextFingerprint: '400x600-paginated',
      findings: analysis.findings,
      patches: analysis.patches,
    },
    CONTAIN_OVERFLOW_OPERATION_VALIDATORS,
  ))!
  return { source, rendered, table, iframe, analysis, plan }
}

describe('wide-table geometry vertical slice', () => {
  beforeAll(() => vi.stubGlobal('crypto', webcrypto as unknown as Crypto))
  afterAll(() => vi.unstubAllGlobals())

  it('diagnoses only proven overflow and changes the geometry hash', async () => {
    const { analysis, plan, iframe } = await analysisAndPlan()
    const emptyHash = await hashCanonicalJson([])

    expect(analysis.inspectedTables).toBe(1)
    expect(analysis.diagnostics).toEqual([])
    expect(analysis.findings).toHaveLength(1)
    expect(analysis.patches).toMatchObject([
      {
        operation: 'contain-overflow',
        effects: {
          paint: false,
          geometry: 'local',
          semantics: 'presentation-only',
        },
      },
    ])
    expect(plan.paintPlanHash).toBe(emptyHash)
    expect(plan.geometryPlanHash).not.toBe(emptyHash)
    iframe.remove()
  })

  it('wraps, validates, and restores without touching source markup', async () => {
    const { source, rendered, table, plan, iframe } = await analysisAndPlan()
    const sourceBefore = new XMLSerializer().serializeToString(source)
    const renderedBefore = new XMLSerializer().serializeToString(rendered)
    const originalParent = table.parentNode
    const layer = await applyContainOverflowPlan(plan, source, rendered, 2)
    const wrapper = layer.targets[0]!.wrapper
    Object.defineProperty(wrapper, 'clientWidth', {
      configurable: true,
      value: 400,
    })
    Object.defineProperty(wrapper, 'scrollWidth', {
      configurable: true,
      value: 720,
    })
    Object.defineProperty(wrapper, 'clientHeight', {
      configurable: true,
      value: 135,
    })
    Object.defineProperty(wrapper, 'scrollHeight', {
      configurable: true,
      value: 135,
    })

    expect(wrapper.getAttribute('tabindex')).toBe('0')
    expect(wrapper.firstElementChild).toBe(table)
    expect(layer.style.textContent).toContain('max-block-size: 600px')
    expect(validateContainedOverflowPlan(layer, true).input).toMatchObject({
      passed: true,
      geometryStable: true,
    })
    expect(new XMLSerializer().serializeToString(source)).toBe(sourceBefore)

    expect(restoreGeometryPresentationLayer(rendered)).toBe(true)

    expect(table.parentNode).toBe(originalParent)
    expect(rendered.querySelector('[data-lumen-overflow-wrapper]')).toBeNull()
    expect(new XMLSerializer().serializeToString(rendered)).toBe(renderedBefore)
    expect(restoreGeometryPresentationLayer(rendered)).toBe(false)
    iframe.remove()
  })

  it('rejects a wrapper whose scrollbar pushes it beyond the page block', async () => {
    const { source, rendered, plan, iframe } = await analysisAndPlan()
    const layer = await applyContainOverflowPlan(plan, source, rendered, 2)
    const wrapper = layer.targets[0]!.wrapper
    Object.defineProperties(wrapper, {
      clientWidth: { configurable: true, value: 400 },
      scrollWidth: { configurable: true, value: 720 },
      clientHeight: { configurable: true, value: 620 },
      scrollHeight: { configurable: true, value: 620 },
    })

    const validation = validateContainedOverflowPlan(layer, true)

    expect(validation.input.passed).toBe(false)
    expect(validation.input.failureReasons).toContainEqual(
      expect.objectContaining({ code: 'wide-table-not-contained' }),
    )
    iframe.remove()
  })

  it('preserves fixed, tall, and already-scrollable tables', async () => {
    const fixed = documents()
    const fixedAnalysis = await analyzeWideTableOverflow({
      sourceDocument: fixed.source,
      renderedDocument: fixed.rendered,
      spineIndex: 0,
      pageInlineSize: 400,
      pageBlockSize: 600,
      layout: 'pre-paginated',
      flow: 'paginated',
      axis: 'horizontal',
      writingMode: 'horizontal-tb',
    })

    const scrollable = documents()
    const wrapper = scrollable.rendered.createElement('div')
    wrapper.setAttribute('style', 'overflow-x: auto')
    scrollable.table.parentNode!.insertBefore(wrapper, scrollable.table)
    wrapper.appendChild(scrollable.table)
    const scrollableAnalysis = await analyzeWideTableOverflow({
      sourceDocument: scrollable.source,
      renderedDocument: scrollable.rendered,
      spineIndex: 0,
      pageInlineSize: 400,
      pageBlockSize: 600,
      layout: 'reflowable',
      flow: 'paginated',
      axis: 'horizontal',
      writingMode: 'horizontal-tb',
    })

    const tall = documents()
    vi.mocked(tall.table.getBoundingClientRect).mockReturnValue({
      x: 0,
      y: 0,
      width: 720,
      height: 800,
      top: 0,
      right: 720,
      bottom: 800,
      left: 0,
      toJSON: () => ({}),
    })
    const tallAnalysis = await analyzeWideTableOverflow({
      sourceDocument: tall.source,
      renderedDocument: tall.rendered,
      spineIndex: 0,
      pageInlineSize: 400,
      pageBlockSize: 600,
      layout: 'reflowable',
      flow: 'paginated',
      axis: 'horizontal',
      writingMode: 'horizontal-tb',
    })

    expect(fixedAnalysis.patches).toHaveLength(0)
    expect(scrollableAnalysis.patches).toHaveLength(0)
    expect(tallAnalysis.patches).toHaveLength(0)
    expect(tallAnalysis.diagnostics).toContain('table-exceeds-page-block-size')
    fixed.iframe.remove()
    scrollable.iframe.remove()
    tall.iframe.remove()
  })

  it('does not mistake root pagination overflow for an authored table scroller', async () => {
    const fixture = documents()
    fixture.rendered.body.style.overflowX = 'auto'

    const analysis = await analyzeWideTableOverflow({
      sourceDocument: fixture.source,
      renderedDocument: fixture.rendered,
      spineIndex: 0,
      pageInlineSize: 400,
      pageBlockSize: 600,
      layout: 'reflowable',
      flow: 'paginated',
      axis: 'horizontal',
      writingMode: 'horizontal-tb',
    })

    expect(analysis.patches).toHaveLength(1)
    expect(analysis.diagnostics).not.toContain(
      'unsafe-table-style-or-existing-scroller',
    )
    fixture.iframe.remove()
  })

  it('discovers a table beyond a truncated general health-map prefix', async () => {
    const prefix = Array.from(
      { length: 600 },
      (_, index) => `<div>Prefix ${index}</div>`,
    ).join('')
    const lateMarkup = `<?xml version="1.0" encoding="UTF-8"?>
      <html xmlns="http://www.w3.org/1999/xhtml"><head></head><body>
      ${prefix}<table id="late"><tbody><tr><td>A</td><td>B</td></tr></tbody></table>
      </body></html>`
    const source = parseXML(lateMarkup, 'application/xhtml+xml')
    const iframe = document.createElement('iframe')
    document.body.appendChild(iframe)
    const rendered = iframe.contentDocument!
    rendered.documentElement.innerHTML = source.documentElement.innerHTML
    installVisibleLayout(rendered)
    const table = rendered.querySelector('#late')!
    Object.defineProperty(table, 'scrollWidth', {
      configurable: true,
      value: 720,
    })
    vi.spyOn(table, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 40,
      width: 720,
      height: 120,
      top: 40,
      right: 720,
      bottom: 160,
      left: 0,
      toJSON: () => ({}),
    })
    const prefixHealth = createPresentationHealthMap({
      renderedDocument: rendered,
      spineIndex: 0,
      canvasColor: '#fff',
      maxInspectedElements: 512,
    })
    expect(prefixHealth.truncated).toBe(true)
    expect(
      prefixHealth.observations.some(
        (observation) => observation.element === table,
      ),
    ).toBe(false)

    const analysis = await analyzeWideTableOverflow({
      sourceDocument: source,
      renderedDocument: rendered,
      spineIndex: 0,
      pageInlineSize: 400,
      pageBlockSize: 600,
      layout: 'reflowable',
      flow: 'paginated',
      axis: 'horizontal',
      writingMode: 'horizontal-tb',
      healthMap: prefixHealth,
    })

    expect(analysis.inspectedTables).toBe(1)
    expect(analysis.patches).toHaveLength(1)
    expect(analysis.diagnostics).toContain('replaced-truncated-health-prefix')
    iframe.remove()
  })

  it('declares when focused table evidence exceeds its own ancestor budget', async () => {
    const nestedTable = `${'<div>'.repeat(
      96,
    )}<table id="deep"><tbody><tr><td>A</td><td>B</td></tr></tbody></table>${'</div>'.repeat(
      96,
    )}`
    const deepMarkup = `<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml"><head></head><body>${nestedTable}</body></html>`
    const source = parseXML(deepMarkup, 'application/xhtml+xml')
    const iframe = document.createElement('iframe')
    document.body.appendChild(iframe)
    const rendered = iframe.contentDocument!
    rendered.documentElement.innerHTML = source.documentElement.innerHTML
    installVisibleLayout(rendered)

    const analysis = await analyzeWideTableOverflow({
      sourceDocument: source,
      renderedDocument: rendered,
      spineIndex: 0,
      pageInlineSize: 400,
      pageBlockSize: 600,
      layout: 'reflowable',
      flow: 'paginated',
      axis: 'horizontal',
      writingMode: 'horizontal-tb',
      maxInspectedElements: 64,
    })

    expect(analysis.inspectedTables).toBe(0)
    expect(analysis.diagnostics).toContain('table-evidence-truncated')
    iframe.remove()
  })

  it('preserves floated, inline, and resource-unsettled tables', async () => {
    const analyze = (fixture: ReturnType<typeof documents>) =>
      analyzeWideTableOverflow({
        sourceDocument: fixture.source,
        renderedDocument: fixture.rendered,
        spineIndex: 0,
        pageInlineSize: 400,
        pageBlockSize: 600,
        layout: 'reflowable',
        flow: 'paginated',
        axis: 'horizontal',
        writingMode: 'horizontal-tb',
      })

    const floated = documents()
    ;(floated.table as HTMLElement).style.float = 'left'
    const inline = documents()
    ;(inline.table as HTMLElement).style.display = 'inline-table'
    const unsettled = documents()
    for (const target of [
      unsettled.source.querySelector('#wide')!,
      unsettled.table,
    ]) {
      target.appendChild(target.ownerDocument!.createElement('img'))
    }

    const [floatedAnalysis, inlineAnalysis, unsettledAnalysis] =
      await Promise.all([analyze(floated), analyze(inline), analyze(unsettled)])
    expect(floatedAnalysis.patches).toEqual([])
    expect(inlineAnalysis.patches).toEqual([])
    expect(unsettledAnalysis.patches).toEqual([])
    expect(unsettledAnalysis.diagnostics).toContain('table-resource-unsettled')
    floated.iframe.remove()
    inline.iframe.remove()
    unsettled.iframe.remove()
  })
})

import { webcrypto } from 'node:crypto'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import {
  analyzeListMarkerContrast,
  applyRestoreListMarkerPlan,
  RESTORE_LIST_MARKER_OPERATION_VALIDATORS,
} from '../src/presentation-list-marker'
import {
  createPresentationPlan,
  PRESENTATION_PLAN_SCHEMA_VERSION,
} from '../src/presentation-plan'

import { installVisibleLayout, parseXML } from './helpers'

describe('list marker contrast repair', () => {
  beforeAll(() => vi.stubGlobal('crypto', webcrypto as unknown as Crypto))
  afterAll(() => vi.unstubAllGlobals())

  it('repairs only the marker owner and restores the rendered DOM exactly', async () => {
    const markup = `<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml"><head><style>
      body { color:#dce4e8; background:transparent; }
      li { color:#000000; list-style-type:disc; }
      li > p { color:#dce4e8; }
    </style></head><body><ul><li id="item"><p>Readable prose whose default bullet remains dark.</p></li></ul></body></html>`
    const source = parseXML(markup, 'application/xhtml+xml')
    const iframe = document.createElement('iframe')
    document.body.appendChild(iframe)
    const rendered = iframe.contentDocument!
    rendered.documentElement.innerHTML = source.documentElement.innerHTML
    installVisibleLayout(rendered)

    const analysis = await analyzeListMarkerContrast({
      sourceDocument: source,
      renderedDocument: rendered,
      spineIndex: 12,
      canvasColor: '#111827',
    })
    expect(analysis.patches).toHaveLength(1)
    expect(analysis.patches[0]).toMatchObject({
      operation: 'restore-list-marker',
      target: { pseudo: 'marker' },
      effects: { paint: true, geometry: 'none', semantics: 'none' },
    })
    const plan = await createPresentationPlan(
      {
        schemaVersion: PRESENTATION_PLAN_SCHEMA_VERSION,
        engineVersion: 'list-marker-test',
        mode: 'adaptive',
        publicationRevision: 'fixture',
        analysisFingerprint: 'list-marker-v1',
        renderingContextFingerprint: 'dark',
        findings: analysis.findings,
        patches: analysis.patches,
      },
      RESTORE_LIST_MARKER_OPERATION_VALIDATORS,
    )
    expect(plan).toBeDefined()

    const layer = await applyRestoreListMarkerPlan(plan!, source, rendered, 12)
    const item = rendered.querySelector('#item')!
    expect(layer).toBeDefined()
    expect(item.hasAttribute('data-lumen-list-marker')).toBe(true)
    expect(layer!.style.textContent).toContain('::marker')
    expect(layer!.style.textContent).toContain('!important')

    layer!.restore()
    expect(item.hasAttribute('data-lumen-list-marker')).toBe(false)
    expect(
      rendered.querySelector(
        '[data-lumen-presentation-layer="list-marker-v1"]',
      ),
    ).toBeNull()
    iframe.remove()
  })

  it('does not claim a candidate for an image marker', async () => {
    const markup = `<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml"><head><style>
      body { background:transparent; }
      li { color:#000; list-style-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E"); }
      li > p { color:#fff; }
    </style></head><body><ul><li><p>Image markers remain authored media.</p></li></ul></body></html>`
    const source = parseXML(markup, 'application/xhtml+xml')
    const iframe = document.createElement('iframe')
    document.body.appendChild(iframe)
    const rendered = iframe.contentDocument!
    rendered.documentElement.innerHTML = source.documentElement.innerHTML
    installVisibleLayout(rendered)

    const analysis = await analyzeListMarkerContrast({
      sourceDocument: source,
      renderedDocument: rendered,
      spineIndex: 2,
      canvasColor: '#111827',
    })
    expect(analysis.inspectedMarkers).toBe(0)
    expect(analysis.patches).toEqual([])
    iframe.remove()
  })
})

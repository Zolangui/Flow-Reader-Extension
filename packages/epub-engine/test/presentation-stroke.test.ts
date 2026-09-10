import { webcrypto } from 'node:crypto'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import {
  createPresentationHealthMap,
  summarizePresentationLegibility,
} from '../src/presentation-health'
import {
  admitPresentationPlan,
  createPresentationPlan,
  createValidationRecord,
  PRESENTATION_PLAN_SCHEMA_VERSION,
} from '../src/presentation-plan'
import {
  analyzeStrokeContrast,
  applyRestoreVisibleStrokePlan,
  RESTORE_VISIBLE_STROKE_OPERATION_VALIDATORS,
  validateRestoredVisibleStrokes,
} from '../src/presentation-stroke'

import { installVisibleLayout, parseXML } from './helpers'

describe('visible stroke contrast repair', () => {
  beforeAll(() => vi.stubGlobal('crypto', webcrypto as unknown as Crypto))
  afterAll(() => vi.unstubAllGlobals())

  it('repairs form lines and table grids as one reversible paint decision', async () => {
    const markup = `<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml"><head><style>
      body { color:#dce4e8; background:transparent; }
      .worksheet-line { color:#000; border-bottom-style:solid; border-bottom-width:1px; height:1em; }
      table { border-collapse:collapse; }
      td { color:#000; border:1px solid currentColor; }
      td > p { color:#dce4e8; }
      .decorative { border:3px outset #000; }
    </style></head><body>
      <div class="worksheet-line"></div>
      <div class="worksheet-line"></div>
      <table><tbody><tr><td><p>Readable table text</p></td><td><p>More text</p></td></tr></tbody></table>
      <img class="decorative" alt="Authored bevel is not a flat semantic stroke" />
    </body></html>`
    const source = parseXML(markup, 'application/xhtml+xml')
    const iframe = document.createElement('iframe')
    document.body.appendChild(iframe)
    const rendered = iframe.contentDocument!
    rendered.documentElement.innerHTML = source.documentElement.innerHTML
    installVisibleLayout(rendered)
    const line = rendered.querySelector('.worksheet-line')!
    const cell = rendered.querySelector('td')!
    const prose = rendered.querySelector('td > p')!
    const view = rendered.defaultView!
    const lineBefore = view.getComputedStyle(line).borderBottomColor
    const cellBefore = view.getComputedStyle(cell).borderTopColor
    const proseBefore = view.getComputedStyle(prose).color
    const publishedLedger = summarizePresentationLegibility({
      healthMap: createPresentationHealthMap({
        renderedDocument: rendered,
        spineIndex: 26,
        canvasColor: '#24292e',
        maxInspectedElements: 8192,
      }),
    })
    expect(publishedLedger).toMatchObject({
      complete: false,
      visibleStrokeSides: 10,
      knownLowContrastStrokeSides: 10,
      provenReadableStrokeSides: 0,
      unknownStrokeSides: 0,
    })

    const analysis = await analyzeStrokeContrast({
      sourceDocument: source,
      renderedDocument: rendered,
      spineIndex: 26,
      canvasColor: '#24292e',
    })
    expect(analysis.patches).toHaveLength(1)
    expect(analysis.patches[0]).toMatchObject({
      operation: 'restore-visible-stroke',
      effects: { paint: true, geometry: 'none', semantics: 'none' },
      parameters: { observedSides: 10, minimumStrokeContrast: 3 },
    })

    const plan = await createPresentationPlan(
      {
        schemaVersion: PRESENTATION_PLAN_SCHEMA_VERSION,
        engineVersion: 'stroke-test',
        mode: 'adaptive',
        publicationRevision: 'fixture',
        analysisFingerprint: 'stroke-v1',
        renderingContextFingerprint: 'dark',
        findings: analysis.findings,
        patches: analysis.patches,
      },
      RESTORE_VISIBLE_STROKE_OPERATION_VALIDATORS,
    )
    expect(plan).toBeDefined()

    const layer = await applyRestoreVisibleStrokePlan(
      plan!,
      source,
      rendered,
      26,
    )
    expect(layer).toBeDefined()
    expect(view.getComputedStyle(line).borderBottomColor).not.toBe(lineBefore)
    expect(view.getComputedStyle(cell).borderTopColor).not.toBe(cellBefore)
    expect(view.getComputedStyle(prose).color).toBe(proseBefore)
    expect(
      summarizePresentationLegibility({
        healthMap: createPresentationHealthMap({
          renderedDocument: rendered,
          spineIndex: 26,
          canvasColor: '#24292e',
          maxInspectedElements: 8192,
        }),
      }),
    ).toMatchObject({
      visibleStrokeSides: 10,
      knownLowContrastStrokeSides: 0,
      provenReadableStrokeSides: 10,
      unknownStrokeSides: 0,
    })

    const validation = createValidationRecord(
      plan!,
      validateRestoredVisibleStrokes(layer!).input,
    )
    const admission = await admitPresentationPlan(plan!, validation, {
      engineVersion: 'stroke-test',
      publicationRevision: 'fixture',
      analysisFingerprint: 'stroke-v1',
      renderingContextFingerprint: 'dark',
      validators: RESTORE_VISIBLE_STROKE_OPERATION_VALIDATORS,
    })
    expect(admission.accepted).toBe(true)

    layer!.restore()
    expect(view.getComputedStyle(line).borderBottomColor).toBe(lineBefore)
    expect(view.getComputedStyle(cell).borderTopColor).toBe(cellBefore)
    expect(line.hasAttribute('style')).toBe(false)
    expect(cell.hasAttribute('style')).toBe(false)
    iframe.remove()
  })

  it('preserves transparent, absent, and three-dimensional decorative borders', async () => {
    const markup = `<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml"><head><style>
      body { color:#fff; background:transparent; }
      .transparent { border:1px solid transparent; }
      .absent { border-bottom:0 solid #000; }
      .bevel { border:3px outset #000; }
    </style></head><body><div class="transparent"></div><div class="absent"></div><div class="bevel"></div></body></html>`
    const source = parseXML(markup, 'application/xhtml+xml')
    const iframe = document.createElement('iframe')
    document.body.appendChild(iframe)
    const rendered = iframe.contentDocument!
    rendered.documentElement.innerHTML = source.documentElement.innerHTML
    installVisibleLayout(rendered)

    const analysis = await analyzeStrokeContrast({
      sourceDocument: source,
      renderedDocument: rendered,
      spineIndex: 1,
      canvasColor: '#24292e',
    })
    expect(analysis.patches).toEqual([])
    iframe.remove()
  })
})

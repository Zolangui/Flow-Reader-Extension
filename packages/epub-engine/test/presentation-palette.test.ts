import { webcrypto } from 'node:crypto'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import {
  analyzeOpaquePaletteForDarkTheme,
  applyRemapPalettePlan,
  REMAP_PALETTE_OPERATION_VALIDATORS,
  validateAppliedPalettePlan,
} from '../src/presentation-palette'
import {
  admitPresentationPlan,
  createPresentationPlan,
  createValidationRecord,
  PRESENTATION_PLAN_SCHEMA_VERSION,
} from '../src/presentation-plan'

import { getFixtureUrl, installVisibleLayout, parseXML } from './helpers'

async function fixtureDocuments(): Promise<{
  source: Document
  rendered: Document
  iframe: HTMLIFrameElement
}> {
  const markup = await fetch(
    getFixtureUrl('/presentation/pink-callout.xhtml'),
  ).then((response) => response.text())
  const source = parseXML(markup, 'application/xhtml+xml')
  const iframe = document.createElement('iframe')
  document.body.appendChild(iframe)
  const rendered = iframe.contentDocument!
  rendered.documentElement.innerHTML = source.documentElement.innerHTML
  installVisibleLayout(rendered)
  return { source, rendered, iframe }
}

function planInput(
  analysis: Awaited<ReturnType<typeof analyzeOpaquePaletteForDarkTheme>>,
) {
  return {
    schemaVersion: PRESENTATION_PLAN_SCHEMA_VERSION,
    engineVersion: 'lpe-pink-fixture-v1',
    mode: 'adaptive' as const,
    publicationRevision: 'pink-fixture-sha256',
    analysisFingerprint: 'opaque-palette-v1',
    renderingContextFingerprint: 'dark-111827-v1',
    findings: analysis.findings,
    patches: analysis.patches,
  }
}

describe('opaque palette vertical slice', () => {
  beforeAll(() => vi.stubGlobal('crypto', webcrypto as unknown as Crypto))
  afterAll(() => vi.unstubAllGlobals())

  it('diagnoses, remaps, validates, admits, and restores the pink fixture', async () => {
    const { source, rendered, iframe } = await fixtureDocuments()
    const sourceBefore = new XMLSerializer().serializeToString(source)
    const callout = rendered.querySelector('.pink-callout')!
    const authoredInlineStyle = callout.getAttribute('style')
    const authored = rendered.defaultView!.getComputedStyle(callout)
    const authoredBackground = authored.backgroundColor
    const authoredText = authored.color

    const analysis = await analyzeOpaquePaletteForDarkTheme({
      sourceDocument: source,
      renderedDocument: rendered,
      spineIndex: 2,
      canvasColor: '#111827',
    })
    expect(analysis.findings).toHaveLength(1)
    expect(analysis.patches).toHaveLength(1)
    const plan = (await createPresentationPlan(
      planInput(analysis),
      REMAP_PALETTE_OPERATION_VALIDATORS,
    ))!
    const published = (await createPresentationPlan({
      ...planInput({ findings: [], patches: [], inspectedElements: 0 }),
      mode: 'published',
    }))!

    expect(plan.geometryPlanHash).toBe(published.geometryPlanHash)
    expect(plan.paintPlanHash).not.toBe(published.paintPlanHash)

    const layer = await applyRemapPalettePlan(plan, source, rendered, 2)
    const idempotent = await applyRemapPalettePlan(plan, source, rendered, 2)
    expect(idempotent).toBe(layer)
    const adapted = rendered.defaultView!.getComputedStyle(callout)
    expect(adapted.backgroundColor).not.toBe(authoredBackground)
    expect(adapted.color).not.toBe(authoredText)
    expect(
      (callout as HTMLElement).style.getPropertyPriority('background-color'),
    ).toBe('important')

    const checked = validateAppliedPalettePlan(layer)
    const validation = createValidationRecord(plan, checked.input)
    const admission = await admitPresentationPlan(plan, validation, {
      engineVersion: plan.engineVersion,
      publicationRevision: plan.publicationRevision,
      analysisFingerprint: plan.analysisFingerprint,
      renderingContextFingerprint: plan.renderingContextFingerprint,
      validators: REMAP_PALETTE_OPERATION_VALIDATORS,
    })
    expect(admission.accepted).toBe(true)
    expect(validation.geometryStable).toBe(true)

    layer.restore()
    expect(callout.getAttribute('style')).toBe(authoredInlineStyle)
    const restored = rendered.defaultView!.getComputedStyle(callout)
    expect(restored.backgroundColor).toBe(authoredBackground)
    expect(restored.color).toBe(authoredText)
    expect(callout.hasAttribute('data-lumen-presentation-target')).toBe(false)
    expect(rendered.querySelector('[data-lumen-presentation-layer]')).toBeNull()
    expect(new XMLSerializer().serializeToString(source)).toBe(sourceBefore)
    iframe.remove()
  })

  it('fails closed when the source signature becomes stale', async () => {
    const { source, rendered, iframe } = await fixtureDocuments()
    const analysis = await analyzeOpaquePaletteForDarkTheme({
      sourceDocument: source,
      renderedDocument: rendered,
      spineIndex: 0,
      canvasColor: '#111827',
    })
    const plan = (await createPresentationPlan(
      planInput(analysis),
      REMAP_PALETTE_OPERATION_VALIDATORS,
    ))!
    source.querySelector('.pink-callout')!.setAttribute('title', 'changed')

    await expect(
      applyRemapPalettePlan(plan, source, rendered, 0),
    ).rejects.toThrow(/signature is stale/)
    expect(rendered.querySelector('[data-lumen-presentation-layer]')).toBeNull()
    iframe.remove()
  })

  it('refuses a palette patch whose declared effects are inconsistent', async () => {
    const { source, rendered, iframe } = await fixtureDocuments()
    const analysis = await analyzeOpaquePaletteForDarkTheme({
      sourceDocument: source,
      renderedDocument: rendered,
      spineIndex: 0,
      canvasColor: '#111827',
    })
    const plan = (await createPresentationPlan(
      planInput(analysis),
      REMAP_PALETTE_OPERATION_VALIDATORS,
    ))!
    const corrupt = {
      ...plan,
      patches: plan.patches.map((patch, index) =>
        index === 0
          ? { ...patch, effects: { ...patch.effects, paint: false } }
          : patch,
      ),
    }

    await expect(
      applyRemapPalettePlan(corrupt, source, rendered, 0),
    ).rejects.toThrow(/unsupported palette operation/)
    expect(rendered.querySelector('[data-lumen-presentation-layer]')).toBeNull()
    iframe.remove()
  })

  it('does not let a stale layer rollback a newer repair', async () => {
    const { source, rendered, iframe } = await fixtureDocuments()
    const analysis = await analyzeOpaquePaletteForDarkTheme({
      sourceDocument: source,
      renderedDocument: rendered,
      spineIndex: 2,
      canvasColor: '#111827',
    })
    const firstPlan = (await createPresentationPlan(
      planInput(analysis),
      REMAP_PALETTE_OPERATION_VALIDATORS,
    ))!
    const secondPlan = (await createPresentationPlan(
      {
        ...planInput(analysis),
        renderingContextFingerprint: 'dark-111827-v2',
      },
      REMAP_PALETTE_OPERATION_VALIDATORS,
    ))!
    const first = await applyRemapPalettePlan(firstPlan, source, rendered, 2)
    const second = await applyRemapPalettePlan(secondPlan, source, rendered, 2)

    first.restore()

    expect(
      rendered.querySelector('[data-lumen-presentation-target]'),
    ).not.toBeNull()
    expect(
      rendered.querySelector('[data-lumen-presentation-layer]'),
    ).not.toBeNull()
    second.restore()
    expect(rendered.querySelector('[data-lumen-presentation-layer]')).toBeNull()
    iframe.remove()
  })

  it('preserves ambiguous gradient and descendant-only paint', async () => {
    const { source, rendered, iframe } = await fixtureDocuments()
    const callout = rendered.querySelector('.pink-callout') as HTMLElement
    callout.style.backgroundImage = 'linear-gradient(#f5d6e2, #ffffff)'
    const sourceCallout = source.querySelector('.pink-callout')!
    sourceCallout.textContent = ''
    sourceCallout.appendChild(
      source.createElementNS(sourceCallout.namespaceURI, 'span'),
    )
    rendered.querySelector('.pink-callout')!.textContent = ''
    rendered
      .querySelector('.pink-callout')!
      .appendChild(rendered.createElement('span')).textContent = 'nested only'

    const analysis = await analyzeOpaquePaletteForDarkTheme({
      sourceDocument: source,
      renderedDocument: rendered,
      spineIndex: 0,
      canvasColor: '#111827',
    })
    expect(analysis.patches).toEqual([])
    iframe.remove()
  })

  it('rejects a remap when final paint becomes composited', async () => {
    const { source, rendered, iframe } = await fixtureDocuments()
    const analysis = await analyzeOpaquePaletteForDarkTheme({
      sourceDocument: source,
      renderedDocument: rendered,
      spineIndex: 0,
      canvasColor: '#111827',
    })
    const plan = (await createPresentationPlan(
      planInput(analysis),
      REMAP_PALETTE_OPERATION_VALIDATORS,
    ))!
    const layer = await applyRemapPalettePlan(plan, source, rendered, 0)
    ;(rendered.querySelector('.pink-callout') as HTMLElement).style.setProperty(
      'background-image',
      'linear-gradient(#fff, #ddd)',
      'important',
    )

    const checked = validateAppliedPalettePlan(layer)
    expect(checked.input.passed).toBe(false)
    expect(checked.input.probes[0]?.metrics.paintKnown).toBe(false)
    layer.restore()
    iframe.remove()
  })

  it('rejects a remap that makes inherited descendant text unreadable', async () => {
    const markup = `<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml"><head><style>
      .callout { color: #171717; background-color: #f2b7cf; }
      .nested { background-color: #ffffff; }
    </style></head><body>
      <div class="callout">Direct callout prose remains long enough to produce a palette repair candidate.
        <span class="nested">This nested text inherits the parent foreground but paints it over an independent light surface.</span>
      </div>
    </body></html>`
    const source = parseXML(markup, 'application/xhtml+xml')
    const iframe = document.createElement('iframe')
    document.body.appendChild(iframe)
    const rendered = iframe.contentDocument!
    rendered.documentElement.innerHTML = source.documentElement.innerHTML
    installVisibleLayout(rendered)
    const analysis = await analyzeOpaquePaletteForDarkTheme({
      sourceDocument: source,
      renderedDocument: rendered,
      spineIndex: 0,
      canvasColor: '#111827',
    })
    expect(analysis.patches).toHaveLength(1)
    const plan = (await createPresentationPlan(
      planInput(analysis),
      REMAP_PALETTE_OPERATION_VALIDATORS,
    ))!
    const layer = await applyRemapPalettePlan(plan, source, rendered, 0)

    const checked = validateAppliedPalettePlan(layer)
    expect(checked.input.passed).toBe(false)
    expect(checked.input.probes[0]?.metrics).toMatchObject({
      descendantSamples: 1,
      descendantPaintPreserved: false,
    })
    expect(checked.input.failureReasons[0]?.code).toBe(
      'opaque-palette-descendant-paint-changed',
    )
    layer.restore()
    iframe.remove()
  })
})

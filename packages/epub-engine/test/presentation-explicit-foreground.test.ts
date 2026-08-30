import { webcrypto } from 'node:crypto'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import {
  analyzeExplicitForegroundContrast,
  analyzeExplicitForegroundForDarkTheme,
  applyRestoreExplicitTextPlan,
  RESTORE_EXPLICIT_TEXT_OPERATION_VALIDATORS,
  validateRestoredExplicitText,
} from '../src/presentation-explicit-foreground'
import {
  admitPresentationPlan,
  createPresentationPlan,
  createValidationRecord,
  PRESENTATION_PLAN_SCHEMA_VERSION,
} from '../src/presentation-plan'

import { installVisibleLayout, parseXML } from './helpers'

describe('explicit foreground repair', () => {
  beforeAll(() => vi.stubGlobal('crypto', webcrypto as unknown as Crypto))
  afterAll(() => vi.unstubAllGlobals())

  it('repairs local gray prose and preserves a chromatic accent exactly', async () => {
    const markup = `<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml"><head><style>
      body { color: #bfc8ca; background: transparent; }
      .gray { color: rgb(55, 55, 55); }
      .accent { color: rgb(255, 0, 130); }
    </style></head><body>
      <p class="gray">This deliberately long gray paragraph represents explicit publication prose that disappears on a dark reader canvas.</p>
      <p class="accent">This long pink accent remains authored and must never be neutralized by the local repair operation.</p>
    </body></html>`
    const source = parseXML(markup, 'application/xhtml+xml')
    const iframe = document.createElement('iframe')
    document.body.appendChild(iframe)
    const rendered = iframe.contentDocument!
    rendered.documentElement.innerHTML = source.documentElement.innerHTML
    installVisibleLayout(rendered)
    const accent = rendered.querySelector('.accent')!
    const accentBefore = rendered.defaultView!.getComputedStyle(accent).color

    const analysis = await analyzeExplicitForegroundForDarkTheme({
      sourceDocument: source,
      renderedDocument: rendered,
      spineIndex: 0,
      canvasColor: '#111827',
    })
    expect(analysis.patches).toHaveLength(1)
    expect(analysis.patches[0]!.operation).toBe('restore-explicit-text')
    const plan = await createPresentationPlan(
      {
        schemaVersion: PRESENTATION_PLAN_SCHEMA_VERSION,
        engineVersion: 'test',
        mode: 'adaptive',
        publicationRevision: 'fixture',
        analysisFingerprint: 'explicit-v1',
        renderingContextFingerprint: 'dark',
        findings: analysis.findings,
        patches: analysis.patches,
      },
      RESTORE_EXPLICIT_TEXT_OPERATION_VALIDATORS,
    )
    expect(plan).toBeDefined()
    const layer = await applyRestoreExplicitTextPlan(plan!, source, rendered, 0)
    expect(layer).toBeDefined()
    const validation = createValidationRecord(
      plan!,
      validateRestoredExplicitText(layer!).input,
    )
    const admission = await admitPresentationPlan(plan!, validation, {
      engineVersion: 'test',
      publicationRevision: 'fixture',
      analysisFingerprint: 'explicit-v1',
      renderingContextFingerprint: 'dark',
      validators: RESTORE_EXPLICIT_TEXT_OPERATION_VALIDATORS,
    })
    expect(admission.accepted).toBe(true)
    expect(rendered.defaultView!.getComputedStyle(accent).color).toBe(
      accentBefore,
    )
    layer!.restore()
    expect(rendered.defaultView!.getComputedStyle(accent).color).toBe(
      accentBefore,
    )
    iframe.remove()
  })

  it('outranks a more-specific host link rule that also uses important', async () => {
    const markup = `<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml"><head><style>
      body { color: #000000; background: transparent; }
    </style></head><body>
      <p>Substantial black publication prose must remain repairable together with <a href="#chapter-1">Capítulo 1</a>.</p>
      <p>More black prose makes this reproduce a normal reflowable chapter rather than a synthetic isolated label.</p>
    </body></html>`
    const source = parseXML(markup, 'application/xhtml+xml')
    const iframe = document.createElement('iframe')
    document.body.appendChild(iframe)
    const rendered = iframe.contentDocument!
    rendered.documentElement.innerHTML = source.documentElement.innerHTML
    const hostStyle = rendered.createElement('style')
    hostStyle.textContent = 'a:any-link { color: #3b82f6 !important; }'
    rendered.head.appendChild(hostStyle)
    installVisibleLayout(rendered)
    const link = rendered.querySelector('a')!
    const hostLinkColor = rendered.defaultView!.getComputedStyle(link).color

    const analysis = await analyzeExplicitForegroundContrast({
      sourceDocument: source,
      renderedDocument: rendered,
      spineIndex: 6,
      canvasColor: '#24292e',
    })
    expect(analysis.patches.length).toBeGreaterThanOrEqual(2)
    const plan = await createPresentationPlan(
      {
        schemaVersion: PRESENTATION_PLAN_SCHEMA_VERSION,
        engineVersion: 'specificity-test',
        mode: 'adaptive',
        publicationRevision: 'specificity-fixture',
        analysisFingerprint: 'explicit-specificity-v1',
        renderingContextFingerprint: 'dark-24292e',
        findings: analysis.findings,
        patches: analysis.patches,
      },
      RESTORE_EXPLICIT_TEXT_OPERATION_VALIDATORS,
    )
    const layer = await applyRestoreExplicitTextPlan(
      plan!,
      source,
      rendered,
      6,
    )

    expect(rendered.defaultView!.getComputedStyle(link).color).not.toBe(
      hostLinkColor,
    )
    expect((link as HTMLElement).style.getPropertyPriority('color')).toBe(
      'important',
    )
    expect(validateRestoredExplicitText(layer!).input.passed).toBe(true)

    layer!.restore()
    expect(rendered.defaultView!.getComputedStyle(link).color).toBe(
      hostLinkColor,
    )
    expect(link.hasAttribute('style')).toBe(false)
    iframe.remove()
  })

  it('coalesces distributed links with identical proven paint into one candidate', async () => {
    const entries = Array.from(
      { length: 40 },
      (_, index) =>
        `<p>Index entry ${index} points to <a href="#chapter-${index}">Capítulo ${index}</a> and keeps substantial surrounding prose.</p>`,
    ).join('')
    const markup = `<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml"><head><style>body { color:#000; background:transparent; }</style></head><body>${entries}</body></html>`
    const source = parseXML(markup, 'application/xhtml+xml')
    const iframe = document.createElement('iframe')
    document.body.appendChild(iframe)
    const rendered = iframe.contentDocument!
    rendered.documentElement.innerHTML = source.documentElement.innerHTML
    const hostStyle = rendered.createElement('style')
    hostStyle.textContent = 'a:any-link { color:#3b82f6 !important; }'
    rendered.head.appendChild(hostStyle)
    installVisibleLayout(rendered)

    const analysis = await analyzeExplicitForegroundContrast({
      sourceDocument: source,
      renderedDocument: rendered,
      spineIndex: 27,
      canvasColor: '#24292e',
      maxCandidates: 2,
    })
    expect(analysis.candidateGroups).toBe(2)
    expect(analysis.patches).toHaveLength(2)
    expect(analysis.truncatedGroups).toBe(0)
    const plan = await createPresentationPlan(
      {
        schemaVersion: PRESENTATION_PLAN_SCHEMA_VERSION,
        engineVersion: 'distributed-link-test',
        mode: 'adaptive',
        publicationRevision: 'distributed-link-fixture',
        analysisFingerprint: 'explicit-v9',
        renderingContextFingerprint: 'dark-24292e',
        findings: analysis.findings,
        patches: analysis.patches,
      },
      RESTORE_EXPLICIT_TEXT_OPERATION_VALIDATORS,
    )
    const layer = await applyRestoreExplicitTextPlan(
      plan!,
      source,
      rendered,
      27,
    )

    expect(validateRestoredExplicitText(layer!).input.passed).toBe(true)
    layer!.restore()
    iframe.remove()
  })

  it('lightens low-contrast chromatic prose while preserving its hue', async () => {
    const markup = `<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml"><head><style>
      body { background: transparent; }
      .publisher-copy { color: #3b3f66; }
    </style></head><body>
      <p class="publisher-copy">A deliberately substantial publisher message uses a dark purple foreground that is readable on paper but disappears against a dark reader canvas.</p>
    </body></html>`
    const source = parseXML(markup, 'application/xhtml+xml')
    const iframe = document.createElement('iframe')
    document.body.appendChild(iframe)
    const rendered = iframe.contentDocument!
    rendered.documentElement.innerHTML = source.documentElement.innerHTML
    installVisibleLayout(rendered)
    const view = rendered.defaultView!
    const prose = rendered.querySelector('.publisher-copy')!
    const before = view.getComputedStyle(prose).color

    const analysis = await analyzeExplicitForegroundForDarkTheme({
      sourceDocument: source,
      renderedDocument: rendered,
      spineIndex: 1,
      canvasColor: '#24292e',
    })

    expect(analysis.patches).toHaveLength(1)
    expect(analysis.findings[0]!.kind).toBe(
      'explicit-text-with-insufficient-contrast',
    )
    const plan = await createPresentationPlan(
      {
        schemaVersion: PRESENTATION_PLAN_SCHEMA_VERSION,
        engineVersion: 'test',
        mode: 'adaptive',
        publicationRevision: 'chromatic-fixture',
        analysisFingerprint: 'explicit-chromatic-v1',
        renderingContextFingerprint: 'dark',
        findings: analysis.findings,
        patches: analysis.patches,
      },
      RESTORE_EXPLICIT_TEXT_OPERATION_VALIDATORS,
    )
    const layer = await applyRestoreExplicitTextPlan(plan!, source, rendered, 1)

    expect(view.getComputedStyle(prose).color).not.toBe(before)
    expect(validateRestoredExplicitText(layer!).input.passed).toBe(true)
    layer!.restore()
    expect(view.getComputedStyle(prose).color).toBe(before)
    iframe.remove()
  })

  it('darkens proven light-on-light text without flattening its hue', async () => {
    const markup = `<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml"><head><style>
      body { background: transparent; }
      .pale { color: #f1e9ff; }
    </style></head><body>
      <p class="pale">This pale violet publication text disappears against a light reader canvas and requires a scheme-neutral contrast repair.</p>
    </body></html>`
    const source = parseXML(markup, 'application/xhtml+xml')
    const iframe = document.createElement('iframe')
    document.body.appendChild(iframe)
    const rendered = iframe.contentDocument!
    rendered.documentElement.innerHTML = source.documentElement.innerHTML
    installVisibleLayout(rendered)
    const view = rendered.defaultView!
    const prose = rendered.querySelector('.pale')!
    const before = view.getComputedStyle(prose).color

    const analysis = await analyzeExplicitForegroundContrast({
      sourceDocument: source,
      renderedDocument: rendered,
      spineIndex: 8,
      canvasColor: '#ffffff',
    })
    expect(analysis.patches).toHaveLength(1)
    const plan = await createPresentationPlan(
      {
        schemaVersion: PRESENTATION_PLAN_SCHEMA_VERSION,
        engineVersion: 'test',
        mode: 'adaptive',
        publicationRevision: 'light-fixture',
        analysisFingerprint: 'explicit-light-v1',
        renderingContextFingerprint: 'light',
        findings: analysis.findings,
        patches: analysis.patches,
      },
      RESTORE_EXPLICIT_TEXT_OPERATION_VALIDATORS,
    )
    const layer = await applyRestoreExplicitTextPlan(plan!, source, rendered, 8)

    expect(view.getComputedStyle(prose).color).not.toBe(before)
    expect(validateRestoredExplicitText(layer!).input.passed).toBe(true)
    layer!.restore()
    expect(view.getComputedStyle(prose).color).toBe(before)
    iframe.remove()
  })

  it('repairs prose and a saturated accent only when each is unreadable', async () => {
    const markup = `<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml"><head><style>
      body { color: #bfc8ca; background: transparent; }
      .intro { color: rgb(40, 40, 40); }
      .accent { color: rgb(236, 0, 140); }
    </style></head><body>
      <section class="intro">
        <p><em>This long nested introduction reproduces EPUB chapters where a container owns the dark color while the actual prose lives entirely inside an italic child.</em></p>
        <p class="accent">This pink authored accent keeps its identity while becoming readable.</p>
      </section>
    </body></html>`
    const source = parseXML(markup, 'application/xhtml+xml')
    const iframe = document.createElement('iframe')
    document.body.appendChild(iframe)
    const rendered = iframe.contentDocument!
    rendered.documentElement.innerHTML = source.documentElement.innerHTML
    installVisibleLayout(rendered)
    const view = rendered.defaultView!
    const prose = rendered.querySelector('em')!
    const accent = rendered.querySelector('.accent')!
    const proseBefore = view.getComputedStyle(prose).color
    const accentBefore = view.getComputedStyle(accent).color

    const analysis = await analyzeExplicitForegroundForDarkTheme({
      sourceDocument: source,
      renderedDocument: rendered,
      spineIndex: 3,
      canvasColor: '#111827',
    })
    expect(analysis.patches).toHaveLength(2)
    expect(analysis.patches[0]!.target.source.sourcePath).toEqual([1])
    const plan = await createPresentationPlan(
      {
        schemaVersion: PRESENTATION_PLAN_SCHEMA_VERSION,
        engineVersion: 'test',
        mode: 'adaptive',
        publicationRevision: 'nested-fixture',
        analysisFingerprint: 'explicit-v2',
        renderingContextFingerprint: 'dark',
        findings: analysis.findings,
        patches: analysis.patches,
      },
      RESTORE_EXPLICIT_TEXT_OPERATION_VALIDATORS,
    )
    const layer = await applyRestoreExplicitTextPlan(plan!, source, rendered, 3)

    expect(view.getComputedStyle(prose).color).not.toBe(proseBefore)
    expect(view.getComputedStyle(accent).color).not.toBe(accentBefore)
    expect(validateRestoredExplicitText(layer!).input.passed).toBe(true)
    layer!.restore()
    expect(view.getComputedStyle(prose).color).toBe(proseBefore)
    expect(view.getComputedStyle(accent).color).toBe(accentBefore)
    iframe.remove()
  })

  it('repairs repeated body color and a separate unreadable saturated accent', async () => {
    const markup = `<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml"><head><style>
      body { color: rgb(20, 20, 20); background: transparent; }
      .intro, .intro em { color: rgb(20, 20, 20); }
      .accent { color: rgb(236, 0, 140); }
    </style></head><body>
      <h2 class="accent">Sereia</h2>
      <p class="intro"><em>This long italic introduction repeats the body foreground explicitly, so changing only the inherited body color cannot make it readable.</em></p>
    </body></html>`
    const source = parseXML(markup, 'application/xhtml+xml')
    const iframe = document.createElement('iframe')
    document.body.appendChild(iframe)
    const rendered = iframe.contentDocument!
    rendered.documentElement.innerHTML = source.documentElement.innerHTML
    installVisibleLayout(rendered)
    const view = rendered.defaultView!
    const prose = rendered.querySelector('em')!
    const accent = rendered.querySelector('.accent')!
    const proseBefore = view.getComputedStyle(prose).color
    const accentBefore = view.getComputedStyle(accent).color

    const analysis = await analyzeExplicitForegroundForDarkTheme({
      sourceDocument: source,
      renderedDocument: rendered,
      spineIndex: 4,
      canvasColor: '#111827',
    })

    expect(analysis.patches).toHaveLength(2)
    expect(
      analysis.patches.some(
        (patch) => patch.target.source.sourcePath.length === 0,
      ),
    ).toBe(true)
    const plan = await createPresentationPlan(
      {
        schemaVersion: PRESENTATION_PLAN_SCHEMA_VERSION,
        engineVersion: 'test',
        mode: 'adaptive',
        publicationRevision: 'repeated-body-color-fixture',
        analysisFingerprint: 'explicit-v3',
        renderingContextFingerprint: 'dark',
        findings: analysis.findings,
        patches: analysis.patches,
      },
      RESTORE_EXPLICIT_TEXT_OPERATION_VALIDATORS,
    )
    const layer = await applyRestoreExplicitTextPlan(plan!, source, rendered, 4)

    expect(view.getComputedStyle(prose).color).not.toBe(proseBefore)
    expect(view.getComputedStyle(accent).color).not.toBe(accentBefore)
    expect(validateRestoredExplicitText(layer!).input.passed).toBe(true)
    layer!.restore()
    expect(view.getComputedStyle(prose).color).toBe(proseBefore)
    expect(view.getComputedStyle(accent).color).toBe(accentBefore)
    iframe.remove()
  })

  it('keeps root text and matching explicit descendants in the same proof', async () => {
    const markup = `<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml"><head><style>
      body { color: rgb(20, 20, 20); background: transparent; }
      em { color: rgb(20, 20, 20); }
    </style></head><body>
      This deliberately long root-level introduction is authored directly in the body and must remain part of the repair proof.
      <p><em>This equally substantial descendant repeats the same explicit foreground and must be repaired with the root text.</em></p>
    </body></html>`
    const source = parseXML(markup, 'application/xhtml+xml')
    const iframe = document.createElement('iframe')
    document.body.appendChild(iframe)
    const rendered = iframe.contentDocument!
    rendered.documentElement.innerHTML = source.documentElement.innerHTML
    installVisibleLayout(rendered)

    const analysis = await analyzeExplicitForegroundForDarkTheme({
      sourceDocument: source,
      renderedDocument: rendered,
      spineIndex: 5,
      canvasColor: '#111827',
    })
    expect(analysis.patches).toHaveLength(1)
    expect(analysis.patches[0]!.target.source.sourcePath).toEqual([])

    const plan = await createPresentationPlan(
      {
        schemaVersion: PRESENTATION_PLAN_SCHEMA_VERSION,
        engineVersion: 'test',
        mode: 'adaptive',
        publicationRevision: 'root-text-fixture',
        analysisFingerprint: 'explicit-root-v1',
        renderingContextFingerprint: 'dark',
        findings: analysis.findings,
        patches: analysis.patches,
      },
      RESTORE_EXPLICIT_TEXT_OPERATION_VALIDATORS,
    )
    const layer = await applyRestoreExplicitTextPlan(plan!, source, rendered, 5)

    expect(layer!.targets[0]!.samples).toHaveLength(2)
    expect(validateRestoredExplicitText(layer!).input.passed).toBe(true)
    layer!.restore()
    iframe.remove()
  })

  it('declares explicit color groups that exceed the candidate budget', async () => {
    const paragraphs = Array.from(
      { length: 20 },
      (_, index) =>
        `<p style="color:rgb(${20 + index},${20 + index},${
          20 + index
        })">Distinct low-contrast group ${index} contains enough authored text to require an explicit repair.</p>`,
    ).join('')
    const markup = `<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml"><head></head><body>${paragraphs}</body></html>`
    const source = parseXML(markup, 'application/xhtml+xml')
    const iframe = document.createElement('iframe')
    document.body.appendChild(iframe)
    const rendered = iframe.contentDocument!
    rendered.documentElement.innerHTML = source.documentElement.innerHTML
    installVisibleLayout(rendered)

    const analysis = await analyzeExplicitForegroundContrast({
      sourceDocument: source,
      renderedDocument: rendered,
      spineIndex: 8,
      canvasColor: '#111827',
      maxCandidates: 16,
    })

    expect(analysis.candidateGroups).toBe(20)
    expect(analysis.patches).toHaveLength(16)
    expect(analysis.truncatedGroups).toBe(4)
    expect(analysis.diagnostics).toContain('explicit-groups-truncated')
    iframe.remove()
  })

  it('allocates one unpredictable marker base for all samples in a layer', async () => {
    const paragraphs = Array.from(
      { length: 40 },
      (_, index) =>
        `<p>Low-contrast sample ${index} belongs to the same authored color root and must be marked without rescanning the document.</p>`,
    ).join('')
    const markup = `<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml"><head><style>.group { color:rgb(20,20,20); }</style></head><body><section class="group">${paragraphs}</section></body></html>`
    const source = parseXML(markup, 'application/xhtml+xml')
    const iframe = document.createElement('iframe')
    document.body.appendChild(iframe)
    const rendered = iframe.contentDocument!
    rendered.documentElement.innerHTML = source.documentElement.innerHTML
    installVisibleLayout(rendered)
    const analysis = await analyzeExplicitForegroundContrast({
      sourceDocument: source,
      renderedDocument: rendered,
      spineIndex: 9,
      canvasColor: '#111827',
    })
    const plan = await createPresentationPlan(
      {
        schemaVersion: PRESENTATION_PLAN_SCHEMA_VERSION,
        engineVersion: 'marker-allocation-test',
        mode: 'adaptive',
        publicationRevision: 'marker-allocation-fixture',
        analysisFingerprint: 'explicit-v8',
        renderingContextFingerprint: 'dark',
        findings: analysis.findings,
        patches: analysis.patches,
      },
      RESTORE_EXPLICIT_TEXT_OPERATION_VALIDATORS,
    )
    const querySelector = vi.spyOn(rendered, 'querySelector')

    const layer = await applyRestoreExplicitTextPlan(plan!, source, rendered, 9)
    const markerLookups = querySelector.mock.calls.filter(([selector]) =>
      String(selector).startsWith('[data-lumen-explicit-text-target='),
    )

    expect(analysis.patches).toHaveLength(1)
    expect(markerLookups).toHaveLength(1)
    layer!.restore()
    iframe.remove()
  })

  it('rejects inherited color changes outside the proven explicit samples', async () => {
    const markup = `<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml"><head><style>
      body { background: transparent; }
      .intro { color: rgb(20, 20, 20); }
      .art { background-image: linear-gradient(#ffffff, #777777); }
    </style></head><body>
      <p class="intro">This direct paragraph text is intentionally long enough to produce a local explicit foreground repair.
        <span class="art">This nested text inherits that color over paint which cannot be reduced to one solid surface.</span>
      </p>
    </body></html>`
    const source = parseXML(markup, 'application/xhtml+xml')
    const iframe = document.createElement('iframe')
    document.body.appendChild(iframe)
    const rendered = iframe.contentDocument!
    rendered.documentElement.innerHTML = source.documentElement.innerHTML
    installVisibleLayout(rendered)
    const analysis = await analyzeExplicitForegroundForDarkTheme({
      sourceDocument: source,
      renderedDocument: rendered,
      spineIndex: 6,
      canvasColor: '#111827',
    })
    expect(analysis.patches).toHaveLength(1)
    const plan = await createPresentationPlan(
      {
        schemaVersion: PRESENTATION_PLAN_SCHEMA_VERSION,
        engineVersion: 'test',
        mode: 'adaptive',
        publicationRevision: 'explicit-collateral-fixture',
        analysisFingerprint: 'explicit-collateral-v1',
        renderingContextFingerprint: 'dark',
        findings: analysis.findings,
        patches: analysis.patches,
      },
      RESTORE_EXPLICIT_TEXT_OPERATION_VALIDATORS,
    )
    const layer = await applyRestoreExplicitTextPlan(plan!, source, rendered, 6)

    const validation = validateRestoredExplicitText(layer!).input
    expect(validation.passed).toBe(false)
    expect(validation.probes[0]?.metrics.collateralColorChanges).toBe(1)
    layer!.restore()
    iframe.remove()
  })

  it('refuses an explicit-text patch whose declared effects are inconsistent', async () => {
    const markup = `<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml"><head><style>
      .gray { color: rgb(35, 35, 35); }
    </style></head><body><p class="gray">This long explicit dark paragraph is sufficient evidence for a local foreground repair candidate.</p></body></html>`
    const source = parseXML(markup, 'application/xhtml+xml')
    const iframe = document.createElement('iframe')
    document.body.appendChild(iframe)
    const rendered = iframe.contentDocument!
    rendered.documentElement.innerHTML = source.documentElement.innerHTML
    installVisibleLayout(rendered)
    const analysis = await analyzeExplicitForegroundForDarkTheme({
      sourceDocument: source,
      renderedDocument: rendered,
      spineIndex: 7,
      canvasColor: '#111827',
    })
    const plan = (await createPresentationPlan(
      {
        schemaVersion: PRESENTATION_PLAN_SCHEMA_VERSION,
        engineVersion: 'explicit-effects-v1',
        mode: 'adaptive',
        publicationRevision: 'explicit-effects-fixture',
        analysisFingerprint: 'explicit-effects-analysis',
        renderingContextFingerprint: 'dark',
        findings: analysis.findings,
        patches: analysis.patches,
      },
      RESTORE_EXPLICIT_TEXT_OPERATION_VALIDATORS,
    ))!
    const corrupt = {
      ...plan,
      patches: plan.patches.map((patch, index) =>
        index === 0
          ? {
              ...patch,
              effects: { ...patch.effects, semantics: 'presentation-only' },
            }
          : patch,
      ),
    }

    await expect(
      applyRestoreExplicitTextPlan(corrupt, source, rendered, 7),
    ).rejects.toThrow(/Unsupported explicit-text operation/)
    expect(rendered.querySelector('[data-lumen-presentation-layer]')).toBeNull()
    iframe.remove()
  })
})

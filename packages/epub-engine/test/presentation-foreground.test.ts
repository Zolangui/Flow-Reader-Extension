import { webcrypto } from 'node:crypto'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import {
  analyzeInheritedForegroundForDarkTheme,
  applyRestoreVisibleTextPlan,
  RESTORE_VISIBLE_TEXT_OPERATION_VALIDATORS,
  validateRestoredVisibleText,
} from '../src/presentation-foreground'
import { MAX_PRESENTATION_HEALTH_ELEMENTS } from '../src/presentation-health'
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
    getFixtureUrl('/presentation/dark-inherited-text.xhtml'),
  ).then((response) => response.text())
  const source = parseXML(markup, 'application/xhtml+xml')
  const iframe = document.createElement('iframe')
  document.body.appendChild(iframe)
  const rendered = iframe.contentDocument!
  rendered.documentElement.innerHTML = source.documentElement.innerHTML
  installVisibleLayout(rendered)
  return { source, rendered, iframe }
}

describe('inherited foreground repair', () => {
  beforeAll(() => vi.stubGlobal('crypto', webcrypto as unknown as Crypto))
  afterAll(() => vi.unstubAllGlobals())

  it('does not admit a body-wide repair from a truncated chapter prefix', async () => {
    const paragraphs = Array.from(
      { length: 12 },
      (_, index) =>
        `<p>Long dark paragraph ${index} with enough prose to qualify as meaningful reading content.</p>`,
    ).join('')
    const markup = `<html xmlns="http://www.w3.org/1999/xhtml"><head><style>body{color:#111;background:transparent}</style></head><body>${paragraphs}</body></html>`
    const source = parseXML(markup, 'application/xhtml+xml')
    const iframe = document.createElement('iframe')
    document.body.appendChild(iframe)
    const rendered = iframe.contentDocument!
    rendered.documentElement.innerHTML = source.documentElement.innerHTML
    installVisibleLayout(rendered)
    const analysis = await analyzeInheritedForegroundForDarkTheme({
      sourceDocument: source,
      renderedDocument: rendered,
      spineIndex: 0,
      canvasColor: '#111827',
      maxInspectedElements: 4,
    })
    expect(analysis.patches).toEqual([])
    iframe.remove()
  })

  it('analyzes a complete index beyond the former 2,048-element ceiling', async () => {
    const entries = Array.from(
      { length: 700 },
      (_, index) =>
        `<div>Index term ${index}, <a href="#${index}">${index}</a>, <a href="#${index}">${
          index + 1
        }</a></div>`,
    ).join('')
    const markup = `<html xmlns="http://www.w3.org/1999/xhtml"><head><style>body{background:transparent}a{color:#4b9fff}</style></head><body>${entries}</body></html>`
    const source = parseXML(markup, 'application/xhtml+xml')
    const iframe = document.createElement('iframe')
    document.body.appendChild(iframe)
    const rendered = iframe.contentDocument!
    rendered.documentElement.innerHTML = source.documentElement.innerHTML
    installVisibleLayout(rendered)

    expect(rendered.querySelectorAll('*').length).toBeGreaterThan(2048)
    const analysis = await analyzeInheritedForegroundForDarkTheme({
      sourceDocument: source,
      renderedDocument: rendered,
      spineIndex: 27,
      canvasColor: '#111827',
      maxInspectedElements: MAX_PRESENTATION_HEALTH_ELEMENTS - 1,
    })

    expect(analysis.patches).toHaveLength(1)
    expect(analysis.patches[0]?.operation).toBe('restore-visible-text')
    expect(analysis.runtimeEvidence?.publishedHealth.truncated).toBe(false)
    expect(analysis.inspectedElements).toBeGreaterThan(2048)
    iframe.remove()
  }, 15_000)

  it('restores inherited prose while preserving an explicit accent', async () => {
    const { source, rendered, iframe } = await fixtureDocuments()
    const sourceBefore = new XMLSerializer().serializeToString(source)
    const view = rendered.defaultView!
    const prose = rendered.querySelector('p')!
    const accent = rendered.querySelector('.accent')!
    const publishedText = view.getComputedStyle(prose).color
    const publishedAccent = view.getComputedStyle(accent).color

    const analysis = await analyzeInheritedForegroundForDarkTheme({
      sourceDocument: source,
      renderedDocument: rendered,
      spineIndex: 4,
      canvasColor: '#24292e',
    })
    expect(analysis.patches).toHaveLength(1)
    expect(analysis.repairableSamples).toBeGreaterThanOrEqual(2)
    const plan = (await createPresentationPlan(
      {
        schemaVersion: PRESENTATION_PLAN_SCHEMA_VERSION,
        engineVersion: 'foreground-fixture-v1',
        mode: 'adaptive',
        publicationRevision: 'foreground-fixture-sha256',
        analysisFingerprint: 'foreground-analysis-v1',
        renderingContextFingerprint: 'dark-24292e-v1',
        findings: analysis.findings,
        patches: analysis.patches,
      },
      RESTORE_VISIBLE_TEXT_OPERATION_VALIDATORS,
    ))!

    const layer = (await applyRestoreVisibleTextPlan(
      plan,
      source,
      rendered,
      4,
    ))!
    expect(view.getComputedStyle(prose).color).not.toBe(publishedText)
    expect(view.getComputedStyle(accent).color).toBe(publishedAccent)
    expect(
      (layer.target as HTMLElement).style.getPropertyPriority('color'),
    ).toBe('important')
    expect(accent.getAttribute('style')).toBeNull()

    const checked = validateRestoredVisibleText(layer)
    const validation = createValidationRecord(plan, checked.input)
    const admission = await admitPresentationPlan(plan, validation, {
      engineVersion: plan.engineVersion,
      publicationRevision: plan.publicationRevision,
      analysisFingerprint: plan.analysisFingerprint,
      renderingContextFingerprint: plan.renderingContextFingerprint,
      validators: RESTORE_VISIBLE_TEXT_OPERATION_VALIDATORS,
    })
    expect(admission.accepted).toBe(true)
    expect(validation.geometryStable).toBe(true)

    layer.restore()
    expect(view.getComputedStyle(prose).color).toBe(publishedText)
    expect(view.getComputedStyle(accent).color).toBe(publishedAccent)
    expect((layer.target as HTMLElement).style.getPropertyValue('color')).toBe(
      '',
    )
    expect(new XMLSerializer().serializeToString(source)).toBe(sourceBefore)
    expect(rendered.querySelector('[data-lumen-presentation-layer]')).toBeNull()
    iframe.remove()
  })

  it('does not analyze a repair when the shared candidate budget is exhausted', async () => {
    const { source, rendered, iframe } = await fixtureDocuments()
    const analysis = await analyzeInheritedForegroundForDarkTheme({
      sourceDocument: source,
      renderedDocument: rendered,
      spineIndex: 4,
      canvasColor: '#24292e',
      maxCandidates: 0,
    })

    expect(analysis.patches).toEqual([])
    expect(analysis.findings).toEqual([])
    expect(analysis.inspectedElements).toBe(0)
    iframe.remove()
  })

  it('normalizes repair coverage to the plan contract minimum', async () => {
    const { source, rendered, iframe } = await fixtureDocuments()
    const analysis = await analyzeInheritedForegroundForDarkTheme({
      sourceDocument: source,
      renderedDocument: rendered,
      spineIndex: 4,
      canvasColor: '#24292e',
      minimumRepairCoverage: 0.2,
    })

    expect(analysis.patches).toHaveLength(1)
    expect(analysis.patches[0]?.parameters.minimumRepairCoverage).toBe(0.5)
    expect(
      await createPresentationPlan(
        {
          schemaVersion: PRESENTATION_PLAN_SCHEMA_VERSION,
          engineVersion: 'foreground-options-v1',
          mode: 'adaptive',
          publicationRevision: 'foreground-options-sha256',
          analysisFingerprint: 'foreground-options-analysis',
          renderingContextFingerprint: 'dark-24292e-v1',
          findings: analysis.findings,
          patches: analysis.patches,
        },
        RESTORE_VISIBLE_TEXT_OPERATION_VALIDATORS,
      ),
    ).toBeDefined()
    iframe.remove()
  })

  it('fails closed when a root color cannot repair explicit dark descendants', async () => {
    const { source, rendered, iframe } = await fixtureDocuments()
    source.querySelectorAll('p').forEach((element) => {
      element.setAttribute('style', 'color: #000000')
    })
    rendered.querySelectorAll('p').forEach((element) => {
      element.setAttribute('style', 'color: #000000')
    })

    const analysis = await analyzeInheritedForegroundForDarkTheme({
      sourceDocument: source,
      renderedDocument: rendered,
      spineIndex: 0,
      canvasColor: '#24292e',
    })
    expect(analysis.lowContrastSamples).toBeGreaterThanOrEqual(2)
    expect(analysis.patches).toEqual([])
    iframe.remove()
  })

  it('fails closed when even one explicit neutral prose block remains unreadable', async () => {
    const { source, rendered, iframe } = await fixtureDocuments()
    source
      .querySelector('p:last-of-type')
      ?.setAttribute('style', 'color: #000000')
    rendered
      .querySelector('p:last-of-type')
      ?.setAttribute('style', 'color: #000000')

    const analysis = await analyzeInheritedForegroundForDarkTheme({
      sourceDocument: source,
      renderedDocument: rendered,
      spineIndex: 0,
      canvasColor: '#24292e',
    })

    expect(analysis.lowContrastSamples).toBeGreaterThanOrEqual(2)
    expect(analysis.repairableSamples).toBeGreaterThanOrEqual(1)
    expect(analysis.patches).toEqual([])
    iframe.remove()
  })

  it('repairs one substantial prose block without requiring a second paragraph', async () => {
    const { source, rendered, iframe } = await fixtureDocuments()
    const prose =
      'Este parágrafo longo representa uma página curta do livro, mas ainda contém texto suficiente para provar que a cor herdada tornou uma passagem inteira ilegível no fundo escuro do leitor.'
    ;[source, rendered].forEach((document) => {
      const paragraphs = Array.from(document.querySelectorAll('p'))
      paragraphs[0]!.textContent = prose
      paragraphs.slice(1).forEach((paragraph) => paragraph.remove())
    })

    const analysis = await analyzeInheritedForegroundForDarkTheme({
      sourceDocument: source,
      renderedDocument: rendered,
      spineIndex: 7,
      canvasColor: '#24292e',
    })
    expect(analysis.patches).toHaveLength(1)
    expect(analysis.repairableSamples).toBe(1)
    expect(analysis.repairableTextCodePoints).toBeGreaterThanOrEqual(80)

    const plan = (await createPresentationPlan(
      {
        schemaVersion: PRESENTATION_PLAN_SCHEMA_VERSION,
        engineVersion: 'foreground-single-prose-v1',
        mode: 'adaptive',
        publicationRevision: 'foreground-single-prose-sha256',
        analysisFingerprint: 'foreground-single-prose-analysis',
        renderingContextFingerprint: 'dark-24292e-v1',
        findings: analysis.findings,
        patches: analysis.patches,
      },
      RESTORE_VISIBLE_TEXT_OPERATION_VALIDATORS,
    ))!
    const layer = (await applyRestoreVisibleTextPlan(
      plan,
      source,
      rendered,
      7,
    ))!
    expect(validateRestoredVisibleText(layer).input.passed).toBe(true)
    layer.restore()
    iframe.remove()
  })

  it('repairs browser-default text nested in an italic child on a transparent EPUB canvas', async () => {
    const prose =
      'Em geral o homem se sente secretamente oprimido pelo papel que é obrigado a representar, tendo sempre de ser responsável, estar no controle e manter a racionalidade. Esta introdução longa reproduz uma publicação que não declara cor para o texto e deixa toda a prosa dentro de um elemento em.'
    const markup = `<html xmlns="http://www.w3.org/1999/xhtml"><head><style>
      html, body { background: transparent; }
      .accent { color: #ec008c; }
      .intro { line-height: 1.62; text-align: center; }
      .italic { font-style: italic; }
    </style></head><body><h2 class="accent">Sereia</h2><p class="intro"><em class="italic">${prose}</em></p></body></html>`
    const source = parseXML(markup, 'application/xhtml+xml')
    const iframe = document.createElement('iframe')
    document.body.appendChild(iframe)
    const rendered = iframe.contentDocument!
    rendered.documentElement.innerHTML = source.documentElement.innerHTML
    installVisibleLayout(rendered)

    const analysis = await analyzeInheritedForegroundForDarkTheme({
      sourceDocument: source,
      renderedDocument: rendered,
      spineIndex: 5,
      canvasColor: '#24292e',
    })

    expect(analysis.lowContrastTextCodePoints).toBeGreaterThanOrEqual(80)
    expect(analysis.patches).toHaveLength(1)
    iframe.remove()
  })

  it('repairs a lone short inherited label with complete paint evidence', async () => {
    const { source, rendered, iframe } = await fixtureDocuments()
    ;[source, rendered].forEach((document) => {
      const paragraphs = Array.from(document.querySelectorAll('p'))
      paragraphs[0]!.textContent = 'Breve.'
      paragraphs.slice(1).forEach((paragraph) => paragraph.remove())
    })

    const analysis = await analyzeInheritedForegroundForDarkTheme({
      sourceDocument: source,
      renderedDocument: rendered,
      spineIndex: 8,
      canvasColor: '#24292e',
    })
    expect(analysis.repairableSamples).toBe(1)
    expect(analysis.repairableTextCodePoints).toBeLessThan(80)
    expect(analysis.patches).toHaveLength(1)
    expect(analysis.patches[0]?.parameters.minimumRepairTextCodePoints).toBe(1)
    iframe.remove()
  })

  it('honors a caller that requires substantial single-sample prose', async () => {
    const { source, rendered, iframe } = await fixtureDocuments()
    ;[source, rendered].forEach((document) => {
      const paragraphs = Array.from(document.querySelectorAll('p'))
      paragraphs[0]!.textContent = 'Breve.'
      paragraphs.slice(1).forEach((paragraph) => paragraph.remove())
    })

    const analysis = await analyzeInheritedForegroundForDarkTheme({
      sourceDocument: source,
      renderedDocument: rendered,
      spineIndex: 8,
      canvasColor: '#24292e',
      minimumRepairTextCodePoints: 80,
    })
    expect(analysis.patches).toEqual([])
    iframe.remove()
  })

  it('rejects a body repair when it changes text over unprovable paint', async () => {
    const markup = `<html xmlns="http://www.w3.org/1999/xhtml"><head><style>
      body { color: #111111; background: transparent; }
      .art { background-image: linear-gradient(#ffffff, #777777); }
    </style></head><body>
      <p>Long dark prose supplies the first safe sample required for the body-wide repair candidate.</p>
      <p>A second substantial paragraph supplies enough evidence for the otherwise valid inherited repair.</p>
      <p class="art">This text inherits the body color over a gradient whose effective contrast cannot be proven.</p>
    </body></html>`
    const source = parseXML(markup, 'application/xhtml+xml')
    const iframe = document.createElement('iframe')
    document.body.appendChild(iframe)
    const rendered = iframe.contentDocument!
    rendered.documentElement.innerHTML = source.documentElement.innerHTML
    installVisibleLayout(rendered)
    const analysis = await analyzeInheritedForegroundForDarkTheme({
      sourceDocument: source,
      renderedDocument: rendered,
      spineIndex: 9,
      canvasColor: '#24292e',
    })
    expect(analysis.patches).toHaveLength(1)
    const plan = (await createPresentationPlan(
      {
        schemaVersion: PRESENTATION_PLAN_SCHEMA_VERSION,
        engineVersion: 'foreground-unknown-paint-v1',
        mode: 'adaptive',
        publicationRevision: 'foreground-unknown-paint-sha256',
        analysisFingerprint: 'foreground-unknown-paint-analysis',
        renderingContextFingerprint: 'dark-24292e-v1',
        findings: analysis.findings,
        patches: analysis.patches,
      },
      RESTORE_VISIBLE_TEXT_OPERATION_VALIDATORS,
    ))!
    const layer = (await applyRestoreVisibleTextPlan(
      plan,
      source,
      rendered,
      9,
    ))!

    const validation = validateRestoredVisibleText(layer).input
    expect(validation.passed).toBe(false)
    expect(validation.probes[0]?.metrics.unprovenPaintChanges).toBe(1)
    layer.restore()
    iframe.remove()
  })

  it('refuses a visible-text patch whose declared effects are inconsistent', async () => {
    const { source, rendered, iframe } = await fixtureDocuments()
    const analysis = await analyzeInheritedForegroundForDarkTheme({
      sourceDocument: source,
      renderedDocument: rendered,
      spineIndex: 10,
      canvasColor: '#24292e',
    })
    const plan = (await createPresentationPlan(
      {
        schemaVersion: PRESENTATION_PLAN_SCHEMA_VERSION,
        engineVersion: 'foreground-effects-v1',
        mode: 'adaptive',
        publicationRevision: 'foreground-effects-fixture',
        analysisFingerprint: 'foreground-effects-analysis',
        renderingContextFingerprint: 'dark-24292e-v1',
        findings: analysis.findings,
        patches: analysis.patches,
      },
      RESTORE_VISIBLE_TEXT_OPERATION_VALIDATORS,
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
      applyRestoreVisibleTextPlan(corrupt, source, rendered, 10),
    ).rejects.toThrow(/unsupported visible-text operation/)
    expect(rendered.querySelector('[data-lumen-presentation-layer]')).toBeNull()
    iframe.remove()
  })
})

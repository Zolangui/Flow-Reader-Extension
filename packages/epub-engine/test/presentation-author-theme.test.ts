import { webcrypto } from 'node:crypto'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import {
  ACTIVATE_AUTHOR_THEME_OPERATION_VERSION,
  analyzeAuthorTheme,
  applyAuthorThemePlan,
  AUTHOR_THEME_OPERATION_VALIDATORS,
  classifyAuthorColorSchemeMedia,
  restoreAuthorThemeLayer,
  validateAppliedAuthorTheme,
} from '../src/presentation-author-theme'
import { markPresentationRuntimeNode } from '../src/presentation-marker'
import {
  createPresentationPlan,
  PRESENTATION_PLAN_SCHEMA_VERSION,
} from '../src/presentation-plan'

import { getFixtureUrl, installVisibleLayout, parseXML } from './helpers'

async function documents(markup?: string): Promise<{
  source: Document
  rendered: Document
  iframe: HTMLIFrameElement
}> {
  const contents =
    markup ??
    (await fetch(getFixtureUrl('/presentation/author-theme.xhtml')).then(
      (response) => response.text(),
    ))
  const source = parseXML(contents, 'application/xhtml+xml')
  const iframe = document.createElement('iframe')
  document.body.appendChild(iframe)
  const rendered = iframe.contentDocument!
  rendered.documentElement.innerHTML = source.documentElement.innerHTML
  installVisibleLayout(rendered)
  return { source, rendered, iframe }
}

async function planFor(source: Document, rendered: Document) {
  const analysis = await analyzeAuthorTheme({
    sourceDocument: source,
    renderedDocument: rendered,
    spineIndex: 2,
    targetScheme: 'dark',
    canvasColor: '#111827',
  })
  const plan = await createPresentationPlan(
    {
      schemaVersion: PRESENTATION_PLAN_SCHEMA_VERSION,
      engineVersion: 'author-theme-test',
      mode: 'adaptive',
      publicationRevision: 'fixture-revision',
      analysisFingerprint: 'author-theme-analysis',
      renderingContextFingerprint: 'author-theme-rendering',
      findings: analysis.findings,
      patches: analysis.patches,
    },
    AUTHOR_THEME_OPERATION_VALIDATORS,
  )
  return { analysis, plan }
}

describe('AuthorThemeResolver', () => {
  beforeAll(() => vi.stubGlobal('crypto', webcrypto as unknown as Crypto))
  afterAll(() => vi.unstubAllGlobals())

  it('builds one conservative geometry-affecting operation from parsed CSSOM branches', async () => {
    const { source, rendered, iframe } = await documents()
    const { analysis, plan } = await planFor(source, rendered)

    expect(analysis.diagnostics).toEqual([])
    expect(analysis.inspectedStyleSheets).toBe(1)
    expect(analysis.patches).toHaveLength(1)
    expect(analysis.patches[0]).toMatchObject({
      operation: 'activate-author-theme',
      operationVersion: ACTIVATE_AUTHOR_THEME_OPERATION_VERSION,
      effects: { paint: true, geometry: 'section' },
      parameters: {
        targetScheme: 'dark',
        darkBranchCount: 1,
        lightBranchCount: 1,
      },
    })
    expect(plan?.geometryPlanHash).toMatch(/^sha256:/)
    expect(plan?.paintPlanHash).toBe(
      await createPresentationPlan(
        {
          schemaVersion: PRESENTATION_PLAN_SCHEMA_VERSION,
          engineVersion: 'empty-test',
          mode: 'adaptive',
          publicationRevision: 'fixture-revision',
          analysisFingerprint: 'empty-analysis',
          renderingContextFingerprint: 'empty-rendering',
          findings: [],
          patches: [],
        },
        AUTHOR_THEME_OPERATION_VALIDATORS,
      ).then((empty) => empty?.paintPlanHash),
    )
    iframe.remove()
  })

  it('activates a light-only authored branch when Lumen is light independently of the operating system', async () => {
    const { source, rendered, iframe } = await documents(`
      <html xmlns="http://www.w3.org/1999/xhtml"><head><style data-lumen-presentation-layer="author-content">
        @media (prefers-color-scheme: light) {
          body { color: #202020; background: #ffffff; }
        }
      </style></head><body><p>A publicação oferece somente o tema claro.</p></body></html>
    `)

    const analysis = await analyzeAuthorTheme({
      sourceDocument: source,
      renderedDocument: rendered,
      spineIndex: 0,
      targetScheme: 'light',
      canvasColor: '#ffffff',
    })

    expect(analysis.diagnostics).toEqual([])
    expect(analysis.patches).toHaveLength(1)
    expect(analysis.patches[0]).toMatchObject({
      operation: 'activate-author-theme',
      parameters: {
        targetScheme: 'light',
        darkBranchCount: 0,
        lightBranchCount: 1,
      },
    })
    iframe.remove()
  })

  it('does not treat a Reader-owned color-scheme branch as authored CSS', async () => {
    const { source, rendered, iframe } = await documents(`
      <html xmlns="http://www.w3.org/1999/xhtml"><head></head>
      <body><p>A publication without an authored theme.</p></body></html>
    `)
    const readerStyle = rendered.createElement('style')
    readerStyle.textContent = `
      @media (prefers-color-scheme: dark) {
        body { color: #ffffff; background: #111827; }
      }
    `
    markPresentationRuntimeNode(readerStyle)
    rendered.head.appendChild(readerStyle)

    const analysis = await analyzeAuthorTheme({
      sourceDocument: source,
      renderedDocument: rendered,
      spineIndex: 0,
      targetScheme: 'dark',
      canvasColor: '#111827',
    })

    expect(analysis.inspectedStyleSheets).toBe(0)
    expect(analysis.patches).toEqual([])
    iframe.remove()
  })

  it('does not invent an authored branch for a scheme the publication lacks', async () => {
    const { source, rendered, iframe } = await documents(`
      <html xmlns="http://www.w3.org/1999/xhtml"><head><style>
        @media (prefers-color-scheme: light) { body { color: #202020; } }
      </style></head><body><p>Somente claro.</p></body></html>
    `)

    const analysis = await analyzeAuthorTheme({
      sourceDocument: source,
      renderedDocument: rendered,
      spineIndex: 0,
      targetScheme: 'dark',
      canvasColor: '#111827',
    })

    expect(analysis.patches).toEqual([])
    expect(analysis.diagnostics).toContain('no-authored-dark-branch')
    iframe.remove()
  })

  it('fails closed when authored CSS exceeds the bounded CSSOM budget', async () => {
    const rules = Array.from(
      { length: 4100 },
      (_, index) => `.r${index} { color: rgb(20, 20, 20); }`,
    ).join('\n')
    const { source, rendered, iframe } = await documents(`
      <html xmlns="http://www.w3.org/1999/xhtml"><head><style>
        @media (prefers-color-scheme: dark) { body { color: white; } }
        ${rules}
      </style></head><body><p>Bounded CSSOM</p></body></html>
    `)
    const analysis = await analyzeAuthorTheme({
      sourceDocument: source,
      renderedDocument: rendered,
      spineIndex: 0,
      targetScheme: 'dark',
      canvasColor: '#111827',
    })
    expect(analysis.patches).toEqual([])
    expect(analysis.diagnostics).toContain('cssom-rule-budget')
    iframe.remove()
  })

  it('activates branches in their original cascade positions and restores them exactly', async () => {
    const { source, rendered, iframe } = await documents()
    const { plan } = await planFor(source, rendered)
    expect(plan).toBeDefined()
    const rules = Array.from(rendered.styleSheets[0]!.cssRules).filter(
      (rule) => 'media' in rule,
    ) as CSSMediaRule[]
    const originals = rules.map((rule) => rule.media.mediaText)

    const layer = await applyAuthorThemePlan(plan!, source, rendered, 2)

    expect(layer).toBeDefined()
    expect(rules.map((rule) => rule.media.mediaText)).toEqual([
      'not all',
      'all',
    ])
    expect(rendered.documentElement.dataset.lumenAuthorTheme).toBe('dark')
    expect(source.documentElement.hasAttribute('data-lumen-author-theme')).toBe(
      false,
    )

    expect(restoreAuthorThemeLayer(rendered)).toBe(true)
    expect(restoreAuthorThemeLayer(rendered)).toBe(false)
    expect(rules.map((rule) => rule.media.mediaText)).toEqual(originals)
    expect(
      rendered.documentElement.hasAttribute('data-lumen-author-theme'),
    ).toBe(false)
    iframe.remove()
  })

  it('rejects an authored branch when final text paint becomes ambiguous', async () => {
    const { source, rendered, iframe } = await documents()
    const { plan } = await planFor(source, rendered)
    const layer = await applyAuthorThemePlan(plan!, source, rendered, 2)
    expect(layer).toBeDefined()

    rendered
      .querySelector('p')!
      .setAttribute(
        'style',
        'background-image: linear-gradient(#111827, #111827)',
      )
    const validation = validateAppliedAuthorTheme(layer!, true)

    expect(validation.input.passed).toBe(false)
    expect(validation.input.failureReasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'author-theme-contrast-unproven' }),
      ]),
    )
    layer!.restore()
    iframe.remove()
  })

  it('rejects an authored dark branch that leaves a list marker unreadable', async () => {
    const { source, rendered, iframe } = await documents(`
      <html xmlns="http://www.w3.org/1999/xhtml"><head><style>
        li { color:#000000; list-style-type:disc; }
        li > p { color:#f1f5f9; }
        @media (prefers-color-scheme: light) {
          body { color:#202020; background:#ffffff; }
        }
        @media (prefers-color-scheme: dark) {
          body { color:#f1f5f9; background:#111827; }
        }
      </style></head><body><ul><li><p>Readable prose with a dark marker.</p></li></ul></body></html>
    `)
    const { plan } = await planFor(source, rendered)
    expect(plan).toBeDefined()
    const layer = await applyAuthorThemePlan(plan!, source, rendered, 2)
    expect(layer).toBeDefined()

    const validation = validateAppliedAuthorTheme(layer!, true)
    expect(validation.input.passed).toBe(false)
    expect(validation.input.failureReasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'author-theme-contrast-unproven' }),
      ]),
    )
    layer!.restore()
    iframe.remove()
  })

  it('fails closed for compound color-scheme conditions', async () => {
    const { source, rendered, iframe } = await documents(`<!doctype html>
      <html><head><style>
        @media (prefers-color-scheme: dark) and (min-width: 20em) {
          body { color: white; background: black; }
        }
      </style></head><body><p>Ambiguous branch</p></body></html>`)

    const analysis = await analyzeAuthorTheme({
      sourceDocument: source,
      renderedDocument: rendered,
      spineIndex: 0,
      targetScheme: 'dark',
      canvasColor: '#111827',
    })

    expect(analysis.patches).toEqual([])
    expect(
      classifyAuthorColorSchemeMedia(
        '(prefers-color-scheme: dark) and (min-width: 20em)',
      ),
    ).toEqual({ kind: 'unsupported' })
    expect(
      classifyAuthorColorSchemeMedia('screen and (prefers-color-scheme: dark)'),
    ).toEqual({ kind: 'scheme', scheme: 'dark' })
    iframe.remove()
  })
})

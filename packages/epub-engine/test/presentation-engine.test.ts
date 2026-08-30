import { webcrypto } from 'node:crypto'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import {
  createPaginationLifecycleArtifacts,
  type PaginationLifecycleContext,
} from '../src/pagination-lifecycle'
import {
  analyzeAuthorTheme,
  applyAuthorThemePlan,
  AUTHOR_THEME_OPERATION_VALIDATORS,
} from '../src/presentation-author-theme'
import {
  LumenPresentationEngine,
  type LumenPresentationOutcome,
} from '../src/presentation-engine'
import {
  createPresentationPlan,
  PRESENTATION_PLAN_SCHEMA_VERSION,
} from '../src/presentation-plan'
import { PresentationRunBudgetError } from '../src/presentation-run'
import Hook from '../src/utils/hook'

import { getFixtureUrl, installVisibleLayout, parseXML } from './helpers'

async function fixture(): Promise<{
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

function testContext(source: Document, rendered: Document) {
  const view = {} as PaginationLifecycleContext['view']
  const section = {
    index: 4,
    loadSource: vi.fn(async () => source),
  } as unknown as PaginationLifecycleContext['section']
  const contents = {
    document: rendered,
  } as PaginationLifecycleContext['contents']
  const context: PaginationLifecycleContext = {
    lifecycleVersion: 2,
    purpose: 'reader',
    view,
    section,
    contents,
    layout: {} as PaginationLifecycleContext['layout'],
    axis: 'horizontal',
    writingMode: 'horizontal-tb',
    artifacts: createPaginationLifecycleArtifacts([
      'lumen-presentation-engine',
    ]),
  }
  return { context, section, contents }
}

function host(
  contents: PaginationLifecycleContext['contents'],
  views: PaginationLifecycleContext['view'][] = [],
) {
  const pipelines = new Map<string, () => string>()
  return {
    book: { load: vi.fn() },
    hooks: {
      beforePagination: new Hook(),
      afterPagination: new Hook(),
    },
    getContents: () => [contents],
    views: () => views,
    registerPaginationGeometryPipeline: (
      producerId: string,
      resolveFingerprint: () => string,
    ) => {
      pipelines.set(producerId, resolveFingerprint)
      return () => pipelines.delete(producerId)
    },
  }
}

const presentationOptions = {
  resolveGeometryPipelineFingerprint: () => 'adaptive-geometry-v1',
}

const adaptivePolicy = {
  enabled: true,
  mode: 'adaptive' as const,
  colorScheme: 'dark' as const,
  canvasColor: '#111827',
  publicationRevision: 'pink-fixture-revision',
  analysisFingerprint: 'pink-analysis',
  renderingContextFingerprint: 'pink-rendering',
}

describe('Lumen Presentation Engine phase-4 lifecycle', () => {
  beforeAll(() => vi.stubGlobal('crypto', webcrypto as unknown as Crypto))
  afterAll(() => vi.unstubAllGlobals())

  it('uses the shared Rendition hooks and admits before the view is revealed', async () => {
    const { source, rendered, iframe } = await fixture()
    const { context, contents } = testContext(source, rendered)
    const rendition = host(contents)
    const outcomes: string[] = []
    const engine = new LumenPresentationEngine(rendition, {
      ...presentationOptions,
      resolvePolicy: () => adaptivePolicy,
      onOutcome: (outcome) => outcomes.push(outcome.status),
    }).attach()

    await rendition.hooks.beforePagination.trigger(context, undefined)
    expect(
      rendered.querySelector('[data-lumen-presentation-layer]'),
    ).not.toBeNull()
    await rendition.hooks.afterPagination.trigger(context, undefined, undefined)

    expect(outcomes).toEqual(['adapted'])
    expect(context.artifacts.geometry).toMatchObject([
      {
        producerId: 'lumen-presentation-engine',
        status: 'accepted',
        geometryAffecting: false,
      },
    ])
    expect(
      rendered.querySelector('[data-lumen-presentation-layer]'),
    ).not.toBeNull()
    engine.detach()
    expect(rendered.querySelector('[data-lumen-presentation-layer]')).toBeNull()
    iframe.remove()
  })

  it('does not stack a palette remap over an explicit repair of the same target', async () => {
    const markup = `<html xmlns="http://www.w3.org/1999/xhtml"><head><style>
      body { background: transparent; }
      aside { background-color: #f5d6e2; color: #b07080; padding: 20px; }
    </style></head><body><aside>Substantial authored callout text proves both its opaque surface and its deliberately low-contrast foreground.</aside></body></html>`
    const source = parseXML(markup, 'application/xhtml+xml')
    const iframe = document.createElement('iframe')
    document.body.appendChild(iframe)
    const rendered = iframe.contentDocument!
    rendered.documentElement.innerHTML = source.documentElement.innerHTML
    installVisibleLayout(rendered)
    const target = rendered.querySelector('aside') as HTMLElement
    const publishedStyle = target.getAttribute('style')
    const publishedCss = rendered.querySelector('style')?.textContent
    const { context, contents } = testContext(source, rendered)
    const outcomes: LumenPresentationOutcome[] = []
    const rendition = host(contents)
    const engine = new LumenPresentationEngine(rendition, {
      ...presentationOptions,
      resolvePolicy: () => adaptivePolicy,
      onOutcome: (outcome) => outcomes.push(outcome),
    }).attach()

    await rendition.hooks.beforePagination.trigger(context, undefined)
    await rendition.hooks.afterPagination.trigger(context, undefined, undefined)

    const operations = outcomes
      .at(-1)
      ?.accepted?.plan.patches.map((patch) => patch.operation)
    expect(outcomes.at(-1)?.status).toBe('adapted')
    expect(operations).toEqual(['restore-explicit-text'])

    engine.detach()
    expect(target.getAttribute('style')).toBe(publishedStyle)
    expect(rendered.querySelector('style')?.textContent).toBe(publishedCss)
    expect(
      rendered.querySelector('[data-lumen-presentation-layer]'),
    ).toBeNull()
    iframe.remove()
  })

  it('is inert when the Adaptive feature flag is disabled', async () => {
    const { source, rendered, iframe } = await fixture()
    const { context, section, contents } = testContext(source, rendered)
    const rendition = host(contents)
    const outcomes: string[] = []
    const engine = new LumenPresentationEngine(rendition, {
      ...presentationOptions,
      resolvePolicy: () => ({ ...adaptivePolicy, enabled: false }),
      onOutcome: (outcome) => outcomes.push(outcome.status),
    })

    const candidate = await engine.getLifecycle().beforePagination!(context)

    expect(candidate).toBeUndefined()
    expect(section.loadSource).not.toHaveBeenCalled()
    expect(outcomes).toEqual(['published-disabled'])
    expect(context.artifacts.geometry).toMatchObject([
      {
        producerId: 'lumen-presentation-engine',
        status: 'published',
        geometryAffecting: false,
      },
    ])
    expect(rendered.querySelector('[data-lumen-presentation-layer]')).toBeNull()
    iframe.remove()
  })

  it('repairs proven light-on-light text under a light reader policy', async () => {
    const markup = `<html xmlns="http://www.w3.org/1999/xhtml"><head><style>
      body { background: transparent; color: #f3ecff; }
    </style></head><body><p>Pale publication prose must remain readable on a light reader canvas.</p></body></html>`
    const source = parseXML(markup, 'application/xhtml+xml')
    const iframe = document.createElement('iframe')
    document.body.appendChild(iframe)
    const rendered = iframe.contentDocument!
    rendered.documentElement.innerHTML = source.documentElement.innerHTML
    installVisibleLayout(rendered)
    const { context, contents } = testContext(source, rendered)
    const outcomes: LumenPresentationOutcome[] = []
    const engine = new LumenPresentationEngine(host(contents), {
      ...presentationOptions,
      resolvePolicy: () => ({
        ...adaptivePolicy,
        colorScheme: 'light',
        canvasColor: '#ffffff',
      }),
      onOutcome: (outcome) => outcomes.push(outcome),
    })
    const lifecycle = engine.getLifecycle()
    const candidate = await lifecycle.beforePagination!(context)
    await lifecycle.afterPagination!(context, candidate)

    expect(outcomes.at(-1)).toMatchObject({ status: 'adapted' })
    expect(
      outcomes
        .at(-1)
        ?.accepted?.plan.patches.some(
          (patch) => patch.operation === 'restore-explicit-text',
        ),
    ).toBe(true)
    expect(outcomes.at(-1)?.legibility?.knownLowContrastSamples).toBe(0)
    iframe.remove()
  })

  it('distinguishes proven Published text from unproven paint', async () => {
    const run = async (paragraphStyle: string) => {
      const markup = `<html xmlns="http://www.w3.org/1999/xhtml"><head><style>
        body { background: transparent; color: #f8fafc; }
        p { ${paragraphStyle} }
      </style></head><body><p>Published text evidence.</p></body></html>`
      const source = parseXML(markup, 'application/xhtml+xml')
      const iframe = document.createElement('iframe')
      document.body.appendChild(iframe)
      const rendered = iframe.contentDocument!
      rendered.documentElement.innerHTML = source.documentElement.innerHTML
      installVisibleLayout(rendered)
      const { context, contents } = testContext(source, rendered)
      const outcomes: LumenPresentationOutcome[] = []
      const engine = new LumenPresentationEngine(host(contents), {
        ...presentationOptions,
        resolvePolicy: () => adaptivePolicy,
        onOutcome: (outcome) => outcomes.push(outcome),
      })
      const lifecycle = engine.getLifecycle()
      const candidate = await lifecycle.beforePagination!(context)
      await lifecycle.afterPagination!(context, candidate)
      iframe.remove()
      return outcomes.at(-1)!
    }

    const readable = await run('background: transparent')
    const unproven = await run(
      'background-image: linear-gradient(#111827, #1f2937)',
    )

    expect(readable).toMatchObject({
      status: 'published-readable',
      legibility: { complete: true, unknownPaintSamples: 0 },
    })
    expect(unproven).toMatchObject({
      status: 'published-unproven',
      legibility: {
        complete: false,
        unknownPaintByReason: { 'background-image': 1 },
      },
    })
  })

  it('does not mark a failed Adaptive run as a cacheable Published decision', async () => {
    const { source, rendered, iframe } = await fixture()
    const { context, contents } = testContext(source, rendered)
    const rendition = host(contents)
    const engine = new LumenPresentationEngine(rendition, {
      ...presentationOptions,
      resolvePolicy: () => {
        throw new Error('temporary policy failure')
      },
    })

    await engine.getLifecycle().beforePagination!(context)

    expect(context.artifacts.geometry).toEqual([])
    iframe.remove()
  })

  it('times out a policy resolver that never settles and keeps Published', async () => {
    const { source, rendered, iframe } = await fixture()
    const { context, contents } = testContext(source, rendered)
    const outcomes: Array<{ status: string; reason?: string }> = []
    const engine = new LumenPresentationEngine(host(contents), {
      ...presentationOptions,
      resolvePolicy: () => new Promise(() => undefined),
      budget: { maxElapsedMs: 20 },
      onOutcome: ({ status, reason }) => outcomes.push({ status, reason }),
    })

    await expect(
      engine.getLifecycle().beforePagination!(context),
    ).resolves.toBeUndefined()
    expect(outcomes).toEqual([
      { status: 'published-fallback', reason: 'policy-resolution-timeout' },
    ])
    expect(rendered.querySelector('[data-lumen-presentation-layer]')).toBeNull()
    iframe.remove()
  })

  it('does not let a stale render consume the candidate of a reused view', async () => {
    const { source, rendered, iframe } = await fixture()
    const first = testContext(source, rendered).context
    const second = {
      ...first,
      artifacts: createPaginationLifecycleArtifacts([
        'lumen-presentation-engine',
      ]),
    }
    const engine = new LumenPresentationEngine(host(first.contents), {
      ...presentationOptions,
      resolvePolicy: () => adaptivePolicy,
    })
    const lifecycle = engine.getLifecycle()
    const firstCandidate = await lifecycle.beforePagination!(first)
    const secondCandidate = await lifecycle.beforePagination!(second)

    await expect(
      lifecycle.afterPagination!(first, firstCandidate),
    ).resolves.toBeUndefined()
    expect(
      rendered.querySelector('[data-lumen-presentation-layer]'),
    ).not.toBeNull()
    await lifecycle.afterPagination!(second, secondCandidate)
    expect(second.artifacts.geometry).toHaveLength(1)
    iframe.remove()
  })

  it('tries the next independent repair when an authored branch fails validation', async () => {
    const markup = `<html xmlns="http://www.w3.org/1999/xhtml"><head><style>
      html, body { background: #111827; color: #000000; }
      @media (prefers-color-scheme: dark) { body { background: #111827; color: #222222; } }
    </style></head><body>
      <p>Long inherited dark prose that gives the bounded fallback enough evidence to repair this intentionally invalid authored theme branch.</p>
      <p>A second paragraph proves repeated prose coverage without changing the publication source or semantic structure.</p>
    </body></html>`
    const source = parseXML(markup, 'application/xhtml+xml')
    const iframe = document.createElement('iframe')
    document.body.appendChild(iframe)
    const rendered = iframe.contentDocument!
    rendered.documentElement.innerHTML = source.documentElement.innerHTML
    installVisibleLayout(rendered)
    const { context, contents } = testContext(source, rendered)
    Object.assign(context.layout, {
      name: 'reflowable',
      _flow: 'paginated',
      columnWidth: 640,
      height: 430,
      format: vi.fn(),
    })
    Object.assign(context.view, { expand: vi.fn() })
    const outcomes: LumenPresentationOutcome[] = []
    const engine = new LumenPresentationEngine(host(contents), {
      ...presentationOptions,
      resolvePolicy: () => adaptivePolicy,
      budget: { maxElapsedMs: 3000 },
      onOutcome: (outcome) => outcomes.push(outcome),
    })
    const lifecycle = engine.getLifecycle()
    const candidate = await lifecycle.beforePagination!(context)
    await lifecycle.afterPagination!(context, candidate)

    const accepted = outcomes.find((outcome) => outcome.status === 'adapted')
    expect(accepted?.reason).toBe('fallback-candidate-accepted')
    expect(
      accepted?.accepted?.plan.patches.some(
        (patch) =>
          patch.operation === 'restore-visible-text' ||
          patch.operation === 'restore-explicit-text',
      ),
    ).toBe(true)
    expect(
      accepted?.accepted?.plan.patches.some(
        (patch) => patch.operation === 'activate-author-theme',
      ),
    ).toBe(false)
    iframe.remove()
  })

  it('re-probes geometry after a rejected author theme is restored', async () => {
    const markup = `<html xmlns="http://www.w3.org/1999/xhtml"><head><style>
      html, body { background: #111827; color: #000000; }
      @media (prefers-color-scheme: dark) { body { background: #111827; color: #222222; } }
    </style></head><body>
      <p>Long inherited dark prose gives the independent fallback enough evidence when the authored branch fails validation.</p>
      <p>A second substantial paragraph makes the body-wide repair conclusive without changing publication semantics.</p>
      <table><tbody><tr><th>One</th><th>Two</th></tr><tr><td>Alpha</td><td>Beta</td></tr></tbody></table>
    </body></html>`
    const source = parseXML(markup, 'application/xhtml+xml')
    const iframe = document.createElement('iframe')
    document.body.appendChild(iframe)
    const rendered = iframe.contentDocument!
    rendered.documentElement.innerHTML = source.documentElement.innerHTML
    installVisibleLayout(rendered)
    const table = rendered.querySelector('table')!
    const tableWidth = () =>
      rendered.documentElement.hasAttribute('data-lumen-author-theme')
        ? 100
        : 900
    Object.defineProperties(table, {
      scrollWidth: { configurable: true, get: tableWidth },
      scrollHeight: { configurable: true, get: () => 20 },
      getBoundingClientRect: {
        configurable: true,
        value: () => ({
          x: 0,
          y: 0,
          top: 0,
          left: 0,
          right: tableWidth(),
          bottom: 20,
          width: tableWidth(),
          height: 20,
          toJSON: () => ({}),
        }),
      },
    })
    const { context, contents } = testContext(source, rendered)
    Object.assign(context.layout, {
      name: 'reflowable',
      _flow: 'paginated',
      columnWidth: 640,
      height: 430,
      format: vi.fn(),
    })
    Object.assign(context.view, { expand: vi.fn() })
    const outcomes: LumenPresentationOutcome[] = []
    const engine = new LumenPresentationEngine(host(contents), {
      ...presentationOptions,
      resolvePolicy: () => adaptivePolicy,
      budget: { maxElapsedMs: 3000 },
      onOutcome: (outcome) => outcomes.push(outcome),
    })

    const candidate = await engine.getLifecycle().beforePagination!(context)
    expect(candidate?.authorThemeLayer).toBeDefined()
    await engine.getLifecycle().afterPagination!(context, candidate)

    const fallbackPlan = outcomes
      .filter((outcome) => outcome.status === 'published-fallback')
      .find((outcome) => outcome.plan?.patches.length)?.plan
    expect(
      fallbackPlan?.patches.some(
        (patch) => patch.operation === 'contain-overflow',
      ),
    ).toBe(true)
    iframe.remove()
  })

  it('repaginates Published after rejecting a geometry-changing author theme', async () => {
    const markup = `<html xmlns="http://www.w3.org/1999/xhtml"><head><style>
      html, body { background: #111827; color: #000000; }
      @media (prefers-color-scheme: dark) { body { background: #111827; color: #222222; } }
    </style></head><body>
      <p>Long inherited dark prose that intentionally makes the authored theme fail its final validation after pagination.</p>
      <p>A second paragraph supplies enough bounded evidence while the test disables the independent fallback candidate.</p>
    </body></html>`
    const source = parseXML(markup, 'application/xhtml+xml')
    const iframe = document.createElement('iframe')
    document.body.appendChild(iframe)
    const rendered = iframe.contentDocument!
    rendered.documentElement.innerHTML = source.documentElement.innerHTML
    installVisibleLayout(rendered)
    const { context, contents } = testContext(source, rendered)
    const format = vi.fn()
    const expand = vi.fn()
    Object.assign(context.layout, {
      name: 'reflowable',
      _flow: 'paginated',
      columnWidth: 640,
      height: 430,
      format,
    })
    Object.assign(context.view, { expand })
    const outcomes: LumenPresentationOutcome[] = []
    const engine = new LumenPresentationEngine(host(contents), {
      ...presentationOptions,
      resolvePolicy: () => adaptivePolicy,
      budget: { maxElapsedMs: 3000 },
      onOutcome: (outcome) => outcomes.push(outcome),
    })
    const lifecycle = engine.getLifecycle()
    const candidate = await lifecycle.beforePagination!(context)
    expect(candidate?.authorThemeLayer).toBeDefined()
    if (candidate) candidate.fallbackAnalysis = undefined

    await lifecycle.afterPagination!(context, candidate)

    expect(outcomes.at(-1)?.status).toBe('published-fallback')
    expect(format).toHaveBeenCalledWith(
      context.contents,
      context.section,
      context.axis,
    )
    expect(expand).toHaveBeenCalledWith(true)
    expect(context.artifacts.geometry).toMatchObject([
      {
        producerId: 'lumen-presentation-engine',
        status: 'published',
        geometryAffecting: false,
      },
    ])
    iframe.remove()
  })

  it('reserves the candidate budget for an authored fallback branch', async () => {
    const markup = `<html xmlns="http://www.w3.org/1999/xhtml"><head><style>
      html, body { background: #111827; color: #000000; }
      @media (prefers-color-scheme: dark) { body { background: #111827; color: #222222; } }
    </style></head><body>
      <p>Long inherited dark prose that would normally produce an independent fallback candidate after the authored theme.</p>
      <p>A second substantial paragraph makes the fallback evidence conclusive while the shared run only permits one candidate.</p>
    </body></html>`
    const source = parseXML(markup, 'application/xhtml+xml')
    const iframe = document.createElement('iframe')
    document.body.appendChild(iframe)
    const rendered = iframe.contentDocument!
    rendered.documentElement.innerHTML = source.documentElement.innerHTML
    installVisibleLayout(rendered)
    const { context, contents } = testContext(source, rendered)
    Object.assign(context.layout, {
      name: 'reflowable',
      _flow: 'paginated',
      columnWidth: 640,
      height: 430,
      format: vi.fn(),
    })
    Object.assign(context.view, { expand: vi.fn() })
    const outcomes: LumenPresentationOutcome[] = []
    const engine = new LumenPresentationEngine(host(contents), {
      ...presentationOptions,
      resolvePolicy: () => adaptivePolicy,
      budget: { maxCandidates: 1, maxElapsedMs: 3000 },
      onOutcome: (outcome) => outcomes.push(outcome),
    })
    const lifecycle = engine.getLifecycle()
    const candidate = await lifecycle.beforePagination!(context)

    expect(candidate?.authorThemeLayer).toBeDefined()
    expect(candidate?.fallbackAnalysis).toBeUndefined()
    await lifecycle.afterPagination!(context, candidate)
    expect(outcomes.at(-1)?.reason).not.toMatch(/maxCandidates/)
    iframe.remove()
  })

  it('repaginates restored geometry when the run expires before afterPagination', async () => {
    const markup = await fetch(
      getFixtureUrl('/presentation/author-theme.xhtml'),
    ).then((response) => response.text())
    const source = parseXML(markup, 'application/xhtml+xml')
    const iframe = document.createElement('iframe')
    document.body.appendChild(iframe)
    const rendered = iframe.contentDocument!
    rendered.documentElement.innerHTML = source.documentElement.innerHTML
    installVisibleLayout(rendered)
    const { context, contents } = testContext(source, rendered)
    const format = vi.fn()
    const expand = vi.fn()
    Object.assign(context.layout, {
      name: 'reflowable',
      _flow: 'paginated',
      columnWidth: 640,
      height: 430,
      format,
    })
    Object.assign(context.view, { expand, _disposed: false })
    const outcomes: LumenPresentationOutcome[] = []
    const engine = new LumenPresentationEngine(host(contents), {
      ...presentationOptions,
      resolvePolicy: () => adaptivePolicy,
      budget: { maxElapsedMs: 3000 },
      onOutcome: (outcome) => outcomes.push(outcome),
    })
    const candidate = await engine.getLifecycle().beforePagination!(context)
    expect(candidate?.authorThemeLayer).toBeDefined()
    format.mockClear()
    expand.mockClear()

    const abortRun = Reflect.get(candidate!.run, 'abortController') as (
      reason: unknown,
    ) => void
    abortRun(new PresentationRunBudgetError('maxElapsedMs'))

    expect(format).toHaveBeenCalledWith(
      context.contents,
      context.section,
      context.axis,
    )
    expect(expand).toHaveBeenCalledWith(true)
    expect(outcomes.at(-1)).toMatchObject({
      status: 'published-fallback',
      reason: 'presentation-timeout',
    })
    expect(context.artifacts.geometry).toEqual([
      expect.objectContaining({
        spineIndex: 4,
        status: 'published',
        geometryAffecting: false,
      }),
    ])
    iframe.remove()
  })

  it('restores Published immediately when a pending candidate is cancelled', async () => {
    const { source, rendered, iframe } = await fixture()
    const { context, contents } = testContext(source, rendered)
    const rendition = host(contents)
    const controller = new AbortController()
    const outcomes: string[] = []
    const engine = new LumenPresentationEngine(rendition, {
      ...presentationOptions,
      resolvePolicy: () => adaptivePolicy,
      onOutcome: (outcome) => outcomes.push(outcome.status),
    })
    const lifecycle = engine.getLifecycle()
    const candidate = await lifecycle.beforePagination!(
      context,
      controller.signal,
    )
    expect(candidate).toBeDefined()

    controller.abort()

    expect(rendered.querySelector('[data-lumen-presentation-layer]')).toBeNull()
    await expect(
      lifecycle.afterPagination!(context, candidate, controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(outcomes).toContain('cancelled')
    expect(context.artifacts.geometry).toEqual([
      expect.objectContaining({
        spineIndex: 4,
        status: 'published',
        geometryAffecting: false,
      }),
    ])
    iframe.remove()
  })

  it('cancels and restores every candidate when detached before validation', async () => {
    const { source, rendered, iframe } = await fixture()
    const { context, contents } = testContext(source, rendered)
    const rendition = host(contents)
    const engine = new LumenPresentationEngine(rendition, {
      ...presentationOptions,
      resolvePolicy: () => adaptivePolicy,
    }).attach()

    await engine.getLifecycle().beforePagination!(context)
    expect(
      rendered.querySelector('[data-lumen-presentation-layer]'),
    ).not.toBeNull()

    engine.detach()

    expect(rendered.querySelector('[data-lumen-presentation-layer]')).toBeNull()
    iframe.remove()
  })

  it('repaginates a pending geometry-changing candidate when detached', async () => {
    const markup = await fetch(
      getFixtureUrl('/presentation/author-theme.xhtml'),
    ).then((response) => response.text())
    const source = parseXML(markup, 'application/xhtml+xml')
    const iframe = document.createElement('iframe')
    document.body.appendChild(iframe)
    const rendered = iframe.contentDocument!
    rendered.documentElement.innerHTML = source.documentElement.innerHTML
    installVisibleLayout(rendered)
    const { context, contents } = testContext(source, rendered)
    const format = vi.fn()
    const expand = vi.fn()
    Object.assign(context.layout, {
      name: 'reflowable',
      _flow: 'paginated',
      columnWidth: 640,
      height: 430,
      format,
    })
    Object.assign(context.view, {
      contents,
      section: context.section,
      layout: context.layout,
      axis: context.axis,
      _disposed: false,
      expand,
    })
    const rendition = host(contents, [context.view])
    const engine = new LumenPresentationEngine(rendition, {
      ...presentationOptions,
      resolvePolicy: () => adaptivePolicy,
      budget: { maxElapsedMs: 3000 },
    }).attach()
    const candidate = await engine.getLifecycle().beforePagination!(context)
    expect(candidate?.authorThemeLayer).toBeDefined()
    format.mockClear()
    expand.mockClear()

    engine.detach()

    expect(format).toHaveBeenCalledWith(contents, context.section, context.axis)
    expect(expand).toHaveBeenCalledWith(true)
    expect(rendered.querySelector('[data-lumen-author-theme]')).toBeNull()
    iframe.remove()
  })

  it('repaginates an accepted geometry-changing layer when detached', async () => {
    const markup = await fetch(
      getFixtureUrl('/presentation/author-theme.xhtml'),
    ).then((response) => response.text())
    const source = parseXML(markup, 'application/xhtml+xml')
    const iframe = document.createElement('iframe')
    document.body.appendChild(iframe)
    const rendered = iframe.contentDocument!
    rendered.documentElement.innerHTML = source.documentElement.innerHTML
    installVisibleLayout(rendered)
    const { context, contents } = testContext(source, rendered)
    const format = vi.fn()
    const expand = vi.fn()
    Object.assign(context.layout, {
      name: 'reflowable',
      _flow: 'paginated',
      columnWidth: 640,
      height: 430,
      format,
    })
    Object.assign(context.view, {
      contents,
      section: context.section,
      layout: context.layout,
      axis: context.axis,
      _disposed: false,
      expand,
    })
    const analysis = await analyzeAuthorTheme({
      sourceDocument: source,
      renderedDocument: rendered,
      spineIndex: 4,
      targetScheme: 'dark',
      canvasColor: '#111827',
    })
    const plan = await createPresentationPlan(
      {
        schemaVersion: PRESENTATION_PLAN_SCHEMA_VERSION,
        engineVersion: 'detach-test',
        mode: 'adaptive',
        publicationRevision: 'detach-revision',
        analysisFingerprint: 'detach-analysis',
        renderingContextFingerprint: 'detach-rendering',
        findings: analysis.findings,
        patches: analysis.patches,
      },
      AUTHOR_THEME_OPERATION_VALIDATORS,
    )
    expect(plan).toBeDefined()
    expect(await applyAuthorThemePlan(plan!, source, rendered, 4)).toBeDefined()

    const rendition = host(contents, [context.view])
    const engine = new LumenPresentationEngine(rendition, {
      ...presentationOptions,
      resolvePolicy: () => adaptivePolicy,
      budget: { maxElapsedMs: 3000 },
    }).attach()
    format.mockClear()
    expand.mockClear()

    engine.detach()

    expect(format).toHaveBeenCalledWith(contents, context.section, context.axis)
    expect(expand).toHaveBeenCalledWith(true)
    iframe.remove()
  })
})

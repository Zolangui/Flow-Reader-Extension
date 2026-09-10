import ePub, {
  MAX_PRESENTATION_HEALTH_ELEMENTS,
  LumenPresentationEngine,
  LayoutMeasurementSession,
  analyzeStrokeContrast,
  contrastRatio,
  createPresentationHealthMap,
  parseSrgbColor,
  resolveComputedSrgbColor,
  srgbToHex,
  srgbToOklch,
  summarizePresentationLegibility,
  type Book,
  type LumenPresentationOutcome,
  type Rendition,
  type SectionLayoutMeasurement,
} from '../src/index'

const CANVAS_COLOR = '#111827'
type FixtureCase =
  | 'pink-callout'
  | 'wide-table'
  | 'author-theme'
  | 'dark-foreground'
  | 'default-foreground'
  | 'large-index'
  | 'chapter-boundary'
  | 'pseudo-noise'
  | 'pseudo-dropcap'
  | 'forged-location-ignore'
  | 'many-color-roots'
  | 'clipped-prose'
  | 'occluded-callout'
  | 'lazy-image-section'
  | 'stroke-contrast'
  | 'private-large-index'
  | 'private-cover'
  | 'private-dark-audit'
  | 'private-light-audit'
  | 'private-stroke-audit'
  | 'private-chapter-boundary'
const requestedCase = new URLSearchParams(window.location.search).get('case')
const requestedSpineIndex = Number.parseInt(
  new URLSearchParams(window.location.search).get('spine') ?? '',
  10,
)
const TEST_CASE: FixtureCase =
  requestedCase === 'wide-table' ||
  requestedCase === 'author-theme' ||
  requestedCase === 'dark-foreground' ||
  requestedCase === 'default-foreground' ||
  requestedCase === 'large-index' ||
  requestedCase === 'chapter-boundary' ||
  requestedCase === 'pseudo-noise' ||
  requestedCase === 'pseudo-dropcap' ||
  requestedCase === 'forged-location-ignore' ||
  requestedCase === 'many-color-roots' ||
  requestedCase === 'clipped-prose' ||
  requestedCase === 'occluded-callout' ||
  requestedCase === 'lazy-image-section' ||
  requestedCase === 'stroke-contrast' ||
  requestedCase === 'private-large-index' ||
  requestedCase === 'private-cover' ||
  requestedCase === 'private-dark-audit' ||
  requestedCase === 'private-light-audit' ||
  requestedCase === 'private-stroke-audit' ||
  requestedCase === 'private-chapter-boundary'
    ? requestedCase
    : 'pink-callout'
const ACTIVE_CANVAS_COLOR =
  TEST_CASE === 'private-dark-audit' || TEST_CASE === 'private-stroke-audit'
    ? '#24292e'
    : TEST_CASE === 'private-light-audit'
    ? '#ffffff'
    : CANVAS_COLOR
const FIXTURE_URL =
  TEST_CASE === 'private-large-index' ||
  TEST_CASE === 'private-cover' ||
  TEST_CASE === 'private-dark-audit' ||
  TEST_CASE === 'private-light-audit' ||
  TEST_CASE === 'private-stroke-audit' ||
  TEST_CASE === 'private-chapter-boundary'
    ? '/fixtures/private.epub'
    : '/fixtures/pink-callout/'

type RenderedFixture = {
  book: Book
  rendition: Rendition
  engine?: LumenPresentationEngine
  outcome?: LumenPresentationOutcome
  outcomes: LumenPresentationOutcome[]
  bookReadyMs: number
  replacementsReadyMs?: number
  displayMs: number
  initialJumpMs?: number
  renderDurationMs: number
}

type Check = {
  id: string
  label: string
  passed: boolean
  detail?: string
}

type BrowserFixtureResult = {
  status: 'passed' | 'failed'
  fixture: typeof TEST_CASE
  browser: string
  checks: Check[]
  published: { surface: string; text: string }
  adaptive: { surface: string; text: string; contrast: number }
  plan?: {
    hash: string
    paintHash: string
    geometryHash: string
    patchCount: number
  }
  geometry?: {
    publishedTableWidth: number
    adaptiveTableWidth: number
    wrapperClientWidth: number
    wrapperScrollWidth: number
  }
  timings?: {
    publishedRenderMs: number
    adaptiveRenderMs: number
    adaptiveOverheadMs: number
    adaptiveLedgerPassMs?: number
  }
  error?: string
}

declare global {
  interface Window {
    __LUMEN_PRESENTATION_FIXTURE__?: BrowserFixtureResult
  }
}

function element<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id)
  if (!value) throw new Error(`Missing fixture element: ${id}`)
  return value as T
}

function nextFrames(count = 2): Promise<void> {
  return new Promise((resolve) => {
    const step = (remaining: number): void => {
      if (remaining <= 0) {
        resolve()
        return
      }
      requestAnimationFrame(() => step(remaining - 1))
    }
    step(count)
  })
}

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(
      () => reject(new Error(`${label} timed out`)),
      60_000,
    )
    promise.then(
      (value) => {
        window.clearTimeout(timeout)
        resolve(value)
      },
      (error: unknown) => {
        window.clearTimeout(timeout)
        reject(error)
      },
    )
  })
}

function fixtureSpineIndex(): number {
  switch (TEST_CASE) {
    case 'wide-table':
      return 1
    case 'author-theme':
      return 2
    case 'dark-foreground':
      return 3
    case 'default-foreground':
      return 4
    case 'large-index':
    case 'chapter-boundary':
      return 5
    case 'pseudo-noise':
      return 6
    case 'pseudo-dropcap':
      return 7
    case 'forged-location-ignore':
      return 8
    case 'many-color-roots':
      return 9
    case 'clipped-prose':
      return 10
    case 'occluded-callout':
      return 11
    case 'lazy-image-section':
      return 12
    case 'stroke-contrast':
      return 13
    case 'private-large-index':
      return 27
    case 'private-chapter-boundary':
      return Number.isInteger(requestedSpineIndex) && requestedSpineIndex >= 0
        ? requestedSpineIndex
        : 12
    case 'private-stroke-audit':
    case 'private-light-audit':
      return Number.isInteger(requestedSpineIndex) && requestedSpineIndex >= 0
        ? requestedSpineIndex
        : TEST_CASE === 'private-light-audit'
        ? 4
        : 0
    default:
      return 0
  }
}

function fixtureContents(rendition: Rendition) {
  const spineIndex = fixtureSpineIndex()
  const contents = rendition
    .getContents()
    .find((candidate) => candidate.sectionIndex === spineIndex)
  if (!contents) {
    throw new Error(
      `The rendered EPUB contents for spine ${spineIndex} are unavailable`,
    )
  }
  return contents
}

function hasFixtureContents(rendition: Rendition): boolean {
  const spineIndex = fixtureSpineIndex()
  return rendition
    .getContents()
    .some((candidate) => candidate.sectionIndex === spineIndex)
}

function findCallout(rendition: Rendition): HTMLElement {
  const contents = fixtureContents(rendition)
  const callout = contents?.document.querySelector('.pink-callout')
  // EPUB nodes live in the iframe's realm, so the outer realm's
  // `instanceof HTMLElement` check is false even for a valid element.
  if (!callout || callout.nodeType !== Node.ELEMENT_NODE) {
    throw new Error('The rendered EPUB callout is unavailable')
  }
  return callout as HTMLElement
}

function findWideTable(rendition: Rendition): HTMLElement {
  const contents = fixtureContents(rendition)
  const table = contents?.document.querySelector('#wide-results')
  if (!table || table.nodeType !== Node.ELEMENT_NODE) {
    throw new Error('The rendered EPUB table is unavailable')
  }
  return table as HTMLElement
}

function findAuthorCard(rendition: Rendition): HTMLElement {
  const contents = fixtureContents(rendition)
  const card = contents?.document.querySelector('.author-card')
  if (!card || card.nodeType !== Node.ELEMENT_NODE) {
    throw new Error('The rendered EPUB author theme card is unavailable')
  }
  return card as HTMLElement
}

function findForegroundProse(rendition: Rendition): HTMLElement {
  const contents = fixtureContents(rendition)
  // Measure the element that owns the glyph paint. The surrounding paragraph
  // can legitimately retain its authored color when all of its direct text is
  // inside an explicitly colored inline descendant.
  const prose = contents?.document.querySelector('#foreground-prose em')
  if (!prose || prose.nodeType !== Node.ELEMENT_NODE) {
    throw new Error('The rendered inherited foreground prose is unavailable')
  }
  return prose as HTMLElement
}

function findForegroundAccent(rendition: Rendition): HTMLElement {
  const contents = fixtureContents(rendition)
  const accent = contents?.document.querySelector('.accent')
  if (!accent || accent.nodeType !== Node.ELEMENT_NODE) {
    throw new Error('The rendered inherited foreground accent is unavailable')
  }
  return accent as HTMLElement
}

function findExplicitForeground(rendition: Rendition): HTMLElement {
  const contents = fixtureContents(rendition)
  const prose = contents?.document.querySelector('#explicit-foreground')
  if (!prose || prose.nodeType !== Node.ELEMENT_NODE) {
    throw new Error('The rendered explicit foreground prose is unavailable')
  }
  return prose as HTMLElement
}

function findColorFourForeground(rendition: Rendition): HTMLElement {
  const prose = fixtureContents(rendition).document.querySelector(
    '#color-four-foreground',
  )
  if (!prose || prose.nodeType !== Node.ELEMENT_NODE) {
    throw new Error('The rendered CSS Color 4 foreground is unavailable')
  }
  return prose as HTMLElement
}

function neutralHierarchyColors(rendition: Rendition): string[] {
  return [
    '#neutral-primary',
    '#neutral-secondary',
    '#neutral-caption',
    '#neutral-muted',
  ].map((selector) => textColor(findFixtureElement(rendition, selector)))
}

function findDefaultForegroundProse(rendition: Rendition): HTMLElement {
  const prose = fixtureContents(rendition).document.querySelector(
    '#default-foreground-prose em',
  )
  if (!prose || prose.nodeType !== Node.ELEMENT_NODE) {
    throw new Error('The rendered default inherited prose is unavailable')
  }
  return prose as HTMLElement
}

function findDefaultForegroundAccent(rendition: Rendition): HTMLElement {
  const accent =
    fixtureContents(rendition).document.querySelector('.default-accent')
  if (!accent || accent.nodeType !== Node.ELEMENT_NODE) {
    throw new Error('The rendered default foreground accent is unavailable')
  }
  return accent as HTMLElement
}

function findDefaultListMarker(rendition: Rendition): HTMLElement {
  const marker = fixtureContents(rendition).document.querySelector(
    '#default-marker-item',
  )
  if (!marker || marker.nodeType !== Node.ELEMENT_NODE) {
    throw new Error('The rendered default list marker is unavailable')
  }
  return marker as HTMLElement
}

function markerColor(element: HTMLElement): string {
  return element.ownerDocument
    .defaultView!.getComputedStyle(element, '::marker')
    .color.trim()
}

function findLargeIndexEntry(rendition: Rendition): HTMLElement {
  const entry = fixtureContents(rendition).document.querySelector(
    TEST_CASE === 'private-large-index' ? 'body' : '.index-entry',
  )
  if (!entry || entry.nodeType !== Node.ELEMENT_NODE) {
    throw new Error('The rendered large index entry is unavailable')
  }
  return entry as HTMLElement
}

function findLargeIndexLink(rendition: Rendition): HTMLElement {
  const link = fixtureContents(rendition).document.querySelector(
    TEST_CASE === 'private-large-index' ? 'body a' : '.index-entry a',
  )
  if (!link || link.nodeType !== Node.ELEMENT_NODE) {
    throw new Error('The rendered large index link is unavailable')
  }
  return link as HTMLElement
}

function findFixtureElement(
  rendition: Rendition,
  selector: string,
): HTMLElement {
  const target = fixtureContents(rendition).document.querySelector(selector)
  if (!target || target.nodeType !== Node.ELEMENT_NODE) {
    throw new Error(`The rendered fixture target is unavailable: ${selector}`)
  }
  return target as HTMLElement
}

function elementColors(element: HTMLElement): {
  surface: string
  text: string
} {
  const style = element.ownerDocument.defaultView!.getComputedStyle(element)
  const surface = parseSrgbColor(style.backgroundColor)
  const text = parseSrgbColor(style.color)
  if (!surface || !text) throw new Error('Unable to parse fixture colors')
  return { surface: srgbToHex(surface), text: srgbToHex(text) }
}

function colorsOf(rendition: Rendition): { surface: string; text: string } {
  return elementColors(findCallout(rendition))
}

function textColor(element: HTMLElement): string {
  const color = resolveComputedSrgbColor(
    element.ownerDocument.defaultView!.getComputedStyle(element).color,
    element,
  )
  if (!color) throw new Error('Unable to parse fixture text color')
  return srgbToHex(color)
}

function borderColor(
  element: HTMLElement,
  side: 'top' | 'right' | 'bottom' | 'left',
): string {
  const style = element.ownerDocument.defaultView!.getComputedStyle(element)
  const value = style.getPropertyValue(`border-${side}-color`)
  const color = resolveComputedSrgbColor(value, element)
  if (!color) throw new Error('Unable to parse fixture border color')
  return srgbToHex(color)
}

function colorContrast(colors: { surface: string; text: string }): number {
  const surface = parseSrgbColor(colors.surface)!
  const text = parseSrgbColor(colors.text)!
  return contrastRatio(text, surface)
}

function hueDistance(left: number, right: number): number {
  const distance = Math.abs(left - right) % 360
  return Math.min(distance, 360 - distance)
}

async function renderFixture(
  container: HTMLElement,
  adaptive: boolean,
): Promise<RenderedFixture> {
  const book = ePub(FIXTURE_URL)
  const renderStartedAt = performance.now()
  await withTimeout(
    book.ready.then(() => undefined),
    'EPUB open',
  )
  const bookReadyAt = performance.now()
  let replacementsReadyAt: number | undefined
  const replacementsReady = book.replacementsReady?.then(() => {
    replacementsReadyAt = performance.now()
  })
  // Archived publications render through blob-backed resource URLs. Wait for
  // their replacement table before asking the rendition for a section so the
  // browser audit observes the publication CSS, not a transient unstyled DOM.
  await replacementsReady
  const width = Math.max(
    container.clientWidth,
    TEST_CASE === 'chapter-boundary' || TEST_CASE === 'private-chapter-boundary'
      ? 1280
      : 640,
  )
  const height = Math.max(container.clientHeight, 430)
  const rendition = book.renderTo(container, {
    width,
    height,
    flow: 'paginated',
    // Exercise the harness against a real two-up view. Every assertion must
    // resolve Contents by spine identity, never by array position.
    spread:
      TEST_CASE === 'dark-foreground' ||
      TEST_CASE === 'chapter-boundary' ||
      TEST_CASE === 'private-chapter-boundary'
        ? 'both'
        : 'none',
    allowScriptedContent: false,
    allowPopups: false,
  })
  if (
    TEST_CASE === 'chapter-boundary' ||
    TEST_CASE === 'private-chapter-boundary'
  ) {
    // Match the reader's always-on stylesheet. In particular, the root width
    // override participates in column geometry at a spine transition.
    rendition.themes.default({
      html: {
        padding: '0 !important',
        width: '100% !important',
        'max-width': '100% !important',
        margin: '0 !important',
      },
      body: { background: 'transparent' },
      iframe: {
        width: '100% !important',
        height: '100% !important',
      },
      'a:any-link': {
        color: 'var(--lumen-reader-link-color, #1d4ed8)',
        'text-decoration': 'none !important',
      },
    })
  }
  if (
    TEST_CASE === 'private-dark-audit' ||
    TEST_CASE === 'private-stroke-audit'
  ) {
    // Match the reader's always-on navigation rule; otherwise a raw engine
    // audit misclassifies authored TOC links that Lumen renders in blue.
    rendition.themes.default({
      'a:any-link': {
        color: '#3b82f6 !important',
        'text-decoration': 'none !important',
      },
    })
  }

  let engine: LumenPresentationEngine | undefined
  let outcome: LumenPresentationOutcome | undefined
  const outcomes: LumenPresentationOutcome[] = []
  let resolveOutcome: ((value: LumenPresentationOutcome) => void) | undefined
  const outcomePromise = new Promise<LumenPresentationOutcome>((resolve) => {
    resolveOutcome = resolve
  })
  if (adaptive) {
    engine = new LumenPresentationEngine(rendition, {
      resolveGeometryPipelineFingerprint: () =>
        `adaptive-presentation-v1|case:${TEST_CASE}`,
      resolvePolicy: () => ({
        enabled: true,
        mode: 'adaptive',
        colorScheme:
          TEST_CASE === 'wide-table' || TEST_CASE === 'private-light-audit'
            ? 'light'
            : 'dark',
        canvasColor:
          TEST_CASE === 'wide-table' ? '#f8fafc' : ACTIVE_CANVAS_COLOR,
        publicationRevision: `${TEST_CASE}-browser-fixture-v1`,
        analysisFingerprint: `${TEST_CASE}-analysis-v1`,
        renderingContextFingerprint: `case:${TEST_CASE}|browser:${navigator.userAgent}|viewport:${width}x${height}`,
      }),
      onOutcome: (value) => {
        outcomes.push(value)
        if (value.spineIndex !== fixtureSpineIndex()) return
        outcome = value
        if (value.status !== 'cancelled') resolveOutcome?.(value)
      },
    }).attach()
  }

  const displayStartedAt = performance.now()
  let initialJumpMs: number | undefined
  if (TEST_CASE === 'private-chapter-boundary') {
    // Reproduce the Reader startup race: its restore starts on an animation
    // frame, while the TOC remains available for an immediate user jump.
    const initialDisplay = rendition.display(0).then(() => undefined)
    await nextFrames(1)
    const jumpStartedAt = performance.now()
    await withTimeout(
      rendition.display(fixtureSpineIndex()).then(() => undefined),
      'EPUB initial TOC jump',
    )
    initialJumpMs = performance.now() - jumpStartedAt
    await initialDisplay
  } else {
    await withTimeout(
      rendition.display(fixtureSpineIndex()).then(() => undefined),
      'EPUB display',
    )
  }
  const displayFinishedAt = performance.now()
  if (adaptive) {
    await withTimeout(outcomePromise, 'Adaptive presentation outcome')
  }
  await nextFrames(3)
  return {
    book,
    rendition,
    engine,
    outcome,
    outcomes,
    bookReadyMs: bookReadyAt - renderStartedAt,
    replacementsReadyMs:
      replacementsReadyAt === undefined
        ? undefined
        : replacementsReadyAt - renderStartedAt,
    displayMs: displayFinishedAt - displayStartedAt,
    initialJumpMs,
    renderDurationMs: performance.now() - renderStartedAt,
  }
}

function disposeFixture(fixture: RenderedFixture | undefined): void {
  if (!fixture) return
  fixture.engine?.detach()
  fixture.book.destroy()
}

function appendChecks(checks: Check[]): void {
  const list = element<HTMLUListElement>('checks')
  list.replaceChildren()
  for (const check of checks) {
    const item = document.createElement('li')
    item.className = `check${check.passed ? '' : ' check-failed'}`
    item.textContent = check.detail
      ? `${check.label} — ${check.detail}`
      : check.label
    list.appendChild(item)
  }
}

function publishResult(result: BrowserFixtureResult): void {
  window.__LUMEN_PRESENTATION_FIXTURE__ = result
  document.documentElement.dataset.fixtureStatus = result.status
  document.documentElement.dataset.fixtureChecks = String(result.checks.length)
  const status = element('status')
  status.className = `status status-${result.status}`
  status.textContent =
    result.status === 'passed'
      ? `Aprovado · ${result.checks.length} checks`
      : 'Falhou · veja o diagnóstico'
  element('result-json').textContent = JSON.stringify(result, null, 2)
  appendChecks(result.checks)
  console.info(`LUMEN_PRESENTATION_FIXTURE:${result.status.toUpperCase()}`)
  void fetch('/fixture-result', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(result),
  }).catch((error: unknown) => {
    console.warn(
      'Unable to report the fixture result to the local runner',
      error,
    )
  })
}

function planSummary(outcome: LumenPresentationOutcome | undefined) {
  const plan = outcome?.accepted?.plan
  return plan
    ? {
        hash: plan.planHash,
        paintHash: plan.paintPlanHash,
        geometryHash: plan.geometryPlanHash,
        patchCount: plan.patches.length,
      }
    : undefined
}

async function runWideTableCase(
  published: RenderedFixture,
  adaptive: RenderedFixture,
  rollback: RenderedFixture,
): Promise<void> {
  const publishedTable = findWideTable(published.rendition)
  const adaptiveTable = findWideTable(adaptive.rendition)
  const adaptiveWrapper = adaptiveTable.closest(
    '[data-lumen-overflow-wrapper]',
  ) as HTMLElement | null
  const acceptedPlan = adaptive.outcome?.accepted?.plan
  const validation = adaptive.outcome?.validation
  const publishedWidth = publishedTable.getBoundingClientRect().width
  const adaptiveWidth = adaptiveTable.getBoundingClientRect().width
  const wrapperClientWidth = adaptiveWrapper?.clientWidth ?? 0
  const wrapperScrollWidth = adaptiveWrapper?.scrollWidth ?? 0
  const publishedRows = publishedTable.querySelectorAll('tr').length
  const publishedCells = publishedTable.querySelectorAll('th, td').length

  const rollbackTable = findWideTable(rollback.rendition)
  const rollbackHadWrapper = Boolean(
    rollbackTable.closest('[data-lumen-overflow-wrapper]'),
  )
  const authoredStyle = rollbackTable.getAttribute('style')
  rollback.engine!.detach()
  await nextFrames(2)
  const rollbackRestored =
    !rollbackTable.closest('[data-lumen-overflow-wrapper]') &&
    rollbackTable.getAttribute('style') === authoredStyle

  const measurementSession = new LayoutMeasurementSession({
    book: adaptive.book,
    renderer: {
      layout: {
        layout: 'reflowable',
        flow: 'paginated',
        spread: 'none',
        minSpreadWidth: 800,
      },
      width: Math.max(element<HTMLElement>('adaptive-reader').clientWidth, 640),
      height: Math.max(
        element<HTMLElement>('adaptive-reader').clientHeight,
        430,
      ),
      direction: 'ltr',
    },
    paginationLifecycle: adaptive.rendition.getPaginationLifecycle(),
  })
  let atlasMeasurements: SectionLayoutMeasurement[]
  try {
    atlasMeasurements = await withTimeout(
      measurementSession.measure(),
      'Atlas geometry measurement',
    )
  } finally {
    measurementSession.destroy()
  }
  const wideTableMeasurement = atlasMeasurements.find(
    (measurement) => measurement.spineIndex === 1,
  )

  const checks: Check[] = [
    {
      id: 'real-epub',
      label: 'EPUB real aberto e paginado pelo motor',
      passed:
        hasFixtureContents(published.rendition) &&
        hasFixtureContents(adaptive.rendition),
    },
    {
      id: 'accepted',
      label: 'Plano geométrico passou pelo gate',
      passed:
        adaptive.outcome?.status === 'adapted' &&
        acceptedPlan?.patches.some(
          (patch) => patch.operation === 'contain-overflow',
        ) === true,
      detail: [
        adaptive.outcome?.status,
        ...(adaptive.outcome?.diagnostics.map((entry) => entry.code) ?? []),
      ]
        .filter(Boolean)
        .join(' · '),
    },
    {
      id: 'geometry-hash',
      label: 'Paint e geometria entraram apenas nas identidades corretas',
      passed:
        Boolean(acceptedPlan) &&
        acceptedPlan!.paintPlanHash !== acceptedPlan!.geometryPlanHash &&
        acceptedPlan!.patches.every(
          (patch) =>
            (patch.operation === 'contain-overflow' &&
              !patch.effects.paint &&
              patch.effects.geometry === 'local') ||
            (patch.operation === 'restore-visible-stroke' &&
              patch.effects.paint &&
              patch.effects.geometry === 'none'),
        ),
    },
    {
      id: 'contained',
      label: 'Tabela larga ficou alcançável por rolagem local',
      passed:
        Boolean(adaptiveWrapper) &&
        wrapperClientWidth > 0 &&
        wrapperClientWidth < adaptiveWidth &&
        wrapperScrollWidth >= adaptiveWidth - 1,
      detail: `${Math.round(wrapperClientWidth)}px ↔ ${Math.round(
        wrapperScrollWidth,
      )}px`,
    },
    {
      id: 'not-scaled',
      label: 'Conteúdo autoral não foi esmagado ou reescalado',
      passed: adaptiveWidth >= publishedWidth - 1,
      detail: `${Math.round(publishedWidth)}px → ${Math.round(
        adaptiveWidth,
      )}px`,
    },
    {
      id: 'semantics',
      label: 'Linhas e células semânticas foram preservadas',
      passed:
        adaptiveTable.querySelectorAll('tr').length === publishedRows &&
        adaptiveTable.querySelectorAll('th, td').length === publishedCells,
      detail: `${publishedRows} linhas · ${publishedCells} células`,
    },
    {
      id: 'stable',
      label: 'Repaginação atingiu geometria estável',
      passed: validation?.geometryStable === true,
    },
    {
      id: 'atlas-geometry-identity',
      label: 'Atlas mediu a mesma projeção geométrica admitida',
      passed:
        Boolean(acceptedPlan?.geometryPlanHash) &&
        wideTableMeasurement?.presentationGeometryPlanHashes.length === 1 &&
        wideTableMeasurement.presentationGeometryPlanHashes[0] ===
          acceptedPlan?.geometryPlanHash,
      detail: `${
        wideTableMeasurement?.presentationGeometryPlanHashes.length ?? 0
      } hash geométrico`,
    },
    {
      id: 'reversible',
      label: 'Detach removeu só a projeção Lumen',
      passed: rollbackHadWrapper && rollbackRestored,
    },
  ]

  element('published-color').textContent = `${Math.round(publishedWidth)}px`
  element('adaptive-color').textContent = `${Math.round(
    wrapperClientWidth,
  )}px viewport`
  publishResult({
    status: checks.every((check) => check.passed) ? 'passed' : 'failed',
    fixture: TEST_CASE,
    browser: navigator.userAgent,
    checks,
    published: { surface: 'not-applicable', text: 'not-applicable' },
    adaptive: {
      surface: 'not-applicable',
      text: 'not-applicable',
      contrast: 0,
    },
    plan: planSummary(adaptive.outcome),
    geometry: {
      publishedTableWidth: publishedWidth,
      adaptiveTableWidth: adaptiveWidth,
      wrapperClientWidth,
      wrapperScrollWidth,
    },
  })

  const toggle = element<HTMLButtonElement>('published-toggle')
  toggle.disabled = false
  toggle.addEventListener('click', () => {
    adaptive.engine?.detach()
    toggle.disabled = true
    toggle.textContent = 'Published restaurado — recarregue para Adaptive'
    element('adaptive-color').textContent = 'Published'
  })
}

function authoredMediaTexts(rendition: Rendition): string[] {
  const contents = fixtureContents(rendition)
  const sheet = contents?.document.styleSheets[0]
  if (!sheet) return []
  const values: string[] = []
  const seen = new Set<CSSStyleSheet>()
  const visitRules = (rules: CSSRuleList): void => {
    Array.from(rules).forEach((rule) => {
      if ('media' in rule) {
        const mediaText = (rule as CSSMediaRule).media.mediaText
        if (
          mediaText.includes('prefers-color-scheme') ||
          mediaText === 'all' ||
          mediaText === 'not all'
        ) {
          values.push(mediaText)
        }
      }
      if (rule.type === CSSRule.IMPORT_RULE) {
        const imported = (rule as CSSImportRule).styleSheet
        if (imported) visitSheet(imported)
      } else if ('cssRules' in rule) {
        visitRules((rule as CSSGroupingRule).cssRules)
      }
    })
  }
  const visitSheet = (current: CSSStyleSheet): void => {
    if (seen.has(current)) return
    seen.add(current)
    visitRules(current.cssRules)
  }
  visitSheet(sheet)
  return values
}

async function runAuthorThemeCase(
  published: RenderedFixture,
  adaptive: RenderedFixture,
  rollback: RenderedFixture,
): Promise<void> {
  const publishedCard = findAuthorCard(published.rendition)
  const adaptiveCard = findAuthorCard(adaptive.rendition)
  const publishedColors = elementColors(publishedCard)
  const adaptiveColors = elementColors(adaptiveCard)
  const adaptiveContrast = colorContrast(adaptiveColors)
  const acceptedPlan = adaptive.outcome?.accepted?.plan
  const validation = adaptive.outcome?.validation
  const authoredCssBefore =
    publishedCard.ownerDocument.querySelector('style')?.textContent
  const authoredCssAfter =
    adaptiveCard.ownerDocument.querySelector('style')?.textContent
  const adaptiveMedia = authoredMediaTexts(adaptive.rendition)

  const rollbackCard = findAuthorCard(rollback.rendition)
  const rollbackBefore = elementColors(rollbackCard)
  const rollbackMediaBefore = authoredMediaTexts(rollback.rendition)
  rollback.engine!.detach()
  await nextFrames(2)
  const rollbackAfter = elementColors(rollbackCard)
  const rollbackMediaAfter = authoredMediaTexts(rollback.rendition)

  const measurementSession = new LayoutMeasurementSession({
    book: adaptive.book,
    renderer: {
      layout: {
        layout: 'reflowable',
        flow: 'paginated',
        spread: 'none',
        minSpreadWidth: 800,
      },
      width: Math.max(element<HTMLElement>('adaptive-reader').clientWidth, 640),
      height: Math.max(
        element<HTMLElement>('adaptive-reader').clientHeight,
        430,
      ),
      direction: 'ltr',
    },
    paginationLifecycle: adaptive.rendition.getPaginationLifecycle(),
  })
  let atlasMeasurements: SectionLayoutMeasurement[]
  try {
    atlasMeasurements = await withTimeout(
      measurementSession.measure(),
      'Atlas author theme measurement',
    )
  } catch (error) {
    const latest = adaptive.outcomes[adaptive.outcomes.length - 1]
    throw new Error(
      `${
        error instanceof Error ? error.message : String(error)
      }; latest outcome: ${JSON.stringify(
        latest
          ? {
              status: latest.status,
              reason: latest.reason,
              diagnostics: latest.diagnostics,
              validation: latest.validation,
            }
          : undefined,
      )}`,
    )
  } finally {
    measurementSession.destroy()
  }
  const authorThemeMeasurement = atlasMeasurements.find(
    (measurement) => measurement.spineIndex === 2,
  )
  const acceptedAuthorTheme = acceptedPlan?.patches.some(
    (patch) => patch.operation === 'activate-author-theme',
  )

  const checks: Check[] = [
    {
      id: 'real-epub',
      label: 'EPUB autoral aberto e paginado pelo motor',
      passed:
        hasFixtureContents(published.rendition) &&
        hasFixtureContents(adaptive.rendition),
    },
    {
      id: 'accepted',
      label: 'Tema autoral passou pelo gate de admissão',
      passed:
        adaptive.outcome?.status === 'adapted' && acceptedAuthorTheme === true,
      detail: adaptive.outcome?.status,
    },
    {
      id: 'cssom-cascade',
      label: 'Ramos CSSOM foram alternados no lugar original da cascata',
      passed: adaptiveMedia.join('|') === 'not all|all',
      detail: adaptiveMedia.join(' · '),
    },
    {
      id: 'custom-properties',
      label: 'Variáveis autorais produziram a paleta escura esperada',
      passed:
        adaptiveColors.surface === '#16120f' &&
        adaptiveColors.text === '#f7efe5',
      detail: `${adaptiveColors.surface} · ${adaptiveColors.text}`,
    },
    {
      id: 'contrast',
      label: 'Contraste autoral foi validado',
      passed: adaptiveContrast >= 4.5,
      detail: `${adaptiveContrast.toFixed(2)}:1`,
    },
    {
      id: 'source-css-untouched',
      label: 'Texto CSS da publicação permaneceu intacto',
      passed: authoredCssBefore === authoredCssAfter,
    },
    {
      id: 'geometry-identity',
      label: 'Tema foi tratado conservadoramente como geometria de seção',
      passed:
        acceptedPlan?.patches.every(
          (patch) =>
            patch.operation === 'activate-author-theme' &&
            patch.effects.paint &&
            patch.effects.geometry === 'section',
        ) === true,
    },
    {
      id: 'stable',
      label: 'Tema atingiu paginação estável',
      passed: validation?.geometryStable === true,
    },
    {
      id: 'atlas-geometry-identity',
      label: 'Atlas recebeu a mesma identidade do tema admitido',
      passed:
        authorThemeMeasurement?.presentationGeometryPlanHashes.length === 1 &&
        authorThemeMeasurement.presentationGeometryPlanHashes[0] ===
          acceptedPlan?.geometryPlanHash,
    },
    {
      id: 'reversible',
      label: 'Detach restaurou cores e condições autorais',
      passed:
        rollbackBefore.surface === adaptiveColors.surface &&
        rollbackAfter.surface === publishedColors.surface &&
        rollbackAfter.text === publishedColors.text &&
        rollbackMediaBefore.join('|') === 'not all|all' &&
        rollbackMediaAfter.join('|').includes('prefers-color-scheme'),
    },
  ]

  element('published-color').textContent = publishedColors.surface
  element('adaptive-color').textContent = adaptiveColors.surface
  publishResult({
    status: checks.every((check) => check.passed) ? 'passed' : 'failed',
    fixture: TEST_CASE,
    browser: navigator.userAgent,
    checks,
    published: publishedColors,
    adaptive: { ...adaptiveColors, contrast: adaptiveContrast },
    plan: planSummary(adaptive.outcome),
  })
}

async function runDarkForegroundCase(
  published: RenderedFixture,
  adaptive: RenderedFixture,
  rollback: RenderedFixture,
): Promise<void> {
  const publishedProse = findForegroundProse(published.rendition)
  const adaptiveProse = findForegroundProse(adaptive.rendition)
  const publishedAccent = findForegroundAccent(published.rendition)
  const adaptiveAccent = findForegroundAccent(adaptive.rendition)
  const publishedExplicit = findExplicitForeground(published.rendition)
  const adaptiveExplicit = findExplicitForeground(adaptive.rendition)
  const publishedColorFour = findColorFourForeground(published.rendition)
  const adaptiveColorFour = findColorFourForeground(adaptive.rendition)
  const publishedAuthorMarker = publishedProse.ownerDocument.querySelector(
    '#author-marker-collision',
  ) as HTMLElement
  const adaptiveAuthorMarker = adaptiveProse.ownerDocument.querySelector(
    '#author-marker-collision',
  ) as HTMLElement
  const publishedText = textColor(publishedProse)
  const adaptiveText = textColor(adaptiveProse)
  const publishedAccentText = textColor(publishedAccent)
  const adaptiveAccentText = textColor(adaptiveAccent)
  const publishedExplicitText = textColor(publishedExplicit)
  const adaptiveExplicitText = textColor(adaptiveExplicit)
  const publishedColorFourText = textColor(publishedColorFour)
  const adaptiveColorFourText = textColor(adaptiveColorFour)
  const publishedNeutralHierarchy = neutralHierarchyColors(published.rendition)
  const adaptiveNeutralHierarchy = neutralHierarchyColors(adaptive.rendition)
  const publishedAuthorMarkerText = textColor(publishedAuthorMarker)
  const adaptiveAuthorMarkerText = textColor(adaptiveAuthorMarker)
  const canvas = parseSrgbColor(CANVAS_COLOR)!
  const publishedContrast = contrastRatio(
    parseSrgbColor(publishedText)!,
    canvas,
  )
  const adaptiveContrast = contrastRatio(parseSrgbColor(adaptiveText)!, canvas)
  const publishedExplicitContrast = contrastRatio(
    parseSrgbColor(publishedExplicitText)!,
    canvas,
  )
  const adaptiveExplicitContrast = contrastRatio(
    parseSrgbColor(adaptiveExplicitText)!,
    canvas,
  )
  const publishedAccentColor = parseSrgbColor(publishedAccentText)!
  const adaptiveAccentColor = parseSrgbColor(adaptiveAccentText)!
  const publishedAccentContrast = contrastRatio(publishedAccentColor, canvas)
  const adaptiveAccentContrast = contrastRatio(adaptiveAccentColor, canvas)
  const accentHueDelta = hueDistance(
    srgbToOklch(publishedAccentColor).h,
    srgbToOklch(adaptiveAccentColor).h,
  )
  const publishedColorFourColor = parseSrgbColor(publishedColorFourText)!
  const adaptiveColorFourColor = parseSrgbColor(adaptiveColorFourText)!
  const publishedColorFourContrast = contrastRatio(
    publishedColorFourColor,
    canvas,
  )
  const adaptiveColorFourContrast = contrastRatio(
    adaptiveColorFourColor,
    canvas,
  )
  const colorFourHueDelta = hueDistance(
    srgbToOklch(publishedColorFourColor).h,
    srgbToOklch(adaptiveColorFourColor).h,
  )
  const acceptedPlan = adaptive.outcome?.accepted?.plan
  const validation = adaptive.outcome?.validation
  const publishedCss =
    publishedProse.ownerDocument.querySelector('style')?.textContent
  const adaptiveAuthoredCss = Array.from(
    adaptiveProse.ownerDocument.querySelectorAll('style'),
  ).find(
    (style) => !style.hasAttribute('data-lumen-presentation-layer'),
  )?.textContent
  const rollbackProse = findForegroundProse(rollback.rendition)
  const rollbackAccent = findForegroundAccent(rollback.rendition)
  const rollbackExplicit = findExplicitForeground(rollback.rendition)
  const rollbackColorFour = findColorFourForeground(rollback.rendition)
  const rollbackBeforeText = textColor(rollbackProse)
  const rollbackBeforeAccent = textColor(rollbackAccent)
  const rollbackBeforeExplicit = textColor(rollbackExplicit)
  const rollbackBeforeColorFour = textColor(rollbackColorFour)
  const rollbackBeforeNeutralHierarchy = neutralHierarchyColors(
    rollback.rendition,
  )
  rollback.engine!.detach()
  await nextFrames(2)
  const rollbackAfterText = textColor(rollbackProse)
  const rollbackAfterAccent = textColor(rollbackAccent)
  const rollbackAfterExplicit = textColor(rollbackExplicit)
  const rollbackAfterColorFour = textColor(rollbackColorFour)
  const rollbackAfterNeutralHierarchy = neutralHierarchyColors(
    rollback.rendition,
  )
  const adaptiveNeutralLightness = adaptiveNeutralHierarchy.map(
    (color) => srgbToOklch(parseSrgbColor(color)!).l,
  )

  const measurementSession = new LayoutMeasurementSession({
    book: adaptive.book,
    renderer: {
      layout: {
        layout: 'reflowable',
        flow: 'paginated',
        spread: 'none',
        minSpreadWidth: 800,
      },
      width: Math.max(element<HTMLElement>('adaptive-reader').clientWidth, 640),
      height: Math.max(
        element<HTMLElement>('adaptive-reader').clientHeight,
        430,
      ),
      direction: 'ltr',
    },
    paginationLifecycle: adaptive.rendition.getPaginationLifecycle(),
  })
  let atlasMeasurements: SectionLayoutMeasurement[]
  try {
    atlasMeasurements = await withTimeout(
      measurementSession.measure(),
      'Atlas inherited foreground measurement',
    )
  } finally {
    measurementSession.destroy()
  }
  const foregroundMeasurement = atlasMeasurements.find(
    (measurement) => measurement.spineIndex === 3,
  )

  const checks: Check[] = [
    {
      id: 'real-epub',
      label: 'EPUB real aberto e paginado pelo motor',
      passed:
        hasFixtureContents(published.rendition) &&
        hasFixtureContents(adaptive.rendition),
    },
    {
      id: 'accepted',
      label: 'Reparos locais de texto passaram pelo gate',
      passed:
        adaptive.outcome?.status === 'adapted' &&
        acceptedPlan?.patches.filter(
          (patch) => patch.operation === 'restore-explicit-text',
        ).length === 8,
      detail: adaptive.outcome?.status,
    },
    {
      id: 'explicit-contrast',
      label: 'Cinza explÃ­cito recebeu reparo local de contraste',
      passed:
        publishedExplicitContrast < 4.5 && adaptiveExplicitContrast >= 4.5,
      detail: `${publishedExplicitContrast.toFixed(
        2,
      )}:1 â†’ ${adaptiveExplicitContrast.toFixed(2)}:1`,
    },
    {
      id: 'contrast',
      label: 'Texto ilegível atingiu contraste de leitura',
      passed: publishedContrast < 4.5 && adaptiveContrast >= 4.5,
      detail: `${publishedContrast.toFixed(2)}:1 → ${adaptiveContrast.toFixed(
        2,
      )}:1`,
    },
    {
      id: 'accent-readable-hue-preserved',
      label: 'Rosa autoral ilegível ganhou contraste sem trocar de matiz',
      passed:
        publishedAccentContrast < 4.5 &&
        adaptiveAccentContrast >= 4.5 &&
        accentHueDelta <= 2,
      detail: `${publishedAccentText} ${publishedAccentContrast.toFixed(
        2,
      )}:1 → ${adaptiveAccentText} ${adaptiveAccentContrast.toFixed(
        2,
      )}:1 · Δh ${accentHueDelta.toFixed(1)}°`,
    },
    {
      id: 'css-color-4',
      label: 'OKLCH foi resolvido pelo pixel pintado nos dois navegadores',
      passed:
        publishedColorFourContrast < 4.5 &&
        adaptiveColorFourContrast >= 4.5 &&
        colorFourHueDelta <= 2,
      detail: `${publishedColorFourText} ${publishedColorFourContrast.toFixed(
        2,
      )}:1 → ${adaptiveColorFourText} ${adaptiveColorFourContrast.toFixed(
        2,
      )}:1 · Δh ${colorFourHueDelta.toFixed(1)}°`,
    },
    {
      id: 'neutral-hierarchy-preserved',
      label: 'Quatro tons neutros permaneceram distintos e ordenados',
      passed:
        new Set(adaptiveNeutralHierarchy).size === 4 &&
        adaptiveNeutralHierarchy.every(
          (color) => contrastRatio(parseSrgbColor(color)!, canvas) >= 7,
        ) &&
        adaptiveNeutralLightness.every(
          (lightness, index) =>
            index === 0 || adaptiveNeutralLightness[index - 1]! > lightness,
        ),
      detail: `${publishedNeutralHierarchy.join(
        ',',
      )} -> ${adaptiveNeutralHierarchy.join(',')}`,
    },
    {
      id: 'pseudo-debt',
      label: 'Pseudo-elemento ficou explicitamente registrado como dívida',
      passed:
        (adaptive.outcome?.legibility?.unknownPaintByReason['pseudo-element'] ??
          0) >= 1,
      detail: String(
        adaptive.outcome?.legibility?.unknownPaintByReason['pseudo-element'] ??
          0,
      ),
    },
    {
      id: 'runtime-marker-collision',
      label: 'Atributo autoral igual ao marcador legado não recebeu o reparo',
      passed: adaptiveAuthorMarkerText === publishedAuthorMarkerText,
      detail: adaptiveAuthorMarkerText,
    },
    {
      id: 'paint-only',
      label: 'Reparo permaneceu estritamente paint-only',
      passed:
        acceptedPlan?.patches.every(
          (patch) => patch.effects.paint && patch.effects.geometry === 'none',
        ) === true && validation?.geometryStable === true,
    },
    {
      id: 'source-css-untouched',
      label: 'CSS autoral permaneceu intacto',
      passed: publishedCss === adaptiveAuthoredCss,
    },
    {
      id: 'atlas-paint-isolation',
      label: 'Atlas não recebeu identidade geométrica por paint',
      passed:
        foregroundMeasurement?.presentationGeometryPlanHashes.length === 0,
    },
    {
      id: 'reversible',
      label: 'Detach restaurou exatamente a apresentação Published',
      passed:
        rollbackBeforeText === adaptiveText &&
        rollbackBeforeAccent === adaptiveAccentText &&
        rollbackBeforeExplicit === adaptiveExplicitText &&
        rollbackBeforeColorFour === adaptiveColorFourText &&
        rollbackBeforeNeutralHierarchy.join(',') ===
          adaptiveNeutralHierarchy.join(',') &&
        rollbackAfterText === publishedText &&
        rollbackAfterAccent === publishedAccentText &&
        rollbackAfterExplicit === publishedExplicitText &&
        rollbackAfterColorFour === publishedColorFourText &&
        rollbackAfterNeutralHierarchy.join(',') ===
          publishedNeutralHierarchy.join(','),
    },
  ]

  element('published-color').textContent = publishedText
  element('adaptive-color').textContent = adaptiveText
  publishResult({
    status: checks.every((check) => check.passed) ? 'passed' : 'failed',
    fixture: TEST_CASE,
    browser: navigator.userAgent,
    checks,
    published: { surface: CANVAS_COLOR, text: publishedText },
    adaptive: {
      surface: CANVAS_COLOR,
      text: adaptiveText,
      contrast: adaptiveContrast,
    },
    plan: planSummary(adaptive.outcome),
    timings: {
      publishedRenderMs: published.renderDurationMs,
      adaptiveRenderMs: adaptive.renderDurationMs,
      adaptiveOverheadMs:
        adaptive.renderDurationMs - published.renderDurationMs,
    },
  })
}

async function runDefaultForegroundCase(
  published: RenderedFixture,
  adaptive: RenderedFixture,
  rollback: RenderedFixture,
): Promise<void> {
  const publishedProse = findDefaultForegroundProse(published.rendition)
  const adaptiveProse = findDefaultForegroundProse(adaptive.rendition)
  const publishedAccent = findDefaultForegroundAccent(published.rendition)
  const adaptiveAccent = findDefaultForegroundAccent(adaptive.rendition)
  const publishedMarker = findDefaultListMarker(published.rendition)
  const adaptiveMarker = findDefaultListMarker(adaptive.rendition)
  const publishedText = textColor(publishedProse)
  const adaptiveText = textColor(adaptiveProse)
  const publishedAccentText = textColor(publishedAccent)
  const adaptiveAccentText = textColor(adaptiveAccent)
  const publishedMarkerText = markerColor(publishedMarker)
  const adaptiveMarkerText = markerColor(adaptiveMarker)
  const canvas = parseSrgbColor(CANVAS_COLOR)!
  const publishedContrast = contrastRatio(
    parseSrgbColor(publishedText)!,
    canvas,
  )
  const adaptiveContrast = contrastRatio(parseSrgbColor(adaptiveText)!, canvas)
  const publishedAccentColor = parseSrgbColor(publishedAccentText)!
  const adaptiveAccentColor = parseSrgbColor(adaptiveAccentText)!
  const publishedAccentContrast = contrastRatio(publishedAccentColor, canvas)
  const adaptiveAccentContrast = contrastRatio(adaptiveAccentColor, canvas)
  const publishedMarkerContrast = contrastRatio(
    parseSrgbColor(publishedMarkerText)!,
    canvas,
  )
  const adaptiveMarkerContrast = contrastRatio(
    parseSrgbColor(adaptiveMarkerText)!,
    canvas,
  )
  const accentHueDelta = hueDistance(
    srgbToOklch(publishedAccentColor).h,
    srgbToOklch(adaptiveAccentColor).h,
  )
  const acceptedPlan = adaptive.outcome?.accepted?.plan
  const validation = adaptive.outcome?.validation
  const authoredCss =
    publishedProse.ownerDocument.querySelector('style')?.textContent
  const adaptiveAuthoredCss = Array.from(
    adaptiveProse.ownerDocument.querySelectorAll('style'),
  ).find(
    (style) => !style.hasAttribute('data-lumen-presentation-layer'),
  )?.textContent
  const sourceDocument = await adaptive.book.spine
    .get(fixtureSpineIndex())
    ?.loadSource()
  const sourceProse = sourceDocument?.querySelector(
    '#default-foreground-prose em',
  )

  const rollbackProse = findDefaultForegroundProse(rollback.rendition)
  const rollbackAccent = findDefaultForegroundAccent(rollback.rendition)
  const rollbackMarker = findDefaultListMarker(rollback.rendition)
  const rollbackBeforeText = textColor(rollbackProse)
  const rollbackBeforeAccent = textColor(rollbackAccent)
  const rollbackBeforeMarker = markerColor(rollbackMarker)
  rollback.engine!.detach()
  await nextFrames(2)
  const rollbackAfterText = textColor(rollbackProse)
  const rollbackAfterAccent = textColor(rollbackAccent)
  const rollbackAfterMarker = markerColor(rollbackMarker)

  const checks: Check[] = [
    {
      id: 'real-epub',
      label: 'EPUB sem color autoral foi aberto e paginado pelo motor',
      passed:
        hasFixtureContents(published.rendition) &&
        hasFixtureContents(adaptive.rendition),
    },
    {
      id: 'accepted',
      label: 'Foreground padrao herdado passou pelo gate',
      passed:
        adaptive.outcome?.status === 'adapted' &&
        acceptedPlan?.patches.length === 3 &&
        acceptedPlan.patches.filter(
          (patch) => patch.operation === 'restore-explicit-text',
        ).length === 2 &&
        acceptedPlan.patches.filter(
          (patch) => patch.operation === 'restore-list-marker',
        ).length === 1,
      detail: adaptive.outcome?.status,
    },
    {
      id: 'marker-contrast',
      label: 'Marcador default preto atingiu contraste de leitura',
      passed: publishedMarkerContrast < 4.5 && adaptiveMarkerContrast >= 4.5,
      detail: `${publishedMarkerContrast.toFixed(
        2,
      )}:1 -> ${adaptiveMarkerContrast.toFixed(2)}:1`,
    },
    {
      id: 'contrast',
      label: 'Texto default preto atingiu contraste de leitura',
      passed: publishedContrast < 4.5 && adaptiveContrast >= 4.5,
      detail: `${publishedContrast.toFixed(2)}:1 -> ${adaptiveContrast.toFixed(
        2,
      )}:1`,
    },
    {
      id: 'accent-readable-hue-preserved',
      label: 'Acento rosa ganhou contraste sem perder o matiz autoral',
      passed:
        publishedAccentContrast < 4.5 &&
        adaptiveAccentContrast >= 4.5 &&
        accentHueDelta <= 2,
      detail: `${publishedAccentText} ${publishedAccentContrast.toFixed(
        2,
      )}:1 -> ${adaptiveAccentText} ${adaptiveAccentContrast.toFixed(
        2,
      )}:1 · delta-h ${accentHueDelta.toFixed(1)}deg`,
    },
    {
      id: 'paint-only',
      label: 'Reparo default permaneceu paint-only',
      passed:
        acceptedPlan?.patches.every(
          (patch) =>
            patch.effects.paint &&
            patch.effects.geometry === 'none' &&
            patch.effects.semantics === 'none',
        ) === true && validation?.geometryStable === true,
    },
    {
      id: 'source-css-untouched',
      label: 'CSS e markup autorais permaneceram intactos',
      passed:
        authoredCss === adaptiveAuthoredCss &&
        publishedProse.getAttribute('style') === null &&
        sourceProse?.nodeType === Node.ELEMENT_NODE &&
        sourceProse.getAttribute('style') === null,
    },
    {
      id: 'reversible',
      label: 'Detach restaurou o foreground default exatamente',
      passed:
        rollbackBeforeText === adaptiveText &&
        rollbackBeforeAccent === adaptiveAccentText &&
        rollbackBeforeMarker === adaptiveMarkerText &&
        rollbackAfterText === publishedText &&
        rollbackAfterAccent === publishedAccentText &&
        rollbackAfterMarker === publishedMarkerText,
    },
  ]

  element('published-color').textContent = publishedText
  element('adaptive-color').textContent = adaptiveText
  publishResult({
    status: checks.every((check) => check.passed) ? 'passed' : 'failed',
    fixture: TEST_CASE,
    browser: navigator.userAgent,
    checks,
    published: { surface: CANVAS_COLOR, text: publishedText },
    adaptive: {
      surface: CANVAS_COLOR,
      text: adaptiveText,
      contrast: adaptiveContrast,
    },
    plan: planSummary(adaptive.outcome),
  })
}

async function runStrokeContrastCase(
  published: RenderedFixture,
  adaptive: RenderedFixture,
  rollback: RenderedFixture,
): Promise<void> {
  const publishedLine = findFixtureElement(
    published.rendition,
    '#worksheet-line',
  )
  const adaptiveLine = findFixtureElement(adaptive.rendition, '#worksheet-line')
  const publishedCell = findFixtureElement(published.rendition, '#stroke-cell')
  const adaptiveCell = findFixtureElement(adaptive.rendition, '#stroke-cell')
  const publishedLineColor = borderColor(publishedLine, 'bottom')
  const adaptiveLineColor = borderColor(adaptiveLine, 'bottom')
  const publishedCellColor = borderColor(publishedCell, 'top')
  const adaptiveCellColor = borderColor(adaptiveCell, 'top')
  const canvas = parseSrgbColor(CANVAS_COLOR)!
  const publishedLineContrast = contrastRatio(
    parseSrgbColor(publishedLineColor)!,
    canvas,
  )
  const adaptiveLineContrast = contrastRatio(
    parseSrgbColor(adaptiveLineColor)!,
    canvas,
  )
  const publishedCellContrast = contrastRatio(
    parseSrgbColor(publishedCellColor)!,
    canvas,
  )
  const adaptiveCellContrast = contrastRatio(
    parseSrgbColor(adaptiveCellColor)!,
    canvas,
  )
  const acceptedPlan = adaptive.outcome?.accepted?.plan
  const publishedSource = await published.book.spine
    .get(fixtureSpineIndex())
    ?.loadSource()
  const publishedLedger = summarizePresentationLegibility({
    healthMap: createPresentationHealthMap({
      renderedDocument: fixtureContents(published.rendition).document,
      spineIndex: fixtureSpineIndex(),
      canvasColor: CANVAS_COLOR,
      maxInspectedElements: MAX_PRESENTATION_HEALTH_ELEMENTS,
    }),
  })
  const directStrokeAnalysis = publishedSource
    ? await analyzeStrokeContrast({
        sourceDocument: publishedSource,
        renderedDocument: fixtureContents(published.rendition).document,
        spineIndex: fixtureSpineIndex(),
        canvasColor: CANVAS_COLOR,
        maxCandidates: 8,
      })
    : undefined
  const rollbackLine = findFixtureElement(rollback.rendition, '#worksheet-line')
  const rollbackCell = findFixtureElement(rollback.rendition, '#stroke-cell')
  const rollbackLineBefore = borderColor(rollbackLine, 'bottom')
  const rollbackCellBefore = borderColor(rollbackCell, 'top')
  const publishedLineStyle = publishedLine.getAttribute('style')
  const publishedCellStyle = publishedCell.getAttribute('style')
  rollback.engine!.detach()
  await nextFrames(2)
  const rollbackLineAfter = borderColor(rollbackLine, 'bottom')
  const rollbackCellAfter = borderColor(rollbackCell, 'top')

  const checks: Check[] = [
    {
      id: 'real-epub',
      label: 'EPUB de traços semânticos foi aberto e paginado pelo motor',
      passed:
        hasFixtureContents(published.rendition) &&
        hasFixtureContents(adaptive.rendition),
    },
    {
      id: 'accepted',
      label: 'Reparo de contraste gráfico passou pelo gate',
      passed:
        adaptive.outcome?.status === 'adapted' &&
        acceptedPlan?.patches.some(
          (patch) => patch.operation === 'restore-visible-stroke',
        ) === true,
      detail: `${adaptive.outcome?.status ?? 'no-outcome'}:${
        adaptive.outcome?.reason ?? '-'
      } · ${
        acceptedPlan?.patches
          .map(
            (patch) =>
              `${patch.operation}:${String(
                patch.parameters.observedSides ?? '-',
              )}`,
          )
          .join(', ') ?? 'no-plan'
      } · published-strokes=${publishedLedger.visibleStrokeSides}/${
        publishedLedger.knownLowContrastStrokeSides
      } · direct=${
        directStrokeAnalysis?.patches
          .map(
            (patch) =>
              `${String(
                patch.parameters.observedSides,
              )}@${patch.target.source.sourcePath.join('.')}`,
          )
          .join(',') ?? 'none'
      } · diagnostics=${
        adaptive.outcome?.diagnostics.map((entry) => entry.code).join(',') ??
        'none'
      }`,
    },
    {
      id: 'worksheet-line',
      label: 'Linha de formulário atingiu contraste gráfico de 3:1',
      passed: publishedLineContrast < 3 && adaptiveLineContrast >= 3,
      detail: `${publishedLineContrast.toFixed(
        2,
      )}:1 -> ${adaptiveLineContrast.toFixed(2)}:1 · style=${
        adaptiveLine.getAttribute('style') ?? 'none'
      }`,
    },
    {
      id: 'table-grid',
      label: 'Grade da tabela atingiu contraste gráfico de 3:1',
      passed: publishedCellContrast < 3 && adaptiveCellContrast >= 3,
      detail: `${publishedCellContrast.toFixed(
        2,
      )}:1 -> ${adaptiveCellContrast.toFixed(2)}:1`,
    },
    {
      id: 'paint-only',
      label: 'Traços permaneceram paint-only e sem repaginação',
      passed:
        acceptedPlan?.patches.every(
          (patch) =>
            patch.effects.geometry === 'none' &&
            patch.effects.semantics === 'none',
        ) === true && adaptive.outcome?.validation?.geometryStable === true,
    },
    {
      id: 'reversible',
      label: 'Detach restaurou exatamente bordas e atributos inline',
      passed:
        rollbackLineBefore === adaptiveLineColor &&
        rollbackCellBefore === adaptiveCellColor &&
        rollbackLineAfter === publishedLineColor &&
        rollbackCellAfter === publishedCellColor &&
        rollbackLine.getAttribute('style') === publishedLineStyle &&
        rollbackCell.getAttribute('style') === publishedCellStyle,
      detail: `line ${rollbackLineBefore}->${rollbackLineAfter} style=${
        rollbackLine.getAttribute('style') ?? 'none'
      }; cell ${rollbackCellBefore}->${rollbackCellAfter} style=${
        rollbackCell.getAttribute('style') ?? 'none'
      }`,
    },
  ]

  element('published-color').textContent = publishedLineColor
  element('adaptive-color').textContent = adaptiveLineColor
  publishResult({
    status: checks.every((check) => check.passed) ? 'passed' : 'failed',
    fixture: TEST_CASE,
    browser: navigator.userAgent,
    checks,
    published: { surface: CANVAS_COLOR, text: publishedLineColor },
    adaptive: {
      surface: CANVAS_COLOR,
      text: adaptiveLineColor,
      contrast: adaptiveLineContrast,
    },
    plan: planSummary(adaptive.outcome),
  })
}

function strokeLedger(fixture: RenderedFixture) {
  return summarizePresentationLegibility({
    healthMap: createPresentationHealthMap({
      renderedDocument: fixtureContents(fixture.rendition).document,
      spineIndex: fixtureSpineIndex(),
      canvasColor: ACTIVE_CANVAS_COLOR,
      maxInspectedElements: MAX_PRESENTATION_HEALTH_ELEMENTS,
    }),
  })
}

async function runPrivateStrokeAudit(
  published: RenderedFixture,
  adaptive: RenderedFixture,
  rollback: RenderedFixture,
): Promise<void> {
  const publishedLedger = strokeLedger(published)
  const adaptiveLedger = strokeLedger(adaptive)
  const publishedDocument = fixtureContents(published.rendition).document
  const authoredStrokeElements = Array.from(
    publishedDocument.querySelectorAll('.class_s2ww, .class_s2xf, .class_s19u'),
  )
  const firstAuthoredStroke = authoredStrokeElements[0] as
    | HTMLElement
    | undefined
  const firstAuthoredStrokeStyle = firstAuthoredStroke
    ? publishedDocument.defaultView!.getComputedStyle(firstAuthoredStroke)
    : undefined
  const rollbackBefore = strokeLedger(rollback)
  rollback.engine!.detach()
  await nextFrames(2)
  const rollbackAfter = strokeLedger(rollback)
  const plan = adaptive.outcome?.accepted?.plan
  const checks: Check[] = [
    {
      id: 'real-private-epub',
      label: 'Capítulo real foi aberto e paginado nos dois modos',
      passed:
        hasFixtureContents(published.rendition) &&
        hasFixtureContents(adaptive.rendition),
    },
    {
      id: 'published-reproduction',
      label: 'Published reproduziu traços abaixo de 3:1',
      passed: publishedLedger.knownLowContrastStrokeSides > 0,
      detail: `${publishedLedger.knownLowContrastStrokeSides}/${
        publishedLedger.visibleStrokeSides
      } lados · href=${
        published.book.spine.get(fixtureSpineIndex())?.href ?? 'missing'
      } · selectors=${authoredStrokeElements.length} · first=${
        firstAuthoredStrokeStyle
          ? `${firstAuthoredStrokeStyle.borderBottomStyle}/${firstAuthoredStrokeStyle.borderBottomWidth}/${firstAuthoredStrokeStyle.borderBottomColor}`
          : 'none'
      }`,
    },
    {
      id: 'accepted-stroke-plan',
      label: 'Adaptive admitiu uma operação de traço canônica',
      passed:
        adaptive.outcome?.status === 'adapted' &&
        plan?.patches.some(
          (patch) => patch.operation === 'restore-visible-stroke',
        ) === true,
      detail: `${adaptive.outcome?.status ?? 'no-outcome'}:${
        adaptive.outcome?.reason ?? '-'
      }`,
    },
    {
      id: 'all-known-strokes-readable',
      label: 'Nenhum traço conhecido permaneceu abaixo de 3:1',
      passed:
        adaptiveLedger.knownLowContrastStrokeSides === 0 &&
        adaptiveLedger.unknownStrokeSides === 0,
      detail: `low=${adaptiveLedger.knownLowContrastStrokeSides} unknown=${adaptiveLedger.unknownStrokeSides} visible=${adaptiveLedger.visibleStrokeSides}`,
    },
    {
      id: 'paint-only',
      label: 'Reparo de traço não alterou a geometria aceita',
      passed:
        plan?.patches
          .filter((patch) => patch.operation === 'restore-visible-stroke')
          .every(
            (patch) => patch.effects.paint && patch.effects.geometry === 'none',
          ) === true && adaptive.outcome?.validation?.geometryStable === true,
    },
    {
      id: 'reversible',
      label: 'Detach restaurou a dívida gráfica publicada',
      passed:
        rollbackBefore.knownLowContrastStrokeSides ===
          adaptiveLedger.knownLowContrastStrokeSides &&
        rollbackAfter.knownLowContrastStrokeSides ===
          publishedLedger.knownLowContrastStrokeSides &&
        rollbackAfter.visibleStrokeSides === publishedLedger.visibleStrokeSides,
      detail: `${rollbackBefore.knownLowContrastStrokeSides} -> ${rollbackAfter.knownLowContrastStrokeSides}`,
    },
  ]
  publishResult({
    status: checks.every((check) => check.passed) ? 'passed' : 'failed',
    fixture: TEST_CASE,
    browser: navigator.userAgent,
    checks,
    published: {
      surface: ACTIVE_CANVAS_COLOR,
      text: `${publishedLedger.knownLowContrastStrokeSides} low strokes`,
    },
    adaptive: {
      surface: ACTIVE_CANVAS_COLOR,
      text: `${adaptiveLedger.knownLowContrastStrokeSides} low strokes`,
      contrast: adaptiveLedger.knownLowContrastStrokeSides === 0 ? 3 : 0,
    },
    plan: planSummary(adaptive.outcome),
  })
}

async function runLargeIndexCase(
  published: RenderedFixture,
  adaptive: RenderedFixture,
  rollback: RenderedFixture,
): Promise<void> {
  const publishedEntry = findLargeIndexEntry(published.rendition)
  const adaptiveEntry = findLargeIndexEntry(adaptive.rendition)
  const publishedText = textColor(publishedEntry)
  const adaptiveText = textColor(adaptiveEntry)
  const publishedLink = textColor(findLargeIndexLink(published.rendition))
  const adaptiveLink = textColor(findLargeIndexLink(adaptive.rendition))
  const canvas = parseSrgbColor(CANVAS_COLOR)!
  const publishedContrast = contrastRatio(
    parseSrgbColor(publishedText)!,
    canvas,
  )
  const adaptiveContrast = contrastRatio(parseSrgbColor(adaptiveText)!, canvas)
  const elementCount = adaptiveEntry.ownerDocument.querySelectorAll('*').length
  const acceptedPlan = adaptive.outcome?.accepted?.plan
  const ledgerStartedAt = performance.now()
  summarizePresentationLegibility({
    healthMap: createPresentationHealthMap({
      renderedDocument: adaptiveEntry.ownerDocument,
      spineIndex: fixtureSpineIndex(),
      canvasColor: CANVAS_COLOR,
      maxInspectedElements: MAX_PRESENTATION_HEALTH_ELEMENTS,
    }),
    minimumTextContrast: 4.5,
  })
  const adaptiveLedgerPassMs = performance.now() - ledgerStartedAt

  const rollbackEntry = findLargeIndexEntry(rollback.rendition)
  const rollbackBefore = textColor(rollbackEntry)
  rollback.engine!.detach()
  await nextFrames(2)
  const rollbackAfter = textColor(rollbackEntry)

  let atlasMeasurement: SectionLayoutMeasurement | undefined
  let atlasOutcome: LumenPresentationOutcome | undefined
  if (TEST_CASE === 'large-index') {
    const measurementSession = new LayoutMeasurementSession({
      book: adaptive.book,
      renderer: {
        layout: {
          layout: 'reflowable',
          flow: 'paginated',
          spread: 'none',
          minSpreadWidth: 800,
        },
        width: Math.max(
          element<HTMLElement>('adaptive-reader').clientWidth,
          640,
        ),
        height: Math.max(
          element<HTMLElement>('adaptive-reader').clientHeight,
          430,
        ),
        direction: 'ltr',
      },
      paginationLifecycle: adaptive.rendition.getPaginationLifecycle(),
    })
    try {
      const measurements = await withTimeout(
        measurementSession.measure(),
        'Large-index Atlas measurement',
      )
      atlasMeasurement = measurements.find(
        (measurement) => measurement.spineIndex === 5,
      )
      atlasOutcome = [...adaptive.outcomes]
        .reverse()
        .find(
          (outcome) =>
            outcome.purpose === 'layout-measurement' &&
            outcome.spineIndex === 5,
        )
    } finally {
      measurementSession.destroy()
    }
  }

  const checks: Check[] = [
    {
      id: 'legacy-boundary-exceeded',
      label: 'Documento excede o antigo limite de 2.048 elementos',
      passed: elementCount > 2048,
      detail: `${elementCount} elementos`,
    },
    {
      id: 'accepted',
      label: 'Indice grande recebeu um plano completo, sem fallback',
      passed:
        adaptive.outcome?.status === 'adapted' &&
        acceptedPlan?.patches.some(
          (patch) => patch.operation === 'restore-explicit-text',
        ) === true,
      detail: [
        adaptive.outcome?.status,
        ...(adaptive.outcome?.diagnostics.map((entry) => entry.code) ?? []),
      ]
        .filter(Boolean)
        .join(' - '),
    },
    {
      id: 'contrast',
      label: 'Texto preto herdado ficou legivel no canvas escuro',
      passed: publishedContrast < 4.5 && adaptiveContrast >= 4.5,
      detail: `${publishedContrast.toFixed(2)}:1 -> ${adaptiveContrast.toFixed(
        2,
      )}:1`,
    },
    {
      id: 'link-preserved',
      label: 'Cor explicita dos links permaneceu autoral',
      passed: adaptiveLink === publishedLink,
      detail: adaptiveLink,
    },
    {
      id: 'complete-evidence',
      label: 'Nenhum gate publicou evidencia truncada',
      passed:
        adaptive.outcome?.diagnostics.every(
          (entry) => !entry.code.toLowerCase().includes('truncat'),
        ) === true,
    },
    {
      id: 'paint-only',
      label: 'Correcao continuou paint-only',
      passed:
        acceptedPlan?.patches.every(
          (patch) => patch.effects.paint && patch.effects.geometry === 'none',
        ) === true,
    },
    ...(TEST_CASE === 'large-index'
      ? [
          {
            id: 'atlas-complete',
            label: 'Atlas recebeu um artefato completo sem repetir a secao',
            passed:
              atlasOutcome?.status === 'adapted' &&
              Boolean(atlasMeasurement) &&
              atlasMeasurement!.presentationGeometryPlanHashes.length === 0,
            detail: [
              atlasOutcome?.status,
              ...(atlasOutcome?.diagnostics.map((entry) => entry.code) ?? []),
            ]
              .filter(Boolean)
              .join(' - '),
          },
        ]
      : []),
    {
      id: 'reversible',
      label: 'Detach restaurou o preto Published',
      passed:
        rollbackBefore === adaptiveText && rollbackAfter === publishedText,
    },
  ]

  element('published-color').textContent = publishedText
  element('adaptive-color').textContent = adaptiveText
  publishResult({
    status: checks.every((check) => check.passed) ? 'passed' : 'failed',
    fixture: TEST_CASE,
    browser: navigator.userAgent,
    checks,
    published: { surface: CANVAS_COLOR, text: publishedText },
    adaptive: {
      surface: CANVAS_COLOR,
      text: adaptiveText,
      contrast: adaptiveContrast,
    },
    plan: planSummary(adaptive.outcome),
    timings: {
      publishedRenderMs: published.renderDurationMs,
      adaptiveRenderMs: adaptive.renderDurationMs,
      adaptiveOverheadMs:
        adaptive.renderDurationMs - published.renderDurationMs,
      adaptiveLedgerPassMs,
    },
  })
}

async function runChapterBoundaryCase(
  published: RenderedFixture,
): Promise<void> {
  const sourceSpineIndex = fixtureSpineIndex()
  let sourceLastLocation = published.rendition.currentLocation()
  let nextSectionLocation = sourceLastLocation
  let pageTurns = 0
  let boundaryLoadMs = 0

  while (
    nextSectionLocation?.start.index === sourceSpineIndex &&
    pageTurns < 500
  ) {
    sourceLastLocation = nextSectionLocation
    const startedAt = performance.now()
    await withTimeout(
      published.rendition.next(),
      `Chapter boundary next ${pageTurns + 1}`,
    )
    await nextFrames(2)
    nextSectionLocation = published.rendition.currentLocation()
    if (nextSectionLocation?.start.index !== sourceSpineIndex) {
      boundaryLoadMs = performance.now() - startedAt
      break
    }
    pageTurns += 1
  }

  const previousStartedAt = performance.now()
  await withTimeout(published.rendition.prev(), 'Chapter boundary previous')
  await nextFrames(2)
  const returnedLocation = published.rendition.currentLocation()
  const previousLoadMs = performance.now() - previousStartedAt
  await new Promise<void>((resolve) => window.setTimeout(resolve, 1_500))
  await nextFrames(2)
  const settledReturnedLocation = published.rendition.currentLocation()

  const expectedStartPage = sourceLastLocation?.start.displayed.page
  const expectedEndPage = sourceLastLocation?.end.displayed.page
  const returnedStartPage = returnedLocation?.start.displayed.page
  const returnedEndPage = returnedLocation?.end.displayed.page
  const settledReturnedStartPage = settledReturnedLocation?.start.displayed.page
  const settledReturnedEndPage = settledReturnedLocation?.end.displayed.page
  const outcomeFor = (spineIndex: number) =>
    [...published.outcomes]
      .reverse()
      .find(
        (outcome) =>
          outcome.purpose === 'reader' &&
          outcome.spineIndex === spineIndex &&
          outcome.status !== 'cancelled',
      )
  const nextSectionOutcome = outcomeFor(sourceSpineIndex + 1)
  const returnedSectionOutcome = outcomeFor(sourceSpineIndex)
  const adaptiveTiming = (outcome: LumenPresentationOutcome | undefined) =>
    outcome?.elapsedMs === undefined
      ? 'LPE indisponivel'
      : `${outcome.status}; LPE ${outcome.elapsedMs.toFixed(1)} ms`
  const checks: Check[] = [
    {
      id: 'initial-load-breakdown',
      label: 'Abertura inicial foi instrumentada',
      passed: true,
      detail: `book.ready ${published.bookReadyMs.toFixed(
        1,
      )} ms; replacements ${
        published.replacementsReadyMs?.toFixed(1) ?? 'n/a'
      } ms; display ${published.displayMs.toFixed(1)} ms; salto inicial ${
        published.initialJumpMs?.toFixed(1) ?? 'n/a'
      } ms`,
    },
    {
      id: 'crossed-section-boundary',
      label: 'Next atravessou para o spine seguinte',
      passed:
        sourceLastLocation?.start.index === sourceSpineIndex &&
        nextSectionLocation?.start.index === sourceSpineIndex + 1,
      detail: `${sourceLastLocation?.start.index ?? 'none'} -> ${
        nextSectionLocation?.start.index ?? 'none'
      } em ${boundaryLoadMs.toFixed(1)} ms (${adaptiveTiming(
        nextSectionOutcome,
      )})`,
    },
    {
      id: 'source-was-last-screen',
      label: 'A travessia partiu da ultima tela da secao',
      passed:
        expectedEndPage !== undefined &&
        expectedEndPage === sourceLastLocation?.end.displayed.total,
      detail: `${expectedStartPage ?? 'none'}-${expectedEndPage ?? 'none'} / ${
        sourceLastLocation?.end.displayed.total ?? 'none'
      }`,
    },
    {
      id: 'returned-to-previous-section',
      label: 'Previous retornou ao spine anterior',
      passed: returnedLocation?.start.index === sourceSpineIndex,
      detail: String(returnedLocation?.start.index ?? 'none'),
    },
    {
      id: 'returned-to-last-screen',
      label: 'Previous restaurou imediatamente a ultima tela',
      passed:
        returnedStartPage === expectedStartPage &&
        returnedEndPage === expectedEndPage &&
        (returnedStartPage ?? 0) > 1,
      detail: `esperado ${expectedStartPage ?? 'none'}-${
        expectedEndPage ?? 'none'
      }; recebido ${returnedStartPage ?? 'none'}-${
        returnedEndPage ?? 'none'
      } em ${previousLoadMs.toFixed(1)} ms (${adaptiveTiming(
        returnedSectionOutcome,
      )})`,
    },
    {
      id: 'settled-on-last-screen',
      label: 'A pagina permaneceu correta depois do layout tardio',
      passed:
        settledReturnedStartPage === expectedStartPage &&
        settledReturnedEndPage === expectedEndPage &&
        (settledReturnedStartPage ?? 0) > 1,
      detail: `esperado ${expectedStartPage ?? 'none'}-${
        expectedEndPage ?? 'none'
      }; estabilizado ${settledReturnedStartPage ?? 'none'}-${
        settledReturnedEndPage ?? 'none'
      }`,
    },
  ]

  publishResult({
    status: checks.every((check) => check.passed) ? 'passed' : 'failed',
    fixture: TEST_CASE,
    browser: navigator.userAgent,
    checks,
    published: { surface: ACTIVE_CANVAS_COLOR, text: 'navigation-only' },
    adaptive: {
      surface: ACTIVE_CANVAS_COLOR,
      text: 'navigation-only',
      contrast: 0,
    },
  })
}

async function runAdversarialEvidenceCase(
  published: RenderedFixture,
  adaptive: RenderedFixture,
  rollback: RenderedFixture,
): Promise<void> {
  const outcome = adaptive.outcome
  const legibility = outcome?.legibility
  const diagnostics = outcome?.diagnostics.map((entry) => entry.code) ?? []
  const checks: Check[] = [
    {
      id: 'target-spine',
      label: 'O outcome pertence ao spine solicitado',
      passed: outcome?.spineIndex === fixtureSpineIndex(),
      detail: String(outcome?.spineIndex),
    },
  ]
  let publishedText = 'not-applicable'
  let adaptiveText = 'not-applicable'
  let adaptiveContrast = 0

  if (TEST_CASE === 'pseudo-noise') {
    const prose = findFixtureElement(adaptive.rendition, '#pseudo-noise-prose')
    adaptiveText = textColor(prose)
    checks.push(
      {
        id: 'readable',
        label: 'Regras pseudo sem pintura e mídia inativa não criaram dívida',
        passed:
          outcome?.status === 'published-readable' &&
          legibility?.complete === true &&
          !legibility.unknownPaintByReason['pseudo-element'],
        detail: `${outcome?.status} · debt ${
          legibility?.unknownPaintSamples ?? 'missing'
        }`,
      },
      {
        id: 'no-plan',
        label: 'Nenhum reparo desnecessário foi criado',
        passed: outcome?.plan === undefined,
      },
    )
  } else if (TEST_CASE === 'pseudo-dropcap') {
    const prose = findFixtureElement(
      adaptive.rendition,
      '#pseudo-dropcap-prose',
    )
    adaptiveText = textColor(prose)
    checks.push({
      id: 'pseudo-debt',
      label: 'A capitular com pintura própria permaneceu dívida explícita',
      passed:
        outcome?.status === 'published-unproven' &&
        legibility?.unknownPaintByReason['pseudo-element'] === 1,
      detail: `${outcome?.status} · pseudo ${
        legibility?.unknownPaintByReason['pseudo-element'] ?? 0
      }`,
    })
  } else if (TEST_CASE === 'forged-location-ignore') {
    const publishedProse = findFixtureElement(
      published.rendition,
      '#forged-location-prose',
    )
    const adaptiveProse = findFixtureElement(
      adaptive.rendition,
      '#forged-location-prose',
    )
    const rollbackProse = findFixtureElement(
      rollback.rendition,
      '#forged-location-prose',
    )
    publishedText = textColor(publishedProse)
    adaptiveText = textColor(adaptiveProse)
    const canvas = parseSrgbColor(CANVAS_COLOR)!
    const publishedContrast = contrastRatio(
      parseSrgbColor(publishedText)!,
      canvas,
    )
    adaptiveContrast = contrastRatio(parseSrgbColor(adaptiveText)!, canvas)
    const rollbackBefore = textColor(rollbackProse)
    rollback.engine!.detach()
    await nextFrames(2)
    const rollbackAfter = textColor(rollbackProse)
    checks.push(
      {
        id: 'forgery-observed',
        label: 'O atributo autoral não ocultou o texto do analisador',
        passed:
          outcome?.status === 'adapted' &&
          outcome.accepted?.plan.patches.some(
            (patch) => patch.operation === 'restore-explicit-text',
          ) === true &&
          publishedContrast < 4.5 &&
          adaptiveContrast >= 4.5,
        detail: `${publishedContrast.toFixed(
          2,
        )}:1 -> ${adaptiveContrast.toFixed(2)}:1`,
      },
      {
        id: 'forgery-rollback',
        label: 'Detach restaurou exatamente a cor Published',
        passed:
          rollbackBefore === adaptiveText && rollbackAfter === publishedText,
      },
    )
  } else if (TEST_CASE === 'many-color-roots') {
    const publishedFirst = findFixtureElement(
      published.rendition,
      'p:first-child',
    )
    const adaptiveFirst = findFixtureElement(
      adaptive.rendition,
      'p:first-child',
    )
    const adaptiveLast = findFixtureElement(adaptive.rendition, 'p:last-child')
    const rollbackFirst = findFixtureElement(
      rollback.rendition,
      'p:first-child',
    )
    publishedText = textColor(publishedFirst)
    adaptiveText = textColor(adaptiveFirst)
    const lastText = textColor(adaptiveLast)
    const canvas = parseSrgbColor(CANVAS_COLOR)!
    adaptiveContrast = contrastRatio(parseSrgbColor(adaptiveText)!, canvas)
    const lastContrast = contrastRatio(parseSrgbColor(lastText)!, canvas)
    const rollbackBefore = textColor(rollbackFirst)
    rollback.engine!.detach()
    await nextFrames(2)
    const rollbackAfter = textColor(rollbackFirst)
    checks.push(
      {
        id: 'truncation-declared',
        label: 'O teto de candidatos aparece nos diagnósticos',
        passed: diagnostics.includes('explicit-groups-truncated'),
        detail: diagnostics.join(', '),
      },
      {
        id: 'bounded-plan',
        label: 'O plano permaneceu limitado a 16 grupos',
        passed:
          outcome?.status === 'adapted' &&
          outcome.accepted?.plan.patches.filter(
            (patch) => patch.operation === 'restore-explicit-text',
          ).length === 16,
      },
      {
        id: 'residual-debt',
        label: 'Grupos não reparados permaneceram dívida honesta',
        passed:
          adaptiveContrast >= 4.5 &&
          lastContrast < 4.5 &&
          (legibility?.knownLowContrastSamples ?? 0) >= 4,
        detail: `last ${lastContrast.toFixed(2)}:1 · debt ${
          legibility?.knownLowContrastSamples ?? 0
        }`,
      },
      {
        id: 'bounded-rollback',
        label: 'Rollback restaurou o primeiro grupo reparado',
        passed:
          rollbackBefore === adaptiveText && rollbackAfter === publishedText,
      },
    )
  } else if (TEST_CASE === 'clipped-prose') {
    const clipped = findFixtureElement(adaptive.rendition, '#clipped-prose')
    const parent = findFixtureElement(adaptive.rendition, '#clipped-parent')
    adaptiveText = textColor(clipped)
    checks.push({
      id: 'clipping-classified',
      label: 'Texto totalmente recortado saiu da divida visivel',
      passed:
        clipped.getBoundingClientRect().height > 0 &&
        parent.getBoundingClientRect().height === 0 &&
        outcome?.status === 'published-readable' &&
        legibility?.nonVisibleTextSamples === 1 &&
        legibility.unknownPaintSamples === 0,
      detail: `${outcome?.status} - non-visible ${
        legibility?.nonVisibleTextSamples ?? 'missing'
      }`,
    })
  } else if (TEST_CASE === 'occluded-callout') {
    const prose = findFixtureElement(adaptive.rendition, '#occluded-prose')
    const cover = findFixtureElement(adaptive.rendition, '#occluding-cover')
    const rect = prose.getBoundingClientRect()
    const hit = prose.ownerDocument.elementFromPoint(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
    )
    adaptiveText = textColor(prose)
    checks.push({
      id: 'occlusion-reproduced',
      label: 'Hit-testing prova a oclusao que o ledger ainda nao classifica',
      passed:
        hit === cover &&
        outcome?.status === 'published-readable' &&
        (legibility?.provenReadableSamples ?? 0) >= 1,
      detail: `${outcome?.status} - hit ${hit?.id || hit?.localName || 'none'}`,
    })
  }

  element('published-color').textContent = publishedText
  element('adaptive-color').textContent = adaptiveText
  publishResult({
    status: checks.every((check) => check.passed) ? 'passed' : 'failed',
    fixture: TEST_CASE,
    browser: navigator.userAgent,
    checks,
    published: { surface: CANVAS_COLOR, text: publishedText },
    adaptive: {
      surface: CANVAS_COLOR,
      text: adaptiveText,
      contrast: adaptiveContrast,
    },
    plan: planSummary(outcome),
  })
}

async function runPrivateCoverCase(
  published: RenderedFixture,
  adaptive: RenderedFixture,
): Promise<void> {
  const contents = fixtureContents(adaptive.rendition)
  const publishedContents = fixtureContents(published.rendition)
  const svg = contents?.document.querySelector('svg') as SVGSVGElement | null
  const publishedSvg = publishedContents?.document.querySelector(
    'svg',
  ) as SVGSVGElement | null
  const image = svg?.querySelector('image')
  const rect = svg?.getBoundingClientRect()
  const publishedRect = publishedSvg?.getBoundingClientRect()
  const viewBox = svg?.viewBox.baseVal
  const expectedRatio =
    viewBox && viewBox.width > 0 && viewBox.height > 0
      ? viewBox.width / viewBox.height
      : 0
  const observedRatio = rect && rect.height > 0 ? rect.width / rect.height : 0
  const reader = element<HTMLElement>('adaptive-reader').getBoundingClientRect()
  const ratioError =
    expectedRatio > 0
      ? Math.abs(observedRatio - expectedRatio) / expectedRatio
      : Number.POSITIVE_INFINITY

  const checks: Check[] = [
    {
      id: 'calibre-cover',
      label: 'Documento de capa do Calibre foi reconhecido',
      passed:
        Boolean(
          contents?.document.querySelector('meta[name="calibre:cover"]'),
        ) &&
        Boolean(svg) &&
        Boolean(image),
    },
    {
      id: 'visible-area',
      label: 'Capa ocupa uma area util da pagina',
      passed:
        Boolean(rect) &&
        rect!.width > 100 &&
        rect!.height >= Math.min(300, reader.height * 0.6),
      detail: rect
        ? `${Math.round(rect.width)}x${Math.round(rect.height)}`
        : 'sem SVG',
    },
    {
      id: 'aspect-ratio',
      label: 'Proporcao intrinseca da capa foi preservada',
      passed: ratioError <= 0.03,
      detail: `${observedRatio.toFixed(3)} vs ${expectedRatio.toFixed(3)}`,
    },
    {
      id: 'bounded',
      label: 'Capa permaneceu dentro do viewport',
      passed:
        Boolean(rect) &&
        rect!.width <= reader.width + 1 &&
        rect!.height <= reader.height + 1,
    },
    {
      id: 'published-equivalent',
      label: 'A camada adaptativa nao deformou a capa',
      passed:
        Boolean(rect) &&
        Boolean(publishedRect) &&
        Math.abs(rect!.width - publishedRect!.width) <= 1 &&
        Math.abs(rect!.height - publishedRect!.height) <= 1,
      detail: adaptive.outcome?.status,
    },
  ]

  publishResult({
    status: checks.every((check) => check.passed) ? 'passed' : 'failed',
    fixture: TEST_CASE,
    browser: navigator.userAgent,
    checks,
    published: {
      surface: 'cover',
      text: publishedRect
        ? `${Math.round(publishedRect.width)}x${Math.round(
            publishedRect.height,
          )}`
        : 'unavailable',
    },
    adaptive: {
      surface: 'cover',
      text: rect
        ? `${Math.round(rect.width)}x${Math.round(rect.height)}`
        : 'unavailable',
      contrast: 0,
    },
    plan: planSummary(adaptive.outcome),
  })
}

async function runLazyImageCase(adaptive: RenderedFixture): Promise<void> {
  const spineIndex = fixtureSpineIndex()
  const renditionViews = adaptive.rendition.views()
  const views = Array.isArray(renditionViews)
    ? renditionViews
    : renditionViews.all()
  const view = views.find((candidate) => candidate.section.index === spineIndex)
  if (!view?.contents) throw new Error('The delayed-image view is unavailable')
  const image = view.contents.document.querySelector(
    '#delayed-image',
  ) as HTMLImageElement | null
  if (!image) throw new Error('The delayed fixture image is unavailable')

  await withTimeout(
    image.complete
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          image.addEventListener('load', () => resolve(), { once: true })
          image.addEventListener('error', () => resolve(), { once: true })
        }),
    'Visible delayed image',
  )
  await nextFrames(3)
  const visibleSettled = view.measureContentLeaves()

  const measurementSession = new LayoutMeasurementSession({
    book: adaptive.book,
    renderer: {
      layout: {
        layout: 'reflowable',
        flow: 'paginated',
        spread: 'none',
        minSpreadWidth: 800,
      },
      width: Math.max(element<HTMLElement>('adaptive-reader').clientWidth, 640),
      height: Math.max(
        element<HTMLElement>('adaptive-reader').clientHeight,
        430,
      ),
      direction: 'ltr',
    },
    paginationLifecycle: adaptive.rendition.getPaginationLifecycle(),
  })
  let atlasMeasurement: SectionLayoutMeasurement | undefined
  try {
    const measurements = await withTimeout(
      measurementSession.measure(),
      'Delayed-image Atlas measurement',
    )
    atlasMeasurement = measurements.find(
      (measurement) => measurement.spineIndex === spineIndex,
    )
  } finally {
    measurementSession.destroy()
  }

  await new Promise((resolve) => window.setTimeout(resolve, 1200))
  await nextFrames(3)
  const visibleLate = view.measureContentLeaves()
  const checks: Check[] = [
    {
      id: 'image-settled',
      label:
        'A imagem tardia concluiu carga e decode com dimensoes intrinsecas',
      passed:
        image.complete && image.naturalWidth > 0 && image.naturalHeight > 0,
      detail: `${image.naturalWidth}x${image.naturalHeight}`,
    },
    {
      id: 'reader-stable',
      label: 'A view visivel permaneceu estavel depois da janela tardia',
      passed:
        visibleSettled.leafCount === visibleLate.leafCount &&
        visibleSettled.rawExtent === visibleLate.rawExtent,
      detail: `${visibleSettled.leafCount} -> ${visibleLate.leafCount} leaves`,
    },
    {
      id: 'atlas-agrees',
      label: 'Atlas e Reader convergiram para a mesma quantidade final',
      passed:
        Boolean(atlasMeasurement) &&
        atlasMeasurement!.leafCount === visibleLate.leafCount,
      detail: `Reader ${visibleLate.leafCount} - Atlas ${
        atlasMeasurement?.leafCount ?? 'missing'
      }`,
    },
  ]

  element('published-color').textContent = String(visibleSettled.leafCount)
  element('adaptive-color').textContent = String(visibleLate.leafCount)
  publishResult({
    status: checks.every((check) => check.passed) ? 'passed' : 'failed',
    fixture: TEST_CASE,
    browser: navigator.userAgent,
    checks,
    published: {
      surface: CANVAS_COLOR,
      text: String(visibleSettled.leafCount),
    },
    adaptive: {
      surface: CANVAS_COLOR,
      text: String(visibleLate.leafCount),
      contrast: 0,
    },
    plan: planSummary(adaptive.outcome),
  })
}

async function runPrivateContrastAudit(
  adaptive: RenderedFixture,
  colorScheme: 'light' | 'dark',
): Promise<void> {
  const failures: string[] = []
  const adaptations: string[] = []
  const total = adaptive.book.spine.spineItems.length
  let inspectedTextCodePoints = 0

  for (let spineIndex = 0; spineIndex < total; spineIndex += 1) {
    await withTimeout(
      adaptive.rendition.display(spineIndex).then(() => undefined),
      `Dark audit display ${spineIndex}`,
    )
    await nextFrames(1)
    // A spread can expose two Contents instances. Always audit the document
    // belonging to the requested spine instead of silently rechecking the
    // first (usually even-numbered) page of the spread.
    const contents = adaptive.rendition
      .getContents()
      .find((candidate) => candidate.sectionIndex === spineIndex)
    if (!contents) {
      failures.push(`${spineIndex}:missing-contents`)
      continue
    }
    const health = createPresentationHealthMap({
      renderedDocument: contents.document,
      spineIndex,
      canvasColor: ACTIVE_CANVAS_COLOR,
      maxInspectedElements: MAX_PRESENTATION_HEALTH_ELEMENTS,
    })
    const lowContrast = health.observations.filter(
      (observation) =>
        observation.textPaintEligible &&
        observation.paint.kind === 'known' &&
        observation.paint.contrast < 4.5,
    )
    inspectedTextCodePoints += health.observations.reduce(
      (sum, observation) => sum + observation.directTextCodePoints,
      0,
    )
    const outcome = [...adaptive.outcomes]
      .reverse()
      .find(
        (candidate) =>
          candidate.purpose === 'reader' && candidate.spineIndex === spineIndex,
      )
    if (outcome?.status === 'adapted') {
      adaptations.push(`${spineIndex}:${summarizeAcceptedPatches(outcome)}`)
    }
    if (health.truncated || lowContrast.length > 0) {
      const codePoints = lowContrast.reduce(
        (sum, observation) => sum + observation.directTextCodePoints,
        0,
      )
      const minimumContrast = lowContrast.reduce(
        (minimum, observation) =>
          observation.paint.kind === 'known'
            ? Math.min(minimum, observation.paint.contrast)
            : minimum,
        Number.POSITIVE_INFINITY,
      )
      failures.push(
        `${spineIndex}:${lowContrast.length}/${codePoints}@${
          Number.isFinite(minimumContrast)
            ? minimumContrast.toFixed(2)
            : 'truncated'
        }:${outcome?.status ?? 'no-outcome'}:${outcome?.reason ?? '-'}:${
          outcome?.validation?.failureReasons
            .map((failure) => failure.code)
            .join(',') ?? '-'
        }:${
          outcome?.diagnostics
            .slice(-6)
            .map((diagnostic) => diagnostic.code)
            .join(',') ?? '-'
        }:${lowContrast
          .slice(0, 3)
          .map((observation) =>
            observation.paint.kind === 'known'
              ? `${observation.localName}@${observation.address.sourcePath.join(
                  '.',
                )}:${observation.style.color}->${srgbToHex(
                  observation.paint.background,
                )}`
              : observation.localName,
          )
          .join(',')}`,
      )
    }
  }

  const checks: Check[] = [
    {
      id: 'all-spines-inspected',
      label: 'Todos os documentos lineares foram renderizados',
      passed: total > 0,
      detail: `${total} spines; ${inspectedTextCodePoints} caracteres de texto`,
    },
    {
      id: 'minimum-contrast',
      label: 'Nenhum texto elegivel permaneceu abaixo de 4.5:1',
      passed: failures.length === 0,
      detail: failures.length
        ? failures.slice(0, 20).join(' | ')
        : 'sem falhas',
    },
    {
      id: 'adaptation-summary',
      label: 'Toda intervenção aceita ficou registrada por operação',
      passed: true,
      detail: adaptations.length
        ? adaptations.join(' | ')
        : 'nenhum spine foi adaptado',
    },
  ]
  publishResult({
    status: checks.every((check) => check.passed) ? 'passed' : 'failed',
    fixture: TEST_CASE,
    browser: navigator.userAgent,
    checks,
    published: {
      surface: ACTIVE_CANVAS_COLOR,
      text: `${colorScheme}-not-audited`,
    },
    adaptive: {
      surface: ACTIVE_CANVAS_COLOR,
      text: failures.length ? failures.join(' | ') : 'all-readable',
      contrast: failures.length ? 0 : 4.5,
    },
  })
}

/**
 * Keep private-corpus reports useful without serializing an unbounded set of
 * DOM addresses and samples. A long index can legitimately contain thousands
 * of accepted patches; the report needs operation counts and representative
 * color changes, not a second copy of the plan.
 */
function summarizeAcceptedPatches(outcome: LumenPresentationOutcome): string {
  const byOperation = new Map<string, string[]>()
  for (const patch of outcome.accepted?.plan.patches ?? []) {
    const parameters = patch.parameters as Record<string, unknown>
    const source =
      typeof parameters.sourceText === 'string'
        ? parameters.sourceText
        : typeof parameters.sourceStroke === 'string'
        ? parameters.sourceStroke
        : undefined
    const target =
      typeof parameters.targetText === 'string'
        ? parameters.targetText
        : typeof parameters.targetStroke === 'string'
        ? parameters.targetStroke
        : undefined
    const samples = byOperation.get(patch.operation) ?? []
    if (source && target && samples.length < 3) {
      samples.push(`${source}→${target}`)
    }
    byOperation.set(patch.operation, samples)
  }
  return [...byOperation]
    .map(([operation, examples]) => {
      const count = outcome.accepted?.plan.patches.filter(
        (patch) => patch.operation === operation,
      ).length
      return examples.length
        ? `${operation}×${count}[${examples.join(',')}]`
        : `${operation}×${count}`
    })
    .join(';')
}

async function main(): Promise<void> {
  let published: RenderedFixture | undefined
  let adaptive: RenderedFixture | undefined
  let rollback: RenderedFixture | undefined
  try {
    if (
      TEST_CASE === 'private-dark-audit' ||
      TEST_CASE === 'private-light-audit'
    ) {
      const colorScheme = TEST_CASE === 'private-light-audit' ? 'light' : 'dark'
      element('fixture-title').textContent = 'Auditoria de contraste do EPUB'
      element(
        'fixture-description',
      ).textContent = `Cada spine e renderizado no modo Adaptive e validado contra o canvas ${colorScheme}.`
      adaptive = await renderFixture(element('adaptive-reader'), true)
      await runPrivateContrastAudit(adaptive, colorScheme)
      return
    }
    if (
      TEST_CASE === 'chapter-boundary' ||
      TEST_CASE === 'private-chapter-boundary'
    ) {
      element('fixture-title').textContent = 'Navegacao entre capitulos'
      element('fixture-description').textContent =
        'O motor percorre uma secao longa, entra na seguinte e deve voltar exatamente para a ultima tela anterior.'
      published = await renderFixture(element('published-reader'), true)
      await runChapterBoundaryCase(published)
      return
    }
    if (TEST_CASE === 'wide-table') {
      element('fixture-title').textContent =
        'Resultado do vertical slice de tabela larga'
      element('fixture-description').textContent =
        'O mesmo EPUB paginado pelo motor real. Adaptive só cria rolagem local quando a tabela sem contêiner excede comprovadamente a coluna.'
    } else if (TEST_CASE === 'author-theme') {
      element('fixture-title').textContent =
        'Resultado do resolver de tema autoral'
      element('fixture-description').textContent =
        'O mesmo EPUB usa prefers-color-scheme e variáveis autorais. Adaptive alterna somente as condições CSSOM e valida a projeção paginada.'
    } else if (TEST_CASE === 'dark-foreground') {
      element('fixture-title').textContent =
        'Resultado do reparo de texto herdado'
      element('fixture-description').textContent =
        'O mesmo EPUB herda texto preto em uma superfície escura. Adaptive corrige somente a herança, preserva o rosa explícito e não invalida o Atlas.'
    } else if (TEST_CASE === 'default-foreground') {
      element('fixture-title').textContent =
        'Resultado do reparo de foreground padrao'
      element('fixture-description').textContent =
        'O EPUB nao declara color. Adaptive corrige o preto padrao herdado do navegador sem alterar o acento autoral.'
    } else if (
      TEST_CASE === 'large-index' ||
      TEST_CASE === 'private-large-index'
    ) {
      element('fixture-title').textContent =
        'Resultado do indice remissivo grande'
      element('fixture-description').textContent =
        'Mais de quatro mil elementos reproduzem o indice real. Adaptive precisa validar o documento inteiro sem criar um plano a partir de um prefixo truncado.'
    } else if (TEST_CASE === 'private-cover') {
      element('fixture-title').textContent = 'Resultado da capa SVG do Calibre'
      element('fixture-description').textContent =
        'A capa deve usar a geometria da pagina e preservar seu viewBox, sem depender da altura transitoria do body.'
    } else if (TEST_CASE === 'pseudo-noise') {
      element('fixture-title').textContent = 'Regras pseudo sem pintura'
      element('fixture-description').textContent =
        'Regras neutras e midia inativa nao podem tornar toda a publicacao inconclusiva.'
    } else if (TEST_CASE === 'pseudo-dropcap') {
      element('fixture-title').textContent = 'Pintura de capitular pseudo'
      element('fixture-description').textContent =
        'Uma first-letter com cor propria precisa aparecer como divida declarada.'
    } else if (TEST_CASE === 'forged-location-ignore') {
      element('fixture-title').textContent = 'Atributo Lumen forjado'
      element('fixture-description').textContent =
        'Markup autoral nao pode se passar por conteudo interno e escapar da analise.'
    } else if (TEST_CASE === 'many-color-roots') {
      element('fixture-title').textContent = 'Orcamento de grupos explicitos'
      element('fixture-description').textContent =
        'O plano permanece limitado, mas o truncamento e a divida residual precisam ser honestos.'
    } else if (TEST_CASE === 'clipped-prose') {
      element('fixture-title').textContent = 'Texto totalmente recortado'
      element('fixture-description').textContent =
        'Texto fora da regiao pintada deve ser separado da divida de legibilidade.'
    } else if (TEST_CASE === 'occluded-callout') {
      element('fixture-title').textContent = 'Experimento de oclusao'
      element('fixture-description').textContent =
        'O hit-testing observa uma oclusao sem ainda transforma-la em politica.'
    } else if (TEST_CASE === 'lazy-image-section') {
      element('fixture-title').textContent = 'Imagem tardia e Atlas'
      element('fixture-description').textContent =
        'Uma resposta de imagem atrasada compara a geometria final do Reader com a medicao isolada do Atlas.'
    } else if (TEST_CASE === 'stroke-contrast') {
      element('fixture-title').textContent = 'Contraste de traços semânticos'
      element('fixture-description').textContent =
        'Linhas de formulário e grades de tabela que usam currentColor precisam continuar visíveis sobre o canvas escuro.'
    } else if (TEST_CASE === 'private-stroke-audit') {
      element('fixture-title').textContent =
        'Auditoria de traços do EPUB privado'
      element('fixture-description').textContent =
        'Compara a dívida gráfica Published, o plano Adaptive e a restauração no capítulo real solicitado.'
    }
    published = await renderFixture(element('published-reader'), false)
    adaptive = await renderFixture(element('adaptive-reader'), true)
    rollback = await renderFixture(element('rollback-probe'), true)

    if (TEST_CASE === 'wide-table') {
      await runWideTableCase(published, adaptive, rollback)
      return
    }
    if (TEST_CASE === 'author-theme') {
      await runAuthorThemeCase(published, adaptive, rollback)
      return
    }
    if (TEST_CASE === 'dark-foreground') {
      await runDarkForegroundCase(published, adaptive, rollback)
      return
    }
    if (TEST_CASE === 'default-foreground') {
      await runDefaultForegroundCase(published, adaptive, rollback)
      return
    }
    if (TEST_CASE === 'stroke-contrast') {
      await runStrokeContrastCase(published, adaptive, rollback)
      return
    }
    if (TEST_CASE === 'private-stroke-audit') {
      await runPrivateStrokeAudit(published, adaptive, rollback)
      return
    }
    if (TEST_CASE === 'large-index' || TEST_CASE === 'private-large-index') {
      await runLargeIndexCase(published, adaptive, rollback)
      return
    }
    if (TEST_CASE === 'private-cover') {
      await runPrivateCoverCase(published, adaptive)
      return
    }
    if (TEST_CASE === 'lazy-image-section') {
      await runLazyImageCase(adaptive)
      return
    }
    if (
      TEST_CASE === 'pseudo-noise' ||
      TEST_CASE === 'pseudo-dropcap' ||
      TEST_CASE === 'forged-location-ignore' ||
      TEST_CASE === 'many-color-roots' ||
      TEST_CASE === 'clipped-prose' ||
      TEST_CASE === 'occluded-callout'
    ) {
      await runAdversarialEvidenceCase(published, adaptive, rollback)
      return
    }

    const publishedColors = colorsOf(published.rendition)
    const adaptiveColors = colorsOf(adaptive.rendition)
    const adaptiveContrast = colorContrast(adaptiveColors)
    const accepted = adaptive.outcome?.accepted
    const acceptedPlan = accepted?.plan
    const validation = adaptive.outcome?.validation
    const publishedCallout = findCallout(published.rendition)
    const sourceDocument = await adaptive.book.spine
      .get(fixtureSpineIndex())
      ?.loadSource()
    const sourceCallout = sourceDocument?.querySelector('.pink-callout')

    const rollbackBefore = colorsOf(rollback.rendition)
    rollback.engine!.detach()
    await nextFrames(2)
    const rollbackAfter = colorsOf(rollback.rendition)

    const sourceOklch = srgbToOklch(parseSrgbColor(publishedColors.surface)!)
    const adaptiveOklch = srgbToOklch(parseSrgbColor(adaptiveColors.surface)!)
    const mappedChromaRatio = adaptiveOklch.c / sourceOklch.c
    const checks: Check[] = [
      {
        id: 'real-epub',
        label: 'EPUB real aberto em iframes pelo motor',
        passed:
          hasFixtureContents(published.rendition) &&
          hasFixtureContents(adaptive.rendition),
      },
      {
        id: 'accepted',
        label: 'Plano Adaptive passou pelo gate',
        passed: adaptive.outcome?.status === 'adapted' && Boolean(accepted),
        detail: adaptive.outcome?.status,
      },
      {
        id: 'contrast',
        label: 'Contraste mínimo preservado',
        passed: adaptiveContrast >= 4.5,
        detail: `${adaptiveContrast.toFixed(2)}:1`,
      },
      {
        id: 'hue',
        label: 'Identidade rosa preservada em OKLCH',
        passed:
          adaptiveOklch.c >= 0.025 &&
          mappedChromaRatio >= 0.75 &&
          hueDistance(sourceOklch.h, adaptiveOklch.h) <= 2,
        detail: `Δh ${hueDistance(sourceOklch.h, adaptiveOklch.h).toFixed(
          1,
        )}° · ${Math.round(mappedChromaRatio * 100)}% do chroma`,
      },
      {
        id: 'geometry',
        label: 'Paint não alterou geometria/paginação',
        passed: validation?.geometryStable === true,
      },
      {
        id: 'paint-only',
        label: 'Operação declarada como paint-only',
        passed:
          acceptedPlan?.patches.length === 1 &&
          acceptedPlan.patches.every(
            (patch) => patch.effects.paint && patch.effects.geometry === 'none',
          ),
      },
      {
        id: 'source-untouched',
        label: 'A marcação autoral permaneceu intacta',
        passed:
          publishedCallout.getAttribute('style') === null &&
          sourceCallout?.nodeType === Node.ELEMENT_NODE &&
          sourceCallout.getAttribute('style') === null,
      },
      {
        id: 'reversible',
        label: 'Detach restaurou exatamente Published',
        passed:
          rollbackBefore.surface === adaptiveColors.surface &&
          rollbackAfter.surface === publishedColors.surface &&
          rollbackAfter.text === publishedColors.text,
        detail: `${rollbackBefore.surface} → ${rollbackAfter.surface}`,
      },
    ]

    element('published-color').textContent = publishedColors.surface
    element('adaptive-color').textContent = adaptiveColors.surface
    const result: BrowserFixtureResult = {
      status: checks.every((check) => check.passed) ? 'passed' : 'failed',
      fixture: TEST_CASE,
      browser: navigator.userAgent,
      checks,
      published: publishedColors,
      adaptive: {
        ...adaptiveColors,
        contrast: adaptiveContrast,
      },
      plan: planSummary(adaptive.outcome),
    }
    publishResult(result)

    const toggle = element<HTMLButtonElement>('published-toggle')
    toggle.disabled = false
    toggle.addEventListener('click', () => {
      adaptive?.engine?.detach()
      toggle.disabled = true
      toggle.textContent = 'Published restaurado — recarregue para Adaptive'
      element('adaptive-color').textContent = colorsOf(
        adaptive!.rendition,
      ).surface
    })
  } catch (error) {
    const message =
      error instanceof Error ? error.stack ?? error.message : String(error)
    publishResult({
      status: 'failed',
      fixture: TEST_CASE,
      browser: navigator.userAgent,
      checks: [
        {
          id: 'harness-error',
          label: 'Execução do harness',
          passed: false,
          detail: error instanceof Error ? error.message : String(error),
        },
      ],
      published: { surface: 'unavailable', text: 'unavailable' },
      adaptive: { surface: 'unavailable', text: 'unavailable', contrast: 0 },
      error: message,
    })
  } finally {
    disposeFixture(rollback)
  }
}

await main()

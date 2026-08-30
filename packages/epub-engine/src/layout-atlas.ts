/**
 * Serializable planning primitives for Lumen's renderer-specific page atlas.
 *
 * An atlas is deliberately not a progress coordinate system.  It records the
 * visual leaves produced by one renderer fingerprint, including synthetic
 * blanks needed to make an opening.  `LayoutPage` therefore counts authored
 * content while `LayoutLeaf` describes a physical slot in a viewport.
 *
 * This module has no DOM, rendition, or Section dependency.  Measurement is
 * performed elsewhere one spine occurrence at a time; this planner only
 * reduces those measurements in reading-order.
 */

export const LAYOUT_ATLAS_VERSION = 4 as const
export const SECTION_LAYOUT_MEASUREMENT_VERSION = 2 as const
export const DEFAULT_SPREAD_SEMANTICS_PROFILE = 'epub33-rec' as const

export type SpreadSemanticsProfile = 'epub33-rec' | 'epub34-crd-20260721'

export type LayoutDirection = 'ltr' | 'rtl'
export type SectionLayoutKind = 'reflowable' | 'pre-paginated'
export type SectionLayoutFlow = 'paginated' | 'roll'
export type PageSpread = 'left' | 'right' | 'center'
export type SectionBoundaryMode = 'flush' | 'continue'
export type AtlasSpreadMode = 'single' | 'two-up'
export type PlannedLayoutKind = SectionLayoutKind | 'roll'

const SPREAD_SEMANTICS_PROFILES: readonly SpreadSemanticsProfile[] = [
  'epub33-rec',
  'epub34-crd-20260721',
]

/**
 * All inputs which can change pagination belong to the atlas key.  This is
 * intentionally a local artifact: never sync it as book progress.
 */
export interface LayoutFingerprint {
  publicationFingerprint: string
  rendererVersion: string
  browserEngine: string
  browserEngineVersion: string
  viewport: {
    width: number
    height: number
    deviceScaleFactor: number
  }
  typographyFingerprint: string
  resolvedFontFingerprint: string
  layoutSettingsFingerprint: string
  /** Active geometry producers and their geometry-only configuration. */
  presentationGeometryPipelineFingerprint: string
  spreadSemanticsProfile: SpreadSemanticsProfile
  atlasVersion: number
}

/**
 * The DOM-dependent measurement result for one spine occurrence.
 *
 * `leafCount` is the number of content leaves (columns/pages) rendered by
 * that occurrence. It does not include any synthetic blank that the planner
 * may add. A rolling document has no discrete leaves and must report zero.
 * `pageSpread` is a spine-item placement hint and is applied to its first
 * rendered leaf when the selected semantics profile permits it; a fixed-layout
 * occurrence normally has exactly one leaf.
 *
 * `sectionBoundaryMode` describes the visible renderer, not the EPUB itself.
 * The current DefaultViewManager pads odd reflowable documents independently,
 * so the compatibility default is `flush` for reflowable items. A renderer
 * that truly lays reflowable documents into one global column sequence must
 * explicitly use `continue` instead.
 *
 * `viewportMode` records the divisor actually used for this occurrence after
 * writing-mode and renderer rules are applied. It overrides the planner's
 * global fallback: for example, DefaultViewManager uses a single page for a
 * vertical-writing section even when the surrounding book is two-up.
 */
export interface SectionLayoutMeasurement {
  measurementVersion: typeof SECTION_LAYOUT_MEASUREMENT_VERSION
  spineIndex: number
  resourceHref: string
  linear: boolean
  layout: SectionLayoutKind
  flow: SectionLayoutFlow
  leafCount: number
  pageSpread?: PageSpread
  sectionBoundaryMode?: SectionBoundaryMode
  viewportMode?: AtlasSpreadMode
  /** Admitted geometry-affecting plan hashes, ordered by producer id. */
  presentationGeometryPlanHashes: string[]
}

/**
 * The physical side which remains available in the current two-up opening.
 * It is the only planning state that needs to cross measured sections.
 */
export interface SpreadState {
  openSlot: 'left' | 'right' | null
  direction: LayoutDirection
  previousLayout?: PlannedLayoutKind
  previousViewportMode?: AtlasSpreadMode
}

export type LayoutLeaf =
  | {
      leafIndex: number
      kind: 'content'
      slot: 'left' | 'right' | 'center'
      pageIndex: number
    }
  | {
      leafIndex: number
      kind: 'blank'
      slot: 'left' | 'right'
    }

/** A user-facing content page, backed by exactly one physical content leaf. */
export interface LayoutPage {
  pageIndex: number
  leafIndex: number
  spineIndex: number
  resourceHref: string
  /** Zero-based page/column inside the measured spine occurrence. */
  sectionPageIndex: number
  layout: SectionLayoutKind
  /** The placement honored by the selected spread semantics profile, if any. */
  pageSpread?: PageSpread
}

export type LayoutSpread =
  | {
      spreadIndex: number
      kind: 'pair'
      leftLeafIndex: number
      rightLeafIndex: number
    }
  | {
      spreadIndex: number
      kind: 'single' | 'center'
      centerLeafIndex: number
    }

/**
 * A rendered viewport is distinct from a spread. A single-page UI has one
 * viewport per page, a two-up UI has one per pair, and roll has no pages.
 */
export type LayoutViewport =
  | {
      viewportIndex: number
      kind: 'spread'
      spreadIndex: number
      leafIndexes: [number, number]
      pageIndexes: number[]
    }
  | {
      viewportIndex: number
      kind: 'single-page'
      spreadIndex: number
      leafIndexes: [number]
      pageIndexes: [number]
    }
  | {
      viewportIndex: number
      kind: 'roll'
      spineIndex: number
      resourceHref: string
      layout: SectionLayoutKind
      leafIndexes: []
      pageIndexes: []
    }

export interface LayoutAtlasTransition {
  kind: 'layout-change' | 'roll-boundary' | 'viewport-mode-change'
  fromLayout: PlannedLayoutKind
  toLayout: PlannedLayoutKind
  spineIndex: number
  /** True when a synthetic blank closed a prior two-up opening. */
  flushedOpenSpread: boolean
  fromViewportMode?: AtlasSpreadMode
  toViewportMode?: AtlasSpreadMode
}

export interface LayoutAtlasPlan {
  atlasVersion: typeof LAYOUT_ATLAS_VERSION
  direction: LayoutDirection
  spreadMode: AtlasSpreadMode
  spreadSemanticsProfile: SpreadSemanticsProfile
  paginationMode: 'paged' | 'roll' | 'mixed'
  state: SpreadState
  leaves: LayoutLeaf[]
  pages: LayoutPage[]
  spreads: LayoutSpread[]
  viewports: LayoutViewport[]
  transitions: LayoutAtlasTransition[]
  skippedSpineIndexes: number[]
  totalLeafCount: number
  /** Content pages only; synthetic blanks never inflate this value. */
  totalPageCount: number
  totalSpreadCount: number
  totalViewportCount: number
}

export interface LayoutAtlas extends LayoutAtlasPlan {
  fingerprint: LayoutFingerprint
  measurements: SectionLayoutMeasurement[]
  /** Complete per-occurrence geometry identity, aggregated in spine order. */
  presentationGeometryPlanSet: Array<{
    spineIndex: number
    geometryPlanHashes: string[]
  }>
}

export interface SpreadPlannerOptions {
  direction?: LayoutDirection
  spreadMode?: AtlasSpreadMode
  spreadSemanticsProfile?: SpreadSemanticsProfile
}

interface OpenPair {
  spreadIndex: number
  leftLeafIndex?: number
  rightLeafIndex?: number
}

const PAGE_SPREAD_PROPERTIES: Readonly<Record<PageSpread, readonly string[]>> =
  {
    left: ['rendition:page-spread-left', 'page-spread-left'],
    right: ['rendition:page-spread-right', 'page-spread-right'],
    center: ['rendition:page-spread-center', 'page-spread-center'],
  }
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/

/**
 * Normalizes both EPUB 3 rendition tokens and legacy unprefixed tokens.
 * Conflicting placement values are malformed input, so the safe behavior is
 * to leave the item unforced rather than silently invent a side.
 */
export function pageSpreadFromProperties(
  properties: readonly string[] | null | undefined,
): PageSpread | undefined {
  if (!properties) return undefined

  const values = (Object.keys(PAGE_SPREAD_PROPERTIES) as PageSpread[]).filter(
    (placement) =>
      PAGE_SPREAD_PROPERTIES[placement].some((property) =>
        properties.includes(property),
      ),
  )

  return values.length === 1 ? values[0] : undefined
}

function assertMeasurement(measurement: SectionLayoutMeasurement): void {
  if (measurement.measurementVersion !== SECTION_LAYOUT_MEASUREMENT_VERSION) {
    throw new RangeError(
      `Unsupported section layout measurement version: ${measurement.measurementVersion}`,
    )
  }

  if (!Number.isInteger(measurement.spineIndex) || measurement.spineIndex < 0) {
    throw new RangeError(
      'Section layout measurement spineIndex must be a non-negative integer',
    )
  }

  if (
    typeof measurement.resourceHref !== 'string' ||
    measurement.resourceHref.length === 0
  ) {
    throw new TypeError('Section layout measurement resourceHref is required')
  }

  if (typeof measurement.linear !== 'boolean') {
    throw new TypeError('Section layout measurement linear must be a boolean')
  }

  if (
    measurement.layout !== 'reflowable' &&
    measurement.layout !== 'pre-paginated'
  ) {
    throw new RangeError(
      `Unsupported section layout: ${measurement.layout as string}`,
    )
  }

  if (measurement.flow !== 'paginated' && measurement.flow !== 'roll') {
    throw new RangeError(
      `Unsupported section layout flow: ${measurement.flow as string}`,
    )
  }

  if (!Number.isInteger(measurement.leafCount) || measurement.leafCount < 0) {
    throw new RangeError(
      'Section layout measurement leafCount must be a non-negative integer',
    )
  }

  if (
    !Array.isArray(measurement.presentationGeometryPlanHashes) ||
    measurement.presentationGeometryPlanHashes.some(
      (hash) => !SHA256_PATTERN.test(hash),
    ) ||
    new Set(measurement.presentationGeometryPlanHashes).size !==
      measurement.presentationGeometryPlanHashes.length
  ) {
    throw new TypeError(
      'Section layout measurement requires unique SHA-256 geometry plan hashes',
    )
  }

  if (measurement.flow === 'roll' && measurement.leafCount !== 0) {
    throw new RangeError(
      'A rolling section cannot report discrete layout leaves',
    )
  }

  if (!measurement.linear && measurement.leafCount !== 0) {
    throw new RangeError(
      'A non-linear section cannot contribute layout leaves to the reading order',
    )
  }

  if (
    measurement.linear &&
    measurement.layout === 'pre-paginated' &&
    (measurement.flow !== 'paginated' || measurement.leafCount !== 1)
  ) {
    throw new RangeError(
      'A linear pre-paginated section must report exactly one paginated content leaf',
    )
  }

  if (
    measurement.pageSpread &&
    measurement.pageSpread !== 'left' &&
    measurement.pageSpread !== 'right' &&
    measurement.pageSpread !== 'center'
  ) {
    throw new RangeError(
      `Unsupported page-spread placement: ${measurement.pageSpread as string}`,
    )
  }

  if (
    measurement.sectionBoundaryMode &&
    measurement.sectionBoundaryMode !== 'flush' &&
    measurement.sectionBoundaryMode !== 'continue'
  ) {
    throw new RangeError(
      `Unsupported section boundary mode: ${
        measurement.sectionBoundaryMode as string
      }`,
    )
  }

  if (
    measurement.viewportMode &&
    measurement.viewportMode !== 'single' &&
    measurement.viewportMode !== 'two-up'
  ) {
    throw new RangeError(
      `Unsupported section viewport mode: ${
        measurement.viewportMode as string
      }`,
    )
  }
}

function firstReadingSlot(direction: LayoutDirection): 'left' | 'right' {
  return direction === 'ltr' ? 'left' : 'right'
}

function oppositeSlot(slot: 'left' | 'right'): 'left' | 'right' {
  return slot === 'left' ? 'right' : 'left'
}

function sectionBoundaryMode(
  measurement: SectionLayoutMeasurement,
): SectionBoundaryMode {
  return (
    measurement.sectionBoundaryMode ??
    (measurement.layout === 'reflowable' ? 'flush' : 'continue')
  )
}

/**
 * Reduces completed section measurements into a serializable visual plan.
 *
 * `append()` may be called as each hidden renderer is released. Internally it
 * keeps at most one unfinished opening; `state` exposes the serializable
 * cross-section state documented by the location-engine contract.
 */
export class SpreadPlanner {
  private readonly direction: LayoutDirection
  private readonly spreadMode: AtlasSpreadMode
  private readonly spreadSemanticsProfile: SpreadSemanticsProfile
  private readonly leaves: LayoutLeaf[] = []
  private readonly pages: LayoutPage[] = []
  private readonly spreads: LayoutSpread[] = []
  private readonly viewports: LayoutViewport[] = []
  private readonly transitions: LayoutAtlasTransition[] = []
  private readonly skippedSpineIndexes: number[] = []
  private readonly planState: SpreadState
  private openPair: OpenPair | undefined
  private finished: LayoutAtlasPlan | undefined

  constructor(options: SpreadPlannerOptions = {}) {
    this.direction = options.direction ?? 'ltr'
    this.spreadMode = options.spreadMode ?? 'two-up'
    this.spreadSemanticsProfile =
      options.spreadSemanticsProfile ?? DEFAULT_SPREAD_SEMANTICS_PROFILE
    if (this.direction !== 'ltr' && this.direction !== 'rtl') {
      throw new RangeError(`Unsupported layout direction: ${this.direction}`)
    }
    if (this.spreadMode !== 'single' && this.spreadMode !== 'two-up') {
      throw new RangeError(`Unsupported atlas spread mode: ${this.spreadMode}`)
    }
    if (!SPREAD_SEMANTICS_PROFILES.includes(this.spreadSemanticsProfile)) {
      throw new RangeError(
        `Unsupported spread semantics profile: ${this.spreadSemanticsProfile}`,
      )
    }
    this.planState = {
      openSlot: null,
      direction: this.direction,
    }
  }

  get state(): SpreadState {
    return { ...this.planState }
  }

  append(measurement: SectionLayoutMeasurement): SpreadState {
    if (this.finished) {
      throw new Error(
        'Cannot append a measurement after finishing a layout atlas plan',
      )
    }

    assertMeasurement(measurement)

    if (!measurement.linear) {
      this.skippedSpineIndexes.push(measurement.spineIndex)
      return this.state
    }

    if (measurement.flow === 'roll') {
      this.transitionTo('roll', measurement)
      this.planState.previousViewportMode = undefined
      this.flushOpenPair()
      this.addRollViewport(measurement)
      return this.state
    }

    // Empty documents create no visual leaf and must not force a new opening.
    if (measurement.leafCount === 0) return this.state

    const viewportMode = this.viewportModeFor(measurement)
    const previousLayout = this.planState.previousLayout
    this.transitionTo(measurement.layout, measurement)
    this.transitionViewportMode(viewportMode, measurement, previousLayout)

    const firstPageSpread = this.honoredPageSpread(measurement, viewportMode)
    // DefaultViewManager deliberately displays an unforced first fixed-layout
    // spine item (normally the cover) on its own. Mirror that compatibility
    // rule so Atlas viewport grouping never pairs the cover with page two.
    if (
      viewportMode === 'two-up' &&
      measurement.layout === 'pre-paginated' &&
      this.isFirstReadingOrderOccurrence(measurement) &&
      !firstPageSpread
    ) {
      this.flushOpenPair()
      this.addSinglePage(measurement, 0, undefined)
      return this.state
    }

    for (
      let sectionPageIndex = 0;
      sectionPageIndex < measurement.leafCount;
      sectionPageIndex += 1
    ) {
      const pageSpread = sectionPageIndex === 0 ? firstPageSpread : undefined
      if (viewportMode === 'single') {
        this.addSinglePage(measurement, sectionPageIndex, pageSpread)
      } else {
        this.addTwoUpPage(measurement, sectionPageIndex, pageSpread)
      }
    }

    if (
      viewportMode === 'two-up' &&
      sectionBoundaryMode(measurement) === 'flush'
    ) {
      this.flushOpenPair()
    }

    return this.state
  }

  finish(): LayoutAtlasPlan {
    if (this.finished) return this.finished

    this.flushOpenPair()
    const rollViewportCount = this.viewports.filter(
      (viewport) => viewport.kind === 'roll',
    ).length
    const paginationMode =
      rollViewportCount === 0
        ? 'paged'
        : rollViewportCount === this.viewports.length
        ? 'roll'
        : 'mixed'
    this.finished = {
      atlasVersion: LAYOUT_ATLAS_VERSION,
      direction: this.direction,
      spreadMode: this.spreadMode,
      spreadSemanticsProfile: this.spreadSemanticsProfile,
      paginationMode,
      state: this.state,
      leaves: this.leaves,
      pages: this.pages,
      spreads: this.spreads,
      viewports: this.viewports,
      transitions: this.transitions,
      skippedSpineIndexes: this.skippedSpineIndexes,
      totalLeafCount: this.leaves.length,
      totalPageCount: this.pages.length,
      totalSpreadCount: this.spreads.length,
      totalViewportCount: this.viewports.length,
    }
    return this.finished
  }

  private transitionTo(
    nextLayout: PlannedLayoutKind,
    measurement: SectionLayoutMeasurement,
  ): void {
    const previousLayout = this.planState.previousLayout
    if (previousLayout && previousLayout !== nextLayout) {
      const flushedOpenSpread = Boolean(this.openPair)
      this.flushOpenPair()
      this.transitions.push({
        kind:
          previousLayout === 'roll' || nextLayout === 'roll'
            ? 'roll-boundary'
            : 'layout-change',
        fromLayout: previousLayout,
        toLayout: nextLayout,
        spineIndex: measurement.spineIndex,
        flushedOpenSpread,
      })
    }
    this.planState.previousLayout = nextLayout
  }

  private viewportModeFor(
    measurement: SectionLayoutMeasurement,
  ): AtlasSpreadMode {
    return measurement.viewportMode ?? this.spreadMode
  }

  /**
   * A complete measurement stream starts at spine index zero, but the planner
   * also accepts ordered subsets for tooling. Only infer a skipped-prefix
   * cover when every preceding occurrence was actually supplied and marked
   * non-linear; never reinterpret an arbitrary subset beginning at index 1.
   */
  private isFirstReadingOrderOccurrence(
    measurement: SectionLayoutMeasurement,
  ): boolean {
    return (
      measurement.spineIndex === 0 ||
      (this.pages.length === 0 &&
        this.viewports.length === 0 &&
        this.skippedSpineIndexes.length === measurement.spineIndex &&
        this.skippedSpineIndexes.every(
          (spineIndex, index) => spineIndex === index,
        ))
    )
  }

  private transitionViewportMode(
    viewportMode: AtlasSpreadMode,
    measurement: SectionLayoutMeasurement,
    previousLayout: PlannedLayoutKind | undefined,
  ): void {
    const previousViewportMode = this.planState.previousViewportMode
    if (previousViewportMode && previousViewportMode !== viewportMode) {
      const flushedOpenSpread = Boolean(this.openPair)
      this.flushOpenPair()
      this.transitions.push({
        kind: 'viewport-mode-change',
        fromLayout: previousLayout ?? measurement.layout,
        toLayout: measurement.layout,
        spineIndex: measurement.spineIndex,
        flushedOpenSpread,
        fromViewportMode: previousViewportMode,
        toViewportMode: viewportMode,
      })
    }
    this.planState.previousViewportMode = viewportMode
  }

  private honoredPageSpread(
    measurement: SectionLayoutMeasurement,
    viewportMode: AtlasSpreadMode,
  ): PageSpread | undefined {
    if (viewportMode !== 'two-up') return undefined

    // EPUB 3.4 CRD narrows synthetic page-spread placement to fixed-layout
    // content. EPUB 3.3 compatibility intentionally retains the broader
    // legacy behavior, and the profile is part of the atlas fingerprint.
    if (
      this.spreadSemanticsProfile === 'epub34-crd-20260721' &&
      measurement.layout === 'reflowable'
    ) {
      return undefined
    }

    return measurement.pageSpread
  }

  private addRollViewport(measurement: SectionLayoutMeasurement): void {
    this.viewports.push({
      viewportIndex: this.viewports.length,
      kind: 'roll',
      spineIndex: measurement.spineIndex,
      resourceHref: measurement.resourceHref,
      layout: measurement.layout,
      leafIndexes: [],
      pageIndexes: [],
    })
  }

  private addSinglePage(
    measurement: SectionLayoutMeasurement,
    sectionPageIndex: number,
    pageSpread: PageSpread | undefined,
  ): void {
    const leafIndex = this.addContentLeaf(
      measurement,
      sectionPageIndex,
      'center',
      pageSpread,
    )
    const pageIndex = this.pageIndexForLeaf(leafIndex)
    const spreadIndex = this.spreads.length
    this.spreads.push({
      spreadIndex,
      kind: 'single',
      centerLeafIndex: leafIndex,
    })
    this.viewports.push({
      viewportIndex: this.viewports.length,
      kind: 'single-page',
      spreadIndex,
      leafIndexes: [leafIndex],
      pageIndexes: [pageIndex],
    })
  }

  private addTwoUpPage(
    measurement: SectionLayoutMeasurement,
    sectionPageIndex: number,
    pageSpread: PageSpread | undefined,
  ): void {
    if (pageSpread === 'center') {
      this.flushOpenPair()
      const leafIndex = this.addContentLeaf(
        measurement,
        sectionPageIndex,
        'center',
        pageSpread,
      )
      const pageIndex = this.pageIndexForLeaf(leafIndex)
      const spreadIndex = this.spreads.length
      this.spreads.push({
        spreadIndex,
        kind: 'center',
        centerLeafIndex: leafIndex,
      })
      this.viewports.push({
        viewportIndex: this.viewports.length,
        kind: 'single-page',
        spreadIndex,
        leafIndexes: [leafIndex],
        pageIndexes: [pageIndex],
      })
      return
    }

    const openSlot = this.planState.openSlot
    if (this.openPair && openSlot) {
      if (!pageSpread || pageSpread === openSlot) {
        this.fillOpenPair(measurement, sectionPageIndex, openSlot, pageSpread)
        return
      }
      // A forced side conflicts with the remaining physical slot. Close the
      // old opening with a blank, then start a new opening at that side.
      this.flushOpenPair()
    }

    this.startPair(measurement, sectionPageIndex, pageSpread)
  }

  private startPair(
    measurement: SectionLayoutMeasurement,
    sectionPageIndex: number,
    pageSpread: Exclude<PageSpread, 'center'> | undefined,
  ): void {
    const readingStart = firstReadingSlot(this.direction)
    const targetSlot = pageSpread ?? readingStart
    const openPair: OpenPair = { spreadIndex: this.spreads.length }

    if (targetSlot !== readingStart) {
      this.setPairLeaf(openPair, readingStart, this.addBlankLeaf(readingStart))
      this.setPairLeaf(
        openPair,
        targetSlot,
        this.addContentLeaf(
          measurement,
          sectionPageIndex,
          targetSlot,
          pageSpread,
        ),
      )
      this.publishPair(openPair)
      return
    }

    this.setPairLeaf(
      openPair,
      targetSlot,
      this.addContentLeaf(
        measurement,
        sectionPageIndex,
        targetSlot,
        pageSpread,
      ),
    )
    this.openPair = openPair
    this.planState.openSlot = oppositeSlot(targetSlot)
  }

  private fillOpenPair(
    measurement: SectionLayoutMeasurement,
    sectionPageIndex: number,
    slot: 'left' | 'right',
    pageSpread: PageSpread | undefined,
  ): void {
    const openPair = this.openPair
    if (!openPair) {
      throw new Error('Spread planner lost its active opening')
    }

    this.setPairLeaf(
      openPair,
      slot,
      this.addContentLeaf(measurement, sectionPageIndex, slot, pageSpread),
    )
    this.publishPair(openPair)
  }

  private flushOpenPair(): void {
    const openPair = this.openPair
    const openSlot = this.planState.openSlot
    if (!openPair || !openSlot) return

    this.setPairLeaf(openPair, openSlot, this.addBlankLeaf(openSlot))
    this.publishPair(openPair)
  }

  private publishPair(openPair: OpenPair): void {
    if (
      openPair.leftLeafIndex === undefined ||
      openPair.rightLeafIndex === undefined
    ) {
      throw new Error(
        'A two-up spread must have both physical leaves before publication',
      )
    }

    const leftLeafIndex = openPair.leftLeafIndex
    const rightLeafIndex = openPair.rightLeafIndex
    this.spreads.push({
      spreadIndex: openPair.spreadIndex,
      kind: 'pair',
      leftLeafIndex,
      rightLeafIndex,
    })
    this.viewports.push({
      viewportIndex: this.viewports.length,
      kind: 'spread',
      spreadIndex: openPair.spreadIndex,
      leafIndexes: [leftLeafIndex, rightLeafIndex],
      pageIndexes: this.pageIndexesForLeaves(leftLeafIndex, rightLeafIndex),
    })
    this.openPair = undefined
    this.planState.openSlot = null
  }

  private setPairLeaf(
    openPair: OpenPair,
    slot: 'left' | 'right',
    leafIndex: number,
  ): void {
    if (slot === 'left') {
      openPair.leftLeafIndex = leafIndex
    } else {
      openPair.rightLeafIndex = leafIndex
    }
  }

  private addBlankLeaf(slot: 'left' | 'right'): number {
    const leafIndex = this.leaves.length
    this.leaves.push({ leafIndex, kind: 'blank', slot })
    return leafIndex
  }

  private addContentLeaf(
    measurement: SectionLayoutMeasurement,
    sectionPageIndex: number,
    slot: 'left' | 'right' | 'center',
    pageSpread: PageSpread | undefined,
  ): number {
    const leafIndex = this.leaves.length
    const pageIndex = this.pages.length
    this.leaves.push({ leafIndex, kind: 'content', slot, pageIndex })
    this.pages.push({
      pageIndex,
      leafIndex,
      spineIndex: measurement.spineIndex,
      resourceHref: measurement.resourceHref,
      sectionPageIndex,
      layout: measurement.layout,
      ...(pageSpread ? { pageSpread } : {}),
    })
    return leafIndex
  }

  private pageIndexForLeaf(leafIndex: number): number {
    const leaf = this.leaves[leafIndex]
    if (!leaf || leaf.kind !== 'content') {
      throw new Error('Expected a content leaf to have a page index')
    }
    return leaf.pageIndex
  }

  private pageIndexesForLeaves(...leafIndexes: number[]): number[] {
    return leafIndexes.flatMap((leafIndex) => {
      const leaf = this.leaves[leafIndex]
      return leaf?.kind === 'content' ? [leaf.pageIndex] : []
    })
  }
}

/** Plan a complete atlas from measurements without retaining any DOM state. */
export function planLayoutAtlas(
  measurements: readonly SectionLayoutMeasurement[],
  options: SpreadPlannerOptions = {},
): LayoutAtlasPlan {
  const planner = new SpreadPlanner(options)
  let previousSpineIndex = -1
  measurements.forEach((measurement) => {
    assertMeasurement(measurement)
    if (measurement.spineIndex <= previousSpineIndex) {
      throw new RangeError(
        'Section layout measurements must be unique and ordered by spineIndex',
      )
    }
    previousSpineIndex = measurement.spineIndex
    planner.append(measurement)
  })
  return planner.finish()
}

/**
 * Creates the persistable local atlas record. The profile in its fingerprint
 * and in planning options must agree so a cache key cannot describe different
 * spread semantics from the stored plan.
 */
export function buildLayoutAtlas(
  fingerprint: LayoutFingerprint,
  measurements: readonly SectionLayoutMeasurement[],
  options: Omit<SpreadPlannerOptions, 'spreadSemanticsProfile'> = {},
): LayoutAtlas {
  if (fingerprint.atlasVersion !== LAYOUT_ATLAS_VERSION) {
    throw new RangeError(
      `Unsupported layout atlas version: ${fingerprint.atlasVersion}`,
    )
  }

  const plan = planLayoutAtlas(measurements, {
    ...options,
    spreadSemanticsProfile: fingerprint.spreadSemanticsProfile,
  })

  return {
    ...plan,
    fingerprint: {
      ...fingerprint,
      viewport: { ...fingerprint.viewport },
    },
    measurements: measurements.map((measurement) => ({
      ...measurement,
      presentationGeometryPlanHashes: [
        ...measurement.presentationGeometryPlanHashes,
      ],
    })),
    presentationGeometryPlanSet: measurements.map((measurement) => ({
      spineIndex: measurement.spineIndex,
      geometryPlanHashes: [...measurement.presentationGeometryPlanHashes],
    })),
  }
}

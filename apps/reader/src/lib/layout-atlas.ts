import {
  acceptedGeometryPlanHashes,
  buildLayoutAtlas,
  DEFAULT_SPREAD_SEMANTICS_PROFILE,
  hasCompletePaginationGeometryArtifacts,
  LAYOUT_ATLAS_VERSION,
  LAYOUT_MEASUREMENT_SESSION_VERSION,
  LayoutMeasurementSession,
  RENDITION_IMAGE_LAYOUT_VERSION,
} from '@flow/epubjs'
import type {
  Book,
  LayoutAtlas,
  LayoutDirection,
  LayoutFingerprint,
  LayoutMeasurementRendererSettings,
  LayoutSettings,
  LayoutMeasurementProgress,
  PaginationLifecycleArtifacts,
  Rendition,
} from '@flow/epubjs'

import type { TypographyConfiguration } from '../state'

/**
 * This changes when Lumen's host-side typography pipeline changes. It is part
 * of every atlas key in addition to the engine's measurement-session version.
 */
export const LUMEN_LAYOUT_RENDERER_VERSION = `lumen-layout-renderer-v4.measure-v${LAYOUT_MEASUREMENT_SESSION_VERSION}.images-v${RENDITION_IMAGE_LAYOUT_VERSION}`

export interface LayoutAtlasViewport {
  width: number
  height: number
}

export interface LayoutAtlasMeasurementInput {
  book: Book
  rendition: Rendition
  publicationRevision: string
  viewport: LayoutAtlasViewport
  typography?: TypographyConfiguration
  signal?: AbortSignal
  onProgress?: (progress: LayoutMeasurementProgress) => void
  /** Reuse the key checked against IndexedDB immediately before measuring. */
  preparedFingerprint?: PreparedLayoutAtlasFingerprint
}

/**
 * An immutable rendering snapshot used for both the IndexedDB key and the
 * isolated measuring renderer. Re-reading live rendition settings later can
 * otherwise store a measurement made under configuration B under key A.
 */
export interface LayoutAtlasRendererSnapshot
  extends LayoutMeasurementRendererSettings {
  spreadMode: 'single' | 'two-up'
}

export interface PreparedLayoutAtlasFingerprint {
  fingerprint: LayoutFingerprint
  fingerprintKey: string
  renderer: LayoutAtlasRendererSnapshot
}

type LayoutAtlasFingerprintInput = Omit<
  LayoutAtlasMeasurementInput,
  'signal' | 'onProgress' | 'preparedFingerprint'
>

export interface MeasuredLayoutAtlas {
  fingerprint: LayoutFingerprint
  fingerprintKey: string
  atlas: LayoutAtlas
}

export interface LayoutPositionMappingInput {
  atlas: LayoutAtlas
  spineIndex: number
  displayedPage: number
  direction?: LayoutDirection
  directMappingSafe: boolean
}

export interface VisiblePaginationArtifactSet {
  spineIndex: number
  artifacts: PaginationLifecycleArtifacts
}

/**
 * Prove that the visible iframe(s) made the same terminal geometry decisions
 * as the detached measurement. A timeout or fallback intentionally leaves an
 * incomplete artifact set, so it must keep visual totals approximate rather
 * than silently mixing two different presentations.
 */
export function layoutAtlasMatchesVisiblePaginationArtifacts(
  atlas: LayoutAtlas,
  visible: readonly VisiblePaginationArtifactSet[],
): boolean {
  if (visible.length === 0) return false

  return visible.every(({ spineIndex, artifacts }) => {
    const measurement = atlas.measurements.find(
      (candidate) => candidate.linear && candidate.spineIndex === spineIndex,
    )
    if (
      !measurement ||
      !hasCompletePaginationGeometryArtifacts(artifacts) ||
      artifacts.geometry.some((artifact) => artifact.spineIndex !== spineIndex)
    ) {
      return false
    }

    const visibleHashes = acceptedGeometryPlanHashes(artifacts)
    return (
      visibleHashes.length ===
        measurement.presentationGeometryPlanHashes.length &&
      visibleHashes.every(
        (hash, index) =>
          hash === measurement.presentationGeometryPlanHashes[index],
      )
    )
  })
}

/**
 * Translate the live renderer's section-local page into global Atlas pages.
 * A synthetic companion leaf is not ambiguous by itself: when the matched
 * content leaf is known, a one-page opening remains an exact visual position.
 */
export function layoutViewportPagesForPosition({
  atlas,
  spineIndex,
  displayedPage,
  direction = 'ltr',
  directMappingSafe,
}: LayoutPositionMappingInput): number[] | undefined {
  if (
    !directMappingSafe ||
    direction === 'rtl' ||
    !Number.isInteger(spineIndex) ||
    spineIndex < 0 ||
    !Number.isInteger(displayedPage) ||
    displayedPage < 1
  ) {
    return undefined
  }

  const page = atlas.pages.find(
    (candidate) =>
      candidate.spineIndex === spineIndex &&
      candidate.sectionPageIndex === displayedPage - 1,
  )
  if (!page || page.pageSpread) return undefined

  const viewport = atlas.viewports.find((candidate) =>
    (candidate.pageIndexes as readonly number[]).includes(page.pageIndex),
  )
  return viewport ? [...viewport.pageIndexes] : [page.pageIndex]
}

/**
 * IndexedDB is an opportunistic cache and can outlive preview builds or be
 * partially written by a browser shutdown. Validate its cross-references
 * before exposing a cached total as a completed visual measurement.
 */
export function isUsableLayoutAtlas(
  value: unknown,
  publicationRevision: string,
  expectedFingerprint?: LayoutFingerprint,
): value is LayoutAtlas {
  if (!value || typeof value !== 'object') return false
  const atlas = value as Partial<LayoutAtlas>
  if (
    atlas.atlasVersion !== LAYOUT_ATLAS_VERSION ||
    atlas.fingerprint?.atlasVersion !== LAYOUT_ATLAS_VERSION ||
    typeof atlas.fingerprint?.presentationGeometryPipelineFingerprint !==
      'string' ||
    typeof atlas.fingerprint?.rendererVersion !== 'string' ||
    typeof atlas.fingerprint?.browserEngine !== 'string' ||
    typeof atlas.fingerprint?.browserEngineVersion !== 'string' ||
    typeof atlas.fingerprint?.typographyFingerprint !== 'string' ||
    typeof atlas.fingerprint?.resolvedFontFingerprint !== 'string' ||
    typeof atlas.fingerprint?.layoutSettingsFingerprint !== 'string' ||
    !Number.isFinite(atlas.fingerprint?.viewport?.width) ||
    atlas.fingerprint!.viewport.width <= 0 ||
    !Number.isFinite(atlas.fingerprint?.viewport?.height) ||
    atlas.fingerprint!.viewport.height <= 0 ||
    !Number.isFinite(atlas.fingerprint?.viewport?.deviceScaleFactor) ||
    atlas.fingerprint!.viewport.deviceScaleFactor <= 0 ||
    atlas.fingerprint?.publicationFingerprint !== publicationRevision ||
    (atlas.direction !== 'ltr' && atlas.direction !== 'rtl') ||
    (atlas.spreadMode !== 'single' && atlas.spreadMode !== 'two-up') ||
    atlas.spreadSemanticsProfile !== atlas.fingerprint.spreadSemanticsProfile ||
    !Array.isArray(atlas.measurements) ||
    !Array.isArray(atlas.presentationGeometryPlanSet) ||
    atlas.presentationGeometryPlanSet.length !== atlas.measurements.length ||
    !Array.isArray(atlas.pages) ||
    !Array.isArray(atlas.leaves) ||
    !Array.isArray(atlas.spreads) ||
    !Array.isArray(atlas.viewports) ||
    !Array.isArray(atlas.transitions) ||
    !Array.isArray(atlas.skippedSpineIndexes) ||
    !Number.isInteger(atlas.totalPageCount) ||
    !Number.isInteger(atlas.totalLeafCount) ||
    !Number.isInteger(atlas.totalSpreadCount) ||
    !Number.isInteger(atlas.totalViewportCount) ||
    atlas.totalPageCount! < 0 ||
    atlas.totalLeafCount! < 0 ||
    atlas.totalSpreadCount! < 0 ||
    atlas.totalViewportCount! < 0 ||
    atlas.totalPageCount !== atlas.pages.length ||
    atlas.totalLeafCount !== atlas.leaves.length ||
    atlas.totalSpreadCount !== atlas.spreads.length ||
    atlas.totalViewportCount !== atlas.viewports.length
  ) {
    return false
  }

  try {
    // IndexedDB uses structured clone and can technically contain cyclic
    // objects. Treat a malformed/cyclic fingerprint as a cache miss instead
    // of letting the deterministic serializer overflow and permanently move
    // this book's Atlas into the failed state.
    if (
      expectedFingerprint &&
      !sameFingerprint(atlas.fingerprint, expectedFingerprint)
    ) {
      return false
    }
    // Measurements are the compact source of truth. Replanning them validates
    // every measurement field and proves every leaf/page/spread/viewport,
    // transition, skipped index, geometry-plan set and aggregate count at
    // once. Checking only page -> leaf references allowed corrupted companion
    // structures to survive a browser shutdown and be presented as exact.
    const rebuilt = buildLayoutAtlas(atlas.fingerprint, atlas.measurements, {
      direction: atlas.direction,
      spreadMode: atlas.spreadMode,
    })
    return stableStringify(rebuilt) === stableStringify(atlas)
  } catch {
    return false
  }
}

/** The visible renderer changed while a detached Atlas was being measured. */
export class LayoutAtlasConfigurationChangedError extends Error {
  constructor() {
    super('The reader layout changed while its page atlas was being measured')
    this.name = 'LayoutAtlasConfigurationChangedError'
  }
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`

  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`
}

const UNCACHEABLE_LAYOUT_ATLAS_KEY_PREFIX = 'lumen-atlas-uncacheable-v1:'

function uncacheableFingerprintKey(): string {
  return `${UNCACHEABLE_LAYOUT_ATLAS_KEY_PREFIX}${Date.now()}:${Math.random()}`
}

/** A fallback key is useful for this browser session, but never worth storing. */
export function isCacheableLayoutAtlasFingerprintKey(key: string): boolean {
  return !key.startsWith(UNCACHEABLE_LAYOUT_ATLAS_KEY_PREFIX)
}

async function fingerprintKeyFor(
  fingerprint: LayoutFingerprint,
): Promise<string> {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) return uncacheableFingerprintKey()

  try {
    const encoded = new TextEncoder().encode(stableStringify(fingerprint))
    const digest = await subtle.digest('SHA-256', encoded)
    const hex = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('')
    return `lumen-layout-atlas-v1:${hex}`
  } catch {
    return uncacheableFingerprintKey()
  }
}

function getBrowserEngine(): { engine: string; version: string } {
  const userAgent = globalThis.navigator?.userAgent ?? ''
  const firefox = /Firefox\/(\d+(?:\.\d+)?)/.exec(userAgent)
  if (firefox) return { engine: 'gecko', version: firefox[1]! }

  const edge = /Edg\/(\d+(?:\.\d+)?)/.exec(userAgent)
  if (edge) return { engine: 'chromium', version: edge[1]! }

  const chrome = /Chrome\/(\d+(?:\.\d+)?)/.exec(userAgent)
  if (chrome) return { engine: 'chromium', version: chrome[1]! }

  const safari = /Version\/(\d+(?:\.\d+)?).*Safari\//.exec(userAgent)
  if (safari) return { engine: 'webkit', version: safari[1]! }

  return { engine: 'unknown', version: 'unknown' }
}

function getResolvedFontFingerprint(
  typography?: TypographyConfiguration,
): string {
  const fonts = globalThis.document?.fonts
  const requestedFamily = typography?.fontFamily?.trim() || undefined
  let requestedFamilyAvailable: boolean | null = null
  if (fonts && requestedFamily) {
    try {
      requestedFamilyAvailable = fonts.check(`16px "${requestedFamily}"`)
    } catch (_error) {
      requestedFamilyAvailable = false
    }
  }

  return stableStringify({
    strategy: 'requested-family-v2',
    requestedFamily: requestedFamily ?? null,
    requestedFamilyAvailable,
  })
}

function requireLayout(rendition: Rendition) {
  const manager = rendition.manager
  const layout = manager?.layout
  if (!manager || !layout) {
    throw new Error(
      'Cannot measure a layout atlas before the rendition is ready',
    )
  }
  return { manager, layout }
}

interface EffectiveAtlasRendererSettings {
  direction: LayoutDirection
  layout: LayoutSettings
  gap?: number
  spreadMode: 'single' | 'two-up'
}

function stringSetting(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback
}

function normalizeEffectiveFlow(flow: string): 'paginated' | 'scrolled' {
  return flow === 'scrolled' ||
    flow === 'scrolled-doc' ||
    flow === 'scrolled-continuous'
    ? 'scrolled'
    : 'paginated'
}

/**
 * `Layout.settings` records the publication's initial settings. Runtime calls
 * such as `rendition.spread('none')` and `rendition.flow('scrolled')` update
 * `rendition.settings`/Layout props instead, so an Atlas must resolve the
 * same effective configuration the reader is using now rather than cloning
 * only the initial Layout settings.
 */
function getEffectiveAtlasRendererSettings(
  rendition: Rendition,
  viewport: LayoutAtlasViewport,
): EffectiveAtlasRendererSettings {
  const { manager, layout } = requireLayout(rendition)
  const renditionSettings = rendition.settings
  const direction: LayoutDirection =
    (renditionSettings.direction ?? manager.settings.direction) === 'rtl'
      ? 'rtl'
      : 'ltr'
  const configuredFlow = stringSetting(
    renditionSettings.flow,
    stringSetting(
      layout.props?.flow,
      stringSetting(layout.settings.flow, 'paginated'),
    ),
  )
  const flow = normalizeEffectiveFlow(configuredFlow)
  const spread = stringSetting(
    renditionSettings.spread,
    stringSetting(
      layout.settings.spread,
      layout.props?.spread ? 'auto' : 'none',
    ),
  )
  const minSpreadWidth =
    typeof renditionSettings.minSpreadWidth === 'number'
      ? renditionSettings.minSpreadWidth
      : layout.settings.minSpreadWidth ?? 800
  const effectiveLayout: LayoutSettings = {
    ...layout.settings,
    layout: stringSetting(renditionSettings.layout, layout.name),
    flow,
    spread,
    minSpreadWidth,
    direction,
  }

  return {
    direction,
    layout: effectiveLayout,
    gap: manager.settings.gap,
    // Do not read `layout.divisor` here: a currently displayed vertical
    // chapter forces it to one even when the global horizontal reader is
    // two-up. Each measured section reports its own viewportMode.
    spreadMode:
      flow === 'paginated' &&
      spread !== 'none' &&
      Math.round(viewport.width) >= minSpreadWidth
        ? 'two-up'
        : 'single',
  }
}

/**
 * Creates a fully explicit, local-only renderer fingerprint. The publication
 * hash protects the EPUB bytes; all remaining fields protect browser/layout
 * conditions that can change CSS pagination without changing those bytes.
 */
export async function createLayoutAtlasFingerprint(
  input: LayoutAtlasFingerprintInput,
): Promise<PreparedLayoutAtlasFingerprint> {
  const browser = getBrowserEngine()
  const effectiveRenderer = getEffectiveAtlasRendererSettings(
    input.rendition,
    input.viewport,
  )
  const viewport = {
    width: Math.round(input.viewport.width),
    height: Math.round(input.viewport.height),
    deviceScaleFactor: Number.isFinite(globalThis.devicePixelRatio)
      ? globalThis.devicePixelRatio
      : 1,
  }
  const renderer: LayoutAtlasRendererSnapshot = {
    layout: { ...effectiveRenderer.layout },
    width: viewport.width,
    height: viewport.height,
    direction: effectiveRenderer.direction,
    gap: effectiveRenderer.gap,
    spreadMode: effectiveRenderer.spreadMode,
  }
  const layoutSettings = {
    name: renderer.layout.layout,
    settings: renderer.layout,
    flow: renderer.layout.flow,
    direction: renderer.direction,
    gap: renderer.gap ?? null,
    spreadMode: renderer.spreadMode,
    // The visible renderer owns its compatibility parity padding. The
    // measurement session deliberately disables it and lets SpreadPlanner
    // produce those blanks exactly once.
    measurementForceEvenPages: false,
  }
  const fingerprint: LayoutFingerprint = {
    publicationFingerprint: input.publicationRevision,
    rendererVersion: LUMEN_LAYOUT_RENDERER_VERSION,
    browserEngine: browser.engine,
    browserEngineVersion: browser.version,
    viewport,
    typographyFingerprint: stableStringify(input.typography ?? {}),
    resolvedFontFingerprint: getResolvedFontFingerprint(input.typography),
    layoutSettingsFingerprint: stableStringify(layoutSettings),
    presentationGeometryPipelineFingerprint:
      input.rendition.getPaginationGeometryPipelineFingerprint(),
    // The visible Lumen renderer remains intentionally EPUB 3.3-compatible
    // until its own page-spread implementation switches profile as well.
    spreadSemanticsProfile: DEFAULT_SPREAD_SEMANTICS_PROFILE,
    atlasVersion: LAYOUT_ATLAS_VERSION,
  }

  return {
    fingerprint,
    fingerprintKey: await fingerprintKeyFor(fingerprint),
    renderer,
  }
}

function sameFingerprint(
  left: LayoutFingerprint,
  right: LayoutFingerprint,
): boolean {
  return stableStringify(left) === stableStringify(right)
}

/**
 * Cache lookup is asynchronous too. Validate the live renderer immediately
 * before accepting a prepared entry, not just before a fresh measurement.
 */
export async function assertPreparedLayoutAtlasFingerprintCurrent(
  input: LayoutAtlasFingerprintInput,
  prepared: PreparedLayoutAtlasFingerprint,
): Promise<void> {
  const current = await createLayoutAtlasFingerprint(input)
  if (!sameFingerprint(current.fingerprint, prepared.fingerprint)) {
    throw new LayoutAtlasConfigurationChangedError()
  }
}

/**
 * Builds a visual page atlas in a separate, visibility-hidden DOM subtree.
 * It never attaches a second rendition to the live Book and never unloads a
 * Section that the reader is using.
 */
export async function measureLayoutAtlas(
  input: LayoutAtlasMeasurementInput,
): Promise<MeasuredLayoutAtlas> {
  const prepared =
    input.preparedFingerprint ?? (await createLayoutAtlasFingerprint(input))
  const { fingerprint, fingerprintKey, renderer } = prepared

  const verifyCurrentConfiguration = () =>
    assertPreparedLayoutAtlasFingerprintCurrent(input, prepared)

  // The caller may have spent time checking IndexedDB after preparing this
  // snapshot. Confirm that the actual renderer still matches before we create
  // any detached iframes, then once more before publishing the result.
  if (input.preparedFingerprint) await verifyCurrentConfiguration()
  const session = new LayoutMeasurementSession({
    book: input.book,
    renderer,
    paginationLifecycle: input.rendition.getPaginationLifecycle(),
  })

  try {
    const measurements = await session.measure({
      signal: input.signal,
      onProgress: input.onProgress,
    })
    await verifyCurrentConfiguration()
    const atlas = buildLayoutAtlas(fingerprint, measurements, {
      direction: renderer.direction ?? 'ltr',
      spreadMode: renderer.spreadMode,
    })
    return { fingerprint, fingerprintKey, atlas }
  } finally {
    session.destroy()
  }
}

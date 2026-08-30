/**
 * Bounded observations of the browser-rendered EPUB document.
 *
 * This module deliberately records evidence only. It does not diagnose a
 * publication, choose a repair, or mutate the rendered/source document.
 * Analyzers consume the same snapshot so paint and geometry policies do not
 * each invent a different model of what the browser displayed.
 */

import {
  contrastRatio,
  parseSrgbColor,
  resolveComputedSrgbColor,
  type SrgbColor,
} from './presentation-color'
import {
  createSourceTreeAddress,
  getSourceTreeRoot,
  SOURCE_TREE_MODEL_VERSION,
  walkSourceTree,
  type SourceTreeAddress,
} from './source-tree'
import { isPresentationRuntimeNode } from './presentation-marker'

export const PRESENTATION_HEALTH_MODEL_VERSION = 11 as const
/**
 * Hard ceiling for a complete presentation evidence map.
 *
 * Large back-of-book indexes routinely contain several thousand short text
 * and link elements. The previous 2,048-element ceiling made those documents
 * permanently ineligible for a document-wide paint repair, even though their
 * rendered structure is otherwise simple. Keep the work bounded, but cover a
 * realistic large EPUB section instead of treating a common index as an
 * exceptional document.
 */
export const MAX_PRESENTATION_HEALTH_ELEMENTS = 8192 as const
export const PRESENTATION_LEGIBILITY_MODEL_VERSION = 4 as const

export type PresentationElementRole =
  | 'root'
  | 'text'
  | 'image'
  | 'table'
  | 'svg'
  | 'math'
  | 'media'
  | 'form-control'
  | 'container'

export type PresentationPaintUnknownReason =
  | 'missing-render-view'
  | 'invalid-canvas'
  | 'unparseable-foreground'
  | 'translucent-foreground'
  | 'background-image'
  | 'translucent-background'
  | 'composited-paint'
  | 'text-effect'
  | 'alternate-text-paint'
  | 'clipped-paint'
  | 'hidden-content'
  | 'no-rendered-box'
  | 'no-known-surface'
  | 'pseudo-element'

export type PresentationObservedStyle = {
  display: string
  float: string
  visibility: string
  position: string
  opacity: number | undefined
  color: string
  backgroundColor: string
  backgroundImage: string
  mixBlendMode: string
  backgroundBlendMode: string
  filter: string
  textShadow: string
  webkitTextFillColor: string
  webkitTextStrokeWidth: string
  clipPath: string
  maskImage: string
  webkitMaskImage: string
  contentVisibility: string
  transform: string
  overflowX: string
  overflowY: string
  overflowInline: string
  overflowBlock: string
  writingMode: string
  direction: string
  listStyleType: string
  listStyleImage: string
}

export type PresentationObservedGeometry = {
  x: number
  y: number
  width: number
  height: number
  clientWidth: number
  clientHeight: number
  scrollWidth: number
  scrollHeight: number
  clientRectCount: number
}

export type PresentationObservedResource =
  | {
      kind: 'image'
      ready: boolean
      intrinsicWidth: number
      intrinsicHeight: number
    }
  | {
      kind: 'media'
      ready: boolean
    }

export type PresentationKnownPaintRelationship = {
  kind: 'known'
  confidence: 'high'
  foreground: SrgbColor
  background: SrgbColor
  contrast: number
  transparentAncestorCount: number
  surface:
    | { kind: 'canvas' }
    | { kind: 'document' }
    | { kind: 'element'; observationIndex: number; address: SourceTreeAddress }
}

export type PresentationUnknownPaintRelationship = {
  kind: 'unknown'
  confidence: 'low'
  reason: PresentationPaintUnknownReason
  foreground?: SrgbColor
}

export type PresentationPaintRelationship =
  | PresentationKnownPaintRelationship
  | PresentationUnknownPaintRelationship

export type PresentationHealthObservation = {
  /** Runtime-only reference. Health maps are never persisted as plans. */
  element: Element
  address: SourceTreeAddress
  parentObservationIndex?: number
  localName: string
  role: PresentationElementRole
  directMeaningfulText: boolean
  directTextCodePoints: number
  textPaintEligible: boolean
  style: PresentationObservedStyle
  paint: PresentationPaintRelationship
  geometry: PresentationObservedGeometry
  resource?: PresentationObservedResource
}

export type PresentationListMarkerObservation = {
  /** Runtime-only reference. Health maps are never persisted as plans. */
  element: Element
  address: SourceTreeAddress
  parentObservationIndex?: number
  style: PresentationObservedStyle
  paint: PresentationPaintRelationship
  geometry: PresentationObservedGeometry
}

export type PresentationHealthMap = {
  modelVersion: typeof PRESENTATION_HEALTH_MODEL_VERSION
  /** Runtime identity; health snapshots are never serialized or cached. */
  renderedDocument: Document
  spineIndex: number
  canvas?: SrgbColor
  observations: readonly PresentationHealthObservation[]
  listMarkers: readonly PresentationListMarkerObservation[]
  inspectedElements: number
  truncated: boolean
  pseudoTextSamples: number
  pseudoTextTruncated: boolean
  diagnostics: readonly string[]
}

export type CreatePresentationHealthMapOptions = {
  renderedDocument: Document
  spineIndex: number
  canvasColor?: string | SrgbColor
  signal?: AbortSignal
  maxInspectedElements?: number
  /**
   * Restrict expensive style/geometry evidence to these elements and their
   * authored ancestors. DOM discovery still walks the source tree so stable
   * source addresses do not depend on a document-prefix sampling budget.
   */
  focusElements?: readonly Element[]
}

export type PresentationLegibilitySummary = {
  modelVersion: typeof PRESENTATION_LEGIBILITY_MODEL_VERSION
  complete: boolean
  truncated: boolean
  visibleTextSamples: number
  visibleTextCodePoints: number
  nonVisibleTextSamples: number
  nonVisibleTextCodePoints: number
  provenReadableSamples: number
  provenReadableCodePoints: number
  knownLowContrastSamples: number
  knownLowContrastCodePoints: number
  unknownPaintSamples: number
  unknownPaintCodePoints: number
  unknownPaintByReason: Readonly<
    Partial<Record<PresentationPaintUnknownReason, number>>
  >
  analysisFailure?: 'health-map-unavailable'
}

export type SummarizePresentationLegibilityOptions = {
  healthMap: PresentationHealthMap
  minimumTextContrast?: number
}

function clipsOverflow(value: string): boolean {
  return value !== 'visible'
}

/**
 * Prove only complete clipping by a local authored ancestor. Root/body are
 * deliberately excluded because paginated renderers use them as viewport
 * machinery; treating their column clipping as invisibility would erase
 * off-screen pages from the section ledger.
 */
function isFullyClippedByObservedAncestor(
  observationIndex: number,
  observations: readonly PresentationHealthObservation[],
): boolean {
  const observation = observations[observationIndex]!
  let left = observation.geometry.x
  let right = left + observation.geometry.width
  let top = observation.geometry.y
  let bottom = top + observation.geometry.height
  let ancestorIndex = observation.parentObservationIndex

  while (ancestorIndex !== undefined) {
    const ancestor = observations[ancestorIndex]
    if (!ancestor) break
    if (ancestor.localName !== 'html' && ancestor.localName !== 'body') {
      const ancestorLeft = ancestor.geometry.x
      const ancestorRight = ancestorLeft + ancestor.geometry.width
      const ancestorTop = ancestor.geometry.y
      const ancestorBottom = ancestorTop + ancestor.geometry.height
      if (clipsOverflow(ancestor.style.overflowX)) {
        left = Math.max(left, ancestorLeft)
        right = Math.min(right, ancestorRight)
      }
      if (clipsOverflow(ancestor.style.overflowY)) {
        top = Math.max(top, ancestorTop)
        bottom = Math.min(bottom, ancestorBottom)
      }
      if (right <= left || bottom <= top) return true
    }
    ancestorIndex = ancestor.parentObservationIndex
  }
  return false
}

type PendingObservation = {
  element: Element
  address: SourceTreeAddress
  parentObservationIndex?: number
  localName: string
  role: PresentationElementRole
  directMeaningfulText: boolean
  directTextCodePoints: number
  style?: PresentationObservedStyle
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException('Aborted', 'AbortError')
  }
}

function finiteMetric(value: number): number {
  return Number.isFinite(value) ? value : 0
}

function normalized(
  value: string | null | undefined,
  fallback: string,
): string {
  const result = value?.trim()
  return result ? result : fallback
}

function numericOpacity(value: string): number | undefined {
  const parsed = Number.parseFloat(value || '1')
  return Number.isFinite(parsed) ? parsed : undefined
}

function directTextCodePoints(element: Element): number {
  const text = Array.from(element.childNodes)
    .filter((node) => node.nodeType === 3)
    .map((node) => node.textContent ?? '')
    .join(' ')
    .replace(/\s+/gu, ' ')
    .trim()
  return Array.from(text).length
}

function elementRole(
  element: Element,
  sourcePath: readonly number[],
  hasDirectText: boolean,
): PresentationElementRole {
  if (sourcePath.length === 0) return 'root'
  const name = (element.localName || element.tagName).toLowerCase()
  if (name === 'img' || name === 'picture' || name === 'canvas') return 'image'
  if (name === 'svg') return 'svg'
  if (name === 'math') return 'math'
  if (name === 'table') return 'table'
  if (name === 'audio' || name === 'video') return 'media'
  if (
    name === 'button' ||
    name === 'input' ||
    name === 'select' ||
    name === 'textarea'
  ) {
    return 'form-control'
  }
  return hasDirectText ? 'text' : 'container'
}

function lumenNodeTraversal(
  element: Element,
): 'observe' | 'transparent' | 'ignore-subtree' {
  if (
    element.hasAttribute('data-lumen-overflow-wrapper') &&
    isPresentationRuntimeNode(element)
  ) {
    // Geometry containment wraps an authored table. The wrapper itself is not
    // source content, but its authored descendants must remain visible to the
    // paint validators that run after all operations have been applied.
    return 'transparent'
  }
  if (
    element.hasAttribute('data-lumen-presentation-layer') &&
    isPresentationRuntimeNode(element)
  ) {
    return 'ignore-subtree'
  }
  return 'observe'
}

function captureStyle(style: CSSStyleDeclaration): PresentationObservedStyle {
  const overflow = normalized(style.overflow, 'visible')
  return {
    display: normalized(style.display, 'inline'),
    float: normalized(style.cssFloat, 'none'),
    visibility: normalized(style.visibility, 'visible'),
    position: normalized(style.position, 'static'),
    opacity: numericOpacity(style.opacity),
    color: style.color,
    backgroundColor: style.backgroundColor,
    backgroundImage: normalized(style.backgroundImage, 'none'),
    mixBlendMode: normalized(style.mixBlendMode, 'normal'),
    backgroundBlendMode: normalized(style.backgroundBlendMode, 'normal'),
    filter: normalized(style.filter, 'none'),
    textShadow: normalized(style.textShadow, 'none'),
    webkitTextFillColor: normalized(
      style.getPropertyValue('-webkit-text-fill-color'),
      'currentcolor',
    ),
    webkitTextStrokeWidth: normalized(
      style.getPropertyValue('-webkit-text-stroke-width'),
      '0px',
    ),
    clipPath: normalized(style.clipPath, 'none'),
    maskImage: normalized(style.maskImage, 'none'),
    webkitMaskImage: normalized(
      style.getPropertyValue('-webkit-mask-image'),
      'none',
    ),
    contentVisibility: normalized(style.contentVisibility, 'visible'),
    transform: normalized(style.transform, 'none'),
    overflowX: normalized(style.overflowX, overflow),
    overflowY: normalized(style.overflowY, overflow),
    overflowInline: normalized(style.overflowInline, 'visible'),
    overflowBlock: normalized(style.overflowBlock, 'visible'),
    writingMode: normalized(style.writingMode, 'horizontal-tb'),
    direction: normalized(style.direction, 'ltr'),
    listStyleType: normalized(style.listStyleType, 'none'),
    listStyleImage: normalized(style.listStyleImage, 'none'),
  }
}

function safeTextPaint(style: PresentationObservedStyle): boolean {
  return (
    style.display !== 'none' &&
    style.visibility === 'visible' &&
    style.contentVisibility !== 'hidden' &&
    style.mixBlendMode === 'normal' &&
    style.filter === 'none' &&
    style.textShadow === 'none' &&
    (style.webkitTextFillColor === 'currentcolor' ||
      style.webkitTextFillColor === style.color) &&
    (Number.parseFloat(style.webkitTextStrokeWidth) || 0) === 0 &&
    style.clipPath === 'none' &&
    style.maskImage === 'none' &&
    style.webkitMaskImage === 'none' &&
    style.opacity !== undefined &&
    style.opacity >= 0.999
  )
}

function unknownPaint(
  reason: PresentationPaintUnknownReason,
  foreground?: SrgbColor,
): PresentationUnknownPaintRelationship {
  return foreground
    ? { kind: 'unknown', confidence: 'low', reason, foreground }
    : { kind: 'unknown', confidence: 'low', reason }
}

function freezeColor(color: SrgbColor): SrgbColor {
  return Object.freeze({ ...color })
}

function freezePaintRelationship(
  relationship: PresentationPaintRelationship,
): PresentationPaintRelationship {
  if (relationship.kind === 'unknown') {
    return Object.freeze({
      ...relationship,
      ...(relationship.foreground
        ? { foreground: freezeColor(relationship.foreground) }
        : {}),
    })
  }
  return Object.freeze({
    ...relationship,
    foreground: freezeColor(relationship.foreground),
    background: freezeColor(relationship.background),
    surface: Object.freeze(relationship.surface),
  })
}

function paintRelationship(
  index: number,
  pending: readonly PendingObservation[],
  canvas: SrgbColor | undefined,
  documentStyle: PresentationObservedStyle | undefined,
  documentElement: Element,
): PresentationPaintRelationship {
  const observation = pending[index]!
  const style = observation.style!
  const foreground = resolveComputedSrgbColor(style.color, observation.element)
  if (!foreground) return unknownPaint('unparseable-foreground')
  if (foreground.a < 0.999) {
    return unknownPaint('translucent-foreground', foreground)
  }
  if (style.textShadow !== 'none')
    return unknownPaint('text-effect', foreground)
  if (
    (style.webkitTextFillColor !== 'currentcolor' &&
      style.webkitTextFillColor !== style.color) ||
    (Number.parseFloat(style.webkitTextStrokeWidth) || 0) !== 0
  ) {
    return unknownPaint('alternate-text-paint', foreground)
  }
  if (
    style.clipPath !== 'none' ||
    style.maskImage !== 'none' ||
    style.webkitMaskImage !== 'none'
  ) {
    return unknownPaint('clipped-paint', foreground)
  }
  if (style.visibility !== 'visible' || style.contentVisibility === 'hidden') {
    return unknownPaint('hidden-content', foreground)
  }

  let currentIndex: number | undefined = index
  let transparentAncestorCount = 0
  while (currentIndex !== undefined) {
    const current: PendingObservation = pending[currentIndex]!
    const currentStyle = current.style!
    if (
      currentStyle.mixBlendMode !== 'normal' ||
      currentStyle.backgroundBlendMode !== 'normal' ||
      currentStyle.filter !== 'none' ||
      currentStyle.opacity === undefined ||
      currentStyle.opacity < 0.999
    ) {
      return unknownPaint('composited-paint', foreground)
    }
    // A mask or clip on any ancestor changes which backdrop pixels actually
    // reach the glyphs. Inspecting only the text element itself falsely
    // classified descendants of masked callouts as ordinary opaque paint.
    if (
      currentStyle.clipPath !== 'none' ||
      currentStyle.maskImage !== 'none' ||
      currentStyle.webkitMaskImage !== 'none'
    ) {
      return unknownPaint('clipped-paint', foreground)
    }
    if (currentStyle.backgroundImage !== 'none') {
      return unknownPaint('background-image', foreground)
    }

    const background = resolveComputedSrgbColor(
      currentStyle.backgroundColor,
      current.element,
    )
    if (background?.a && background.a >= 0.999) {
      return {
        kind: 'known',
        confidence: 'high',
        foreground,
        background,
        contrast: contrastRatio(foreground, background),
        transparentAncestorCount,
        surface: {
          kind: 'element',
          observationIndex: currentIndex,
          address: current.address,
        },
      }
    }
    if (background && background.a > 0.001) {
      return unknownPaint('translucent-background', foreground)
    }
    transparentAncestorCount += 1
    currentIndex = current.parentObservationIndex
  }

  // CSS propagates the root element background to the document canvas. It is
  // not a descendant of <body>, so a body-root source walk must inspect it
  // explicitly before falling through to Lumen's surrounding canvas.
  if (documentStyle) {
    if (
      documentStyle.mixBlendMode !== 'normal' ||
      documentStyle.backgroundBlendMode !== 'normal' ||
      documentStyle.filter !== 'none' ||
      documentStyle.opacity === undefined ||
      documentStyle.opacity < 0.999
    ) {
      return unknownPaint('composited-paint', foreground)
    }
    if (documentStyle.backgroundImage !== 'none') {
      return unknownPaint('background-image', foreground)
    }
    const rootBackground = resolveComputedSrgbColor(
      documentStyle.backgroundColor,
      documentElement,
    )
    if (rootBackground?.a && rootBackground.a >= 0.999) {
      return {
        kind: 'known',
        confidence: 'high',
        foreground,
        background: rootBackground,
        contrast: contrastRatio(foreground, rootBackground),
        transparentAncestorCount,
        surface: { kind: 'document' },
      }
    }
    if (rootBackground && rootBackground.a > 0.001) {
      return unknownPaint('translucent-background', foreground)
    }
  }

  if (!canvas || canvas.a < 0.999) {
    return unknownPaint(
      canvas ? 'no-known-surface' : 'invalid-canvas',
      foreground,
    )
  }
  return {
    kind: 'known',
    confidence: 'high',
    foreground,
    background: canvas,
    contrast: contrastRatio(foreground, canvas),
    transparentAncestorCount,
    surface: { kind: 'canvas' },
  }
}

function captureGeometry(element: Element): PresentationObservedGeometry {
  const rect = element.getBoundingClientRect()
  return {
    x: finiteMetric(rect.x),
    y: finiteMetric(rect.y),
    width: finiteMetric(rect.width),
    height: finiteMetric(rect.height),
    clientWidth: finiteMetric(element.clientWidth),
    clientHeight: finiteMetric(element.clientHeight),
    scrollWidth: finiteMetric(element.scrollWidth),
    scrollHeight: finiteMetric(element.scrollHeight),
    clientRectCount: element.getClientRects().length,
  }
}

function captureResource(
  element: Element,
  role: PresentationElementRole,
): PresentationObservedResource | undefined {
  if (role === 'image' && (element.localName || '').toLowerCase() === 'img') {
    const image = element as HTMLImageElement
    return {
      kind: 'image',
      ready: Boolean(image.complete && image.naturalWidth > 0),
      intrinsicWidth: finiteMetric(image.naturalWidth),
      intrinsicHeight: finiteMetric(image.naturalHeight),
    }
  }
  if (role === 'media') {
    const media = element as HTMLMediaElement
    return { kind: 'media', ready: media.readyState >= 2 }
  }
  return undefined
}

/**
 * Pseudo text is not source-addressable in v1. Enumerate bounded selectors so
 * the terminal ledger declares that debt instead of calling the page readable.
 * Actual pseudo paint repair remains a browser-fixture-gated later operation.
 */
const PSEUDO_SELECTOR_PATTERN = /::(?:before|after|first-line|first-letter)\b/iu
const PSEUDO_PAINT_PROPERTIES = [
  'color',
  'background',
  'background-color',
  'background-image',
  'opacity',
  'text-shadow',
  '-webkit-text-fill-color',
  '-webkit-text-stroke',
  '-webkit-text-stroke-color',
  '-webkit-text-stroke-width',
  'filter',
  'mix-blend-mode',
  'visibility',
] as const

function hasGeneratedContent(style: CSSStyleDeclaration): boolean {
  const content = style.getPropertyValue('content').trim().toLowerCase()
  if (!content || content === 'none' || content === 'normal') return false
  return content !== '""' && content !== "''"
}

function hasPseudoPaint(style: CSSStyleDeclaration): boolean {
  return PSEUDO_PAINT_PROPERTIES.some(
    (property) => style.getPropertyValue(property).trim().length > 0,
  )
}

function pseudoRuleNeedsAudit(
  pseudo: string,
  style: CSSStyleDeclaration,
): boolean {
  if (pseudo === 'before' || pseudo === 'after') {
    return hasGeneratedContent(style)
  }
  return hasPseudoPaint(style)
}

function countPseudoTextSamples(
  document: Document,
  signal?: AbortSignal,
  maximum = 128,
): { samples: number; truncated: boolean } {
  const matches = new Map<Element, Set<string>>()
  const view = document.defaultView
  let count = 0
  let truncated = false
  const visitRules = (rules: CSSRuleList): void => {
    for (const rule of Array.from(rules)) {
      throwIfAborted(signal)
      const nested = (rule as CSSGroupingRule).cssRules
      const media = (rule as CSSMediaRule).media
      if (
        nested &&
        media &&
        typeof media.mediaText === 'string' &&
        typeof view?.matchMedia === 'function' &&
        !view.matchMedia(media.mediaText).matches
      ) {
        continue
      }
      if (nested) visitRules(nested)
      const selectorText = (rule as CSSStyleRule).selectorText
      const style = (rule as CSSStyleRule).style
      if (
        !selectorText ||
        !style ||
        !PSEUDO_SELECTOR_PATTERN.test(selectorText)
      ) {
        continue
      }
      for (const selector of selectorText.split(',')) {
        const pseudo = /::(before|after|first-line|first-letter)\b/iu.exec(
          selector,
        )?.[1]
        if (!pseudo || !pseudoRuleNeedsAudit(pseudo, style)) continue
        const baseSelector =
          selector.replace(PSEUDO_SELECTOR_PATTERN, '').trim() || '*'
        let elements: Element[]
        try {
          elements = Array.from(document.querySelectorAll(baseSelector))
        } catch {
          continue
        }
        for (const element of elements) {
          if (
            (pseudo === 'first-line' || pseudo === 'first-letter') &&
            !element.textContent?.trim()
          ) {
            continue
          }
          const kinds = matches.get(element) ?? new Set<string>()
          if (kinds.has(pseudo)) continue
          kinds.add(pseudo)
          matches.set(element, kinds)
          count += 1
          if (count >= maximum) {
            truncated = true
            return
          }
        }
      }
    }
  }

  for (const sheet of Array.from(document.styleSheets)) {
    if (truncated) break
    if (sheet.ownerNode && isPresentationRuntimeNode(sheet.ownerNode)) continue
    try {
      visitRules(sheet.cssRules)
    } catch {
      // Inaccessible author sheets cannot be inspected; the ordinary paint
      // ledger remains conservative for their computed element styles.
    }
  }
  return {
    samples: count,
    truncated,
  }
}

function listMarkerPaint(
  element: Element,
  style: PresentationObservedStyle,
  basePaint: PresentationPaintRelationship,
): PresentationPaintRelationship {
  const foreground = resolveComputedSrgbColor(style.color, element)
  if (!foreground) return unknownPaint('unparseable-foreground')
  if (foreground.a < 0.999) {
    return unknownPaint('translucent-foreground', foreground)
  }
  if (!safeTextPaint(style)) return unknownPaint('text-effect', foreground)
  if (basePaint.kind !== 'known') {
    return unknownPaint(basePaint.reason, foreground)
  }
  return {
    kind: 'known',
    confidence: 'high',
    foreground,
    background: basePaint.background,
    contrast: contrastRatio(foreground, basePaint.background),
    transparentAncestorCount: basePaint.transparentAncestorCount,
    surface: basePaint.surface,
  }
}

function captureListMarkers(
  document: Document,
  observations: readonly PresentationHealthObservation[],
  signal?: AbortSignal,
): PresentationListMarkerObservation[] {
  const view = document.defaultView
  if (!view) return []
  const jsdom = /\bjsdom\b/iu.test(view.navigator.userAgent)
  const markers: PresentationListMarkerObservation[] = []
  for (let index = 0; index < observations.length; index += 1) {
    throwIfAborted(signal)
    const observation = observations[index]!
    const listStyleType = observation.style.listStyleType.trim().toLowerCase()
    const listStyleImage = observation.style.listStyleImage.trim().toLowerCase()
    if (
      observation.localName !== 'li' ||
      observation.style.display !== 'list-item' ||
      listStyleType === 'none' ||
      (listStyleImage !== '' && listStyleImage !== 'none') ||
      observation.style.visibility !== 'visible' ||
      observation.style.contentVisibility === 'hidden' ||
      observation.geometry.clientRectCount === 0 ||
      (observation.geometry.width <= 0 && observation.geometry.height <= 0)
    ) {
      continue
    }
    let computed: CSSStyleDeclaration
    try {
      // jsdom does not implement pseudo-element computed styles; its default
      // marker still follows the list item's currentColor, which is sufficient
      // for deterministic unit evidence. Real admission is browser-gated.
      computed = jsdom
        ? view.getComputedStyle(observation.element)
        : view.getComputedStyle(observation.element, '::marker')
    } catch {
      continue
    }
    const content = computed.getPropertyValue('content').trim().toLowerCase()
    if (content === 'none' || content === '""' || content === "''") continue
    const style = Object.freeze(captureStyle(computed))
    const marker: PresentationListMarkerObservation = {
      element: observation.element,
      address: observation.address,
      style,
      paint: freezePaintRelationship(
        listMarkerPaint(observation.element, style, observation.paint),
      ),
      geometry: observation.geometry,
    }
    if (observation.parentObservationIndex !== undefined) {
      marker.parentObservationIndex = observation.parentObservationIndex
    }
    markers.push(Object.freeze(marker))
  }
  return markers
}

/**
 * Observe one final rendered document with a fixed work budget.
 *
 * DOM traversal, computed-style reads, and geometry reads happen in separate
 * passes. This avoids interleaving style and layout work while retaining the
 * exact iframe realm that produced the rendering.
 */
export function createPresentationHealthMap(
  options: CreatePresentationHealthMapOptions,
): PresentationHealthMap {
  const { renderedDocument, spineIndex, signal } = options
  if (!Number.isInteger(spineIndex) || spineIndex < 0) {
    throw new RangeError(
      'Presentation health requires a non-negative spineIndex',
    )
  }
  const view = renderedDocument.defaultView
  const suppliedCanvas =
    typeof options.canvasColor === 'string'
      ? parseSrgbColor(options.canvasColor)
      : options.canvasColor
  const canvas =
    suppliedCanvas && suppliedCanvas.a >= 0.999
      ? freezeColor(suppliedCanvas)
      : undefined
  const diagnostics: string[] = []
  if (!view) diagnostics.push('missing-render-view')
  if (!canvas) diagnostics.push('invalid-canvas')

  const requestedMaximum = options.maxInspectedElements ?? 512
  const maximum = Number.isFinite(requestedMaximum)
    ? Math.min(
        MAX_PRESENTATION_HEALTH_ELEMENTS,
        Math.max(0, Math.floor(requestedMaximum)),
      )
    : 512
  const pending: PendingObservation[] = []
  const indexes = new WeakMap<Element, number>()
  const focused = options.focusElements
    ? (() => {
        const elements = new WeakSet<Element>()
        const root = getSourceTreeRoot(renderedDocument)
        for (const target of options.focusElements) {
          if (target.ownerDocument !== renderedDocument) continue
          let current: Element | null = target
          while (current) {
            elements.add(current)
            if (current === root) break
            current = current.parentElement
          }
        }
        return elements
      })()
    : undefined
  // A zero budget is an empty prefix, not a complete inspection. Consumers
  // use this bit as a safety gate for document-wide repairs.
  let truncated = Boolean(view && maximum === 0)

  if (view && maximum > 0) {
    walkSourceTree(renderedDocument, ({ node, nodeKind, sourcePath }) => {
      throwIfAborted(signal)
      if (nodeKind !== 'element') return 'continue'
      const element = node as Element
      const lumenTraversal = lumenNodeTraversal(element)
      if (lumenTraversal === 'ignore-subtree') return 'skip-children'
      if (lumenTraversal === 'transparent') return 'continue'
      if (focused && !focused.has(element)) return 'continue'
      if (pending.length >= maximum) {
        truncated = true
        return 'stop'
      }
      let observedParent = element.parentElement
      let parentIndex: number | undefined
      while (observedParent && parentIndex === undefined) {
        parentIndex = indexes.get(observedParent)
        observedParent = observedParent.parentElement
      }
      const textCodePoints = directTextCodePoints(element)
      const hasDirectText = textCodePoints > 0
      const projectedAddress = createSourceTreeAddress(
        renderedDocument,
        element,
        spineIndex,
        {
          isTransparentContainer: (candidate) =>
            candidate.hasAttribute('data-lumen-overflow-wrapper') &&
            isPresentationRuntimeNode(candidate),
        },
      )
      const frozenSourcePath = [...projectedAddress.sourcePath]
      Object.freeze(frozenSourcePath)
      const address: SourceTreeAddress = Object.freeze({
        sourceModelVersion: SOURCE_TREE_MODEL_VERSION,
        spineIndex,
        nodeKind: projectedAddress.nodeKind,
        sourcePath: frozenSourcePath,
      })
      const observation: PendingObservation = {
        element,
        address,
        localName: (element.localName || element.tagName).toLowerCase(),
        role: elementRole(element, sourcePath, hasDirectText),
        directMeaningfulText: hasDirectText,
        directTextCodePoints: textCodePoints,
      }
      if (parentIndex !== undefined) {
        observation.parentObservationIndex = parentIndex
      }
      indexes.set(element, pending.length)
      pending.push(observation)
      if (
        observation.role === 'svg' ||
        observation.role === 'math' ||
        observation.localName === 'canvas'
      ) {
        return 'skip-children'
      }
      return 'continue'
    })
  }

  // Style pass: no geometry reads are allowed in this loop.
  for (const observation of pending) {
    throwIfAborted(signal)
    observation.style = captureStyle(
      view!.getComputedStyle(observation.element),
    )
  }
  const documentElementTracked = indexes.has(renderedDocument.documentElement)
  const documentStyle =
    view && !documentElementTracked
      ? captureStyle(view.getComputedStyle(renderedDocument.documentElement))
      : undefined

  const observations: PresentationHealthObservation[] = []
  // Geometry pass: style facts and paint relationships are already captured.
  for (let index = 0; index < pending.length; index += 1) {
    throwIfAborted(signal)
    const observation = pending[index]!
    const resource = captureResource(observation.element, observation.role)
    const geometry = captureGeometry(observation.element)
    const hasRenderedBox =
      geometry.clientRectCount > 0 &&
      (geometry.width > 0 || geometry.height > 0)
    const paint =
      hasRenderedBox || !observation.directMeaningfulText
        ? paintRelationship(
            index,
            pending,
            canvas,
            documentStyle,
            renderedDocument.documentElement,
          )
        : unknownPaint('no-rendered-box')
    const complete: PresentationHealthObservation = {
      element: observation.element,
      address: observation.address,
      localName: observation.localName,
      role: observation.role,
      directMeaningfulText: observation.directMeaningfulText,
      directTextCodePoints: observation.directTextCodePoints,
      textPaintEligible:
        observation.directMeaningfulText &&
        hasRenderedBox &&
        safeTextPaint(observation.style!),
      style: Object.freeze(observation.style!),
      paint: freezePaintRelationship(paint),
      geometry: Object.freeze(geometry),
    }
    if (observation.parentObservationIndex !== undefined) {
      complete.parentObservationIndex = observation.parentObservationIndex
    }
    if (resource) complete.resource = Object.freeze(resource)
    observations.push(Object.freeze(complete))
  }
  const pseudoText = view
    ? countPseudoTextSamples(renderedDocument, signal)
    : { samples: 0, truncated: false }
  const listMarkers = view
    ? captureListMarkers(renderedDocument, observations, signal)
    : []

  return Object.freeze({
    modelVersion: PRESENTATION_HEALTH_MODEL_VERSION,
    renderedDocument,
    spineIndex,
    ...(canvas ? { canvas } : {}),
    observations: Object.freeze(observations),
    listMarkers: Object.freeze(listMarkers),
    inspectedElements: observations.length,
    truncated,
    pseudoTextSamples: pseudoText.samples,
    pseudoTextTruncated: pseudoText.truncated,
    diagnostics: Object.freeze(diagnostics),
  })
}

/**
 * Classify every visible direct-text observation as readable, known-low-
 * contrast, or unproven. This is evidence about one concrete rendered state;
 * callers must not reuse a Published summary for an Adapted DOM.
 */
export function summarizePresentationLegibility(
  options: SummarizePresentationLegibilityOptions,
): PresentationLegibilitySummary {
  const minimumTextContrast =
    typeof options.minimumTextContrast === 'number' &&
    Number.isFinite(options.minimumTextContrast)
      ? Math.min(21, Math.max(1, options.minimumTextContrast))
      : 4.5
  let visibleTextSamples = 0
  let visibleTextCodePoints = 0
  let nonVisibleTextSamples = 0
  let nonVisibleTextCodePoints = 0
  let provenReadableSamples = 0
  let provenReadableCodePoints = 0
  let knownLowContrastSamples = 0
  let knownLowContrastCodePoints = 0
  let unknownPaintSamples = 0
  let unknownPaintCodePoints = 0
  const unknownPaintByReason: Partial<
    Record<PresentationPaintUnknownReason, number>
  > = {}

  for (
    let observationIndex = 0;
    observationIndex < options.healthMap.observations.length;
    observationIndex += 1
  ) {
    const observation = options.healthMap.observations[observationIndex]!
    const visiblyRendered =
      observation.directMeaningfulText &&
      observation.style.display !== 'none' &&
      observation.style.visibility === 'visible' &&
      observation.style.contentVisibility !== 'hidden' &&
      (observation.style.opacity ?? 1) > 0.001 &&
      observation.geometry.clientRectCount > 0 &&
      (observation.geometry.width > 0 || observation.geometry.height > 0)
    if (!visiblyRendered) continue

    if (
      isFullyClippedByObservedAncestor(
        observationIndex,
        options.healthMap.observations,
      )
    ) {
      nonVisibleTextSamples += 1
      nonVisibleTextCodePoints += observation.directTextCodePoints
      continue
    }

    visibleTextSamples += 1
    visibleTextCodePoints += observation.directTextCodePoints
    if (observation.paint.kind === 'known') {
      if (observation.paint.contrast >= minimumTextContrast) {
        provenReadableSamples += 1
        provenReadableCodePoints += observation.directTextCodePoints
      } else {
        knownLowContrastSamples += 1
        knownLowContrastCodePoints += observation.directTextCodePoints
      }
      continue
    }

    unknownPaintSamples += 1
    unknownPaintCodePoints += observation.directTextCodePoints
    unknownPaintByReason[observation.paint.reason] =
      (unknownPaintByReason[observation.paint.reason] ?? 0) + 1
  }

  for (const marker of options.healthMap.listMarkers) {
    visibleTextSamples += 1
    visibleTextCodePoints += 1
    if (marker.paint.kind === 'known') {
      if (marker.paint.contrast >= minimumTextContrast) {
        provenReadableSamples += 1
        provenReadableCodePoints += 1
      } else {
        knownLowContrastSamples += 1
        knownLowContrastCodePoints += 1
      }
    } else {
      unknownPaintSamples += 1
      unknownPaintCodePoints += 1
      unknownPaintByReason[marker.paint.reason] =
        (unknownPaintByReason[marker.paint.reason] ?? 0) + 1
    }
  }

  if (options.healthMap.pseudoTextSamples > 0) {
    visibleTextSamples += options.healthMap.pseudoTextSamples
    unknownPaintSamples += options.healthMap.pseudoTextSamples
    unknownPaintByReason['pseudo-element'] =
      (unknownPaintByReason['pseudo-element'] ?? 0) +
      options.healthMap.pseudoTextSamples
  }

  const complete =
    !options.healthMap.truncated &&
    !options.healthMap.pseudoTextTruncated &&
    knownLowContrastSamples === 0 &&
    unknownPaintSamples === 0
  return Object.freeze({
    modelVersion: PRESENTATION_LEGIBILITY_MODEL_VERSION,
    complete,
    truncated: options.healthMap.truncated,
    visibleTextSamples,
    visibleTextCodePoints,
    nonVisibleTextSamples,
    nonVisibleTextCodePoints,
    provenReadableSamples,
    provenReadableCodePoints,
    knownLowContrastSamples,
    knownLowContrastCodePoints,
    unknownPaintSamples,
    unknownPaintCodePoints,
    unknownPaintByReason: Object.freeze({ ...unknownPaintByReason }),
  })
}

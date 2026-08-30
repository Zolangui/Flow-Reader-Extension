/**
 * Stable publication positions for Lumen Read.
 *
 * EPUB CFI offsets are UTF-16 offsets because they map to DOM Range offsets.
 * Reading progress deliberately uses Unicode code points instead. Keeping the
 * two coordinate systems explicit prevents surrogate pairs from corrupting a
 * saved reading position or a progress calculation.
 */

import {
  formatSourceTreePath,
  getSourceNodeKind,
  getSourceTreeRoot,
  walkSourceTree,
} from './source-tree'

export const CANONICAL_MODEL_VERSION = 3 as const
export const LOCATION_INDEX_ALGORITHM_ID = 'lumen-location-index'
export const LOCATION_INDEX_ALGORITHM_VERSION = 1 as const
export const PROGRESS_METRIC_ALGORITHM_ID = 'lumen-progress-metric'
export const PROGRESS_METRIC_ALGORITHM_VERSION = 1 as const
export const DEFAULT_LOCATION_MARKER_CODE_POINT_INTERVAL = 1000
export const DEFAULT_ATOMIC_PROGRESS_UNITS = 1000

type CanonicalSegmentBase = {
  id: string
}

export type AtomicSegmentKind =
  | 'fixed-page'
  | 'image'
  | 'svg'
  | 'math'
  | 'canvas'
  | 'media'
  | 'embedded-content'

export type CanonicalTextSegment = CanonicalSegmentBase & {
  kind: 'text'
  codePointLength: number
  utf16Length: number
}

export type CanonicalAtomicSegment = CanonicalSegmentBase & {
  kind: 'atomic'
  atomicKind: AtomicSegmentKind
}

export type CanonicalMediaSegment = CanonicalSegmentBase & {
  kind: 'media'
  mediaKind: 'audio' | 'video'
}

export type CanonicalSegment =
  | CanonicalTextSegment
  | CanonicalAtomicSegment
  | CanonicalMediaSegment

export type CanonicalContentModel = {
  canonicalModelVersion: typeof CANONICAL_MODEL_VERSION
  spineIndex: number
  spineItemId?: string
  resourceHref: string
  segments: CanonicalSegment[]
  totalCodePoints: number
}

type ParsedTextSegment = CanonicalTextSegment & { node: Text }
type ParsedAtomicSegment = CanonicalAtomicSegment & { node: Element }
type ParsedMediaSegment = CanonicalMediaSegment & { node: Element }

export type ParsedCanonicalSegment =
  | ParsedTextSegment
  | ParsedAtomicSegment
  | ParsedMediaSegment

export type ParsedCanonicalContent = {
  model: CanonicalContentModel
  segments: ParsedCanonicalSegment[]
}

export type CanonicalContentOptions = {
  spineIndex: number
  spineItemId?: string
  resourceHref: string
  /** A pre-paginated resource is one logical atomic page in metric v1. */
  fixedLayout?: boolean
  /** Allows a host reader to skip its own presentation-only nodes. */
  isReaderOwnedElement?: (element: Element) => boolean
}

export type CanonicalPositionBase = {
  canonicalModelVersion: typeof CANONICAL_MODEL_VERSION
  spineIndex: number
  spineItemId?: string
  resourceHref: string
  segmentId: string
  cfi: string
}

export type TextPosition = CanonicalPositionBase & {
  kind: 'text'
  /** Unicode code-point offset inside the original source text node. */
  codePointOffset: number
  /** The matching DOM Range / EPUB CFI UTF-16 code-unit offset. */
  domUtf16Offset: number
  /** False only when an imported CFI lands inside a surrogate pair. */
  isCodePointBoundary: boolean
}

export type AtomicPosition = CanonicalPositionBase & {
  kind: 'atomic'
  atomIndex: number
  edge: 'before' | 'after'
}

export type MediaPosition = CanonicalPositionBase & {
  kind: 'media'
  mediaOffsetSeconds: number
  /**
   * Metric v1 treats media as an atomic boundary. A future duration-aware
   * metric can still use `mediaOffsetSeconds` without changing the position
   * identity, while `edge` keeps the current ledger internally consistent.
   */
  edge: 'before' | 'after'
}

export type CanonicalPosition = TextPosition | AtomicPosition | MediaPosition

export type LocationMarker = {
  index: number
  /** Global text-only code-point offset. Atomic markers can share an offset. */
  canonicalCodePointOffset: number
  canonicalPosition: CanonicalPosition
  cfi: string
  terminal?: boolean
}

export type CanonicalSectionForIndex = {
  content: ParsedCanonicalContent
  cfiForText: (node: Text, utf16Offset: number) => string
  cfiForElement: (node: Element, edge: 'before' | 'after') => string
}

export type LocationIndexOptions = {
  markerCodePointInterval?: number
}

export type CanonicalSectionIndex = {
  spineIndex: number
  spineItemId?: string
  resourceHref: string
  firstMarkerIndex?: number
  totalCodePoints: number
  segmentCount: number
}

export type CanonicalLocationIndex = {
  canonicalModelVersion: typeof CANONICAL_MODEL_VERSION
  algorithmId: typeof LOCATION_INDEX_ALGORITHM_ID
  algorithmVersion: typeof LOCATION_INDEX_ALGORITHM_VERSION
  markerCodePointInterval: number
  markers: LocationMarker[]
  sections: CanonicalSectionIndex[]
  totalCodePoints: number
}

export type ProgressMetricConfiguration = {
  algorithmId?: string
  algorithmVersion?: number
  atomicUnitWeight?: number
  fixedPageUnitWeight?: number
  mediaUnitWeight?: number
}

export type ProgressMetricSnapshot = {
  algorithmId: string
  algorithmVersion: number
  completedUnits: number
  totalUnits: number
}

type ProgressMetricSegment = {
  spineIndex: number
  spineItemId?: string
  resourceHref: string
  segment: CanonicalSegment
  atomIndex?: number
  startUnits: number
  totalUnits: number
}

export type ResolvedProgressMetricConfiguration =
  Required<ProgressMetricConfiguration>

export type ProgressMetric = {
  algorithmId: string
  algorithmVersion: number
  totalUnits: number
  unitsAt(position: CanonicalPosition): number
  snapshotAt(position: CanonicalPosition): ProgressMetricSnapshot
}

const EXCLUDED_TAGS = new Set(['script', 'style', 'template', 'noscript'])
const ATOMIC_TAGS: Readonly<Record<string, AtomicSegmentKind>> = {
  img: 'image',
  image: 'image',
  svg: 'svg',
  math: 'math',
  canvas: 'canvas',
  object: 'embedded-content',
  embed: 'embedded-content',
  iframe: 'embedded-content',
}
const MEDIA_TAGS: Readonly<Record<string, 'audio' | 'video'>> = {
  audio: 'audio',
  video: 'video',
}

function isElement(node: Node): node is Element {
  return getSourceNodeKind(node) === 'element'
}

function isText(node: Node): node is Text {
  return getSourceNodeKind(node) === 'text'
}

function tagName(element: Element): string {
  return (element.localName || element.tagName).toLowerCase()
}

function isExcludedElement(
  element: Element,
  isReaderOwnedElement: ((element: Element) => boolean) | undefined,
): boolean {
  if (EXCLUDED_TAGS.has(tagName(element))) return true
  if (element.hasAttribute('hidden')) return true
  if (element.hasAttribute('inert')) return true
  return isReaderOwnedElement?.(element) ?? false
}

function textSegmentId(path: readonly number[]): string {
  return `text:${formatSourceTreePath(path)}`
}

function atomicSegmentId(path: readonly number[]): string {
  return `atomic:${formatSourceTreePath(path)}`
}

function mediaSegmentId(path: readonly number[]): string {
  return `media:${formatSourceTreePath(path)}`
}

/** Counts Unicode code points rather than JavaScript UTF-16 code units. */
export function codePointLength(value: string): number {
  return Array.from(value).length
}

/**
 * Converts a code-point boundary to a DOM Range / CFI UTF-16 offset.
 * Throws rather than silently clamping an invalid canonical position.
 */
export function codePointOffsetToUtf16(
  value: string,
  codePointOffset: number,
): number {
  const total = codePointLength(value)
  if (
    !Number.isInteger(codePointOffset) ||
    codePointOffset < 0 ||
    codePointOffset > total
  ) {
    throw new RangeError(
      `Code-point offset ${codePointOffset} is outside 0..${total}`,
    )
  }

  let currentCodePoint = 0
  let utf16Offset = 0
  for (const character of value) {
    if (currentCodePoint === codePointOffset) return utf16Offset
    utf16Offset += character.length
    currentCodePoint += 1
  }
  return utf16Offset
}

export type Utf16OffsetResolution = {
  codePointOffset: number
  isCodePointBoundary: boolean
}

/**
 * Resolves a CFI/Range UTF-16 offset to the nearest preceding code-point
 * boundary. A CFI may legally land between surrogate units; the boolean keeps
 * that exactness visible to callers instead of inventing a code-point value.
 */
export function utf16OffsetToCodePoint(
  value: string,
  utf16Offset: number,
): Utf16OffsetResolution {
  if (
    !Number.isInteger(utf16Offset) ||
    utf16Offset < 0 ||
    utf16Offset > value.length
  ) {
    throw new RangeError(
      `UTF-16 offset ${utf16Offset} is outside 0..${value.length}`,
    )
  }

  let currentCodePoint = 0
  let currentUtf16 = 0
  for (const character of value) {
    if (currentUtf16 === utf16Offset) {
      return { codePointOffset: currentCodePoint, isCodePointBoundary: true }
    }
    const nextUtf16 = currentUtf16 + character.length
    if (utf16Offset > currentUtf16 && utf16Offset < nextUtf16) {
      return { codePointOffset: currentCodePoint, isCodePointBoundary: false }
    }
    currentUtf16 = nextUtf16
    currentCodePoint += 1
  }

  return { codePointOffset: currentCodePoint, isCodePointBoundary: true }
}

/**
 * Reads a source document without relying on the global `document`, so it is
 * safe for iframe documents and for server-side test DOMs.
 */
export function parseCanonicalContent(
  source: Document | Element,
  options: CanonicalContentOptions,
): ParsedCanonicalContent {
  if (!Number.isInteger(options.spineIndex) || options.spineIndex < 0) {
    throw new RangeError('Canonical content requires a non-negative spineIndex')
  }

  const segments: ParsedCanonicalSegment[] = []
  let totalCodePoints = 0

  if (options.fixedLayout) {
    const root = getSourceTreeRoot(source)
    segments.push({
      id: atomicSegmentId([]),
      kind: 'atomic',
      atomicKind: 'fixed-page',
      node: root,
    })
  } else {
    walkSourceTree(source, ({ node, sourcePath: path }) => {
      if (isText(node)) {
        const text = node.data
        // Source whitespace is part of the publication. Keeping every
        // non-empty text node makes positions deterministic without relying
        // on computed CSS, and preserves separators between inline elements.
        if (text.length === 0) return 'continue'
        const codePoints = codePointLength(text)
        segments.push({
          id: textSegmentId(path),
          kind: 'text',
          codePointLength: codePoints,
          utf16Length: text.length,
          node,
        })
        totalCodePoints += codePoints
        return 'continue'
      }

      if (
        !isElement(node) ||
        isExcludedElement(node, options.isReaderOwnedElement)
      )
        return 'skip-children'

      const name = tagName(node)
      const mediaKind = MEDIA_TAGS[name]
      if (mediaKind) {
        segments.push({
          id: mediaSegmentId(path),
          kind: 'media',
          mediaKind,
          node,
        })
        return 'skip-children'
      }

      const atomicKind = ATOMIC_TAGS[name]
      if (atomicKind) {
        segments.push({
          id: atomicSegmentId(path),
          kind: 'atomic',
          atomicKind,
          node,
        })
        return 'skip-children'
      }

      return 'continue'
    })
  }

  const serializableSegments = segments.map(
    ({ node: _node, ...segment }) => segment,
  )
  return {
    model: {
      canonicalModelVersion: CANONICAL_MODEL_VERSION,
      spineIndex: options.spineIndex,
      spineItemId: options.spineItemId,
      resourceHref: options.resourceHref,
      segments: serializableSegments,
      totalCodePoints,
    },
    segments,
  }
}

function positionBase(
  content: ParsedCanonicalContent,
  segment: ParsedCanonicalSegment,
  cfi: string,
): CanonicalPositionBase {
  return {
    canonicalModelVersion: CANONICAL_MODEL_VERSION,
    spineIndex: content.model.spineIndex,
    spineItemId: content.model.spineItemId,
    resourceHref: content.model.resourceHref,
    segmentId: segment.id,
    cfi,
  }
}

export function createTextPosition(
  content: ParsedCanonicalContent,
  segment: ParsedTextSegment,
  codePointOffset: number,
  cfiForText: (node: Text, utf16Offset: number) => string,
): TextPosition {
  const domUtf16Offset = codePointOffsetToUtf16(
    segment.node.data,
    codePointOffset,
  )
  return createTextPositionFromUtf16(
    content,
    segment,
    domUtf16Offset,
    cfiForText,
  )
}

/**
 * Materializes a canonical text position from a DOM Range / CFI UTF-16
 * offset. The CFI remains exact even if it lands between surrogate units;
 * progress uses the preceding code-point boundary and records that fact.
 */
export function createTextPositionFromUtf16(
  content: ParsedCanonicalContent,
  segment: ParsedTextSegment,
  domUtf16Offset: number,
  cfiForText: (node: Text, utf16Offset: number) => string,
): TextPosition {
  const resolution = utf16OffsetToCodePoint(segment.node.data, domUtf16Offset)
  return {
    ...positionBase(content, segment, cfiForText(segment.node, domUtf16Offset)),
    kind: 'text',
    codePointOffset: resolution.codePointOffset,
    domUtf16Offset,
    isCodePointBoundary: resolution.isCodePointBoundary,
  }
}

export function createAtomicPosition(
  content: ParsedCanonicalContent,
  segment: ParsedAtomicSegment,
  atomIndex: number,
  edge: 'before' | 'after',
  cfiForElement: (node: Element, edge: 'before' | 'after') => string,
): AtomicPosition {
  if (!Number.isInteger(atomIndex) || atomIndex < 0) {
    throw new RangeError('Atomic positions require a non-negative atomIndex')
  }
  return {
    ...positionBase(content, segment, cfiForElement(segment.node, edge)),
    kind: 'atomic',
    atomIndex,
    edge,
  }
}

export function createMediaPosition(
  content: ParsedCanonicalContent,
  segment: ParsedMediaSegment,
  mediaOffsetSeconds: number,
  edge: 'before' | 'after',
  cfiForElement: (node: Element, edge: 'before' | 'after') => string,
): MediaPosition {
  if (!Number.isFinite(mediaOffsetSeconds) || mediaOffsetSeconds < 0) {
    throw new RangeError(
      'Media positions require a non-negative offset in seconds',
    )
  }
  return {
    ...positionBase(content, segment, cfiForElement(segment.node, edge)),
    kind: 'media',
    mediaOffsetSeconds,
    edge,
  }
}

function markerKey(position: CanonicalPosition): string {
  switch (position.kind) {
    case 'text':
      return `${position.spineIndex}:${position.segmentId}:${position.codePointOffset}`
    case 'atomic':
      return `${position.spineIndex}:${position.segmentId}:${position.atomIndex}:${position.edge}`
    case 'media':
      return `${position.spineIndex}:${position.segmentId}:${position.mediaOffsetSeconds}:${position.edge}`
  }
}

/**
 * Incremental CFI-backed marker builder. It intentionally retains only the
 * serializable marker/model information after `append`, so a host can unload
 * each source document before moving to the next spine occurrence.
 */
export class CanonicalLocationIndexBuilder {
  private readonly markerCodePointInterval: number
  private readonly markers: LocationMarker[] = []
  private readonly sectionIndexes: CanonicalSectionIndex[] = []
  private totalCodePoints = 0
  private nextMarkerCodePointOffset = 0
  private lastPosition: CanonicalPosition | undefined
  private lastSpineIndex = -1
  private completed = false

  constructor(options: LocationIndexOptions = {}) {
    this.markerCodePointInterval =
      options.markerCodePointInterval ??
      DEFAULT_LOCATION_MARKER_CODE_POINT_INTERVAL
    if (
      !Number.isInteger(this.markerCodePointInterval) ||
      this.markerCodePointInterval <= 0
    ) {
      throw new RangeError('markerCodePointInterval must be a positive integer')
    }
  }

  private addMarker(
    position: CanonicalPosition,
    canonicalCodePointOffset: number,
    terminal = false,
  ): void {
    const previous = this.markers[this.markers.length - 1]
    if (
      previous &&
      markerKey(previous.canonicalPosition) === markerKey(position)
    ) {
      if (terminal) previous.terminal = true
      return
    }
    this.markers.push({
      index: this.markers.length,
      canonicalCodePointOffset,
      canonicalPosition: position,
      cfi: position.cfi,
      terminal: terminal || undefined,
    })
  }

  append(section: CanonicalSectionForIndex): void {
    if (this.completed) {
      throw new Error(
        'Cannot append to a completed CanonicalLocationIndexBuilder',
      )
    }

    const { content, cfiForText, cfiForElement } = section
    const spineIndex = content.model.spineIndex
    if (spineIndex <= this.lastSpineIndex) {
      throw new RangeError(
        'Canonical index sections must be ordered by distinct spineIndex values',
      )
    }
    this.lastSpineIndex = spineIndex

    const firstMarkerIndex = this.markers.length
    let sectionAtomIndex = 0
    for (const segment of content.segments) {
      if (segment.kind === 'text') {
        const start = this.totalCodePoints
        const end = start + segment.codePointLength
        while (this.nextMarkerCodePointOffset <= end) {
          const codePointOffset = this.nextMarkerCodePointOffset - start
          const position = createTextPosition(
            content,
            segment,
            codePointOffset,
            cfiForText,
          )
          this.addMarker(position, this.nextMarkerCodePointOffset)
          this.lastPosition = position
          this.nextMarkerCodePointOffset += this.markerCodePointInterval
        }
        this.totalCodePoints = end
        this.lastPosition = createTextPosition(
          content,
          segment,
          segment.codePointLength,
          cfiForText,
        )
        continue
      }

      if (segment.kind === 'atomic') {
        const position = createAtomicPosition(
          content,
          segment,
          sectionAtomIndex,
          'before',
          cfiForElement,
        )
        this.addMarker(position, this.totalCodePoints)
        this.lastPosition = createAtomicPosition(
          content,
          segment,
          sectionAtomIndex,
          'after',
          cfiForElement,
        )
        sectionAtomIndex += 1
        continue
      }

      const position = createMediaPosition(
        content,
        segment,
        0,
        'before',
        cfiForElement,
      )
      this.addMarker(position, this.totalCodePoints)
      this.lastPosition = createMediaPosition(
        content,
        segment,
        0,
        'after',
        cfiForElement,
      )
    }

    this.sectionIndexes.push({
      spineIndex,
      spineItemId: content.model.spineItemId,
      resourceHref: content.model.resourceHref,
      firstMarkerIndex:
        this.markers.length > firstMarkerIndex ? firstMarkerIndex : undefined,
      totalCodePoints: content.model.totalCodePoints,
      segmentCount: content.model.segments.length,
    })
  }

  complete(): CanonicalLocationIndex {
    if (!this.completed) {
      if (this.lastPosition)
        this.addMarker(this.lastPosition, this.totalCodePoints, true)
      this.completed = true
    }

    return {
      canonicalModelVersion: CANONICAL_MODEL_VERSION,
      algorithmId: LOCATION_INDEX_ALGORITHM_ID,
      algorithmVersion: LOCATION_INDEX_ALGORITHM_VERSION,
      markerCodePointInterval: this.markerCodePointInterval,
      markers: this.markers.map((marker) => ({ ...marker })),
      sections: this.sectionIndexes.map((section) => ({ ...section })),
      totalCodePoints: this.totalCodePoints,
    }
  }
}

/**
 * Builds CFI-backed location markers from already loaded source documents.
 * Use {@link CanonicalLocationIndexBuilder} for production indexing so each
 * source document can be released between sections.
 */
export function buildCanonicalLocationIndex(
  sections: readonly CanonicalSectionForIndex[],
  options: LocationIndexOptions = {},
): CanonicalLocationIndex {
  const builder = new CanonicalLocationIndexBuilder(options)
  sections.forEach((section) => builder.append(section))
  return builder.complete()
}

function metricSegmentKey(spineIndex: number, segmentId: string): string {
  return `${spineIndex}:${segmentId}`
}

export function resolveProgressMetricConfiguration(
  configuration: ProgressMetricConfiguration = {},
): ResolvedProgressMetricConfiguration {
  const resolved = {
    algorithmId: configuration.algorithmId ?? PROGRESS_METRIC_ALGORITHM_ID,
    algorithmVersion:
      configuration.algorithmVersion ?? PROGRESS_METRIC_ALGORITHM_VERSION,
    atomicUnitWeight:
      configuration.atomicUnitWeight ?? DEFAULT_ATOMIC_PROGRESS_UNITS,
    fixedPageUnitWeight:
      configuration.fixedPageUnitWeight ??
      configuration.atomicUnitWeight ??
      DEFAULT_ATOMIC_PROGRESS_UNITS,
    mediaUnitWeight:
      configuration.mediaUnitWeight ??
      configuration.atomicUnitWeight ??
      DEFAULT_ATOMIC_PROGRESS_UNITS,
  }

  if (
    !resolved.algorithmId ||
    !Number.isInteger(resolved.algorithmVersion) ||
    resolved.algorithmVersion <= 0
  ) {
    throw new RangeError(
      'Progress metric requires a non-empty algorithmId and positive algorithmVersion',
    )
  }
  for (const [name, value] of Object.entries({
    atomicUnitWeight: resolved.atomicUnitWeight,
    fixedPageUnitWeight: resolved.fixedPageUnitWeight,
    mediaUnitWeight: resolved.mediaUnitWeight,
  })) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new RangeError(`${name} must be a positive integer`)
    }
  }

  return resolved
}

/**
 * Creates a versioned progress interpretation for canonical source segments.
 * It is intentionally independent from visual pages and Layout Atlas data.
 */
export function createProgressMetric(
  models: readonly CanonicalContentModel[],
  configuration: ProgressMetricConfiguration = {},
): ProgressMetric {
  const {
    algorithmId,
    algorithmVersion,
    atomicUnitWeight,
    fixedPageUnitWeight,
    mediaUnitWeight,
  } = resolveProgressMetricConfiguration(configuration)

  let previousSpineIndex = -1
  let totalUnits = 0
  const segmentsByKey = new Map<string, ProgressMetricSegment>()
  for (const model of models) {
    if (model.canonicalModelVersion !== CANONICAL_MODEL_VERSION) {
      throw new RangeError('Progress metric model version is not supported')
    }
    if (
      !Number.isInteger(model.spineIndex) ||
      model.spineIndex < 0 ||
      !model.resourceHref
    ) {
      throw new RangeError('Progress metric model source identity is invalid')
    }
    if (model.spineIndex <= previousSpineIndex) {
      throw new RangeError(
        'Progress metric models must be ordered by distinct spineIndex values',
      )
    }
    previousSpineIndex = model.spineIndex

    let atomIndex = 0
    let modelCodePoints = 0
    for (const segment of model.segments) {
      if (!segment.id) {
        throw new RangeError('Canonical segment id cannot be empty')
      }
      if (segment.kind === 'text') {
        if (
          !Number.isInteger(segment.codePointLength) ||
          segment.codePointLength < 0 ||
          !Number.isInteger(segment.utf16Length) ||
          segment.utf16Length < segment.codePointLength
        ) {
          throw new RangeError('Canonical text segment lengths are invalid')
        }
        modelCodePoints += segment.codePointLength
      }
      const segmentUnits =
        segment.kind === 'text'
          ? segment.codePointLength
          : segment.kind === 'atomic' && segment.atomicKind === 'fixed-page'
          ? fixedPageUnitWeight
          : segment.kind === 'media'
          ? mediaUnitWeight
          : atomicUnitWeight
      const key = metricSegmentKey(model.spineIndex, segment.id)
      if (segmentsByKey.has(key)) {
        throw new RangeError(`Duplicate canonical segment key ${key}`)
      }
      segmentsByKey.set(key, {
        spineIndex: model.spineIndex,
        spineItemId: model.spineItemId,
        resourceHref: model.resourceHref,
        segment,
        atomIndex: segment.kind === 'atomic' ? atomIndex : undefined,
        startUnits: totalUnits,
        totalUnits: segmentUnits,
      })
      if (segment.kind === 'atomic') atomIndex += 1
      totalUnits += segmentUnits
    }
    if (model.totalCodePoints !== modelCodePoints) {
      throw new RangeError(
        'Canonical model totalCodePoints does not match its segments',
      )
    }
  }

  const unitsAt = (position: CanonicalPosition): number => {
    if (position.canonicalModelVersion !== CANONICAL_MODEL_VERSION) {
      throw new RangeError('Canonical position model version is not supported')
    }
    if (
      !Number.isInteger(position.spineIndex) ||
      position.spineIndex < 0 ||
      !position.segmentId ||
      !position.resourceHref ||
      !position.cfi
    ) {
      throw new RangeError('Canonical position identity is invalid')
    }
    const entry = segmentsByKey.get(
      metricSegmentKey(position.spineIndex, position.segmentId),
    )
    if (!entry) {
      throw new RangeError(
        'Canonical position does not belong to this progress metric',
      )
    }

    if (position.kind !== entry.segment.kind) {
      throw new RangeError(
        'Canonical position kind does not match its indexed segment',
      )
    }
    if (
      position.resourceHref !== entry.resourceHref ||
      position.spineItemId !== entry.spineItemId
    ) {
      throw new RangeError(
        'Canonical position source identity does not match its indexed segment',
      )
    }

    let localUnits = 0
    if (position.kind === 'text') {
      if (entry.segment.kind !== 'text') {
        throw new RangeError(
          'Canonical position kind does not match its indexed segment',
        )
      }
      if (
        !Number.isInteger(position.codePointOffset) ||
        position.codePointOffset < 0 ||
        position.codePointOffset > entry.totalUnits
      ) {
        throw new RangeError(
          'Canonical text offset is outside its indexed segment',
        )
      }
      if (
        !Number.isInteger(position.domUtf16Offset) ||
        position.domUtf16Offset < 0 ||
        position.domUtf16Offset > entry.segment.utf16Length ||
        typeof position.isCodePointBoundary !== 'boolean'
      ) {
        throw new RangeError(
          'Canonical DOM text offset is outside its indexed segment',
        )
      }
      localUnits = position.codePointOffset
    } else if (position.kind === 'atomic') {
      if (
        position.atomIndex !== entry.atomIndex ||
        (position.edge !== 'before' && position.edge !== 'after')
      ) {
        throw new RangeError(
          'Canonical atomic index does not match its indexed segment',
        )
      }
      localUnits = position.edge === 'after' ? entry.totalUnits : 0
    } else if (position.kind === 'media') {
      if (
        !Number.isFinite(position.mediaOffsetSeconds) ||
        position.mediaOffsetSeconds < 0 ||
        (position.edge !== 'before' && position.edge !== 'after')
      ) {
        throw new RangeError('Canonical media position is invalid')
      }
      // v1 has no media-duration ledger, so media has the same explicit
      // before/after semantics as another atomic source segment. A future
      // metric version may interpolate by mediaOffsetSeconds.
      localUnits = position.edge === 'after' ? entry.totalUnits : 0
    }

    return entry.startUnits + localUnits
  }

  return {
    algorithmId,
    algorithmVersion,
    totalUnits,
    unitsAt,
    snapshotAt(position: CanonicalPosition): ProgressMetricSnapshot {
      return {
        algorithmId,
        algorithmVersion,
        completedUnits: unitsAt(position),
        totalUnits,
      }
    },
  }
}

import EpubCFI from './epubcfi'
import { sectionLayoutName } from './layout'
import {
  CanonicalLocationIndexBuilder,
  createAtomicPosition,
  createMediaPosition,
  createProgressMetric,
  createTextPositionFromUtf16,
  parseCanonicalContent,
} from './lumen-location'
import type {
  CanonicalContentModel,
  CanonicalLocationIndex,
  CanonicalPosition,
  LocationIndexOptions,
  ParsedCanonicalContent,
  ParsedCanonicalSegment,
  ProgressMetric,
  ProgressMetricConfiguration,
} from './lumen-location'
import type Section from './section'
import type Spine from './spine'
import type { RequestFunction } from './types'

type ParsedTextSegment = Extract<ParsedCanonicalSegment, { kind: 'text' }>

// Canonical indexing is background work. If the browser never reports an idle
// period, keep it progressing eventually, but allow a full second for the
// visible chapter, fonts and direct navigation to win first.
const CANONICAL_INDEX_IDLE_TIMEOUT_MS = 1000

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return

  if (signal.reason) {
    throw signal.reason
  }

  const error = new Error('The operation was aborted')
  error.name = 'AbortError'
  throw error
}

async function yieldToBrowser(signal: AbortSignal | undefined): Promise<void> {
  throwIfAborted(signal)

  await new Promise<void>((resolve) => {
    let settled = false
    let cancelScheduled: () => void = () => undefined
    let abort: () => void = () => undefined

    const finish = () => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', abort)
      resolve()
    }

    if (
      typeof requestIdleCallback === 'function' &&
      typeof cancelIdleCallback === 'function'
    ) {
      const callback = requestIdleCallback(finish, {
        timeout: CANONICAL_INDEX_IDLE_TIMEOUT_MS,
      })
      cancelScheduled = () => cancelIdleCallback(callback)
    } else {
      const timeout = setTimeout(finish, 0)
      cancelScheduled = () => clearTimeout(timeout)
    }

    abort = () => {
      cancelScheduled()
      finish()
    }
    signal?.addEventListener('abort', abort, { once: true })

    // The signal may have changed between the initial check and listener
    // registration. Resolve immediately; the check below preserves its reason.
    if (signal?.aborted) abort()
  })
  throwIfAborted(signal)
}

function cfiForText(section: Section, node: Text, utf16Offset: number): string {
  const document = node.ownerDocument
  if (!document) throw new Error('Cannot create a CFI for a detached text node')

  const range = document.createRange()
  range.setStart(node, utf16Offset)
  range.collapse(true)
  return section.cfiFromRange(range)
}

function cfiForElement(
  section: Section,
  node: Element,
  edge: 'before' | 'after',
): string {
  void edge
  // EPUB CFI terminal offsets address text, not arbitrary element child
  // boundaries. The element itself is therefore the durable anchor; the
  // canonical position keeps the before/after edge separately.
  return section.cfiFromElement(node)
}

export type CanonicalLocationGenerationProgress = {
  completedSections: number
  totalSections: number
  spineIndex: number
}

export type CanonicalLocationGenerationOptions = LocationIndexOptions & {
  /** Abort the sequential source scan without retaining a late document. */
  signal?: AbortSignal
  /** Non-linear spine occurrences are navigable but excluded by default. */
  includeNonLinear?: boolean
  /**
   * Yield before each group of source documents so visible rendering and
   * navigation retain priority. The default yields before every document.
   */
  yieldEverySections?: number
  /** Versioned interpretation for the generated canonical content models. */
  progressMetric?: ProgressMetricConfiguration
  onSection?: (progress: CanonicalLocationGenerationProgress) => void
}

export type CanonicalLocationGeneration = {
  index: CanonicalLocationIndex
  models: CanonicalContentModel[]
  progressMetric: ProgressMetric
}

export type CanonicalPositionResolutionOptions = {
  signal?: AbortSignal
  /** Ignore reader wrapper nodes if the caller's CFI was created in one. */
  ignoreClass?: string
}

type CachedCanonicalSection = {
  spineIndex: number
  source: Document
  content: ParsedCanonicalContent
}

function firstSegmentWithin(
  content: ParsedCanonicalContent,
  node: Node,
): ParsedCanonicalSegment | undefined {
  return content.segments.find((segment) => {
    if (segment.node === node) return true
    return node.contains(segment.node) || segment.node.contains(node)
  })
}

function lastSegmentWithin(
  content: ParsedCanonicalContent,
  node: Node,
): ParsedCanonicalSegment | undefined {
  for (let index = content.segments.length - 1; index >= 0; index -= 1) {
    const segment = content.segments[index]!
    if (segment.node === node) return segment
    if (node.contains(segment.node) || segment.node.contains(node)) {
      return segment
    }
  }
  return undefined
}

function textSegmentForNode(
  content: ParsedCanonicalContent,
  node: Node,
): ParsedTextSegment | undefined {
  return content.segments.find(
    (segment): segment is ParsedTextSegment =>
      segment.kind === 'text' && segment.node === node,
  )
}

function atomicIndex(
  content: ParsedCanonicalContent,
  target: ParsedCanonicalSegment,
): number {
  let index = 0
  for (const segment of content.segments) {
    if (segment.kind !== 'atomic') continue
    if (segment === target) return index
    index += 1
  }
  throw new Error(
    'Canonical atomic segment was not found in its source content',
  )
}

function positionAtStart(
  content: ParsedCanonicalContent,
  segment: ParsedCanonicalSegment,
  cfi: string,
): CanonicalPosition {
  if (segment.kind === 'text') {
    return createTextPositionFromUtf16(content, segment, 0, () => cfi)
  }
  if (segment.kind === 'atomic') {
    return createAtomicPosition(
      content,
      segment,
      atomicIndex(content, segment),
      'before',
      () => cfi,
    )
  }
  return createMediaPosition(content, segment, 0, 'before', () => cfi)
}

function positionAtEnd(
  content: ParsedCanonicalContent,
  segment: ParsedCanonicalSegment,
  cfi: string,
): CanonicalPosition {
  if (segment.kind === 'text') {
    return createTextPositionFromUtf16(
      content,
      segment,
      segment.node.data.length,
      () => cfi,
    )
  }
  if (segment.kind === 'atomic') {
    return createAtomicPosition(
      content,
      segment,
      atomicIndex(content, segment),
      'after',
      () => cfi,
    )
  }
  return createMediaPosition(content, segment, 0, 'after', () => cfi)
}

function positionFromRange(
  content: ParsedCanonicalContent,
  range: Range,
  cfi: string,
): CanonicalPosition | undefined {
  const textSegment = textSegmentForNode(content, range.startContainer)
  if (textSegment) {
    return createTextPositionFromUtf16(
      content,
      textSegment,
      range.startOffset,
      () => cfi,
    )
  }

  const directSegment = content.segments.find(
    (segment) => segment.node === range.startContainer,
  )
  if (directSegment) return positionAtStart(content, directSegment, cfi)

  // A CFI may resolve to an element boundary rather than directly to a text
  // node. Respect that boundary's child offset, then walk outwards through
  // wrapper elements. This handles inline separators and excluded elements
  // without confusing "segment contains boundary" (SVG/fixed atoms) with
  // "boundary subtree contains segment" (ordinary XHTML wrappers).
  let boundary: Node | null = range.startContainer
  let offset = range.startOffset
  while (boundary) {
    const containingAtomic = content.segments.find(
      (segment) => segment.kind !== 'text' && segment.node.contains(boundary!),
    )
    if (containingAtomic) return positionAtStart(content, containingAtomic, cfi)

    for (let index = offset; index < boundary.childNodes.length; index += 1) {
      const nextSegment = firstSegmentWithin(
        content,
        boundary.childNodes[index]!,
      )
      if (nextSegment) return positionAtStart(content, nextSegment, cfi)
    }
    for (
      let index = Math.min(offset, boundary.childNodes.length) - 1;
      index >= 0;
      index -= 1
    ) {
      const previousSegment = lastSegmentWithin(
        content,
        boundary.childNodes[index]!,
      )
      if (previousSegment) return positionAtEnd(content, previousSegment, cfi)
    }

    const parent: Node | null = boundary.parentNode
    if (!parent) break
    const siblingIndex = Array.prototype.indexOf.call(
      parent.childNodes,
      boundary,
    ) as number
    boundary = parent
    offset = siblingIndex + 1
  }

  return undefined
}

/**
 * Generates Lumen's canonical location data directly from source documents.
 *
 * This intentionally differs from the legacy `Locations` class: it never
 * invokes presentation hooks, never uses a rendered iframe DOM, and processes
 * one spine occurrence at a time. The returned result is serializable; this
 * `generate` retains no source DOM after it resolves. `positionFromCfi` keeps
 * at most one separately loaded source document so ordinary page turns inside
 * a chapter do not re-request or parse the chapter.
 */
class CanonicalLocations {
  private positionCache: CachedCanonicalSection | undefined
  private positionLoads = new Map<number, Promise<CachedCanonicalSection>>()

  constructor(
    private readonly spine: Spine,
    private readonly request: RequestFunction,
    private readonly globalLayoutName: () => string | undefined = () =>
      undefined,
  ) {}

  private contentFromSource(
    section: Section,
    source: Document,
  ): ParsedCanonicalContent {
    if (section.index === undefined || !section.href || !section.cfiBase) {
      throw new Error(
        'Canonical locations require a fully unpacked spine section',
      )
    }

    return parseCanonicalContent(source, {
      spineIndex: section.index,
      spineItemId: section.idref,
      resourceHref: section.href,
      fixedLayout:
        sectionLayoutName(section, this.globalLayoutName()) === 'pre-paginated',
    })
  }

  private async sourceForPosition(
    section: Section,
    signal?: AbortSignal,
  ): Promise<CachedCanonicalSection> {
    if (
      section.index !== undefined &&
      this.positionCache?.spineIndex === section.index
    ) {
      return this.positionCache
    }
    if (section.index === undefined) {
      throw new Error('Canonical positions require an indexed spine section')
    }

    let pending = this.positionLoads.get(section.index)
    if (!pending) {
      const spineIndex = section.index
      pending = (async () => {
        const source = await section.loadSource(this.request, signal)
        throwIfAborted(signal)
        const content = this.contentFromSource(section, source)
        const cached = { spineIndex: content.model.spineIndex, source, content }
        this.positionCache = cached
        return cached
      })().finally(() => {
        if (this.positionLoads.get(spineIndex) === pending) {
          this.positionLoads.delete(spineIndex)
        }
      })
      this.positionLoads.set(spineIndex, pending)
    }
    const cached = await pending
    throwIfAborted(signal)
    return cached
  }

  /** Release the optional one-section resolver cache, for example on tab close. */
  clearPositionCache(): void {
    this.positionCache = undefined
    this.positionLoads.clear()
  }

  async generate(
    options: CanonicalLocationGenerationOptions = {},
  ): Promise<CanonicalLocationGeneration> {
    const {
      signal,
      includeNonLinear = false,
      progressMetric,
      onSection,
      markerCodePointInterval,
      yieldEverySections = 1,
    } = options
    if (!Number.isInteger(yieldEverySections) || yieldEverySections <= 0) {
      throw new RangeError('yieldEverySections must be a positive integer')
    }
    const sections = this.spine.spineItems.filter(
      (section) => includeNonLinear || section.linear,
    )
    const builder = new CanonicalLocationIndexBuilder({
      markerCodePointInterval,
    })
    const models: CanonicalContentModel[] = []

    for (let ordinal = 0; ordinal < sections.length; ordinal += 1) {
      throwIfAborted(signal)
      // The initial source scan used to start immediately, competing with the
      // reader's first chapter display on an uncached book. Scheduling before
      // the group (rather than after it) lets browser rendering and user input
      // run first without changing canonical ordering or output.
      if (ordinal % yieldEverySections === 0) {
        await yieldToBrowser(signal)
      }
      const section = sections[ordinal]!
      const source = await section.loadSource(this.request, signal)
      throwIfAborted(signal)
      const content = this.contentFromSource(section, source)

      builder.append({
        content,
        cfiForText: (node, utf16Offset) =>
          cfiForText(section, node, utf16Offset),
        cfiForElement: (node, edge) => cfiForElement(section, node, edge),
      })
      models.push(content.model)
      onSection?.({
        completedSections: ordinal + 1,
        totalSections: sections.length,
        spineIndex: content.model.spineIndex,
      })
    }

    throwIfAborted(signal)
    return {
      index: builder.complete(),
      models,
      progressMetric: createProgressMetric(models, progressMetric),
    }
  }

  /**
   * Resolves an EPUB CFI to an exact canonical source position. The document
   * is loaded outside the visible rendition and is never passed through
   * presentation hooks.
   */
  async positionFromCfi(
    cfi: string,
    options: CanonicalPositionResolutionOptions = {},
  ): Promise<CanonicalPosition | undefined> {
    const { signal, ignoreClass } = options
    throwIfAborted(signal)

    let parsedCfi: EpubCFI
    try {
      parsedCfi = new EpubCFI(cfi)
    } catch (_error) {
      return undefined
    }

    const section = this.spine.get(parsedCfi.spinePos)
    if (!section) return undefined

    const cached = await this.sourceForPosition(section, signal)
    throwIfAborted(signal)
    const range = parsedCfi.toRange(cached.source, ignoreClass)
    if (!range) return undefined
    return positionFromRange(cached.content, range, cfi)
  }
}

export default CanonicalLocations

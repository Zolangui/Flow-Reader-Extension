import { IS_SERVER } from '@literal-ui/hooks'
import React from 'react'
import { v4 as uuidv4 } from 'uuid'
import { proxy, ref, snapshot, useSnapshot } from 'valtio'

import type {
  Book,
  CanonicalLocationIndex,
  LayoutAtlas,
  Location,
  Navigation,
  NavItem,
  ProgressMetric,
  Rendition,
  Section,
} from '@flow/epubjs'
import {
  createProgressMetric,
  LayoutMeasurementIncompleteError,
  resolveProgressMetricConfiguration,
} from '@flow/epubjs'

import { AnnotationColor, AnnotationType } from '../annotation'
import {
  db,
  isCurrentCanonicalLocationIndexRecord,
  isCacheableLocalFileRevision,
  isRestoreLocationRecord,
  isSupportedCanonicalProgressRecord,
  localFileRecordRevision,
} from '../db'
import type {
  BookRecord,
  CanonicalLocationIndexRecord,
  CanonicalMetricIdentity,
  CanonicalProgressRecord,
  FileRecord,
  LayoutAtlasRecord,
} from '../db'
import { fileToEpub } from '../file'
import {
  indexPublicationImages,
  type SectionImageReference,
} from '../lib/image-index'
import {
  assertPreparedLayoutAtlasFingerprintCurrent,
  createLayoutAtlasFingerprint,
  isCacheableLayoutAtlasFingerprintKey,
  isUsableLayoutAtlas,
  layoutAtlasMatchesVisiblePaginationArtifacts,
  layoutViewportPagesForPosition,
  LayoutAtlasConfigurationChangedError,
  measureLayoutAtlas,
  type VisiblePaginationArtifactSet,
} from '../lib/layout-atlas'
import type { TypographyConfiguration } from '../state'
import { defaultStyle } from '../styles'

import { dfs, INode } from './tree'

function updateIndex(array: any[], deletedItemIndex: number) {
  const last = array.length - 1
  return deletedItemIndex > last ? last : deletedItemIndex
}

function sameCanonicalPosition(
  left: CanonicalProgressRecord['position'],
  right: CanonicalProgressRecord['position'],
) {
  if (
    left.canonicalModelVersion !== right.canonicalModelVersion ||
    left.spineIndex !== right.spineIndex ||
    left.spineItemId !== right.spineItemId ||
    left.resourceHref !== right.resourceHref ||
    left.segmentId !== right.segmentId ||
    left.kind !== right.kind
  ) {
    return false
  }

  if (left.kind === 'text' && right.kind === 'text') {
    return (
      left.codePointOffset === right.codePointOffset &&
      left.domUtf16Offset === right.domUtf16Offset &&
      left.isCodePointBoundary === right.isCodePointBoundary
    )
  }
  if (left.kind === 'atomic' && right.kind === 'atomic') {
    return left.atomIndex === right.atomIndex && left.edge === right.edge
  }
  return (
    left.kind === 'media' &&
    right.kind === 'media' &&
    left.mediaOffsetSeconds === right.mediaOffsetSeconds &&
    left.edge === right.edge
  )
}

function sameCanonicalProgress(
  left: CanonicalProgressRecord | undefined,
  right: CanonicalProgressRecord,
) {
  return (
    isSupportedCanonicalProgressRecord(left) &&
    sameCanonicalPosition(left.position, right.position) &&
    left.metric.algorithmId === right.metric.algorithmId &&
    left.metric.algorithmVersion === right.metric.algorithmVersion &&
    left.metric.completedUnits === right.metric.completedUnits &&
    left.metric.totalUnits === right.metric.totalUnits &&
    JSON.stringify(left.metricIdentity ?? null) ===
      JSON.stringify(right.metricIdentity ?? null)
  )
}

export function compareHref(
  sectionHref: string | undefined,
  navitemHref: string | undefined,
) {
  if (sectionHref && navitemHref) {
    const [target] = String(navitemHref).split('#')

    return (
      sectionHref.endsWith(target!) ||
      // fix for relative nav path `../Text/example.html`
      target?.endsWith(sectionHref)
    )
  }
}

const DEFAULT_CANONICAL_UNITS_PER_ESTIMATED_PAGE = 1800

type PublisherPageListItem = { page?: unknown }

/**
 * epub.js 0.3 typings claimed `loaded.pageList` resolved to an array, while
 * its runtime (and epub.ts) resolves to a PageList object. Support both shapes
 * so a publisher-provided page list is never mistaken for an unavailable one.
 */
function getPublisherPageListItems(value: unknown): PublisherPageListItem[] {
  if (Array.isArray(value)) return value as PublisherPageListItem[]

  const pageList = (value as { pageList?: unknown } | undefined)?.pageList
  return Array.isArray(pageList) ? (pageList as PublisherPageListItem[]) : []
}

export interface INavItem extends NavItem, INode {
  subitems?: INavItem[]
}

// A plain object representation of INavItem for use in snapshots
export interface INavItemSnapshot {
  id: string
  href: string
  label: string
  parent?: string
  subitems?: readonly INavItemSnapshot[]
  depth?: number
  expanded?: boolean
}

export interface IMatch extends INode {
  excerpt: string
  description?: string
  cfi?: string
  subitems?: readonly IMatch[]
}

export interface ISection extends Section {
  length?: number
  images?: SectionImageReference[]
  navitem?: INavItem
}

// A plain object representation of ISection for use in snapshots
export interface ISectionSnapshot {
  idref: string
  href: string
  index: number
  length?: number
  images?: readonly SectionImageReference[]
  navitem?: INavItemSnapshot
}

interface TimelineItem {
  location: Location
  timestamp: number
}

/**
 * A domain event for every accepted canonical relocation. React snapshots are
 * intentionally not used as the event journal: several relocations can be
 * coalesced into a single render.
 */
export type CanonicalProgressListener = (
  progress: CanonicalProgressRecord,
) => void

export interface LayoutAtlasRequest {
  viewport: { width: number; height: number }
  typography?: TypographyConfiguration
}

class BaseTab {
  constructor(public readonly id: string, public readonly title = id) {}

  get isBook(): boolean {
    return this instanceof BookTab
  }

  get isPage(): boolean {
    return this instanceof PageTab
  }
}

// https://github.com/pmndrs/valtio/blob/92f3311f7f1a9fe2a22096cd30f9174b860488ed/src/vanilla.ts#L6
type AsRef = { $$valtioRef: true }

/** Keep Web-IDL objects out of Valtio proxies so their native brand checks work. */
export function createUnproxiedAbortController(): AbortController {
  return ref(new AbortController())
}

export class BookTab extends BaseTab {
  readonly instanceId = uuidv4()
  tocExpandedState: Record<string, boolean> = {}
  epub?: Book
  iframe?: Window & AsRef
  rendition?: Rendition & { manager?: any }
  nav?: Navigation
  locationToReturn?: Location
  section?: ISection
  sections?: ISection[]
  results?: IMatch[]
  activeResultID?: string
  rendered = false
  private searchTimer?: NodeJS.Timeout
  private searchAbort?: AbortController
  private searchRequest = 0
  private imageIndexAbort?: AbortController
  /** Exact IndexedDB record backing this live EPUB instance. */
  private sourceFileRecord?: FileRecord
  /** One exact byte revision shared by Reader, LPE, canonical index and Atlas. */
  private publicationRevisionPromise?: Promise<string>
  private canonicalIndexAbort?: AbortController
  private canonicalLocationIndex?: CanonicalLocationIndex
  private canonicalMetric?: ProgressMetric
  private canonicalFixedPageCount?: number
  private canonicalMetricIdentity?: CanonicalMetricIdentity
  private canonicalPositionRequest = 0
  private readonly canonicalProgressListeners =
    new Set<CanonicalProgressListener>()
  private layoutAtlasAbort?: AbortController
  /** Drops stale file-hash/fingerprint preparation before a job is started. */
  private layoutAtlasRefreshGeneration = 0
  /** Invalidates refreshes that have not reached their AbortController yet. */
  private layoutAtlasIntent = 0
  private layoutAtlasRequest = 0
  /** Debounces background Atlas work after direct reader navigation. */
  layoutAtlasNavigationEpoch = 0
  private visibleNavigationIntent = 0
  private layoutAtlasPendingKey?: string
  private layoutAtlasRetryTimer?: ReturnType<typeof setTimeout>
  private layoutAtlasRetryCount = 0
  private layoutAtlasPositionRetryTimer?: ReturnType<typeof setTimeout>
  private layoutAtlasPositionRetryCount = 0
  /** Direct local-page mapping is disabled for unsupported page-spread rules. */
  private layoutAtlasDirectMappingSafe = false
  /** True only when visible and detached pagination geometry decisions match. */
  layoutAtlasPresentationCompatible = false
  /** A local visual cache; never copied into the synced BookRecord. */
  layoutAtlas?: LayoutAtlas
  layoutAtlasFingerprintKey?: string
  layoutAtlasState: 'idle' | 'measuring' | 'ready' | 'failed' = 'idle'
  /** A new Atlas must wait for a location measured by the same live layout. */
  private layoutAtlasAwaitingRelocation = false
  /** Zero-based physical content page, present only when the mapping is safe. */
  layoutPageIndex?: number
  /** One or two zero-based content pages in the current visual viewport. */
  layoutViewportPageIndexes?: number[]
  canonicalIndexState: 'idle' | 'indexing' | 'ready' | 'failed' = 'idle'
  imageIndexState: 'idle' | 'indexing' | 'ready' | 'failed' = 'idle'
  private active = false
  private lastReadingLocationCfi?: string
  private destroyed = false
  searchVersion = 0

  get container() {
    return this?.rendition?.manager?.container as HTMLDivElement | undefined
  }

  timeline: TimelineItem[] = []
  get location() {
    return this.timeline[0]?.location
  }

  /**
   * Keep a stable CFI outside the rendition lifecycle. A hidden rendition is
   * temporarily resized to 0x0 and can report an intermediate location while
   * rebuilding; that event must never replace the user's real position.
   */
  get readingLocationCfi() {
    return (
      this.lastReadingLocationCfi ??
      (isRestoreLocationRecord(this.book.restoreLocation)
        ? this.book.restoreLocation.cfi
        : this.book.cfi)
    )
  }

  /** Changes whenever a user-facing navigation must supersede startup restore. */
  get navigationIntent() {
    return this.visibleNavigationIntent
  }

  /**
   * Resolve the exact revision once per live tab. IndexedDB returns a new File
   * object for every get(), so a WeakMap<File> alone cannot coalesce the
   * canonical index, LPE and Atlas callers during first open.
   */
  resolvePublicationRevision(
    fileRecord: FileRecord | undefined = this.sourceFileRecord,
  ) {
    if (this.publicationRevisionPromise) {
      return this.publicationRevisionPromise
    }
    if (!fileRecord) {
      return Promise.reject(new Error('EPUB file record is unavailable'))
    }

    const pending = localFileRecordRevision(fileRecord)
    this.publicationRevisionPromise = ref(pending)
    pending.catch(() => {
      if (this.publicationRevisionPromise === pending) {
        this.publicationRevisionPromise = undefined
      }
    })
    return pending
  }

  /** Cancel only unfinished background pagination; completed Atlas stays valid. */
  private prioritizeVisibleNavigation() {
    this.visibleNavigationIntent += 1
    this.layoutAtlasNavigationEpoch += 1

    if (!this.layoutAtlasAbort && this.layoutAtlasState !== 'measuring') return
    this.layoutAtlasAbort?.abort()
    this.layoutAtlasRefreshGeneration += 1
    this.layoutAtlasIntent += 1
    this.layoutAtlasAbort = undefined
    this.layoutAtlasPendingKey = undefined
    this.clearLayoutAtlasRetry()
    if (this.layoutAtlasState === 'measuring') this.layoutAtlasState = 'idle'
  }

  setActive(active: boolean) {
    this.active = active
    if (!active) {
      // A hidden tab has no trustworthy geometry. Discard the in-flight job;
      // a later visible pass can reuse its completed IndexedDB cache instead.
      this.layoutAtlasAbort?.abort()
      this.layoutAtlasRefreshGeneration += 1
      this.layoutAtlasIntent += 1
      this.layoutAtlasAbort = undefined
      this.layoutAtlasPendingKey = undefined
      this.clearLayoutAtlasRetry()
      this.clearLayoutAtlasPositionRetry()
      // A completed Atlas is immutable and remains useful when the same tab
      // returns with the same fingerprint. Keep its total in memory; the next
      // refresh will invalidate it if viewport or typography actually changed.
      const hasReusableAtlas =
        this.layoutAtlasState === 'ready' &&
        !!this.layoutAtlas &&
        !!this.layoutAtlasFingerprintKey
      if (!hasReusableAtlas) {
        this.layoutAtlas = undefined
        this.layoutAtlasFingerprintKey = undefined
        this.layoutAtlasDirectMappingSafe = false
        this.layoutAtlasState = 'idle'
      }
      this.layoutAtlasPresentationCompatible = false
      this.layoutAtlasAwaitingRelocation = hasReusableAtlas
      this.layoutPageIndex = undefined
      this.layoutViewportPageIndexes = undefined
    }
  }

  /**
   * Subscribe to accepted canonical positions without relying on a React
   * render. The returned cleanup makes tab switches and destruction safe.
   */
  subscribeCanonicalProgress(listener: CanonicalProgressListener): () => void {
    this.canonicalProgressListeners.add(listener)
    return () => this.canonicalProgressListeners.delete(listener)
  }

  private emitCanonicalProgress(progress: CanonicalProgressRecord) {
    this.canonicalProgressListeners.forEach((listener) => {
      try {
        listener(progress)
      } catch (error) {
        // Reading tracking must never make a valid relocation fail.
        console.warn('Canonical progress listener failed', error)
      }
    })
  }

  /** Release the iframe, EPUB archive and their event listeners on tab close. */
  destroy() {
    this.destroyed = true
    this.active = false
    this.onRender = undefined
    this.canonicalIndexAbort?.abort()
    this.canonicalIndexAbort = undefined
    this.sourceFileRecord = undefined
    this.publicationRevisionPromise = undefined
    this.canonicalLocationIndex = undefined
    this.canonicalMetric = undefined
    this.canonicalFixedPageCount = undefined
    this.canonicalMetricIdentity = undefined
    this.canonicalPositionRequest += 1
    this.canonicalProgressListeners.clear()
    this.searchAbort?.abort()
    this.searchAbort = undefined
    this.searchRequest += 1
    this.imageIndexAbort?.abort()
    this.imageIndexAbort = undefined
    this.imageIndexState = 'idle'
    this.layoutAtlasAbort?.abort()
    this.layoutAtlasRefreshGeneration += 1
    this.layoutAtlasIntent += 1
    this.layoutAtlasAbort = undefined
    this.layoutAtlasPendingKey = undefined
    this.clearLayoutAtlasRetry()
    this.clearLayoutAtlasPositionRetry()
    this.layoutAtlas = undefined
    this.layoutAtlasFingerprintKey = undefined
    this.layoutAtlasAwaitingRelocation = false
    this.layoutAtlasDirectMappingSafe = false
    this.layoutAtlasPresentationCompatible = false
    this.layoutPageIndex = undefined
    this.layoutViewportPageIndexes = undefined

    try {
      // `Book.destroy()` also destroys the rendition it created with
      // `renderTo()`, then releases archive resources and blob URLs.
      if (this.epub) this.epub.destroy()
      else this.rendition?.destroy()
    } catch (error) {
      console.warn('Unable to destroy EPUB tab:', error)
    }

    this.epub = undefined
    this.rendition = undefined
    this.iframe = undefined
    this._el = undefined
    this.section = undefined
    this.sections = undefined
    this.results = undefined
  }

  display(target?: string, returnable = true) {
    this.prioritizeVisibleNavigation()
    if (target && this.sections) {
      const [targetPath] = String(target).split('#')
      const section = this.sections.find((s) => compareHref(s.href, targetPath))
      if (section) {
        const hashIndex = target.indexOf('#')
        const hash = hashIndex > -1 ? target.substring(hashIndex) : ''
        target = section.href + hash
      }
    }

    const displayed = this.rendition?.display(target)
    if (returnable) this.showPrevLocation()
    return displayed
  }
  displayFromSelector(selector: string, section: ISection, returnable = true) {
    try {
      const el = section.document?.querySelector(selector)
      if (el) this.display(section.cfiFromElement(el), returnable)
    } catch (err) {
      this.display(section.href, returnable)
    }
  }
  prev() {
    this.prioritizeVisibleNavigation()
    this.rendition?.prev()
    // avoid content flash
    if (this.container?.scrollLeft === 0 && !this.location?.atStart) {
      this.rendered = false
    }
  }
  next() {
    this.prioritizeVisibleNavigation()
    this.rendition?.next()
  }

  updateBook(changes: Partial<BookRecord>) {
    changes = {
      ...changes,
      updatedAt: Date.now(),
    }
    // don't wait promise resolve to make valtio batch updates
    this.book = { ...this.book, ...changes }
    db?.books.update(this.book.id, changes)
  }

  annotationRange?: Range
  setAnnotationRange(cfi: string) {
    const range = this.view?.contents.range(cfi)
    if (range) this.annotationRange = ref(range)
  }

  rangeToCfi(range: Range) {
    return this.view.contents.cfiFromRange(range)
  }
  putAnnotation(
    type: AnnotationType,
    cfi: string,
    color: AnnotationColor,
    text: string,
    notes?: string,
  ) {
    const spine = this.section
    if (!spine?.navitem) return

    const i = this.book.annotations.findIndex((a) => a.cfi === cfi)
    let annotation = this.book.annotations[i]

    const now = Date.now()
    if (!annotation) {
      annotation = {
        id: uuidv4(),
        bookId: this.book.id,
        cfi,
        spine: {
          index: spine.index,
          title: spine.navitem.label,
        },
        createAt: now,
        updatedAt: now,
        type,
        color,
        notes,
        text,
      }

      this.updateBook({
        // DataCloneError: Failed to execute 'put' on 'IDBObjectStore': #<Object> could not be cloned.
        annotations: [...snapshot(this.book.annotations), annotation],
      })
    } else {
      annotation = {
        ...this.book.annotations[i]!,
        type,
        updatedAt: now,
        color,
        notes,
        text,
      }
      this.book.annotations.splice(i, 1, annotation)
      this.updateBook({
        annotations: [...snapshot(this.book.annotations)],
      })
    }
  }
  removeAnnotation(cfi: string) {
    return this.updateBook({
      annotations: snapshot(this.book.annotations).filter((a) => a.cfi !== cfi),
    })
  }

  keyword = ''
  setKeyword(keyword: string) {
    if (this.keyword === keyword) return
    this.keyword = keyword

    if (this.searchTimer) {
      clearTimeout(this.searchTimer)
    }
    this.searchTimer = setTimeout(() => this.onKeywordChange(), 1000)
  }

  async onKeywordChange() {
    this.searchAbort?.abort()
    // AbortController has Web-IDL brand checks and must never be proxied by
    // Valtio (`abort()` / `signal` reject a Proxy as an illegal receiver).
    const controller = createUnproxiedAbortController()
    this.searchAbort = controller
    const request = ++this.searchRequest
    const results = await this.search(this.keyword, controller.signal)
    if (
      controller.signal.aborted ||
      request !== this.searchRequest ||
      this.destroyed
    ) {
      return
    }
    this.results = results
  }

  get totalLength() {
    return this.sections?.reduce((acc, s) => acc + (s.length ?? 0), 0) ?? 0
  }

  toggle(id: string) {
    this.tocExpandedState = {
      ...this.tocExpandedState,
      [id]: !this.tocExpandedState[id],
    }
  }

  /**
   * Screen-page samples used to mutate the total as the reader happened to
   * visit chapters. They are deliberately retired: only a completed Layout
   * Atlas may publish a visual page total. See docs/lumen-location-engine.md.
   */
  private prepareStablePageCount() {
    // Older preview builds persisted a local Atlas total inside BookRecord.
    // That record can travel through backup/sync without its renderer-specific
    // atlas, so it must never be shown as exact after reopening the book.
    if (this.book.pageCountSource === 'layout-atlas') {
      this.updateBook({
        pageCount: undefined,
        pageCountSource: 'calculating',
        pageCountEstimated: true,
        pageCountLayoutKey: undefined,
        pageCountLayouts: undefined,
      })
      return
    }

    if (
      this.book.pageCountSource === 'publisher-page-list' ||
      this.book.pageCountSource === 'canonical-estimate'
    ) {
      return
    }

    this.updateBook({
      pageCount: undefined,
      pageCountSource: 'calculating',
      pageCountEstimated: true,
      pageCountLayoutKey: undefined,
      pageCountLayouts: undefined,
    })
  }

  /**
   * The canonical metric is stable across chapter visits and typography
   * changes. Until the local Layout Atlas exists, it supplies a clearly marked
   * stable estimate instead of letting totals drift as rendered samples arrive.
   */
  private applyCanonicalPageEstimate() {
    if (!this.canonicalMetric) return
    if (this.book.pageCount && !this.book.pageCountEstimated) return

    if (this.canonicalFixedPageCount !== undefined) {
      this.updateBook({
        pageCount: this.canonicalFixedPageCount,
        pageCountEstimated: false,
        pageCountSource: 'fixed-layout-model',
        pageCountLayoutKey: undefined,
      })
      return
    }

    const pageCount = Math.max(
      1,
      Math.ceil(
        this.canonicalMetric.totalUnits /
          DEFAULT_CANONICAL_UNITS_PER_ESTIMATED_PAGE,
      ),
    )

    if (
      this.book.pageCount === pageCount &&
      this.book.pageCountEstimated &&
      this.book.pageCountSource === 'canonical-estimate'
    ) {
      return
    }

    this.updateBook({
      pageCount,
      pageCountEstimated: true,
      pageCountSource: 'canonical-estimate',
      pageCountLayoutKey: undefined,
    })
  }

  private activateCanonicalIndex(record: CanonicalLocationIndexRecord) {
    const metricConfiguration = resolveProgressMetricConfiguration(
      record.progressMetricConfiguration,
    )
    this.canonicalLocationIndex = record.index
    this.canonicalMetric = createProgressMetric(
      record.models,
      metricConfiguration,
    )
    this.canonicalFixedPageCount =
      record.models.length > 0 &&
      record.models.every(
        (model) =>
          model.segments.length === 1 &&
          model.segments[0]?.kind === 'atomic' &&
          model.segments[0].atomicKind === 'fixed-page',
      )
        ? record.models.length
        : undefined
    this.canonicalMetricIdentity = {
      schemaVersion: 2,
      publicationRevision: record.revision,
      canonicalModelVersion: record.index.canonicalModelVersion,
      progressMetricAlgorithmId: metricConfiguration.algorithmId,
      progressMetricAlgorithmVersion: metricConfiguration.algorithmVersion,
      progressMetricConfigurationFingerprint: JSON.stringify({
        atomicUnitWeight: metricConfiguration.atomicUnitWeight,
        fixedPageUnitWeight: metricConfiguration.fixedPageUnitWeight,
        mediaUnitWeight: metricConfiguration.mediaUnitWeight,
      }),
    }
    this.canonicalIndexState = 'ready'
    this.applyCanonicalPageEstimate()
  }

  private async initializeCanonicalLocations(
    epub: Book,
    fileRecord: FileRecord,
  ) {
    this.canonicalIndexAbort?.abort()
    const controller = createUnproxiedAbortController()
    this.canonicalIndexAbort = controller
    this.canonicalIndexState = 'indexing'

    try {
      // `displayOptions` participates in per-item fixed-layout resolution, so
      // the engine must be fully ready before generating its canonical model.
      await epub.ready
      if (this.destroyed || this.epub !== epub || controller.signal.aborted) {
        return
      }

      const revision = await this.resolvePublicationRevision(fileRecord)
      if (this.destroyed || this.epub !== epub || controller.signal.aborted) {
        return
      }

      const generateRecord =
        async (): Promise<CanonicalLocationIndexRecord> => {
          const generated = await epub.canonicalLocations.generate({
            signal: controller.signal,
          })
          if (
            this.destroyed ||
            this.epub !== epub ||
            controller.signal.aborted
          ) {
            throw (
              controller.signal.reason ??
              new DOMException('Aborted', 'AbortError')
            )
          }

          const now = Date.now()
          return {
            schemaVersion: 1,
            bookId: this.book.id,
            revision,
            index: generated.index,
            models: generated.models,
            createdAt: now,
            updatedAt: now,
          }
        }

      let record = await db?.canonicalLocationIndices.get(this.book.id)
      if (
        !isCurrentCanonicalLocationIndexRecord(record, this.book.id, revision)
      ) {
        if (record) await db?.canonicalLocationIndices.delete(this.book.id)
        record = await generateRecord()
        if (isCacheableLocalFileRevision(revision)) {
          await db?.canonicalLocationIndices.put(record)
        }
      }

      if (this.destroyed || this.epub !== epub || controller.signal.aborted) {
        return
      }

      try {
        this.activateCanonicalIndex(record)
      } catch (error) {
        // A malformed local cache must be self-healing rather than leaving the
        // book permanently without canonical progress.
        await db?.canonicalLocationIndices.delete(this.book.id)
        record = await generateRecord()
        if (isCacheableLocalFileRevision(revision)) {
          await db?.canonicalLocationIndices.put(record)
        }
        this.activateCanonicalIndex(record)
      }
      const targetCfi = this.readingLocationCfi
      if (targetCfi) {
        await this.updateCanonicalProgress(targetCfi, epub)
      }
    } catch (error) {
      if ((error as { name?: string })?.name === 'AbortError') return
      this.canonicalIndexState = 'failed'
      console.warn('Unable to generate canonical EPUB locations:', error)
    }
  }

  private async updateCanonicalProgress(cfi: string, epub = this.epub) {
    if (!epub || !this.canonicalMetric || !this.canonicalLocationIndex) return

    const request = ++this.canonicalPositionRequest
    try {
      const position = await epub.canonicalLocations.positionFromCfi(cfi, {
        signal: this.canonicalIndexAbort?.signal,
      })
      const currentCfi = this.readingLocationCfi
      if (
        !position ||
        this.destroyed ||
        this.epub !== epub ||
        request !== this.canonicalPositionRequest ||
        currentCfi !== cfi
      ) {
        return
      }

      // Non-linear content is intentionally excluded from the reading-order
      // metric. Its CFI remains persisted, but it must not distort progress.
      if (
        !this.canonicalLocationIndex.sections.some(
          (section) => section.spineIndex === position.spineIndex,
        )
      ) {
        return
      }

      const metric = this.canonicalMetric.snapshotAt(position)
      const canonicalProgress: CanonicalProgressRecord = {
        schemaVersion: 1,
        position,
        metric,
        metricIdentity: this.canonicalMetricIdentity,
        updatedAt: Date.now(),
      }
      const percentage =
        metric.totalUnits > 0
          ? Math.max(0, Math.min(1, metric.completedUnits / metric.totalUnits))
          : 0

      // Resize, restore and typography reflow can emit the same relocation.
      // Do not refresh the LWW clock or sync an unchanged reading fact.
      if (
        sameCanonicalProgress(this.book.canonicalProgress, canonicalProgress)
      ) {
        return
      }

      this.updateBook({ canonicalProgress, percentage })
      this.emitCanonicalProgress(canonicalProgress)
    } catch (error) {
      if ((error as { name?: string })?.name === 'AbortError') return
      console.warn('Unable to resolve canonical EPUB position:', error)
    }
  }

  /**
   * Forget only the renderer-local result. Canonical progress and the stable
   * estimate remain valid while a new viewport/font-specific atlas is built.
   */
  private clearLayoutAtlasRetry(resetCount = true) {
    if (this.layoutAtlasRetryTimer) {
      clearTimeout(this.layoutAtlasRetryTimer)
      this.layoutAtlasRetryTimer = undefined
    }
    if (resetCount) this.layoutAtlasRetryCount = 0
  }

  private clearLayoutAtlasPositionRetry(resetCount = true) {
    if (this.layoutAtlasPositionRetryTimer) {
      clearTimeout(this.layoutAtlasPositionRetryTimer)
      this.layoutAtlasPositionRetryTimer = undefined
    }
    if (resetCount) this.layoutAtlasPositionRetryCount = 0
  }

  /**
   * A spread rebuild can publish its cached Atlas a frame before the visible
   * iframes expose their final pagination artifacts. Re-check the pure current
   * location briefly instead of leaving Timeline approximate until the user
   * happens to turn another page.
   */
  private scheduleLayoutAtlasPositionRetry() {
    if (
      this.layoutAtlasPositionRetryCount >= 6 ||
      !this.layoutAtlasDirectMappingSafe ||
      this.rendition?.manager?.settings.direction === 'rtl'
    ) {
      return
    }

    const attempt = ++this.layoutAtlasPositionRetryCount
    this.clearLayoutAtlasPositionRetry(false)
    this.layoutAtlasPositionRetryTimer = setTimeout(() => {
      this.layoutAtlasPositionRetryTimer = undefined
      if (
        this.destroyed ||
        !this.active ||
        this.layoutAtlasState !== 'ready' ||
        !this.layoutAtlas
      ) {
        return
      }

      let mapped = false
      try {
        const currentLocation = this.rendition?.currentLocation()
        if (currentLocation) {
          mapped = this.updateLayoutPagePosition(currentLocation, true)
        }
      } catch {
        // The manager can be between its old and new spread for one frame.
      }

      if (mapped) this.clearLayoutAtlasPositionRetry()
      else this.scheduleLayoutAtlasPositionRetry()
    }, Math.min(400, 50 * 2 ** (attempt - 1)))
  }

  private scheduleLayoutAtlasRetry(request: LayoutAtlasRequest): boolean {
    // A timeout normally means a lazy embedded asset is still becoming ready.
    // The engine already retries only the unsettled chapter once. Allow one
    // final full pass for browser resource caches, but never perform three
    // complete background walks of a large book.
    if (this.layoutAtlasRetryCount >= 1) return false

    const attempt = ++this.layoutAtlasRetryCount
    this.clearLayoutAtlasRetry(false)
    this.layoutAtlasRetryTimer = setTimeout(() => {
      this.layoutAtlasRetryTimer = undefined
      if (!this.destroyed && this.active && this.layoutAtlasState === 'idle') {
        void this.refreshLayoutAtlas(request)
      }
    }, 1500 * 2 ** (attempt - 1))
    return true
  }

  invalidateLayoutAtlas(resetRetries = true, invalidateIntent = true) {
    this.layoutAtlasAbort?.abort()
    this.layoutAtlasRefreshGeneration += 1
    if (invalidateIntent) this.layoutAtlasIntent += 1
    this.layoutAtlasAbort = undefined
    this.layoutAtlasPendingKey = undefined
    this.clearLayoutAtlasRetry(resetRetries)
    this.clearLayoutAtlasPositionRetry()
    this.layoutAtlas = undefined
    this.layoutAtlasFingerprintKey = undefined
    this.layoutAtlasAwaitingRelocation = false
    this.layoutAtlasDirectMappingSafe = false
    this.layoutPageIndex = undefined
    this.layoutViewportPageIndexes = undefined
    if (this.layoutAtlasState !== 'failed') this.layoutAtlasState = 'idle'
  }

  private isCurrentLayoutAtlasRequest(
    intent: number,
    request: number,
    epub: Book,
    rendition: Rendition,
    controller: AbortController,
  ) {
    return (
      this.isCurrentLayoutAtlasIntent(intent, epub, rendition) &&
      this.layoutAtlasRequest === request &&
      this.layoutAtlasAbort === controller &&
      !controller.signal.aborted
    )
  }

  private isCurrentLayoutAtlasIntent(
    intent: number,
    epub: Book,
    rendition: Rendition,
  ) {
    return (
      !this.destroyed &&
      this.active &&
      this.epub === epub &&
      this.rendition === rendition &&
      this.layoutAtlasIntent === intent
    )
  }

  private isCurrentLayoutAtlasRefresh(
    generation: number,
    epub: Book,
    rendition: Rendition,
  ) {
    return (
      !this.destroyed &&
      this.active &&
      this.epub === epub &&
      this.rendition === rendition &&
      this.layoutAtlasRefreshGeneration === generation
    )
  }

  private applyLayoutAtlas(atlas: LayoutAtlas, fingerprintKey: string) {
    this.clearLayoutAtlasRetry()
    this.clearLayoutAtlasPositionRetry()
    this.layoutAtlas = ref(atlas)
    this.layoutAtlasFingerprintKey = fingerprintKey
    this.layoutAtlasState = 'ready'
    this.layoutAtlasPendingKey = undefined
    // The current DefaultViewManager does not yet mirror every modern
    // `rendition:page-spread-*` rule that the planner understands. The total
    // remains correct, but do not claim an exact numerator after any such
    // placement until page-boundary CFIs are available.
    this.layoutAtlasDirectMappingSafe =
      !atlas.pages.some((page) => page.pageSpread) &&
      !atlas.transitions.some(
        (transition) => transition.kind === 'layout-change',
      )
    this.layoutAtlasPresentationCompatible = false
    // A saved Location can describe the pre-font/pre-spread layout. Derive a
    // fresh local location before presenting a current page number as exact;
    // until then Timeline deliberately keeps the `~` marker.
    this.layoutAtlasAwaitingRelocation = true
    this.layoutPageIndex = undefined
    this.layoutViewportPageIndexes = undefined
    // This is a pure query rather than `reportLocation()`: emitting a
    // synthetic relocation would write an unchanged CFI/timeline entry and
    // could create needless sync work. A manager query computes the current
    // leaf under the already-settled live layout without publishing an event.
    try {
      const currentLocation = this.rendition?.currentLocation()
      const mapped = currentLocation
        ? this.updateLayoutPagePosition(currentLocation, true)
        : false
      if (!mapped) this.scheduleLayoutAtlasPositionRetry()
    } catch {
      // A first render can briefly have no measurable view. The next genuine
      // relocation will safely fill this optional current-page mapping.
      this.scheduleLayoutAtlasPositionRetry()
    }
  }

  /**
   * Maps the renderer's current local leaf to an Atlas page when that mapping
   * is demonstrably direct. RTL, forced blank pages and roll intentionally
   * fall back to the canonical percentage until the future CFI-boundary layer
   * is available; inventing an exact page number would be worse than `~`.
   */
  private updateLayoutPagePosition(
    location?: Location,
    fromCurrentRelocation = false,
  ): boolean {
    if (fromCurrentRelocation) this.layoutAtlasAwaitingRelocation = false
    if (this.layoutAtlasAwaitingRelocation) {
      this.layoutPageIndex = undefined
      this.layoutViewportPageIndexes = undefined
      return false
    }
    const atlas = this.layoutAtlas
    const start = location?.start
    const displayedPage = start?.displayed?.page
    if (
      !atlas ||
      !start ||
      !Number.isInteger(displayedPage) ||
      displayedPage! < 1
    ) {
      this.layoutPageIndex = undefined
      this.layoutViewportPageIndexes = undefined
      return false
    }

    const renditionViews = this.rendition?.views()
    const renderedViews = Array.isArray(renditionViews)
      ? renditionViews
      : renditionViews?.all() ?? []
    const visibleArtifacts = renderedViews.flatMap(
      (view): VisiblePaginationArtifactSet[] => {
        const spineIndex = view.section.index
        return view.displayed &&
          !view._disposed &&
          Number.isInteger(spineIndex) &&
          spineIndex! >= 0 &&
          typeof view.getPaginationLifecycleArtifacts === 'function'
          ? [
              {
                spineIndex: spineIndex!,
                artifacts: view.getPaginationLifecycleArtifacts(),
              },
            ]
          : []
      },
    )
    this.layoutAtlasPresentationCompatible =
      layoutAtlasMatchesVisiblePaginationArtifacts(atlas, visibleArtifacts)
    if (!this.layoutAtlasPresentationCompatible) {
      this.layoutPageIndex = undefined
      this.layoutViewportPageIndexes = undefined
      return false
    }

    const viewportPages = layoutViewportPagesForPosition({
      atlas,
      spineIndex: start.index,
      displayedPage: displayedPage!,
      direction:
        this.rendition?.manager?.settings.direction === 'rtl' ? 'rtl' : 'ltr',
      directMappingSafe: this.layoutAtlasDirectMappingSafe,
    })
    if (!viewportPages?.length) {
      this.layoutPageIndex = undefined
      this.layoutViewportPageIndexes = undefined
      return false
    }

    this.layoutPageIndex = viewportPages[0]
    this.layoutViewportPageIndexes = viewportPages
    return true
  }

  /**
   * Build or load a complete, local visual atlas for the active reader size.
   * This never writes a visual total to BookRecord: backup/sync can transfer
   * a book record, but not this browser/font/viewport-specific artifact.
   */
  async refreshLayoutAtlas({ viewport, typography }: LayoutAtlasRequest) {
    const epub = this.epub
    const rendition = this.rendition
    if (
      !epub ||
      !rendition ||
      !this.active ||
      this.destroyed ||
      this.canonicalIndexState === 'idle' ||
      this.canonicalIndexState === 'indexing' ||
      viewport.width <= 0 ||
      viewport.height <= 0
    ) {
      return
    }

    // File hashing and fingerprinting are asynchronous. A preparation
    // generation makes an older call harmless if a newer viewport/style call
    // begins before either has a final key. Once a matching job is measuring,
    // callers deliberately coalesce onto it instead of cancelling/restarting
    // the same full-book work.
    const refreshGeneration = ++this.layoutAtlasRefreshGeneration

    let intent: number | undefined
    let request: number | undefined
    let controller: AbortController | undefined
    try {
      const revision = await this.resolvePublicationRevision()
      if (
        !this.isCurrentLayoutAtlasRefresh(refreshGeneration, epub, rendition)
      ) {
        return
      }

      const preparedFingerprint = await createLayoutAtlasFingerprint({
        book: epub,
        rendition,
        publicationRevision: revision,
        viewport,
        typography,
      })
      if (
        !this.isCurrentLayoutAtlasRefresh(refreshGeneration, epub, rendition)
      ) {
        return
      }

      const { fingerprintKey } = preparedFingerprint
      if (
        this.layoutAtlasFingerprintKey === fingerprintKey &&
        this.layoutAtlasState === 'ready'
      ) {
        return
      }
      if (
        this.layoutAtlasState === 'measuring' &&
        this.layoutAtlasPendingKey === fingerprintKey &&
        this.layoutAtlasAbort &&
        !this.layoutAtlasAbort.signal.aborted
      ) {
        return
      }

      this.invalidateLayoutAtlas(false)
      intent = this.layoutAtlasIntent
      request = ++this.layoutAtlasRequest
      controller = createUnproxiedAbortController()
      this.layoutAtlasAbort = controller
      this.layoutAtlasPendingKey = fingerprintKey
      this.layoutAtlasState = 'measuring'

      const cacheable =
        isCacheableLocalFileRevision(revision) &&
        isCacheableLayoutAtlasFingerprintKey(fingerprintKey)
      const cached = cacheable
        ? await db?.layoutAtlases.get([this.book.id, revision, fingerprintKey])
        : undefined
      if (
        !this.isCurrentLayoutAtlasRequest(
          intent,
          request,
          epub,
          rendition,
          controller,
        )
      ) {
        return
      }
      if (
        cached?.schemaVersion === 1 &&
        cached.bookId === this.book.id &&
        cached.revision === revision &&
        cached.fingerprintKey === fingerprintKey &&
        isUsableLayoutAtlas(
          cached.atlas,
          revision,
          preparedFingerprint.fingerprint,
        )
      ) {
        await assertPreparedLayoutAtlasFingerprintCurrent(
          {
            book: epub,
            rendition,
            publicationRevision: revision,
            viewport,
            typography,
          },
          preparedFingerprint,
        )
        if (
          !this.isCurrentLayoutAtlasRequest(
            intent,
            request,
            epub,
            rendition,
            controller,
          )
        ) {
          return
        }
        this.applyLayoutAtlas(cached.atlas, fingerprintKey)
        this.layoutAtlasAbort = undefined
        return
      }
      if (cached && cacheable) {
        // Do not retry a malformed local entry forever. It is derived data and
        // can always be regenerated from the EPUB under the current renderer.
        await db?.layoutAtlases.delete([this.book.id, revision, fingerprintKey])
      }

      const measured = await measureLayoutAtlas({
        book: epub,
        rendition,
        publicationRevision: revision,
        viewport,
        typography,
        signal: controller.signal,
        preparedFingerprint,
      })
      if (
        !this.isCurrentLayoutAtlasRequest(
          intent,
          request,
          epub,
          rendition,
          controller,
        )
      ) {
        return
      }

      const now = Date.now()
      const record: LayoutAtlasRecord = {
        schemaVersion: 1,
        bookId: this.book.id,
        revision,
        fingerprintKey: measured.fingerprintKey,
        atlas: measured.atlas,
        createdAt: now,
        updatedAt: now,
      }
      if (cacheable) await db?.layoutAtlases.put(record)
      // IndexedDB writes yield back to the browser. A font, spread or viewport
      // change during that wait must not let a correctly keyed Atlas for A be
      // exposed as the exact result for the now-visible configuration B.
      await assertPreparedLayoutAtlasFingerprintCurrent(
        {
          book: epub,
          rendition,
          publicationRevision: revision,
          viewport,
          typography,
        },
        preparedFingerprint,
      )
      if (
        !this.isCurrentLayoutAtlasRequest(
          intent,
          request,
          epub,
          rendition,
          controller,
        )
      ) {
        return
      }

      this.applyLayoutAtlas(measured.atlas, measured.fingerprintKey)
      this.layoutAtlasAbort = undefined
      if (cacheable) void this.pruneLayoutAtlases()
    } catch (error) {
      if ((error as { name?: string })?.name === 'AbortError') {
        // A superseded/destroyed request has already cleared its state in
        // invalidateLayoutAtlas(). An AbortError from the still-current job,
        // however, is an internal measurement failure; returning without
        // cleanup would leave this book permanently stuck in `measuring`.
        const currentAbort = controller
          ? intent !== undefined && request !== undefined
            ? this.isCurrentLayoutAtlasRequest(
                intent,
                request,
                epub,
                rendition,
                controller,
              )
            : false
          : this.isCurrentLayoutAtlasRefresh(refreshGeneration, epub, rendition)
        if (currentAbort) {
          this.layoutAtlasState = 'failed'
          this.layoutAtlasPendingKey = undefined
          this.layoutAtlasAbort = undefined
          console.warn(
            'Visual EPUB page atlas aborted unexpectedly while current:',
            error,
          )
        }
        return
      }
      const stillRelevant = controller
        ? intent !== undefined && request !== undefined
          ? this.isCurrentLayoutAtlasRequest(
              intent,
              request,
              epub,
              rendition,
              controller,
            )
          : false
        : this.isCurrentLayoutAtlasRefresh(refreshGeneration, epub, rendition)
      if (!stillRelevant) return
      if (
        !controller ||
        intent === undefined ||
        request === undefined ||
        this.isCurrentLayoutAtlasRequest(
          intent,
          request,
          epub,
          rendition,
          controller,
        )
      ) {
        const shouldRetry =
          error instanceof LayoutMeasurementIncompleteError ||
          (error as { name?: string })?.name ===
            'LayoutMeasurementIncompleteError' ||
          error instanceof LayoutAtlasConfigurationChangedError ||
          (error as { name?: string })?.name ===
            'LayoutAtlasConfigurationChangedError'
        if (shouldRetry) {
          this.layoutAtlasState = this.scheduleLayoutAtlasRetry({
            viewport,
            typography,
          })
            ? 'idle'
            : 'failed'
          this.layoutAtlasPendingKey = undefined
          this.layoutAtlasAbort = undefined
          console.info(
            'Visual EPUB page atlas will retry after layout settling:',
            error,
          )
          return
        }
        this.layoutAtlasState = 'failed'
        this.layoutAtlasPendingKey = undefined
        this.layoutAtlasAbort = undefined
        console.warn('Unable to build visual EPUB page atlas:', error)
      }
    }
  }

  private async pruneLayoutAtlases() {
    const records = await db?.layoutAtlases
      .where('bookId')
      .equals(this.book.id)
      .toArray()
    if (!records) return

    // Keep a small history for font/viewport changes without letting a resize
    // drag turn IndexedDB into an unbounded pagination cache.
    const stale = records
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(3)
    await Promise.all(
      stale.map((record) =>
        db?.layoutAtlases.delete([
          record.bookId,
          record.revision,
          record.fingerprintKey,
        ]),
      ),
    )
  }

  /**
   * Publisher page-list labels are a citation layer. When a page-list contains
   * one boundary per published page, its item count is authoritative for that
   * layer; label arithmetic breaks Roman front matter and deliberate gaps.
   */
  private calculatePageCount() {
    const epub = this.epub
    if (!epub) return

    epub.loaded.pageList
      .then((pageList) => {
        if (this.destroyed || this.epub !== epub) return
        const pageListItems = getPublisherPageListItems(pageList)
        if (pageListItems.length === 0) {
          this.applyCanonicalPageEstimate()
          return
        }

        if (
          this.book.pageCount === pageListItems.length &&
          this.book.pageCountSource === 'publisher-page-list'
        ) {
          return
        }

        this.updateBook({
          pageCount: pageListItems.length,
          pageCountSource: 'publisher-page-list',
          pageCountEstimated: false,
          pageCountLayoutKey: undefined,
        })
      })
      .catch((err: Error) => {
        if (this.destroyed || this.epub !== epub) return
        console.warn('Failed to load pageList:', err)
        this.applyCanonicalPageEstimate()
      })
  }
  toggleResult(id: string) {
    if (this.searchTimer) {
      clearTimeout(this.searchTimer)
    }

    if (!this.results) return
    this.results = this.results.map((r) =>
      r.id === id ? { ...r, expanded: !r.expanded } : r,
    )
    this.searchVersion++
  }

  showPrevLocation() {
    this.locationToReturn = this.location
  }

  hidePrevLocation() {
    this.locationToReturn = undefined
  }

  mapSectionToNavItem(sectionHref: string) {
    let navItem: NavItem | undefined
    this.nav?.toc.forEach((item) =>
      dfs(item as NavItem, (i) => {
        if (compareHref(sectionHref, i.href)) navItem ??= i
      }),
    )
    return navItem
  }

  get currentHref() {
    return this.location?.start.href
  }

  get currentNavItem() {
    return this.section?.navitem
  }

  get view() {
    return this.rendition?.manager?.views._views[0]
  }

  getNavPath(navItem = this.currentNavItem) {
    const path: INavItem[] = []

    if (this.nav) {
      while (navItem) {
        path.unshift(navItem)
        const parentId = navItem.parent
        if (!parentId) {
          navItem = undefined
        } else {
          const index = this.nav.tocById[parentId]!
          navItem = this.nav.getByIndex(parentId, index, this.nav.toc)
        }
      }
    }

    return path
  }

  async searchInSection(
    keyword = this.keyword,
    section = this.section,
    signal?: AbortSignal,
  ) {
    if (!section || !keyword.trim() || !this.epub) return
    const searchSection = section.cloneForMeasurement()

    try {
      await searchSection.load(this.epub.load.bind(this.epub), signal)
      if (signal?.aborted) return
      const subitems = searchSection.find(keyword) as unknown as IMatch[]
      if (!subitems.length) return

      const navItem = section.navitem
      const path = navItem ? this.getNavPath(navItem) : []
      path.pop()
      return {
        // Some valid EPUBs have no TOC entry for a spine item. A match must
        // still be usable for full-book search in that case.
        id: navItem?.href ?? section.href,
        excerpt: navItem?.label ?? section.href,
        description: path.map((i) => i.label).join(' / '),
        subitems: subitems.map((i) => ({ ...i, id: i.cfi! })),
        expanded: false,
      }
    } catch (error) {
      if ((error as { name?: string })?.name === 'AbortError') return
      console.warn('Unable to search EPUB section', error)
    } finally {
      searchSection.destroy()
    }
  }

  search(keyword = this.keyword, signal?: AbortSignal) {
    // avoid blocking input
    return new Promise<IMatch[] | undefined>((resolve) => {
      requestIdleCallback(async () => {
        if (!keyword || signal?.aborted) {
          resolve(undefined)
          return
        }

        const results: IMatch[] = []

        for (const s of this.sections ?? []) {
          if (signal?.aborted) {
            resolve(undefined)
            return
          }
          const result = await this.searchInSection(keyword, s, signal)
          if (result) results.push(result)
        }

        resolve(results)
      })
    })
  }

  /**
   * Lazily index publication images when the gallery is opened. Each source
   * document is independent and becomes collectible before the next chapter,
   * preserving the memory fix that removed eager full-spine loading.
   */
  async ensureImageIndex() {
    if (
      this.imageIndexState === 'indexing' ||
      this.imageIndexState === 'ready'
    ) {
      return
    }
    const epub = this.epub
    const sections = this.sections
    if (!epub || !sections || this.destroyed) return

    this.imageIndexAbort?.abort()
    const controller = createUnproxiedAbortController()
    this.imageIndexAbort = controller
    this.imageIndexState = 'indexing'
    let failedSections = 0

    const yieldControl = () =>
      new Promise<void>((resolve) => {
        if (typeof requestIdleCallback === 'function') {
          requestIdleCallback(() => resolve(), { timeout: 100 })
        } else {
          setTimeout(resolve, 0)
        }
      })

    try {
      // Source indexing does not depend on blob/CSS replacement generation.
      // Start immediately: media-heavy books previously kept the gallery empty
      // until every unrelated asset URL completed.
      const indexing = indexPublicationImages({
        sections,
        assets: epub.resources.assets,
        resolvePublicationPath: (href) => epub.resolve(href, false),
        request: epub.load.bind(epub),
        signal: controller.signal,
        yieldControl,
        onSection: (section, images, completed, total) => {
          if (
            this.destroyed ||
            this.epub !== epub ||
            controller.signal.aborted
          ) {
            return
          }
          const indexedSection = section as ISection
          indexedSection.images = images
          // Publish useful results immediately and otherwise batch snapshots
          // so a long text-only book does not cause one React render per spine.
          if (images.length > 0 || completed === total || completed % 8 === 0) {
            this.sections = ref([...sections] as ISection[])
          }
        },
        onSectionError: (section, error) => {
          failedSections += 1
          console.warn(
            `Unable to index images in EPUB section ${section.index ?? '?'}`,
            error,
          )
        },
      })
      // Each expanded thumbnail can resolve its own archive URL. The gallery
      // must not remain in `indexing` merely because an unrelated font or CSS
      // replacement is slow or malformed.
      await indexing
      if (this.destroyed || this.epub !== epub || controller.signal.aborted) {
        return
      }
      this.sections = ref([...sections])
      this.imageIndexState =
        sections.length > 0 && failedSections === sections.length
          ? 'failed'
          : 'ready'
    } catch (error) {
      if ((error as { name?: string })?.name === 'AbortError') return
      if (!this.destroyed && this.epub === epub) {
        this.imageIndexState = 'failed'
        console.warn('Unable to index EPUB images:', error)
      }
    } finally {
      if (this.imageIndexAbort === controller) {
        this.imageIndexAbort = undefined
      }
    }
  }

  private _el?: HTMLDivElement
  onRender?: () => void
  async render(el: HTMLDivElement, width?: number, height?: number) {
    if (el === this._el && this.rendition) return
    this.destroyed = false
    this._el = ref(el)

    const file = await db?.files.get(this.book.id)
    if (!file || this.destroyed) return
    this.sourceFileRecord = ref(file)

    const epub = await fileToEpub(file.file)
    if (this.destroyed) {
      epub.destroy()
      return
    }
    this.epub = ref(epub)

    this.epub.loaded.navigation.then((nav) => {
      if (!this.destroyed && this.epub === epub) this.nav = nav
    })
    this.epub.loaded.spine.then((spine: any) => {
      if (this.destroyed || this.epub !== epub) return
      const sections = spine.spineItems as ISection[]
      // Keep the spine metadata available for navigation and search, but do
      // not preload every chapter DOM. Large books previously held every
      // source document in memory solely to estimate pages. The canonical
      // generator below processes one independent source document at a time.
      this.sections = ref(sections)
      this.epub!.loaded.navigation.then(() => {
        if (this.destroyed || this.epub !== epub) return
        sections.forEach((section) => {
          section.navitem = this.mapSectionToNavItem(section.href)
        })
      })

      this.prepareStablePageCount()
      this.calculatePageCount()
      void this.initializeCanonicalLocations(epub, file)
    })
    this.rendition = ref(
      this.epub.renderTo(el, {
        width: width || '100%',
        height: height || '100%',
        // EPUB files are user-provided HTML. Keep their iframe sandboxed and
        // never grant book scripts access to the extension context.
        allowScriptedContent: false,
        allowPopups: false,
      }),
    )
    this.rendition.themes.default(defaultStyle)
    this.rendition.hooks.render.register(() => {
      this.onRender?.()
    })

    this.rendition.on('relocated', (loc: Location) => {
      const start = loc.start
      if (!start?.cfi) return

      // A hidden tab is temporarily resized to 0x0. Its intermediate
      // `relocated` events must not overwrite the position of the visible
      // reader, but the first visible render must always be accepted.
      if (!this.active) return

      const previousRestoreCfi = this.readingLocationCfi
      this.lastReadingLocationCfi = start.cfi
      this.rendered = true
      this.timeline.unshift({
        location: loc,
        timestamp: Date.now(),
      })
      if (this.updateLayoutPagePosition(loc, true)) {
        this.clearLayoutAtlasPositionRetry()
      }

      // Persist the CFI immediately. Canonical position resolution is
      // asynchronous by design but must never delay restoration/sync fallback.
      const changes: Partial<BookRecord> = {}
      if (this.book.cfi !== start.cfi) changes.cfi = start.cfi

      if (!isRestoreLocationRecord(this.book.restoreLocation)) {
        const canonicalTimestamp =
          isSupportedCanonicalProgressRecord(this.book.canonicalProgress) &&
          this.book.canonicalProgress.position.cfi === start.cfi
            ? this.book.canonicalProgress.updatedAt
            : undefined
        changes.restoreLocation = {
          schemaVersion: 1,
          cfi: start.cfi,
          // Migrating an unchanged legacy CFI must not make an old location
          // look newer than actual reading performed on another device.
          updatedAt:
            previousRestoreCfi === start.cfi
              ? canonicalTimestamp ?? this.book.updatedAt ?? this.book.createdAt
              : Date.now(),
        }
      } else if (this.book.restoreLocation.cfi !== start.cfi) {
        changes.restoreLocation = {
          schemaVersion: 1,
          cfi: start.cfi,
          updatedAt: Date.now(),
        }
      }

      if (this.canonicalMetric && this.canonicalLocationIndex) {
        if (Object.keys(changes).length > 0) this.updateBook(changes)
        void this.updateCanonicalProgress(start.cfi, epub)
        return
      }

      // Legacy fallback while a canonical index is still being generated.
      if (this.sections && this.totalLength > 0) {
        const i = this.sections.findIndex((s) =>
          compareHref(s.href, start.href),
        )
        if (i < 0) {
          this.updateBook(changes)
          return
        }

        const previousSectionsLength = this.sections
          .slice(0, i)
          .reduce((acc, s) => acc + (s.length ?? 0), 0)
        const previousSectionsPercentage =
          previousSectionsLength / this.totalLength
        const currentSectionPercentage =
          (this.sections[i]!.length ?? 0) / this.totalLength
        const displayedPercentage = start.displayed.page / start.displayed.total

        let percentage =
          previousSectionsPercentage +
          currentSectionPercentage * displayedPercentage

        // If we are in the last section and at the last page, mark as finished (100%)
        if (
          i === this.sections.length - 1 &&
          start.displayed.page === start.displayed.total
        ) {
          percentage = 1
        }

        if (Number.isFinite(percentage)) {
          changes.percentage = Math.max(0, Math.min(1, percentage))
        }
      }

      this.updateBook(changes)
    })

    this.rendition.on('rendered', (section: ISection, view: any) => {
      this.section = ref(section)
      this.iframe = ref(view.window as Window)
    })

    // The visible BookPane owns the first display. It waits for a measurable
    // container and restores one snapshot of the CFI; starting a second display
    // here raced that restoration and briefly exposed an intermediate page.
  }

  constructor(public book: BookRecord) {
    super(book.id, book.name)

    // don't subscribe `db.books` in `constructor`, it will
    // 1. update the unproxied instance, which is not reactive
    // 2. update unnecessary state (e.g. percentage) of all tabs with the same book
  }
}

class PageTab extends BaseTab {
  constructor(public readonly Component: React.FC<any>) {
    super(Component.displayName ?? 'untitled')
  }
}

type Tab = BookTab | PageTab
type TabParam = ConstructorParameters<typeof BookTab | typeof PageTab>[0]

export class Group {
  id = uuidv4()
  tabs: Tab[] = []

  constructor(
    tabs: Array<Tab | TabParam> = [],
    public selectedIndex = tabs.length - 1,
  ) {
    this.tabs = tabs.map((t) => {
      if (t instanceof BookTab || t instanceof PageTab) return t
      const isPage = typeof t === 'function'
      return isPage ? new PageTab(t) : new BookTab(t)
    })
  }

  get selectedTab() {
    return this.tabs[this.selectedIndex]
  }

  get bookTabs() {
    return this.tabs.filter((t) => t instanceof BookTab) as BookTab[]
  }

  removeTab(index: number) {
    const tab = this.tabs.splice(index, 1)
    this.selectedIndex = updateIndex(this.tabs, index)
    return tab[0]
  }

  addTab(param: TabParam | Tab) {
    const isTab = param instanceof BookTab || param instanceof PageTab
    const isPage = typeof param === 'function'

    const id = isTab ? param.id : isPage ? param.displayName : param.id

    const index = this.tabs.findIndex((t) => t.id === id)
    if (index > -1) {
      this.selectTab(index)
      return this.tabs[index]
    }

    const tab = isTab ? param : isPage ? new PageTab(param) : new BookTab(param)

    this.tabs.splice(++this.selectedIndex, 0, tab)
    return tab
  }

  replaceTab(param: TabParam, index = this.selectedIndex) {
    this.addTab(param)
    return this.removeTab(index)
  }

  selectTab(index: number) {
    this.selectedIndex = index
  }
}

export class Reader {
  groups: Group[] = []
  focusedIndex = -1

  get focusedGroup() {
    return this.groups[this.focusedIndex]
  }

  get focusedTab() {
    return this.focusedGroup?.selectedTab
  }

  get focusedBookTab() {
    return this.focusedTab instanceof BookTab ? this.focusedTab : undefined
  }

  addTab(param: TabParam | Tab, groupIdx = this.focusedIndex) {
    let group = this.groups[groupIdx]
    if (group) {
      this.focusedIndex = groupIdx
    } else {
      group = this.addGroup([])
    }
    return group.addTab(param)
  }

  removeTab(index: number, groupIdx = this.focusedIndex, dispose = true) {
    const group = this.groups[groupIdx]
    if (group?.tabs.length === 1) {
      const tab = group.tabs[0]
      this.removeGroup(groupIdx, dispose)
      return tab
    }
    const tab = group?.removeTab(index)
    if (dispose) this.disposeTab(tab)
    return tab
  }

  replaceTab(
    param: TabParam,
    index = this.focusedIndex,
    groupIdx = this.focusedIndex,
  ) {
    const group = this.groups[groupIdx]
    const tab = group?.replaceTab(param, index)
    this.disposeTab(tab)
  }

  removeGroup(index: number, dispose = true) {
    const [group] = this.groups.splice(index, 1)
    if (dispose) group?.tabs.forEach((tab) => this.disposeTab(tab))
    this.focusedIndex = updateIndex(this.groups, index)
  }

  addGroup(tabs: Array<Tab | TabParam>, index = this.focusedIndex + 1) {
    const group = proxy(new Group(tabs))
    this.groups.splice(index, 0, group)
    this.focusedIndex = index
    return group
  }

  selectGroup(index: number) {
    this.focusedIndex = index
  }

  clear() {
    this.groups.forEach((group) =>
      group.tabs.forEach((tab) => this.disposeTab(tab)),
    )
    this.groups = []
    this.focusedIndex = -1
  }

  private disposeTab(tab?: Tab) {
    if (tab instanceof BookTab) tab.destroy()
  }

  resize() {
    this.groups.forEach(({ bookTabs }) => {
      bookTabs.forEach(({ rendition }) => {
        try {
          if (rendition?.manager) {
            rendition.resize()
          }
        } catch (error) {
          console.error('Error resizing rendition:', error)
        }
      })
    })
  }
}

export const reader = proxy(new Reader())

export function useReaderSnapshot() {
  return useSnapshot(reader)
}

declare global {
  interface Window {
    reader?: Reader
  }
}

if (!IS_SERVER && process.env.NODE_ENV === 'development') {
  window.reader = reader
}

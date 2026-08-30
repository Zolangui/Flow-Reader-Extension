import { IS_SERVER } from '@literal-ui/hooks'
import Dexie, { Table } from 'dexie'

import type {
  CanonicalContentModel,
  CanonicalLocationIndex,
  CanonicalPosition,
  LayoutAtlas,
  PackagingMetadataObject,
  ProgressMetricConfiguration,
  ProgressMetricSnapshot,
} from '@flow/epubjs'
import {
  CANONICAL_MODEL_VERSION,
  LOCATION_INDEX_ALGORITHM_ID,
  LOCATION_INDEX_ALGORITHM_VERSION,
  PROGRESS_METRIC_ALGORITHM_ID,
  PROGRESS_METRIC_ALGORITHM_VERSION,
  resolveProgressMetricConfiguration,
} from '@flow/epubjs'

import { Annotation } from './annotation'
import { fileToEpub } from './lib/epub-file'
import { TypographyConfiguration } from './state'

export interface FileRecord {
  id: string
  file: File
  /** SHA-256 of the EPUB bytes, lazily backfilled for existing records. */
  publicationRevision?: string
}

export interface CoverRecord {
  id: string
  cover: string | null
}

export interface ChatMessageRecord {
  role: 'user' | 'assistant'
  content: string
  id: string
}

export interface ChatSessionRecord {
  id: string
  title?: string
  messages: ChatMessageRecord[]
  createdAt: number
  updatedAt: number
}

export interface PageCountLayoutSample {
  characters: number
  pages: number
}

export interface PageCountLayoutRecord {
  pageCount: number
  samples: Record<string, PageCountLayoutSample>
  updatedAt: number
}

/**
 * What a displayed total represents. Reflowable EPUBs do not have one
 * universal screen-page count, so consumers must never silently treat these
 * sources as interchangeable.
 */
export type PageCountSource =
  | 'calculating'
  | 'publisher-page-list'
  | 'fixed-layout-model'
  | 'canonical-estimate'
  /** @deprecated Legacy preview value; visual totals now live only in layoutAtlases. */
  | 'layout-atlas'

/**
 * Identifies the publication and algorithms behind a canonical metric. Two
 * EPUB revisions can coincidentally have the same unit total, so historical
 * reading segments must not use that number as their only identity.
 */
export interface LegacyCanonicalMetricIdentity {
  schemaVersion: 1
  publicationRevision: string
  canonicalModelVersion: number
  locationAlgorithmId: string
  locationAlgorithmVersion: number
  markerCodePointInterval: number
  progressMetricConfigurationFingerprint: string
}

export interface CurrentCanonicalMetricIdentity {
  schemaVersion: 2
  publicationRevision: string
  canonicalModelVersion: number
  progressMetricAlgorithmId: string
  progressMetricAlgorithmVersion: number
  progressMetricConfigurationFingerprint: string
}

export type CanonicalMetricIdentity =
  | LegacyCanonicalMetricIdentity
  | CurrentCanonicalMetricIdentity

/** A durable reading fact, independent from local screen-page layouts. */
export interface CanonicalProgressRecord {
  schemaVersion: 1
  position: CanonicalPosition
  metric: ProgressMetricSnapshot
  /** Absent only on canonical records written by the first preview build. */
  metricIdentity?: CanonicalMetricIdentity
  updatedAt: number
}

/**
 * The last place the user chose to view, including navigable `linear="no"`
 * content. It is deliberately separate from reading-order progress.
 */
export interface RestoreLocationRecord {
  schemaVersion: 1
  cfi: string
  updatedAt: number
}

/**
 * Local-only canonical source data. It is regenerated from the EPUB and is
 * intentionally excluded from Dropbox and backup book payloads.
 */
export interface CanonicalLocationIndexRecord {
  schemaVersion: 1
  bookId: string
  /** Invalidates the local cache when the locally stored file changes. */
  revision: string
  index: CanonicalLocationIndex
  models: CanonicalContentModel[]
  progressMetricConfiguration?: ProgressMetricConfiguration
  createdAt: number
  updatedAt: number
}

/**
 * A renderer-local visual pagination result. Unlike canonical progress, an
 * atlas is intentionally never synced or exported: font metrics, browser
 * layout and the viewport are part of its identity.
 */
export interface LayoutAtlasRecord {
  schemaVersion: 1
  bookId: string
  revision: string
  fingerprintKey: string
  atlas: LayoutAtlas
  createdAt: number
  updatedAt: number
}

const localFileRevisionCache = new WeakMap<File, Promise<string>>()
const UNCACHEABLE_FILE_REVISION_PREFIX = '["lumen-uncacheable-file-v1",'

function uncacheableFileRevision(file: File): string {
  // Metadata alone is not a publication identity. On the very rare platform
  // without Web Crypto, prefer regenerating this local cache after a reload
  // to accidentally reusing an index for different EPUB bytes.
  return JSON.stringify([
    'lumen-uncacheable-file-v1',
    file.name,
    file.size,
    file.lastModified,
    file.type,
    Date.now(),
    Math.random(),
  ])
}

/**
 * A fallback revision is scoped to the current in-memory File only. Caches
 * keyed by it cannot be reused after a reload, so callers should avoid adding
 * those records to IndexedDB in the first place.
 */
export function isCacheableLocalFileRevision(revision: string): boolean {
  return !revision.startsWith(UNCACHEABLE_FILE_REVISION_PREFIX)
}

/**
 * A canonical index is valid only for the exact EPUB bytes that produced it.
 * Web Crypto runs asynchronously, so hashing does not block the reader thread.
 * Without it the result is deliberately uncacheable across reloads instead of
 * mistaking metadata for an exact publication identity.
 */
export function localFileRevision(file: File): Promise<string> {
  const cached = localFileRevisionCache.get(file)
  if (cached) return cached

  const fallback = uncacheableFileRevision(file)
  const subtle = globalThis.crypto?.subtle
  const revision = subtle
    ? file
        .arrayBuffer()
        .then((bytes) => subtle.digest('SHA-256', bytes))
        .then((digest) => {
          const hex = Array.from(new Uint8Array(digest), (byte) =>
            byte.toString(16).padStart(2, '0'),
          ).join('')
          return `lumen-file-sha256-v1:${hex}`
        })
        .catch(() => fallback)
    : Promise.resolve(fallback)

  localFileRevisionCache.set(file, revision)
  return revision
}

/** Hash once, then persist the exact byte revision beside the local File. */
export async function localFileRecordRevision(
  record: FileRecord,
): Promise<string> {
  if (
    record.publicationRevision &&
    isCacheableLocalFileRevision(record.publicationRevision)
  ) {
    return record.publicationRevision
  }

  const revision = await localFileRevision(record.file)
  if (isCacheableLocalFileRevision(revision)) {
    const current = await db?.files.get(record.id)
    if (
      current &&
      current.file.name === record.file.name &&
      current.file.size === record.file.size &&
      current.file.lastModified === record.file.lastModified &&
      current.file.type === record.file.type
    ) {
      await db?.files.update(record.id, { publicationRevision: revision })
    }
  }
  return revision
}

export interface BookRecord {
  // TODO: use file hash as id
  id: string
  name: string
  size: number
  metadata: PackagingMetadataObject
  createdAt: number
  updatedAt?: number
  cfi?: string
  restoreLocation?: RestoreLocationRecord
  percentage?: number
  /**
   * A sync-safe total only. A publisher page-list is a citation count and the
   * canonical estimate is deliberately approximate. Exact visual totals are
   * held in the local `layoutAtlases` table and on the active BookTab.
   */
  pageCount?: number
  pageCountSource?: PageCountSource
  pageCountEstimated?: boolean // Kept for compatibility with existing UI/data.
  pageCountLayoutKey?: string
  pageCountLayouts?: Record<string, PageCountLayoutRecord>
  canonicalProgress?: CanonicalProgressRecord
  locations?: string // Serialized EPUB.js locations JSON for CFI→page mapping
  annotations: Annotation[]
  configuration?: {
    typography?: TypographyConfiguration
  }
  favorite?: boolean
  position?: number
  aiPersona?: string
  chatHistory?: ChatMessageRecord[]
  chatSessions?: ChatSessionRecord[]
  activeChatId?: string
}

export class DB extends Dexie {
  // 'books' is added by dexie when declaring the stores()
  // We just tell the typing system this is the case
  files!: Table<FileRecord>
  covers!: Table<CoverRecord>
  books!: Table<BookRecord>
  vectors!: Table<VectorRecord>
  canonicalLocationIndices!: Table<CanonicalLocationIndexRecord>
  layoutAtlases!: Table<LayoutAtlasRecord, [string, string, string]>
  indices!: Table<{
    bookId: string
    kind: 'chunks' | 'chapters'
    data: string
    dim?: number
    model?: string
    version?: number
    ragVersion?: string
    locale?: string
  }>

  constructor(name: string) {
    super(name)

    // Versions reordered to appear chronologically at the end

    // Layout Atlases are cache entries keyed by the exact EPUB bytes and the
    // complete renderer fingerprint. They deliberately live in their own
    // local-only table instead of BookRecord, which is part of sync/backups.
    this.version(18).stores({
      layoutAtlases:
        '[bookId+revision+fingerprintKey], bookId, revision, fingerprintKey, updatedAt',
    })

    // Lumen Location Engine: a local-only cache. BookRecord's canonical
    // position is unindexed and remains additive for existing users.
    this.version(17).stores({
      canonicalLocationIndices: 'bookId, revision, updatedAt',
    })

    // SOTA v7.2: Add ragVersion for explicit index compatibility checks
    this.version(16).stores({
      indices: '[bookId+kind], bookId, ragVersion',
    })

    // SOTA v6.3: Clean Migration for Indices (Fixes SchemaError)
    // 2. Re-create with correct compound primary key AND individual indices for fallback queries
    this.version(15).stores({
      indices: '[bookId+kind], bookId',
    })

    // 1. Drop the table first to remove old schema conflicts (Nuclear Option)
    this.version(14).stores({
      indices: null,
    })

    this.version(13).stores({
      books:
        'id, name, size, metadata, createdAt, updatedAt, cfi, percentage, pageCount, pageCountEstimated, locations, definitions, annotations, configuration, favorite, position',
      files: 'id',
      covers: 'id',
      vectors: 'id, bookId, [bookId+index]',
      indices: '[bookId+kind], bookId', // support multiple indices (chunks, chapters) per book
    })

    // Intermediate version to drop the old 'indices' table (allows changing PK)
    this.version(12).stores({
      indices: null,
    })

    this.version(11).stores({
      books:
        'id, name, size, metadata, createdAt, updatedAt, cfi, percentage, pageCount, pageCountEstimated, locations, definitions, annotations, configuration, favorite, position',
      files: 'id',
      covers: 'id',
      vectors: 'id, bookId, [bookId+index]',
      indices: 'bookId', // Store serialized Voyager index (Uint8Array)
    })

    this.version(10).stores({
      books:
        'id, name, size, metadata, createdAt, updatedAt, cfi, percentage, pageCount, pageCountEstimated, locations, definitions, annotations, configuration, favorite, position',
      files: 'id',
      covers: 'id',
      vectors: 'id, bookId, [bookId+index]',
      indices: 'bookId', // Store serialized Voyager index (Uint8Array)
    })

    // Kept for reference/history - this version was flawed (missing books)
    this.version(9).stores({
      vectors: 'id, bookId, [bookId+index]',
      files: 'id',
      covers: 'id',
    })

    this.version(8).stores({
      books:
        'id, name, size, metadata, createdAt, updatedAt, cfi, percentage, pageCount, pageCountEstimated, locations, definitions, annotations, configuration, favorite, position',
      files: 'id',
      covers: 'id',
    })

    this.version(7).stores({
      books:
        'id, name, size, metadata, createdAt, updatedAt, cfi, percentage, pageCount, pageCountEstimated, locations, definitions, annotations, configuration, favorite',
    })

    this.version(6).stores({
      books:
        'id, name, size, metadata, createdAt, updatedAt, cfi, percentage, pageCount, pageCountEstimated, locations, definitions, annotations, configuration',
    })

    this.version(5).stores({
      books:
        'id, name, size, metadata, createdAt, updatedAt, cfi, percentage, definitions, annotations, configuration',
    })

    this.version(4)
      .stores({
        books:
          'id, name, size, metadata, createdAt, updatedAt, cfi, percentage, definitions, annotations',
      })
      .upgrade(async (t) => {
        t.table('books')
          .toCollection()
          .modify((r) => {
            r.annotations = []
          })
      })

    this.version(3)
      .stores({
        books:
          'id, name, size, metadata, createdAt, updatedAt, cfi, percentage, definitions',
      })
      .upgrade(async (t) => {
        const files = await t.table('files').toArray()

        const metadatas = await Dexie.waitFor(
          Promise.all(
            files.map(async ({ file }) => {
              const epub = await fileToEpub(file)
              return epub.loaded.metadata
            }),
          ),
        )

        return t
          .table('books')
          .toCollection()
          .modify(async (r) => {
            const i = files.findIndex((f) => f.id === r.id)
            r.metadata = metadatas[i]
            r.size = files[i].file.size
          })
          .catch((e) => {
            console.error(e)
            throw e
          })
      })
    this.version(2)
      .stores({
        books: 'id, name, createdAt, cfi, percentage, definitions',
      })
      .upgrade(async (t) => {
        const books = await t.table('books').toArray()
        ;['covers', 'files'].forEach((tableName) => {
          t.table(tableName)
            .toCollection()
            .modify((r) => {
              const book = books.find((b) => b.name === r.id)
              if (book) r.id = book.id
            })
        })
      })

    this.version(1).stores({
      books: 'id, name, createdAt, cfi, percentage, definitions', // Primary key and indexed props
      covers: 'id, cover',
      files: 'id, file',
    })
  }
}

export interface VectorRecord {
  id: string // uuid
  bookId: string
  content: string
  embedding?: number[] | Float32Array
  index: number // chunk index
  metadata?: any
}

/** Reject stale or partially written local canonical caches before activation. */
export function isCurrentCanonicalLocationIndexRecord(
  value: unknown,
  bookId: string,
  revision: string,
): value is CanonicalLocationIndexRecord {
  if (!value || typeof value !== 'object') return false
  const record = value as CanonicalLocationIndexRecord
  if (
    record.schemaVersion !== 1 ||
    record.bookId !== bookId ||
    record.revision !== revision ||
    record.index?.canonicalModelVersion !== CANONICAL_MODEL_VERSION ||
    record.index?.algorithmId !== LOCATION_INDEX_ALGORITHM_ID ||
    record.index?.algorithmVersion !== LOCATION_INDEX_ALGORITHM_VERSION ||
    !Number.isInteger(record.index.markerCodePointInterval) ||
    record.index.markerCodePointInterval <= 0 ||
    !Array.isArray(record.index.sections) ||
    !Array.isArray(record.models) ||
    record.index.sections.length !== record.models.length
  ) {
    return false
  }

  let metricConfiguration
  try {
    metricConfiguration = resolveProgressMetricConfiguration(
      record.progressMetricConfiguration,
    )
  } catch (_error) {
    return false
  }
  if (
    metricConfiguration.algorithmId !== PROGRESS_METRIC_ALGORITHM_ID ||
    metricConfiguration.algorithmVersion !== PROGRESS_METRIC_ALGORITHM_VERSION
  ) {
    return false
  }

  return record.models.every((model, index) => {
    const section = record.index.sections[index]
    return (
      model.canonicalModelVersion === CANONICAL_MODEL_VERSION &&
      Number.isInteger(model.spineIndex) &&
      model.spineIndex >= 0 &&
      !!model.resourceHref &&
      Array.isArray(model.segments) &&
      section?.spineIndex === model.spineIndex &&
      section.spineItemId === model.spineItemId &&
      section.resourceHref === model.resourceHref &&
      section.totalCodePoints === model.totalCodePoints &&
      section.segmentCount === model.segments.length
    )
  })
}

/** Prefer the newest canonical reading fact without overwriting old clients. */
export function mergeCanonicalProgress(
  local?: CanonicalProgressRecord,
  incoming?: CanonicalProgressRecord,
): CanonicalProgressRecord | undefined {
  const supportedLocal = isSupportedCanonicalProgressRecord(local)
    ? local
    : undefined
  const supportedIncoming = isSupportedCanonicalProgressRecord(incoming)
    ? incoming
    : undefined
  if (!supportedLocal) return supportedIncoming
  if (!supportedIncoming) return supportedLocal
  return supportedIncoming.updatedAt >= supportedLocal.updatedAt
    ? supportedIncoming
    : supportedLocal
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object'
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

export function isSupportedCanonicalPosition(
  value: unknown,
): value is CanonicalPosition {
  if (!isRecord(value)) return false
  if (
    value.canonicalModelVersion !== CANONICAL_MODEL_VERSION ||
    !Number.isInteger(value.spineIndex) ||
    Number(value.spineIndex) < 0 ||
    !isNonEmptyString(value.resourceHref) ||
    !isNonEmptyString(value.segmentId) ||
    !isNonEmptyString(value.cfi) ||
    (value.spineItemId !== undefined && !isNonEmptyString(value.spineItemId))
  ) {
    return false
  }

  if (value.kind === 'text') {
    return (
      Number.isInteger(value.codePointOffset) &&
      Number(value.codePointOffset) >= 0 &&
      Number.isInteger(value.domUtf16Offset) &&
      Number(value.domUtf16Offset) >= 0 &&
      typeof value.isCodePointBoundary === 'boolean'
    )
  }
  if (value.kind === 'atomic') {
    return (
      Number.isInteger(value.atomIndex) &&
      Number(value.atomIndex) >= 0 &&
      (value.edge === 'before' || value.edge === 'after')
    )
  }
  return (
    value.kind === 'media' &&
    isFiniteNonNegative(value.mediaOffsetSeconds) &&
    (value.edge === 'before' || value.edge === 'after')
  )
}

export function isSupportedProgressMetricSnapshot(
  value: unknown,
): value is ProgressMetricSnapshot {
  if (!isRecord(value)) return false
  return (
    value.algorithmId === PROGRESS_METRIC_ALGORITHM_ID &&
    value.algorithmVersion === PROGRESS_METRIC_ALGORITHM_VERSION &&
    Number.isInteger(value.completedUnits) &&
    Number(value.completedUnits) >= 0 &&
    Number.isInteger(value.totalUnits) &&
    Number(value.totalUnits) >= 0 &&
    Number(value.completedUnits) <= Number(value.totalUnits)
  )
}

export function isSupportedCanonicalProgressRecord(
  value: unknown,
): value is CanonicalProgressRecord {
  if (!isRecord(value)) return false
  const identity = value.metricIdentity
  const validLegacyIdentity =
    isRecord(identity) &&
    identity.schemaVersion === 1 &&
    isNonEmptyString(identity.publicationRevision) &&
    identity.canonicalModelVersion === CANONICAL_MODEL_VERSION &&
    identity.locationAlgorithmId === LOCATION_INDEX_ALGORITHM_ID &&
    identity.locationAlgorithmVersion === LOCATION_INDEX_ALGORITHM_VERSION &&
    Number.isInteger(identity.markerCodePointInterval) &&
    Number(identity.markerCodePointInterval) > 0 &&
    typeof identity.progressMetricConfigurationFingerprint === 'string'
  const validCurrentIdentity =
    isRecord(identity) &&
    identity.schemaVersion === 2 &&
    isNonEmptyString(identity.publicationRevision) &&
    identity.canonicalModelVersion === CANONICAL_MODEL_VERSION &&
    identity.progressMetricAlgorithmId === PROGRESS_METRIC_ALGORITHM_ID &&
    identity.progressMetricAlgorithmVersion ===
      PROGRESS_METRIC_ALGORITHM_VERSION &&
    typeof identity.progressMetricConfigurationFingerprint === 'string'
  const validIdentity =
    identity === undefined || validLegacyIdentity || validCurrentIdentity

  return (
    value.schemaVersion === 1 &&
    isSupportedCanonicalPosition(value.position) &&
    isSupportedProgressMetricSnapshot(value.metric) &&
    validIdentity &&
    isFiniteNonNegative(value.updatedAt)
  )
}

export function isRestoreLocationRecord(
  value: unknown,
): value is RestoreLocationRecord {
  return (
    isRecord(value) &&
    value.schemaVersion === 1 &&
    isNonEmptyString(value.cfi) &&
    isFiniteNonNegative(value.updatedAt)
  )
}

function legacyRestoreLocation(
  book?: BookRecord,
): RestoreLocationRecord | undefined {
  if (!book) return undefined
  if (isRestoreLocationRecord(book.restoreLocation)) return book.restoreLocation
  if (!isNonEmptyString(book.cfi)) return undefined
  return {
    schemaVersion: 1,
    cfi: book.cfi,
    updatedAt: isFiniteNonNegative(book.updatedAt)
      ? book.updatedAt
      : book.createdAt,
  }
}

export function mergeRestoreLocation(
  local?: BookRecord,
  incoming?: BookRecord,
): RestoreLocationRecord | undefined {
  const localLocation = legacyRestoreLocation(local)
  const incomingLocation = legacyRestoreLocation(incoming)
  if (!localLocation) return incomingLocation
  if (!incomingLocation) return localLocation
  return incomingLocation.updatedAt >= localLocation.updatedAt
    ? incomingLocation
    : localLocation
}

/**
 * Remote/backup BookRecords do not carry local index caches. Preserve the
 * newest synchronized canonical position while allowing normal metadata to
 * follow the incoming record.
 */
export function mergeIncomingBookRecord(
  local: BookRecord | undefined,
  incoming: BookRecord,
): BookRecord {
  const canonicalProgress = mergeCanonicalProgress(
    local?.canonicalProgress,
    incoming.canonicalProgress,
  )
  const restoreLocation = mergeRestoreLocation(local, incoming)
  const merged: BookRecord = { ...incoming }

  if (restoreLocation) {
    merged.restoreLocation = restoreLocation
    // Keep the legacy field as a downgrade-compatible mirror only.
    merged.cfi = restoreLocation.cfi
  }

  if (canonicalProgress) {
    merged.canonicalProgress = canonicalProgress
    merged.percentage =
      canonicalProgress.metric.totalUnits > 0
        ? Math.max(
            0,
            Math.min(
              1,
              canonicalProgress.metric.completedUnits /
                canonicalProgress.metric.totalUnits,
            ),
          )
        : 0
  } else {
    // Preserve opaque future-version data without interpreting it. A client
    // that does not understand the record must neither derive percentage
    // from it nor erase it during a same-format sync merge.
    merged.canonicalProgress =
      local.canonicalProgress ?? incoming.canonicalProgress
  }

  return merged
}

const isExport = process.env.NEXT_PUBLIC_IS_EXPORT === 'true'

export const db = IS_SERVER && !isExport ? null : new DB('re-reader')

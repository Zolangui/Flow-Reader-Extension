import { IS_SERVER } from '@literal-ui/hooks'
import Dexie, { Table } from 'dexie'

import { PackagingMetadataObject } from '@flow/epubjs/types/packaging'

import { Annotation } from './annotation'
import { fileToEpub } from './file'
import { TypographyConfiguration } from './state'

export interface FileRecord {
  id: string
  file: File
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

export interface BookRecord {
  // TODO: use file hash as id
  id: string
  name: string
  size: number
  metadata: PackagingMetadataObject
  createdAt: number
  updatedAt?: number
  cfi?: string
  percentage?: number
  pageCount?: number // Total page count (from pageList or locations.length())
  pageCountEstimated?: boolean // True if estimate, false if precise
  locations?: string // Serialized EPUB.js locations JSON for CFI→page mapping
  definitions: string[]
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


    // SOTA v7.2: Add ragVersion for explicit index compatibility checks
    this.version(16).stores({
      indices: '[bookId+kind], bookId, ragVersion'
    })

    // SOTA v6.3: Clean Migration for Indices (Fixes SchemaError)
    // 2. Re-create with correct compound primary key AND individual indices for fallback queries
    this.version(15).stores({
      indices: '[bookId+kind], bookId'
    })

    // 1. Drop the table first to remove old schema conflicts (Nuclear Option)
    this.version(14).stores({
      indices: null
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
      indices: null
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

const isExport = process.env.NEXT_PUBLIC_IS_EXPORT === 'true'

export const db = IS_SERVER && !isExport ? null : new DB('re-reader')

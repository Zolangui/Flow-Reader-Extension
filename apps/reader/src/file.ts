import { v4 as uuidv4 } from 'uuid'

import type { Book } from '@flow/epubjs'

import {
  BookRecord,
  db,
  isCacheableLocalFileRevision,
  localFileRevision,
} from './db'
import { fileToEpub, readBlob } from './lib/epub-file'
import { mapExtToMimes } from './mime'
import { unpack } from './sync'

export { fileToEpub, readBlob } from './lib/epub-file'

export async function handleFiles(files: Iterable<File>) {
  const books = await db?.books.toArray()
  const newBooks = []

  for (const file of files) {
    console.log(file)

    if (mapExtToMimes['.zip'].includes(file.type)) {
      unpack(file)
      continue
    }

    if (!mapExtToMimes['.epub'].includes(file.type)) {
      console.error(`Unsupported file type: ${file.type}`)
      continue
    }

    let book = books?.find((b) => b.name === file.name)

    if (!book) {
      book = await addBook(file)
    }

    newBooks.push(book)
  }

  return newBooks
}

export async function addBook(file: File) {
  const epub = await fileToEpub(file)
  const metadata = await epub.loaded.metadata

  const book: BookRecord = {
    id: uuidv4(),
    name: file.name || `${metadata.title}.epub`,
    size: file.size,
    metadata,
    createdAt: Date.now(),
    annotations: [],
  }
  await db?.books.add(book)
  await addFile(book.id, file, epub)
  return book
}

export async function addFile(id: string, file: File, epub?: Book) {
  const revisionPromise = localFileRevision(file)
  let openedBook = epub
  let manualCoverUrl: string | undefined

  try {
    if (!openedBook) {
      openedBook = await fileToEpub(file)
    }

    const revision = await revisionPromise
    await db?.files.add({
      id,
      file,
      ...(isCacheableLocalFileRevision(revision)
        ? { publicationRevision: revision }
        : {}),
    })

    let url = await openedBook.coverUrl()

    // Fallback: Try to find cover manually if epub.js fails
    if (!url && (openedBook.archive as any)?.zip) {
      console.warn('epub.coverUrl() failed, attempting manual fallback...')
      const zip = (openedBook.archive as any).zip
      const files = Object.keys(zip.files)
      // Common cover filenames
      const coverCandidates = [
        'cover.jpg',
        'cover.jpeg',
        'cover.png',
        'OEBPS/cover.jpg',
        'OPS/cover.jpg',
      ]

      // 1. Try exact candidates
      let match = coverCandidates.find((c) => files.includes(c))

      // 2. Try fuzzy match for "cover" + image extension
      if (!match) {
        match = files.find(
          (f) =>
            f.toLowerCase().includes('cover') && /\.(jpg|jpeg|png)$/i.test(f),
        )
      }

      if (match) {
        console.log(`Found cover via fallback: ${match}`)
        const coverFile = zip.file(match)
        if (coverFile) {
          const blob = await coverFile.async('blob')
          manualCoverUrl = URL.createObjectURL(blob)
          url = manualCoverUrl
        }
      }
    }

    const cover = url && (await toDataUrl(url))
    await db?.covers.add({ id, cover })
  } finally {
    if (manualCoverUrl) URL.revokeObjectURL(manualCoverUrl)
    openedBook?.destroy()
  }
}

async function toDataUrl(url: string) {
  const res = await fetch(url)
  const buffer = await res.blob()
  return readBlob((r) => r.readAsDataURL(buffer))
}

export async function fetchBook(url: string) {
  const filename = decodeURIComponent(/\/([^/]*\.epub)$/i.exec(url)?.[1] ?? '')
  const books = await db?.books.toArray()
  const book = books?.find((b) => b.name === filename)

  return (
    book ??
    fetch(url)
      .then((res) => res.blob())
      .then((blob) => addBook(new File([blob], filename)))
  )
}

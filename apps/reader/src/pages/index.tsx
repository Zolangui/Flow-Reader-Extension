import { useLiveQuery } from 'dexie-react-hooks'
import { saveAs } from 'file-saver'
import Head from 'next/head'
import { useRouter } from 'next/router'
import React, { useEffect, useState, useRef } from 'react'
import { usePrevious } from 'react-use'

import { BookDetailsModal } from '../components/BookDetailsModal'
import { LibraryView } from '../components/LibraryView'
import { ReaderGridView } from '../components/Reader'
import { BookRecord, db, mergeIncomingBookRecord } from '../db'
import { addFile, fetchBook, handleFiles } from '../file'
import {
  useDisablePinchZooming,
  useLibrary,
  useRemoteBooks,
  useRemoteFiles,
} from '../hooks'
import { reader, useReaderSnapshot } from '../models'
import { downloadDropboxFile, queueBooksUpload } from '../sync'

const SOURCE = 'src'

export default function Index() {
  const { focusedTab } = useReaderSnapshot()
  const router = useRouter()
  const src = new URL(window.location.href).searchParams.get(SOURCE)
  const [loading, setLoading] = useState(!!src)

  useDisablePinchZooming()

  useEffect(() => {
    let src = router.query[SOURCE]
    if (!src) return
    if (!Array.isArray(src)) src = [src]

    Promise.all(
      src.map((s: string) =>
        fetchBook(s).then((b: any) => {
          reader.addTab(b)
        }),
      ),
    ).finally(() => setLoading(false))
  }, [router.query])

  useEffect(() => {
    if ('launchQueue' in window && 'LaunchParams' in window) {
      window.launchQueue.setConsumer((params) => {
        console.log('launchQueue', params)
        if (params.files.length) {
          Promise.all(params.files.map((f) => f.getFile()))
            .then((files) => handleFiles(files))
            .then((books) => books.forEach((b) => reader.addTab(b)))
        }
      })
    }
  }, [])

  useEffect(() => {
    router.beforePopState(({ url }: { url: string }) => {
      if (url === '/') {
        reader.clear()
      }
      return true
    })
  }, [router])

  return (
    <>
      <Head>
        {/* https://github.com/microsoft/vscode/blob/36fdf6b697cba431beb6e391b5a8c5f3606975a1/src/vs/code/browser/workbench/workbench.html#L16 */}
        {/* Disable pinch zooming */}
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1.0, maximum-scale=1.0, minimum-scale=1.0, user-scalable=no"
        />
        <title>{focusedTab?.title ?? 'Lumen Read'}</title>
      </Head>
      <ReaderGridView />
      {loading || <Library />}
    </>
  )
}

const Library: React.FC = () => {
  const books = useLibrary()
  const covers = useLiveQuery(() => db?.covers.toArray() ?? [])
  const fileInputRef = useRef<HTMLInputElement>(null)

  const { data: remoteBooks, mutate: mutateRemoteBooks } = useRemoteBooks()
  const { data: remoteFiles } = useRemoteFiles()
  const previousRemoteBooks = usePrevious(remoteBooks)
  const previousRemoteFiles = usePrevious(remoteFiles)

  const [, setLoading] = useState<string | undefined>()
  const [readyToSync, setReadyToSync] = useState(false)
  const [detailsBook, setDetailsBook] = useState<BookRecord | null>(null)

  const { groups } = useReaderSnapshot()

  useEffect(() => {
    if (previousRemoteFiles && remoteFiles) {
      // to remove effect dependency `books`
      db?.books.toArray().then((books) => {
        if (books.length === 0) return

        const newRemoteBooks = remoteFiles
          .map((f: any) => books.find((b) => b.name === f.name))
          .filter((book): book is BookRecord => Boolean(book))

        void queueBooksUpload(newRemoteBooks)
        mutateRemoteBooks(newRemoteBooks, { revalidate: false })
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mutateRemoteBooks, remoteFiles])

  useEffect(() => {
    if (!previousRemoteBooks && remoteBooks) {
      db?.transaction('rw', db.books, async () => {
        for (const remoteBook of remoteBooks) {
          const localBook = await db.books.get(remoteBook.id)
          await db.books.put(mergeIncomingBookRecord(localBook, remoteBook))
        }
      }).then(() => setReadyToSync(true))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remoteBooks])

  useEffect(() => {
    if (!remoteFiles || !readyToSync) return

    db?.books.toArray().then(async (books) => {
      for (const remoteFile of remoteFiles) {
        const book = books.find((b) => b.name === remoteFile.name)
        if (!book) continue

        const file = await db?.files.get(book.id)
        if (file) continue

        setLoading(book.id)
        await downloadDropboxFile(`/files/${remoteFile.name}`).then((d) => {
          const blob: Blob = (d.result as any).fileBlob
          return addFile(book.id, new File([blob], book.name))
        })
        setLoading(undefined)
      }
    })
  }, [readyToSync, remoteFiles])

  const handleToggleFavorite = async (book: BookRecord) => {
    await db?.books.update(book.id, { favorite: !book.favorite })
  }

  const handleDownload = async (book: BookRecord) => {
    const fileRecord = await db?.files.get(book.id)
    if (fileRecord) {
      saveAs(fileRecord.file, `${book.name}.epub`)
    }
  }

  const handleRemove = async (book: BookRecord) => {
    console.log('Attempting to remove book:', book.id, book.name)
    // Removed confirm dialog as it was causing issues.
    // TODO: Implement a better confirmation UI (modal or double-click)
    try {
      await Promise.all([
        db?.books.delete(book.id),
        db?.files.delete(book.id),
        db?.covers.delete(book.id),
        // These are local derivations of the deleted EPUB, never reusable by
        // a future book that happens to receive the same library ID.
        db?.canonicalLocationIndices.delete(book.id),
        db?.layoutAtlases.where('bookId').equals(book.id).delete(),
      ])
      console.log('Book removed successfully')
    } catch (error) {
      console.error('Failed to remove book:', error)
    }
  }

  const handleViewDetails = (book: BookRecord) => {
    setDetailsBook(book)
  }

  if (groups.length) return null
  if (!books) return null

  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        accept="application/epub+zip,application/epub,application/zip"
        className="hidden"
        onChange={(e) => {
          const files = e.target.files
          if (files) handleFiles(files)
        }}
        multiple
      />
      <LibraryView
        books={books}
        covers={covers || []}
        onAddBook={() => fileInputRef.current?.click()}
        onBookClick={(book: BookRecord) => reader.addTab(book)}
        onDrop={(e) => {
          const bookId = e.dataTransfer.getData('text/plain')
          const book = books.find((b) => b.id === bookId)
          if (book) reader.addTab(book)

          handleFiles(e.dataTransfer.files)
        }}
        onToggleFavorite={handleToggleFavorite}
        onDownload={handleDownload}
        onRemove={handleRemove}
        onViewDetails={handleViewDetails}
      />
      {detailsBook && (
        <BookDetailsModal
          book={detailsBook}
          cover={covers?.find((cover) => cover.id === detailsBook.id)?.cover}
          onClose={() => setDetailsBook(null)}
          onRead={(book) => {
            setDetailsBook(null)
            reader.addTab(book)
          }}
        />
      )}
    </>
  )
}

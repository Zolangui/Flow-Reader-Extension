import { useCallback, useEffect } from 'react'
import { useSnapshot } from 'valtio'

import { Annotation } from '@flow/reader/annotation'
import {
  BookRecord,
  isRestoreLocationRecord,
  isSupportedCanonicalProgressRecord,
} from '@flow/reader/db'
import { BookTab } from '@flow/reader/models'
import { queueBooksUpload } from '@flow/reader/sync'

import { useRemoteBooks } from './useRemote'

export function useSync(tab: BookTab) {
  const { mutate } = useRemoteBooks()
  const { location, book } = useSnapshot(tab)

  const id = tab.book.id

  const sync = useCallback(
    async (changes: Partial<BookRecord>) => {
      // to remove effect dependency `remoteBooks`
      mutate(
        (remoteBooks) => {
          if (remoteBooks) {
            const i = remoteBooks.findIndex((b) => b.id === id)
            if (i < 0) return remoteBooks

            remoteBooks[i] = {
              ...remoteBooks[i]!,
              ...changes,
            }

            void queueBooksUpload(remoteBooks)

            return [...remoteBooks]
          }
        },
        { revalidate: false },
      )
    },
    [id, mutate],
  )

  useEffect(() => {
    const restoreLocation = isRestoreLocationRecord(book.restoreLocation)
      ? book.restoreLocation
      : undefined
    const cfi = restoreLocation?.cfi ?? location?.start.cfi
    const canonicalProgress = isSupportedCanonicalProgressRecord(
      book.canonicalProgress,
    )
      ? book.canonicalProgress
      : undefined
    const changes: Partial<BookRecord> = {}
    if (cfi) changes.cfi = cfi
    if (restoreLocation) changes.restoreLocation = restoreLocation
    if (Number.isFinite(book.percentage)) changes.percentage = book.percentage
    if (canonicalProgress) changes.canonicalProgress = canonicalProgress
    if (Object.keys(changes).length > 0) void sync(changes)
  }, [
    sync,
    book.canonicalProgress,
    book.percentage,
    book.restoreLocation,
    location?.start.cfi,
  ])

  useEffect(() => {
    sync({
      annotations: book.annotations as Annotation[],
    })
  }, [book.annotations, sync])

  useEffect(() => {
    sync({
      configuration: book.configuration,
    })
  }, [book.configuration, sync])
}

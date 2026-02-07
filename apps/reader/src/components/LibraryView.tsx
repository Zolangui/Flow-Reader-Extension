import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
  DragStartEvent,
  DragOverlay,
  TouchSensor,
  MouseSensor,
} from '@dnd-kit/core'
import { snapCenterToCursor } from '@dnd-kit/modifiers'
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  rectSortingStrategy,
} from '@dnd-kit/sortable'
import clsx from 'clsx'
import { useLiveQuery } from 'dexie-react-hooks'
import React, { useState, useMemo, useEffect } from 'react'

import { BookRecord, CoverRecord, db } from '../db'
import { useTranslation } from '../hooks'
import { useLibraryState } from '../state'

import { BookCard } from './BookCard'
import { BookDetailsModal } from './BookDetailsModal'
import { NewHeader } from './NewHeader'
import { SortableBookCard } from './SortableBookCard'
import { DropZone } from './base'

interface LibraryViewProps {
  books: BookRecord[]
  covers: CoverRecord[]
  onAddBook: () => void
  onBookClick: (book: BookRecord) => void
  onDrop: (e: React.DragEvent<HTMLDivElement>) => void
  onToggleFavorite: (book: BookRecord) => void
  onDownload: (book: BookRecord) => void
  onRemove: (book: BookRecord) => void
  onViewDetails: (book: BookRecord) => void
}

export const LibraryView: React.FC<LibraryViewProps> = ({
  books,
  covers,
  onAddBook,
  onBookClick,
  onDrop,
  onToggleFavorite,
  onDownload,
  onRemove,
  onViewDetails: _onViewDetails,
}) => {
  const [{ viewMode, filter }, setLibraryState] = useLibraryState()
  const [searchQuery, setSearchQuery] = useState('')
  const [sortMode, setSortMode] = useState<
    'recent' | 'title' | 'author' | 'custom'
  >('recent')
  const [activeId, setActiveId] = useState<string | null>(null)
  const [localBooks, setLocalBooks] = useState<BookRecord[]>(books)
  const [selectedBook, setSelectedBook] = useState<BookRecord | null>(null)
  const t = useTranslation()

  const indexedBookIds = useLiveQuery(async () => {
    try {
        // SOTA v6.3: Try new 'kind' index
        const indices = await db?.indices.where('kind').equals('chunks').toArray()
        return new Set(indices?.map((i) => i.bookId) || [])
    } catch (e: any) {
        // Fallback: Legacy schema (no 'kind' index)
        const errName = e?.name || e?._e?.name
        if (errName === 'SchemaError' || errName === 'DataError') {
             // In legacy schema, all entries in 'indices' are chunks for books.
             // Just get everything (it's metadata-only effectively for this list check)
             const allIndices = await db?.indices.toArray()
             return new Set(allIndices?.map((i: any) => i.bookId || i.id) || [])
        }
        return new Set()
    }
  }, [])

  useEffect(() => {
    setLocalBooks(books)
  }, [books])

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
    useSensor(TouchSensor, {
      activationConstraint: {
        delay: 200,
        tolerance: 5,
      },
    }),
    useSensor(MouseSensor, {
      activationConstraint: {
        distance: 10,
      },
    }),
  )
  const [isSortMenuOpen, setIsSortMenuOpen] = useState(false)

  const setViewMode = (mode: 'grid' | 'list') =>
    setLibraryState((prev) => ({ ...prev, viewMode: mode }))

  const setFilter = (
    f: 'All' | 'Favorites' | 'Unread' | 'In Progress' | 'Finished',
  ) => setLibraryState((prev) => ({ ...prev, filter: f }))

  const filteredBooks = useMemo(() => {
    const filtered = localBooks.filter((book) => {
      const matchesSearch =
        (book.metadata?.title || book.name)
          .toLowerCase()
          .includes(searchQuery.toLowerCase()) ||
        (book.metadata?.creator || '')
          .toLowerCase()
          .includes(searchQuery.toLowerCase())

      if (!matchesSearch) return false

      const percentage = book.percentage || 0
      if (filter === 'Favorites') return book.favorite
      if (filter === 'Unread') return percentage === 0
      if (filter === 'In Progress') return percentage > 0 && percentage < 0.99
      if (filter === 'Finished') return percentage >= 0.99

      return true
    })

    if (sortMode === 'custom') {
      return filtered.sort((a, b) => (a.position || 0) - (b.position || 0))
    }

    return filtered.sort((a, b) => {
      switch (sortMode) {
        case 'title':
          return (a.metadata?.title || a.name).localeCompare(
            b.metadata?.title || b.name,
          )
        case 'author':
          return (a.metadata?.creator || '').localeCompare(
            b.metadata?.creator || '',
          )
        case 'recent':
        default:
          // Sort by last read (updatedAt) or added time
          return (b.updatedAt || 0) - (a.updatedAt || 0)
      }
    })
  }, [localBooks, searchQuery, filter, sortMode])

  const handleDragStart = (event: DragStartEvent) => {
    setActiveId(event.active.id as string)
  }

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event

    if (over && active.id !== over.id) {
      // Find indices in filtered books
      const oldIndex = filteredBooks.findIndex((item) => item.id === active.id)
      const newIndex = filteredBooks.findIndex((item) => item.id === over.id)

      if (oldIndex === -1 || newIndex === -1) {
        setActiveId(null)
        return
      }

      // Reorder filtered books
      const reorderedFiltered = arrayMove(filteredBooks, oldIndex, newIndex)

      // Update positions in DB and local state
      reorderedFiltered.forEach((book, index) => {
        db?.books.update(book.id, { position: index })
      })

      // Update local books to reflect new positions
      setLocalBooks((prevBooks) => {
        return prevBooks.map((book) => {
          const newPosition = reorderedFiltered.findIndex(
            (b) => b.id === book.id,
          )
          if (newPosition !== -1) {
            return { ...book, position: newPosition }
          }
          return book
        })
      })
    }
    setActiveId(null)
  }

  const filterLabels: Record<string, string> = {
    All: t('library.filter.all'),
    Favorites: t('library.filter.favorites'),
    Unread: t('library.filter.unread'),
    'In Progress': t('library.filter.in_progress'),
    Finished: t('library.filter.finished'),
  }

  const sortLabels: Record<string, string> = {
    recent: t('library.sort.recent'),
    title: t('library.sort.title'),
    author: t('library.sort.author'),
    custom: t('library.sort.custom'),
  }

  return (
    <DropZone
      className="bg-background-light dark:bg-background-dark flex h-full w-full flex-col"
      onDrop={onDrop}
    >
      <div className="flex flex-1 flex-col overflow-y-auto p-4 sm:p-6 md:p-8">
        <NewHeader
          viewMode={viewMode}
          onViewModeChange={setViewMode}
          onAddBook={onAddBook}
        />

        <div className="mb-6 flex flex-col items-start gap-4 md:flex-row md:items-center">
          <label className="relative block w-full md:max-w-md">
            <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 dark:text-gray-500">
              search
            </span>
            <input
              className="focus:ring-primary focus:border-primary w-full rounded-lg border border-gray-200 bg-gray-50 py-2 pl-10 pr-4 text-sm text-gray-800 placeholder-gray-400 focus:ring-1 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200 dark:placeholder-gray-500"
              placeholder={t('library.search_placeholder')}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </label>
          <div className="flex flex-wrap gap-2">
            {['All', 'Favorites', 'Unread', 'In Progress', 'Finished'].map(
              (f) => (
                <button
                  key={f}
                  onClick={() => setFilter(f as any)}
                  className={clsx(
                    'flex h-9 shrink-0 items-center justify-center gap-x-2 whitespace-nowrap rounded-full px-4 transition-colors',
                    filter === f
                      ? 'bg-primary/20 dark:bg-primary/30 text-primary'
                      : 'bg-surface-light dark:bg-surface-dark border-border-light dark:border-border-dark border hover:bg-black/5 dark:hover:bg-white/5',
                  )}
                >
                  <p className="text-sm font-medium leading-normal">
                    {filterLabels[f]}
                  </p>
                </button>
              ),
            )}
            <div className="relative">
              <button
                onClick={() => setIsSortMenuOpen(!isSortMenuOpen)}
                className="bg-surface-light dark:bg-surface-dark border-border-light dark:border-border-dark flex h-9 shrink-0 items-center justify-center gap-x-2 rounded-full border pl-4 pr-3 transition-colors hover:bg-black/5 dark:hover:bg-white/5"
              >
                <p className="text-sm font-medium leading-normal">
                  {t('library.sort_by')} {sortLabels[sortMode]}
                </p>
                <span className="material-symbols-outlined text-lg">
                  expand_more
                </span>
              </button>

              {isSortMenuOpen && (
                <>
                  <div
                    className="fixed inset-0 z-10"
                    onClick={() => setIsSortMenuOpen(false)}
                  />
                  <div className="bg-surface-light dark:bg-surface-dark border-border-light dark:border-border-dark absolute right-0 top-full z-20 mt-2 w-40 overflow-hidden rounded-xl border shadow-xl">
                    {[
                      { label: sortLabels['recent'], value: 'recent' },
                      { label: sortLabels['title'], value: 'title' },
                      { label: sortLabels['author'], value: 'author' },
                      { label: sortLabels['custom'], value: 'custom' },
                    ].map((option) => (
                      <button
                        key={option.value}
                        onClick={() => {
                          setSortMode(option.value as any)
                          setIsSortMenuOpen(false)
                        }}
                        className={clsx(
                          'w-full px-4 py-2.5 text-left text-sm transition-colors hover:bg-black/5 dark:hover:bg-white/5',
                          sortMode === option.value
                            ? 'text-primary font-medium'
                            : 'text-gray-700 dark:text-gray-200',
                        )}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>

        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          modifiers={[snapCenterToCursor]}
        >
          <SortableContext
            items={filteredBooks.map((b) => b.id)}
            strategy={rectSortingStrategy}
            disabled={sortMode !== 'custom'}
          >
            <div
              className={clsx(
                viewMode === 'grid'
                  ? 'grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-x-4 gap-y-8 sm:grid-cols-[repeat(auto-fill,minmax(180px,1fr))]'
                  : 'flex flex-col gap-4',
              )}
            >
              {filteredBooks.map((book) =>
                sortMode === 'custom' ? (
                  <SortableBookCard
                    key={book.id}
                    id={book.id}
                    book={book}
                    cover={covers.find((c) => c.id === book.id)?.cover}
                    viewMode={viewMode}
                    onClick={() => onBookClick(book)}
                    onToggleFavorite={() => onToggleFavorite(book)}
                    onDownload={() => onDownload(book)}
                    onRemove={() => onRemove(book)}
                    onViewDetails={() => setSelectedBook(book)}
                    isIndexed={indexedBookIds?.has(book.id)}
                  />
                ) : (
                  <BookCard
                    key={book.id}
                    book={book}
                    cover={covers.find((c) => c.id === book.id)?.cover}
                    viewMode={viewMode}
                    onClick={() => onBookClick(book)}
                    onToggleFavorite={() => onToggleFavorite(book)}
                    onDownload={() => onDownload(book)}
                    onRemove={() => onRemove(book)}
                    onViewDetails={() => setSelectedBook(book)}
                    isIndexed={indexedBookIds?.has(book.id)}
                  />
                ),
              )}
            </div>
          </SortableContext>
          <DragOverlay>
            {activeId ? (
              <div style={{ transform: 'scale(1.05)' }}>
                <BookCard
                  book={filteredBooks.find((b) => b.id === activeId)!}
                  cover={covers.find((c) => c.id === activeId)?.cover}
                  viewMode={viewMode}
                  onClick={() => { }}
                  onToggleFavorite={() => { }}
                  onDownload={() => { }}
                  onRemove={() => { }}
                  onViewDetails={() => { }}
                />
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      </div>
      {selectedBook && (
        <BookDetailsModal
          book={selectedBook}
          cover={covers.find((c) => c.id === selectedBook.id)?.cover}
          onClose={() => setSelectedBook(null)}
          onRead={(book) => {
            onBookClick(book)
            setSelectedBook(null)
          }}
        />
      )}
    </DropZone>
  )
}

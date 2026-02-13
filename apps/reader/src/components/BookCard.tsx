import React from 'react'
import { MdStar } from 'react-icons/md'

import { BookRecord } from '../db'
import { useTranslation } from '../hooks'

import { BookMenu } from './BookMenu'
import { IndexedIcon } from './icons/ProviderIcons'

export interface BookCardProps {
  book: BookRecord
  cover?: string | null
  viewMode: 'grid' | 'list'
  onClick: () => void
  onToggleFavorite: () => void
  onDownload: () => void
  onRemove: () => void
  onViewDetails: () => void
  isIndexed?: boolean
}

const placeholder = `data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect fill="gray" fill-opacity="0.1" width="1" height="1"/></svg>`

export const BookCard: React.FC<BookCardProps> = ({
  book,
  cover,
  viewMode,
  onClick,
  onToggleFavorite,
  onDownload,
  onRemove,
  onViewDetails,
  isIndexed,
}) => {
  const t = useTranslation()
  const title = book.metadata?.title || book.name
  const author = book.metadata?.creator || t('books.unknown_author')
  const percentage =
    book.percentage !== undefined ? Math.round(book.percentage * 100) : 0

  if (viewMode === 'list') {
    return (
      <div
        onClick={onClick}
        className="bg-surface-light dark:bg-surface-dark hover:border-border-light dark:hover:border-border-dark group grid cursor-pointer grid-cols-[auto_1fr_auto] items-center gap-4 rounded-lg border border-transparent p-4 transition-colors duration-200 sm:grid-cols-[auto_1fr_120px_auto] [&:not(:has(.book-menu-container:hover))]:hover:bg-black/5 dark:[&:not(:has(.book-menu-container:hover))]:hover:bg-white/5"
      >
        <div
          className="relative aspect-[2/3] h-[72px] w-12 rounded bg-cover bg-center bg-no-repeat shadow-md"
          style={{ backgroundImage: `url("${cover || placeholder}")` }}
        >
          {book.favorite && (
            <div className="size-5 absolute -top-1 -left-1 flex items-center justify-center rounded-md bg-black/60 p-0.5 text-yellow-400 backdrop-blur-sm">
              <MdStar className="text-xs" />
            </div>
          )}

          {isIndexed && (
            <div className="size-5 animate-in fade-in zoom-in absolute bottom-1 right-1 flex items-center justify-center rounded-md border border-white/40 bg-white/20 text-white shadow-lg backdrop-blur-md duration-300">
              <div className="from-primary/40 absolute inset-0 rounded-md bg-gradient-to-br to-blue-600/40 opacity-50" />
              <IndexedIcon className="relative z-10 text-[12px] drop-shadow-sm" />
            </div>
          )}
        </div>
        <div className="flex flex-col gap-1">
          <p className="text-text-light dark:text-text-dark truncate text-base font-medium leading-normal">
            {title}
          </p>
          <p className="text-subtle-light dark:text-subtle-dark text-sm font-normal leading-normal">
            {author}
          </p>
        </div>
        <div className="hidden flex-col gap-2 sm:flex">
          <div className="flex items-center justify-between">
            <p className="text-subtle-light dark:text-subtle-dark text-xs font-medium">
              {t('books.progress')}
            </p>
            <p className="text-subtle-light dark:text-subtle-dark text-xs font-medium">
              {percentage}%
            </p>
          </div>
          <div className="bg-primary/20 h-1 w-full overflow-hidden rounded-full">
            <div
              className="bg-primary h-full rounded-full"
              style={{ width: `${percentage}%` }}
            ></div>
          </div>
        </div>
        <BookMenu
          isFavorite={book.favorite}
          onToggleFavorite={onToggleFavorite}
          onDownload={onDownload}
          onRemove={onRemove}
          onViewDetails={onViewDetails}
          className="book-menu-container h-8 w-8 rounded-md text-gray-500 hover:bg-gray-200 dark:text-gray-400 dark:hover:bg-gray-700"
          activeClassName="bg-gray-300 dark:bg-gray-600"
        />
      </div>
    )
  }

  return (
    <div
      onClick={onClick}
      className="group relative flex cursor-pointer flex-col gap-3"
    >
      <div className="relative w-full overflow-hidden">
        <div
          className="aspect-[2/3] w-full rounded-lg bg-cover bg-center bg-no-repeat shadow-md transition-transform group-hover:scale-105"
          style={{ backgroundImage: `url("${cover || placeholder}")` }}
        ></div>

        {book.favorite && (
          <div className="size-8 absolute top-2 left-2 z-10 flex items-center justify-center rounded-md bg-black/60 text-yellow-400 backdrop-blur-md transition-colors hover:bg-black/80">
            <MdStar className="text-2xl" />
          </div>
        )}

        {isIndexed && (
          <div className="size-8 animate-in fade-in zoom-in absolute bottom-4 right-2 z-10 flex items-center justify-center rounded-xl border border-white/40 bg-white/10 text-white shadow-xl backdrop-blur-xl duration-300">
            {/* SOTA Glow Layer */}
            <div className="from-primary/60 absolute inset-0 rounded-xl bg-gradient-to-br to-blue-600/60 opacity-40" />
            <div className="absolute inset-0 rounded-xl bg-gradient-to-tl from-white/20 to-transparent" />
            <IndexedIcon className="animate-pulse-slow relative z-10 text-xl drop-shadow-md" />
          </div>
        )}

        <div className="absolute bottom-0 left-0 right-0 mx-2 mb-2 h-1 overflow-hidden rounded-full bg-white/80 shadow-sm">
          <div
            className="bg-primary h-full rounded-full"
            style={{ width: `${percentage}%` }}
          ></div>
        </div>
      </div>

      <div className="absolute top-2 right-2 z-20 opacity-0 transition-opacity group-hover:opacity-100">
        <BookMenu
          isFavorite={book.favorite}
          onToggleFavorite={onToggleFavorite}
          onDownload={onDownload}
          onRemove={onRemove}
          onViewDetails={onViewDetails}
          className="size-8 flex items-center justify-center rounded-md bg-black/60 text-white backdrop-blur-md transition-colors hover:bg-black/80"
        />
      </div>

      <div>
        <p className="text-text-light dark:text-text-dark truncate text-base font-medium leading-normal">
          {title}
        </p>
        <p className="text-subtle-light dark:text-subtle-dark text-sm font-normal leading-normal">
          {author}
        </p>
      </div>
    </div>
  )
}

import clsx from 'clsx'
import dayjs from 'dayjs'
import React, { useMemo } from 'react'

import { Annotation } from '@flow/reader/annotation'
import { useAction, useTranslation } from '@flow/reader/hooks'
import { reader, useReaderSnapshot } from '@flow/reader/models'

import { PaneViewProps } from '../base'

export const AnnotationView: React.FC<PaneViewProps> = () => {
  const { focusedBookTab } = useReaderSnapshot()
  const t = useTranslation('annotation')
  const [, setAction] = useAction()

  const annotations = useMemo(
    () => (focusedBookTab?.book.annotations as Annotation[]) ?? [],
    [focusedBookTab?.book.annotations],
  )

  // Sort annotations by date (newest first)
  const sortedAnnotations = useMemo(() => {
    return [...annotations].sort((a, b) => b.createAt - a.createAt)
  }, [annotations])

  return (
    <div className="h-full w-full overflow-hidden bg-white dark:bg-gray-900">
      <div className="flex h-full min-w-[220px] flex-col">
        {/* Header */}
        <div className="flex h-16 shrink-0 items-center justify-between border-b border-gray-200 p-4 dark:border-gray-700">
          <div className="flex items-center">
            <button
              onClick={() => setAction(undefined)}
              className="rounded p-2 text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
            >
              <span className="material-symbols-outlined text-xl">
                format_underlined
              </span>
            </button>
            <h2 className="ml-2 font-semibold text-gray-800 dark:text-white">
              {t('annotations')}
            </h2>
          </div>
        </div>

        <div className="no-scrollbar flex-1 overflow-y-auto p-4">
          {/* Annotations Section */}
          <div>
            <div className="mb-3 flex items-center justify-between px-1">
              <h3 className="text-xs font-bold uppercase tracking-wider text-gray-400">
                {t('annotations')} & {t('notes')}
              </h3>
            </div>

            {sortedAnnotations.length > 0 ? (
              <div className="space-y-3">
                {sortedAnnotations.map((a) => (
                  <AnnotationCard key={a.id} annotation={a} />
                ))}
              </div>
            ) : (
              <div className="rounded-lg border-2 border-dashed border-gray-100 p-4 text-center dark:border-gray-800">
                <p className="text-xs italic text-gray-400">
                  {t('empty_annotations')}
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

const AnnotationCard: React.FC<{ annotation: Annotation }> = ({
  annotation,
}) => {
  const t = useTranslation('annotation')
  const isNote = !!annotation.notes
  const typeLabel = isNote ? t('note_label') : t('highlight_label')
  const iconName = isNote ? 'comment' : 'ink_highlighter'

  // Color mapping
  const color = annotation.color || 'yellow'
  const colorStyles = {
    yellow: {
      icon: 'text-yellow-600 dark:text-yellow-400',
      bg: 'bg-yellow-50 dark:bg-yellow-900/30',
      border: 'border-yellow-300 dark:border-yellow-700',
    },
    red: {
      icon: 'text-red-600 dark:text-red-400',
      bg: 'bg-red-50 dark:bg-red-900/30',
      border: 'border-red-300 dark:border-red-700',
    },
    green: {
      icon: 'text-green-600 dark:text-green-400',
      bg: 'bg-green-50 dark:bg-green-900/30',
      border: 'border-green-300 dark:border-green-700',
    },
    blue: {
      icon: 'text-blue-600 dark:text-blue-400',
      bg: 'bg-blue-50 dark:bg-blue-900/30',
      border: 'border-blue-300 dark:border-blue-700',
    },
  }[color] || {
    icon: 'text-yellow-600 dark:text-yellow-400',
    bg: 'bg-yellow-50 dark:bg-yellow-900/30',
    border: 'border-yellow-300 dark:border-yellow-700',
  }

  return (
    <div
      onClick={() => reader.focusedBookTab?.display(annotation.cfi)}
      className="group relative mb-2 flex cursor-pointer items-start gap-3 rounded-lg border border-gray-100 bg-white p-3 shadow-sm transition-all hover:shadow-md dark:border-gray-800 dark:bg-gray-800/50"
    >
      {/* Icon Left */}
      <div
        className={clsx(
          'flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-transform group-hover:scale-105',
          colorStyles.bg,
          colorStyles.icon,
        )}
      >
        <span className="material-symbols-outlined text-lg">{iconName}</span>
      </div>

      {/* Content Right */}
      <div className="min-w-0 flex-1">
        {/* Header: Type & Date */}
        <div className="mb-1 flex items-baseline justify-between">
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-bold uppercase tracking-wider text-gray-500 opacity-80 dark:text-gray-400">
              {typeLabel}
            </span>
            <span className="text-[10px] text-gray-400">
              {dayjs(annotation.createAt).format('D MMM')}
            </span>
          </div>

          <button
            onClick={(e) => {
              e.stopPropagation()
              reader.focusedBookTab?.removeAnnotation(annotation.cfi)
            }}
            className="opacity-0 transition-opacity group-hover:opacity-100"
            title={t('remove_annotation')}
          >
            <span className="material-symbols-outlined text-base text-gray-400 hover:text-red-500">
              close
            </span>
          </button>
        </div>

        {isNote ? (
          <div className="space-y-1.5">
            {/* Context (Quote) - Smaller & Italic */}
            <div
              className={clsx('border-l-2 pl-2', colorStyles.border)}
              title={annotation.text}
            >
              <p
                className="py-1 font-serif text-[11px] italic text-gray-500 dark:text-gray-400"
                style={{
                  display: '-webkit-box',
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: 'vertical',
                  overflow: 'hidden',
                  lineHeight: '1.6',
                  maxHeight: '3.2em', // 2 lines × 1.6 line-height = 3.2em
                  wordWrap: 'break-word',
                  textOverflow: 'ellipsis',
                }}
              >
                &quot;{annotation.text}&quot;
              </p>
            </div>
            {/* User Note - Prominent */}
            <p className="break-words text-sm font-medium text-gray-900 dark:text-gray-100">
              {annotation.notes}
            </p>
          </div>
        ) : (
          /* Highlight only */
          <p
            className="py-1 font-serif text-xs italic text-gray-600 dark:text-gray-300"
            style={{
              display: '-webkit-box',
              WebkitLineClamp: 3,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
              lineHeight: '1.6',
              maxHeight: '4.8em', // 3 lines × 1.6 line-height = 4.8em
              wordWrap: 'break-word',
              textOverflow: 'ellipsis',
            }}
            title={annotation.text}
          >
            &quot;{annotation.text}&quot;
          </p>
        )}
      </div>
    </div>
  )
}

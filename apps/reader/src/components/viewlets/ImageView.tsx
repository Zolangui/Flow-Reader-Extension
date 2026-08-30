import clsx from 'clsx'
import { useEffect, useMemo, useState } from 'react'

import { useAction, useTranslation } from '@flow/reader/hooks'
import {
  resolvePublicationImageDisplaySource,
  type SectionImageReference,
} from '@flow/reader/lib/image-index'
import {
  ISectionSnapshot,
  reader,
  useReaderSnapshot,
} from '@flow/reader/models'

import { PaneViewProps } from '../base'

export const ImageView: React.FC<PaneViewProps> = () => {
  const { focusedBookTab } = useReaderSnapshot()
  const [, setAction] = useAction()
  const t = useTranslation()

  useEffect(() => {
    void reader.focusedBookTab?.ensureImageIndex()
  }, [focusedBookTab?.instanceId, focusedBookTab?.sections])

  const sections = useMemo(() => {
    if (!focusedBookTab?.sections) return []
    // Cast to any to avoid "Type instantiation is excessively deep" error with Valtio proxies
    const allSections = Array.from(
      focusedBookTab.sections as any,
    ) as ISectionSnapshot[]
    return allSections.filter((s) => s.images && s.images.length > 0)
  }, [focusedBookTab?.sections])

  const indexState = focusedBookTab?.imageIndexState ?? 'idle'

  return (
    <div className="h-full w-full overflow-hidden bg-white dark:bg-gray-900">
      <div className="flex h-full min-w-[220px] flex-col">
        <div className="flex h-16 shrink-0 items-center justify-between border-b border-gray-200 p-4 dark:border-gray-700">
          <div className="flex items-center">
            <button
              onClick={() => setAction(undefined)}
              className="rounded p-2 text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
            >
              <span className="material-symbols-outlined text-xl">image</span>
            </button>
            <h2 className="ml-2 font-semibold text-gray-800 dark:text-white">
              {t('image.header')}
            </h2>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {indexState === 'indexing' && (
            <div className="mb-4 flex items-center justify-center gap-2 text-sm text-gray-500 dark:text-gray-400">
              <span className="material-symbols-outlined animate-spin text-lg">
                progress_activity
              </span>
              <span>{t('image.indexing')}</span>
            </div>
          )}
          {indexState === 'ready' && sections.length === 0 && (
            <div className="flex h-full items-center justify-center text-center text-sm text-gray-500 dark:text-gray-400">
              {t('image.empty')}
            </div>
          )}
          {indexState === 'failed' && sections.length === 0 && (
            <div className="flex h-full items-center justify-center text-center text-sm text-red-600 dark:text-red-400">
              {t('image.index_failed')}
            </div>
          )}
          <div className="space-y-2">
            {sections?.map((s) => (
              <Block key={`${s.index}:${s.href}`} section={s} />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

interface BlockProps {
  section: ISectionSnapshot
}

const Block: React.FC<BlockProps> = ({ section }) => {
  const { focusedBookTab } = useReaderSnapshot()
  const [expanded, setExpanded] = useState(false)
  const t = useTranslation()

  const resources = focusedBookTab?.epub?.resources
  if (!resources) return null

  const images = section.images ?? []
  const imageCount = images.length

  return (
    <div>
      <div
        onClick={() => setExpanded(!expanded)}
        className={clsx(
          'flex cursor-pointer items-center space-x-3 rounded-lg p-2 transition-colors',
          expanded
            ? 'bg-primary/10'
            : 'hover:bg-gray-100 dark:hover:bg-gray-800',
        )}
      >
        <span
          className={clsx(
            'material-symbols-outlined text-lg',
            expanded ? 'text-primary' : 'text-gray-500 dark:text-gray-400',
          )}
        >
          {expanded ? 'expand_more' : 'chevron_right'}
        </span>
        <span
          className={clsx(
            'flex-1 text-sm font-medium',
            expanded ? 'text-primary' : 'text-gray-900 dark:text-white',
          )}
        >
          {section.navitem?.label || t('image.untitled_section')}
        </span>
        <span
          className={clsx(
            'rounded-full px-2 py-0.5 font-mono text-xs',
            expanded
              ? 'bg-primary/20 text-primary'
              : 'bg-gray-200 text-gray-600 dark:bg-gray-700 dark:text-gray-400',
          )}
        >
          {imageCount}
        </span>
      </div>

      {expanded && (
        <div className="pl-8 pt-3">
          {images.map((image) => {
            return (
              <ImageTile
                key={`${image.cfi}:${image.resourceHref ?? image.source}`}
                image={image}
                bookInstanceId={focusedBookTab?.instanceId ?? ''}
              />
            )
          })}
        </div>
      )}
    </div>
  )
}

const ImageTile: React.FC<{
  image: SectionImageReference
  bookInstanceId: string
}> = ({ image, bookInstanceId }) => {
  const [source, setSource] = useState<string | undefined>(() =>
    image.source.startsWith('data:image/') ? image.source : undefined,
  )
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let current = true
    const tab = reader.focusedBookTab
    const epub = tab?.epub
    setSource(image.source.startsWith('data:image/') ? image.source : undefined)
    setFailed(false)
    if (!epub || tab.instanceId !== bookInstanceId) {
      setFailed(true)
      return () => {
        current = false
      }
    }

    void resolvePublicationImageDisplaySource(image, epub.resources, (href) =>
      epub.resolve(href, false),
    ).then((resolved) => {
      if (!current) return
      setSource(resolved)
      setFailed(!resolved)
    })

    return () => {
      current = false
    }
  }, [bookInstanceId, image])

  if (!source) {
    return (
      <div className="mb-4 flex min-h-[3rem] items-center justify-center rounded-md border border-gray-200 text-xs text-gray-500 dark:border-gray-700 dark:text-gray-400">
        {failed ? (
          image.alt ?? image.resourceHref ?? image.source
        ) : (
          <span className="material-symbols-outlined animate-spin text-lg">
            progress_activity
          </span>
        )}
      </div>
    )
  }

  return (
    <div className="mb-4 flex justify-center">
      <img
        className="h-auto max-w-full cursor-pointer rounded-md border border-gray-200 object-contain shadow-md transition-shadow hover:shadow-lg dark:border-gray-700"
        src={source}
        alt={image.alt ?? image.resourceHref ?? ''}
        onError={() => {
          setSource(undefined)
          setFailed(true)
        }}
        onClick={() => {
          const tab = reader.focusedBookTab
          if (tab?.instanceId === bookInstanceId) tab.display(image.cfi)
        }}
      />
    </div>
  )
}

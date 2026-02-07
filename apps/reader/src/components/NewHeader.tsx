import { Hct, argbFromHex } from '@material/material-color-utilities'
import clsx from 'clsx'
import React, { useMemo } from 'react'

import { useSourceColor, useTranslation } from '../hooks'

interface NewHeaderProps {
  viewMode: 'grid' | 'list'
  onViewModeChange: (mode: 'grid' | 'list') => void
  onAddBook: () => void
}

export const NewHeader: React.FC<NewHeaderProps> = ({
  viewMode,
  onViewModeChange,
  onAddBook,
}) => {
  const { sourceColor } = useSourceColor()
  const t = useTranslation()

  const hueRotation = useMemo(() => {
    try {
      const sourceHue = Hct.fromInt(argbFromHex(sourceColor)).hue
      // Base icon color is approx #0ea5e9 which has a hue of ~199deg
      const baseHue = 199
      return `${sourceHue - baseHue}deg`
    } catch (e) {
      return '0deg'
    }
  }, [sourceColor])

  return (
    <header className="border-border-light dark:border-border-dark mb-6 flex flex-col items-start justify-between gap-4 border-b border-solid pb-6 sm:flex-row sm:items-center">
      <div className="flex items-center gap-8">
        <div className="text-text-light dark:text-text-dark flex items-center gap-3">
          <div className="size-8">
            <img
              src="/icons/512.png"
              alt={t('details.logo_alt')}
              className="h-8 w-8 object-contain transition-all duration-500"
              style={{ filter: `hue-rotate(${hueRotation})` }}
            />
          </div>
          <h2 className="text-2xl font-bold leading-tight tracking-tighter">
            {t('library.title')}
          </h2>
        </div>
      </div>
      <div className="flex w-full items-center justify-end gap-2 sm:w-auto">
        <button
          onClick={onAddBook}
          className="bg-primary flex h-10 min-w-[84px] cursor-pointer items-center justify-center overflow-hidden rounded-lg px-4 text-sm font-bold leading-normal tracking-wide text-white transition-opacity hover:opacity-90"
        >
          <span className="truncate">{t('library.add_book')}</span>
        </button>
        <div className="bg-background-light dark:bg-surface-dark border-border-light dark:border-border-dark flex items-center rounded-lg border">
          <button
            onClick={() => onViewModeChange('grid')}
            className={clsx(
              'flex h-10 min-w-0 cursor-pointer items-center justify-center gap-2 overflow-hidden rounded-l-lg px-3 text-sm font-bold leading-normal transition-colors',
              viewMode === 'grid'
                ? 'bg-primary/20 dark:bg-primary/30 text-primary'
                : 'text-subtle-light dark:text-subtle-dark bg-transparent hover:bg-black/5 dark:hover:bg-white/5',
            )}
          >
            <span className="material-symbols-outlined text-xl">grid_view</span>
          </button>
          <button
            onClick={() => onViewModeChange('list')}
            className={clsx(
              'flex h-10 min-w-0 cursor-pointer items-center justify-center gap-2 overflow-hidden rounded-r-lg px-3 text-sm font-bold leading-normal transition-colors',
              viewMode === 'list'
                ? 'bg-primary/20 dark:bg-primary/30 text-primary'
                : 'text-subtle-light dark:text-subtle-dark bg-transparent hover:bg-black/5 dark:hover:bg-white/5',
            )}
          >
            <span className="material-symbols-outlined text-xl">list</span>
          </button>
        </div>
      </div>
    </header>
  )
}

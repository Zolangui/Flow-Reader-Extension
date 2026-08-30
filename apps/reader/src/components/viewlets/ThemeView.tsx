import clsx from 'clsx'
import { useEffect, useMemo, useState } from 'react'

import {
  useAction,
  useBackground,
  useColorScheme,
  useSourceColor,
  useTheme,
  useTranslation,
  type ColorScheme,
} from '@flow/reader/hooks'
import {
  READER_BACKGROUND_LEVELS,
  normalizeReaderBackgroundLevel,
  resolveReaderBackgroundColor,
  type ReaderBackgroundLevel,
} from '@flow/reader/lib/theme-colors'
import { useSettings } from '@flow/reader/state'

import { PaneViewProps } from '../base'

const schemeIcons: Record<ColorScheme, string> = {
  light: 'light_mode',
  dark: 'dark_mode',
  system: 'brightness_auto',
}

const backgroundLabelKeys: Record<ReaderBackgroundLevel, string> = {
  [-1]: 'theme.background_default',
  1: 'theme.background_soft',
  3: 'theme.background_tinted',
  5: 'theme.background_deep',
}

export const ThemeView: React.FC<PaneViewProps> = () => {
  const { scheme, setScheme } = useColorScheme()
  const { sourceColor, setSourceColor } = useSourceColor()
  const materialTheme = useTheme()
  const [, setBackground] = useBackground()
  const [, setAction] = useAction()
  const [{ theme }] = useSettings()
  const t = useTranslation()
  const [draftSourceColor, setDraftSourceColor] = useState(sourceColor)

  useEffect(() => setDraftSourceColor(sourceColor), [sourceColor])

  const backgroundLevel = normalizeReaderBackgroundLevel(theme?.background)
  const backgroundOptions = useMemo(
    () =>
      READER_BACKGROUND_LEVELS.map((value) => ({
        value,
        color:
          resolveReaderBackgroundColor(false, value, materialTheme) ??
          '#ffffff',
      })),
    [materialTheme],
  )

  const schemeOptions: ColorScheme[] = ['light', 'dark', 'system']
  const sourceColorChanged =
    draftSourceColor.toLowerCase() !== sourceColor.toLowerCase()

  return (
    <div className="bg-surface text-on-surface h-full w-full overflow-hidden">
      <div className="flex h-full min-w-[220px] flex-col">
        <div className="border-outline-variant flex h-16 shrink-0 items-center justify-between border-b p-4">
          <div className="flex items-center">
            <button
              type="button"
              onClick={() => setAction(undefined)}
              className="text-on-surface-variant hover:bg-on-surface/5 rounded p-2"
              aria-label={t('theme.close')}
              title={t('theme.close')}
            >
              <span className="material-symbols-outlined text-xl">palette</span>
            </button>
            <h2 className="ml-2 font-semibold">{t('theme.header')}</h2>
          </div>
        </div>

        <div className="flex-grow space-y-6 overflow-y-auto p-4">
          <section>
            <h3 className="text-on-surface-variant mb-2 text-xs font-medium">
              {t('theme.color_scheme_label')}
            </h3>
            <div
              className="grid grid-cols-3 gap-1"
              role="radiogroup"
              aria-label={t('theme.color_scheme_label')}
            >
              {schemeOptions.map((value) => {
                const selected = scheme === value
                return (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    title={t(`theme.scheme_${value}`)}
                    onClick={() => setScheme(value)}
                    className={clsx(
                      'flex min-w-0 flex-col items-center gap-1 rounded-md border px-1 py-2 text-xs transition-colors',
                      selected
                        ? 'border-primary bg-primary/10 text-on-surface'
                        : 'border-outline-variant text-on-surface-variant hover:bg-on-surface/5',
                    )}
                  >
                    <span className="material-symbols-outlined text-lg">
                      {schemeIcons[value]}
                    </span>
                    <span className="truncate">
                      {t(`theme.scheme_${value}`)}
                    </span>
                  </button>
                )
              })}
            </div>
          </section>

          <section>
            <h3 className="text-on-surface-variant mb-2 text-xs font-medium">
              {t('theme.source_color_label')}
            </h3>
            <div className="flex items-center gap-2">
              <input
                id="source-color"
                type="color"
                value={draftSourceColor}
                onChange={(event) => setDraftSourceColor(event.target.value)}
                className="border-primary h-9 w-9 shrink-0 cursor-pointer rounded-full border-2 bg-transparent p-0"
                aria-label={t('theme.source_color_label')}
                title={t('theme.source_color_label')}
              />
              <code className="text-on-surface-variant min-w-0 flex-1 text-sm">
                {draftSourceColor.toUpperCase()}
              </code>
              <button
                type="button"
                disabled={!sourceColorChanged}
                onClick={() => setSourceColor(draftSourceColor)}
                className="bg-primary text-on-primary rounded-md px-3 py-1.5 text-xs font-medium disabled:cursor-default disabled:opacity-40"
              >
                {t('theme.apply_source_color')}
              </button>
            </div>
            <p className="text-on-surface-variant mt-2 text-xs">
              {t('theme.source_color_help')}
            </p>
          </section>

          <section>
            <h3 className="text-on-surface-variant mb-2 text-xs font-medium">
              {t('theme.background_color_label')}
            </h3>
            <div
              className="grid grid-cols-2 gap-2"
              role="radiogroup"
              aria-label={t('theme.background_color_label')}
            >
              {backgroundOptions.map(({ value, color }) => {
                const label = t(backgroundLabelKeys[value])
                const selected = backgroundLevel === value
                return (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    aria-label={label}
                    title={`${label} · ${color.toUpperCase()}`}
                    onClick={() => setBackground(value)}
                    className={clsx(
                      'text-on-surface flex min-w-0 items-center gap-2 rounded-md border p-2 text-left text-xs transition-colors',
                      selected
                        ? 'border-primary ring-primary/20 border-2 ring-2'
                        : 'border-outline-variant hover:bg-on-surface/5',
                    )}
                  >
                    <span
                      className="h-7 w-7 shrink-0 rounded border border-black/20"
                      style={{ backgroundColor: color }}
                    />
                    <span className="truncate">{label}</span>
                  </button>
                )
              })}
            </div>
            <p className="text-on-surface-variant mt-2 text-xs">
              {t('theme.background_color_help')}
            </p>
          </section>
        </div>
      </div>
    </div>
  )
}

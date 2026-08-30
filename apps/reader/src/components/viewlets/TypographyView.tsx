import clsx from 'clsx'
import { useCallback, useRef, useState } from 'react'

import { RenditionSpread } from '@flow/epubjs'
import { useAction, useTranslation } from '@flow/reader/hooks'
import { reader, useReaderSnapshot } from '@flow/reader/models'
import { TypographyConfiguration, useSettings } from '@flow/reader/state'

import { PaneViewProps } from '../base'

enum TypographyScope {
  Book,
  Global,
}

const FONT_PRESETS = [
  { value: '', label: 'default' },
  { value: 'serif', label: 'serif' },
  { value: 'sans-serif', label: 'sans-serif' },
  { value: 'system-ui', label: 'system-ui' },
  { value: 'monospace', label: 'monospace' },
] as const

const CUSTOM_FONT_VALUE = '__custom_font__'

export const TypographyView: React.FC<PaneViewProps> = () => {
  const { focusedBookTab } = useReaderSnapshot()
  const [settings, setSettings] = useSettings()
  const [scope, setScope] = useState(TypographyScope.Book)
  const t = useTranslation('typography')
  const [, setAction] = useAction()

  const [localFonts, setLocalFonts] = useState<string[]>([])
  const [fontListStatus, setFontListStatus] = useState<
    'idle' | 'loading' | 'ready' | 'unsupported' | 'failed'
  >('idle')

  const {
    fontFamily,
    fontSize,
    fontWeight,
    lineHeight,
    zoom,
    spread,
    contentWidthPercent,
  } =
    scope === TypographyScope.Book
      ? {
          ...settings,
          ...(focusedBookTab?.book.configuration?.typography ?? {}),
        }
      : settings

  const setTypography = useCallback(
    <K extends keyof TypographyConfiguration>(
      k: K,
      v: TypographyConfiguration[K],
    ) => {
      if (scope === TypographyScope.Book) {
        const bookTab = reader.focusedBookTab
        if (bookTab) {
          const newConfiguration = JSON.parse(
            JSON.stringify(bookTab.book.configuration || {}),
          )
          if (!newConfiguration.typography) {
            newConfiguration.typography = {}
          }
          newConfiguration.typography[k] = v
          bookTab.updateBook({
            configuration: newConfiguration,
          })
        }
      } else {
        setSettings((prev) => ({
          ...prev,
          [k]: v,
        }))
      }
    },
    [scope, setSettings],
  )

  const queryLocalFonts = useCallback(async () => {
    if (fontListStatus === 'loading' || fontListStatus === 'ready') return

    const fontWindow = window as Window & {
      queryLocalFonts?: () => Promise<Array<{ family: string }>>
    }
    if (!fontWindow.queryLocalFonts) {
      setFontListStatus('unsupported')
      return
    }

    try {
      setFontListStatus('loading')
      const fonts = await fontWindow.queryLocalFonts()
      const uniqueFonts = Array.from(
        new Set(fonts.map((font) => font.family).filter(Boolean)),
      ).sort((a, b) => a.localeCompare(b))
      setLocalFonts(uniqueFonts)
      setFontListStatus('ready')
    } catch (error) {
      console.error('Error querying local fonts:', error)
      setFontListStatus('failed')
    }
  }, [fontListStatus])

  const selectedFont =
    FONT_PRESETS.some((font) => font.value === fontFamily) ||
    localFonts.includes(fontFamily ?? '')
      ? fontFamily || ''
      : CUSTOM_FONT_VALUE

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
                text_fields
              </span>
            </button>
            <h2 className="ml-2 font-semibold text-gray-800 dark:text-white">
              {t('title')}
            </h2>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-gray-200 dark:border-gray-700">
          <button
            onClick={() => setScope(TypographyScope.Book)}
            className={clsx(
              'flex-1 py-2 text-sm font-semibold transition-colors',
              scope === TypographyScope.Book
                ? 'border-primary text-primary border-b-2 dark:text-white'
                : 'text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800',
            )}
          >
            {t('scope.book')}
          </button>
          <button
            onClick={() => setScope(TypographyScope.Global)}
            className={clsx(
              'flex-1 py-2 text-sm font-semibold transition-colors',
              scope === TypographyScope.Global
                ? 'border-primary text-primary border-b-2 dark:text-white'
                : 'text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800',
            )}
          >
            {t('scope.global')}
          </button>
        </div>

        {/* Controls */}
        <div
          className="flex-grow space-y-5 overflow-y-auto p-4"
          key={`${scope}${focusedBookTab?.id}`}
        >
          {/* Page View */}
          <div>
            <label
              className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400"
              htmlFor="page-view"
            >
              {t('page_view')}
            </label>
            <div className="relative">
              <select
                className="focus:ring-primary focus:border-primary w-full appearance-none rounded-md border-gray-300 bg-gray-100 py-2 pl-3 pr-8 text-sm text-gray-800 dark:border-gray-600 dark:bg-gray-800 dark:text-white"
                id="page-view"
                value={spread ?? RenditionSpread.Auto}
                onChange={(e) =>
                  setTypography('spread', e.target.value as RenditionSpread)
                }
              >
                <option value={RenditionSpread.Auto}>
                  {t('page_view.double_page')}
                </option>
                <option value={RenditionSpread.None}>
                  {t('page_view.single_page')}
                </option>
              </select>
              <span className="material-symbols-outlined pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-gray-500 dark:text-gray-400">
                expand_more
              </span>
            </div>
          </div>

          {/* Font Family */}
          <div>
            <label
              className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400"
              htmlFor="font-family-select"
            >
              {t('font_family')}
            </label>
            <p className="mb-2 text-xs text-gray-500 dark:text-gray-400">
              {t('font_family_hint')}
            </p>
            <select
              className="focus:ring-primary focus:border-primary w-full rounded-md border border-gray-300 bg-gray-100 py-2 px-3 text-sm text-gray-800 dark:border-gray-600 dark:bg-gray-800 dark:text-white"
              id="font-family-select"
              value={selectedFont}
              onChange={(event) => {
                if (event.target.value !== CUSTOM_FONT_VALUE) {
                  setTypography('fontFamily', event.target.value || undefined)
                }
              }}
            >
              {FONT_PRESETS.map((font) => (
                <option key={font.value || 'default'} value={font.value}>
                  {font.label === 'default' ? t('default') : font.label}
                </option>
              ))}
              {localFonts.map((font) => (
                <option key={font} value={font}>
                  {font}
                </option>
              ))}
              <option value={CUSTOM_FONT_VALUE}>
                {t('font_family_custom')}
              </option>
            </select>
            <div className="mt-2 flex items-center gap-2">
              <button
                type="button"
                onClick={() => void queryLocalFonts()}
                disabled={
                  fontListStatus === 'loading' ||
                  fontListStatus === 'ready' ||
                  fontListStatus === 'unsupported'
                }
                className="text-primary rounded-md border border-gray-300 px-2.5 py-1.5 text-xs font-medium transition-colors hover:bg-gray-100 disabled:cursor-default disabled:opacity-60 dark:border-gray-600 dark:hover:bg-gray-800"
              >
                {fontListStatus === 'loading'
                  ? t('font_family_loading')
                  : t('font_family_load_local')}
              </button>
              {fontListStatus === 'ready' && (
                <span className="text-xs text-gray-500 dark:text-gray-400">
                  {t('font_family_ready')}
                </span>
              )}
            </div>
            {(fontListStatus === 'unsupported' ||
              fontListStatus === 'failed') && (
              <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">
                {t(
                  fontListStatus === 'unsupported'
                    ? 'font_family_unsupported'
                    : 'font_family_failed',
                )}
              </p>
            )}
            <label
              className="mb-1 mt-3 block text-xs font-medium text-gray-500 dark:text-gray-400"
              htmlFor="font-family-custom"
            >
              {t('font_family_custom')}
            </label>
            <input
              type="text"
              list="local-fonts"
              className="focus:ring-primary focus:border-primary w-full rounded-md border border-gray-300 bg-gray-100 py-2 px-3 text-sm text-gray-800 focus:placeholder-transparent dark:border-gray-600 dark:bg-gray-800 dark:text-white"
              id="font-family-custom"
              value={fontFamily || ''}
              placeholder={t('font_family_custom_placeholder')}
              onChange={(event) =>
                setTypography('fontFamily', event.target.value || undefined)
              }
            />
            {localFonts.length > 0 && (
              <datalist id="local-fonts">
                {localFonts.map((font) => (
                  <option key={font} value={font} />
                ))}
              </datalist>
            )}
          </div>

          {/* Font Size */}
          <NumberField
            name={t('font_size')}
            min={14}
            max={28}
            value={fontSize ? parseInt(fontSize) : undefined}
            onChange={(v) => {
              setTypography('fontSize', v ? v + 'px' : undefined)
            }}
            placeholder={t('default')}
          />

          {/* Font Weight */}
          <NumberField
            name={t('font_weight')}
            min={100}
            max={900}
            step={100}
            value={fontWeight}
            onChange={(v) => {
              setTypography('fontWeight', v || undefined)
            }}
            placeholder={t('default')}
          />

          {/* Line Height */}
          <NumberField
            name={t('line_height')}
            min={1}
            step={0.1}
            value={lineHeight}
            onChange={(v) => {
              setTypography('lineHeight', v || undefined)
            }}
            placeholder={t('default')}
          />

          {/* Content Width */}
          <NumberField
            name={t('content_width')}
            min={50}
            max={100}
            step={5}
            value={contentWidthPercent || 90}
            onChange={(v) => {
              setTypography('contentWidthPercent', v || undefined)
            }}
            placeholder={t('default')}
          />

          {/* Zoom */}
          <NumberField
            name={t('zoom')}
            min={1}
            step={0.1}
            value={zoom}
            onChange={(v) => {
              setTypography('zoom', v || undefined)
            }}
            placeholder={t('default')}
          />

          {/* Reset Button */}
          {scope === TypographyScope.Book && (
            <div className="pt-2">
              <button
                onClick={() => {
                  const bookTab = reader.focusedBookTab
                  if (bookTab) {
                    const newConfiguration = JSON.parse(
                      JSON.stringify(bookTab.book.configuration || {}),
                    )
                    newConfiguration.typography = {}
                    bookTab.updateBook({
                      configuration: newConfiguration,
                    })
                  }
                }}
                className="w-full rounded-md border border-gray-300 bg-white py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
              >
                {t('reset_to_global')}
              </button>
            </div>
          )}
        </div>

        {/* Footer removed - use settings icon in main sidebar instead */}
      </div>
    </div>
  )
}

interface NumberFieldProps {
  name: string
  onChange: (v?: number) => void
  min?: number
  max?: number
  step?: number
  value?: number
  placeholder?: string
}

const NumberField: React.FC<NumberFieldProps> = ({
  name,
  onChange,
  min,
  max,
  step,
  value,
  placeholder,
}) => {
  const ref = useRef<HTMLInputElement>(null)

  // Sync ref with value prop
  if (ref.current && value !== undefined) {
    ref.current.value = value.toString()
  }

  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">
        {name}
      </label>
      <div className="focus-within:border-primary focus-within:ring-primary flex items-center rounded-md border border-gray-300 focus-within:ring-1 dark:border-gray-600">
        <button
          onClick={() => {
            if (!ref.current) return
            ref.current.stepDown()
            onChange(Number(ref.current.value))
          }}
          className="rounded-l-md px-3 py-1.5 text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
        >
          -
        </button>
        <input
          ref={ref}
          type="number"
          min={min}
          max={max}
          step={step}
          value={value ?? ''}
          placeholder={placeholder}
          className="w-full border-0 bg-transparent py-1.5 text-center text-sm text-gray-800 [appearance:textfield] focus:placeholder-transparent focus:outline-none focus:ring-0 dark:text-white [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
          onChange={(e) => {
            onChange(e.target.value ? Number(e.target.value) : undefined)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              onChange(
                e.currentTarget.value
                  ? Number(e.currentTarget.value)
                  : undefined,
              )
            }
          }}
        />
        <button
          onClick={() => {
            if (!ref.current) return
            ref.current.stepUp()
            onChange(Number(ref.current.value))
          }}
          className="rounded-r-md px-3 py-1.5 text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
        >
          +
        </button>
      </div>
    </div>
  )
}

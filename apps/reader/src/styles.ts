import { CSSProperties } from 'react'

import { Contents } from '@flow/epubjs'

import { Settings } from './state'
import { keys } from './utils'

export const activeClass = 'bg-primary70'
export const LIGHT_READER_TEXT_COLOR = '#3f484a'
export const DARK_READER_TEXT_COLOR = '#bfc8ca'
export const LIGHT_READER_LINK_COLOR = '#1e40af'
export const DARK_READER_LINK_COLOR = '#93c5fd'
export const READER_LINK_COLOR_PROPERTY = '--lumen-reader-link-color'
export const defaultStyle = {
  html: {
    padding: '0 !important',
    width: '100% !important',
    'max-width': '100% !important',
    margin: '0 !important',
  },
  body: {
    background: 'transparent',
    // width, max-width, and margin removed to allow dynamic centering and prevent cutoff
  },
  iframe: {
    width: '100% !important',
    height: '100% !important',
  },
  'a:any-link': {
    color: `var(${READER_LINK_COLOR_PROPERTY}, ${LIGHT_READER_LINK_COLOR})`,
    'text-decoration': 'none !important',
  },
  '::selection': {
    'background-color': 'rgba(3, 102, 214, 0.2)',
  },
  '.glow-highlight': {
    'background-color': 'rgba(6, 182, 212, 0.4) !important',
    'border-radius': '2px',
    'box-shadow': '0 0 8px rgba(6, 182, 212, 0.6)',
  },
}

const camelToSnake = (str: string) =>
  str.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)

function mapToCss(o: CSSProperties) {
  return keys(o)
    .filter((k) => o[k] !== undefined)
    .map((k) => `${camelToSnake(k)}: ${o[k]} !important;`)
    .join('\n')
}

enum Style {
  Custom = 'custom',
}

export type ReaderContentLayout = 'reflowable' | 'pre-paginated'

// A visible Contents can be styled again after its exact section metadata was
// used by the pre-pagination hook. Remember that decision so an intermediate
// render, while BookTab is still publishing `sections`, cannot accidentally
// apply reflowable typography to a fixed-layout iframe.
const contentLayoutByDocument = new WeakMap<Document, ReaderContentLayout>()

function normalizedTextScale(zoom: number | undefined): number | undefined {
  if (!Number.isFinite(zoom) || zoom === undefined || zoom <= 0)
    return undefined
  return Math.abs(zoom - 1) < 0.0001 ? undefined : zoom
}

function scaleCssLength(value: string, scale: number): string {
  const match = value
    .trim()
    .match(/^([+-]?(?:\d+(?:\.\d+)?|\.\d+))(px|pt|pc|in|cm|mm|q|em|rem|%)$/i)
  if (!match) return value
  const amount = Number(match[1]) * scale
  return `${Number(amount.toFixed(4))}${match[2]}`
}

/**
 * Build the reader stylesheet without flattening the publication's type
 * hierarchy. EPUB body classes commonly choose a different base size for each
 * spine item; setting the root and body establishes one user-selected body
 * size while relative `em`/`rem` headings, notes and quotations keep their
 * intended proportions.
 *
 * Reader-only controls (`spread` and `contentWidthPercent`) are not emitted as
 * arbitrary CSS declarations. Reflowable `zoom` becomes a native root font
 * size before pagination; fixed-layout scaling remains owned by the engine.
 */
export function buildCustomStyleCss(
  settings: Settings,
  layout: ReaderContentLayout = 'reflowable',
): string {
  const { fontSize, fontFamily, fontWeight, lineHeight } = settings
  const textScale =
    layout === 'reflowable' ? normalizedTextScale(settings.zoom) : undefined
  const scaledFontSize =
    fontSize && textScale ? scaleCssLength(fontSize, textScale) : fontSize
  const rootFontSize =
    scaledFontSize ??
    (textScale ? `${Number((textScale * 100).toFixed(4))}%` : '')

  const rootTypography = rootFontSize
    ? `html {
      ${mapToCss({ fontSize: rootFontSize })}
    }
    body {
      ${mapToCss({ fontSize: '1rem' })}
    }`
    : ''

  const explicitReaderTypography = mapToCss({
    fontFamily,
    fontWeight,
    lineHeight,
  })
  const bodyTypography = explicitReaderTypography
    ? `a, article, cite, div, li, p, pre, span, table, body {
      ${explicitReaderTypography}
    }`
    : ''

  // Keep a non-empty stylesheet so clearing every preference replaces a
  // previously injected custom stylesheet instead of leaving it behind.
  return `/* Lumen reader typography */
  ${rootTypography}
  ${bodyTypography}`
}

export function updateCustomStyle(
  contents: Contents | undefined,
  settings: Settings | undefined,
  layout?: ReaderContentLayout,
) {
  if (!contents || !settings) return

  if (layout) contentLayoutByDocument.set(contents.document, layout)
  const effectiveLayout =
    layout ?? contentLayoutByDocument.get(contents.document) ?? 'reflowable'

  return contents.addStylesheetCss(
    buildCustomStyleCss(settings, effectiveLayout),
    Style.Custom,
  )
}

export function lock(l: number, r: number, unit = 'px') {
  const minw = 400
  const maxw = 2560

  return `calc(${l}${unit} + ${r - l} * (100vw - ${minw}px) / ${maxw - minw})`
}

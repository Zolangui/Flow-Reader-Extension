import type { Theme } from '@material/material-color-utilities'

import { compositeColors } from '../color'

export const DEFAULT_LIGHT_READER_BACKGROUND = '#ffffff'
export const DEFAULT_DARK_READER_BACKGROUND = '#24292e'
export const DEFAULT_THEME_SOURCE_COLOR = '#0ea5e9'

export const READER_BACKGROUND_LEVELS = [-1, 1, 3, 5] as const
export type ReaderBackgroundLevel = typeof READER_BACKGROUND_LEVELS[number]

export function normalizeThemeSourceColor(source: string | undefined): string {
  return source && /^#[0-9a-f]{6}$/i.test(source)
    ? source.toLowerCase()
    : DEFAULT_THEME_SOURCE_COLOR
}

const LIGHT_SURFACE_PRIMARY_OPACITY: Record<
  Exclude<ReaderBackgroundLevel, -1>,
  number
> = {
  1: 0.05,
  3: 0.11,
  5: 0.14,
}

export function normalizeReaderBackgroundLevel(
  level: number | undefined,
): ReaderBackgroundLevel {
  return READER_BACKGROUND_LEVELS.includes(level as ReaderBackgroundLevel)
    ? (level as ReaderBackgroundLevel)
    : -1
}

export function readerBackgroundClass(
  dark: boolean,
  level: number | undefined,
): string {
  const normalized = normalizeReaderBackgroundLevel(level)
  return dark || normalized === -1 ? 'bg-default' : `bg-surface${normalized}`
}

/**
 * Resolve the actual opaque reader canvas. Theme controls, the reader iframe
 * and LPE must all consume this function so a preview can never describe a
 * different colour from the one used for contrast analysis.
 */
export function resolveReaderBackgroundColor(
  dark: boolean,
  level: number | undefined,
  materialTheme: Pick<Theme, 'schemes'> | undefined,
): string | undefined {
  if (dark) return DEFAULT_DARK_READER_BACKGROUND

  const normalized = normalizeReaderBackgroundLevel(level)
  if (normalized === -1) return DEFAULT_LIGHT_READER_BACKGROUND
  if (!materialTheme) return undefined

  const { surface, primary } = materialTheme.schemes.light
  return compositeColors(
    surface,
    primary,
    LIGHT_SURFACE_PRIMARY_OPACITY[normalized],
  )
}

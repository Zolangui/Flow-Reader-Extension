import { describe, expect, it } from 'vitest'

import { contrastRatio, parseSrgbColor, RenditionSpread } from '@flow/epubjs'

import {
  buildCustomStyleCss,
  DARK_READER_LINK_COLOR,
  DARK_READER_TEXT_COLOR,
  defaultStyle,
  LIGHT_READER_LINK_COLOR,
  LIGHT_READER_TEXT_COLOR,
  READER_LINK_COLOR_PROPERTY,
} from '../src/styles'

describe('reader typography stylesheet', () => {
  it('provides an accessible fallback link without overriding author priority', () => {
    expect(defaultStyle['a:any-link'].color).toBe(
      `var(${READER_LINK_COLOR_PROPERTY}, ${LIGHT_READER_LINK_COLOR})`,
    )
    expect(defaultStyle['a:any-link'].color).not.toContain('!important')
  })

  it('normalizes only the document base size and preserves relative descendants', () => {
    const css = buildCustomStyleCss({ fontSize: '18px' })

    expect(css).toContain('html {')
    expect(css).toContain('font-size: 18px !important;')
    expect(css).toContain('font-size: 1rem !important;')
    expect(css).not.toMatch(/(?:p|span|div),/)
  })

  it('does not serialize reader-only controls as invalid CSS properties', () => {
    const css = buildCustomStyleCss({
      contentWidthPercent: 90,
      spread: RenditionSpread.Auto,
      zoom: 1.2,
    })

    expect(css).not.toContain('content-width-percent')
    expect(css).not.toContain('spread:')
    expect(css).not.toContain('zoom:')
  })

  it('implements reflowable zoom as native root typography without transforms', () => {
    const css = buildCustomStyleCss({ zoom: 1.2 })

    expect(css).toContain('font-size: 120% !important;')
    expect(css).toContain('font-size: 1rem !important;')
    expect(css).not.toContain('transform')
    expect(css).not.toContain('column-width')
  })

  it('combines an explicit font size and zoom before pagination', () => {
    const css = buildCustomStyleCss({ fontSize: '18px', zoom: 1.2 })

    expect(css).toContain('font-size: 21.6px !important;')
    expect(css).toContain('font-size: 1rem !important;')
  })

  it('does not override the engine scale of a fixed-layout page', () => {
    const css = buildCustomStyleCss({ zoom: 1.4 }, 'pre-paginated')

    expect(css).not.toContain('font-size: 140%')
    expect(css).not.toContain('transform')
  })

  it('keeps body and link colours above the AAA normal-text target', () => {
    const ratio = (foreground: string, background: string) =>
      contrastRatio(parseSrgbColor(foreground)!, parseSrgbColor(background)!)

    expect(ratio(LIGHT_READER_TEXT_COLOR, '#ffffff')).toBeGreaterThanOrEqual(7)
    expect(ratio(DARK_READER_TEXT_COLOR, '#24292e')).toBeGreaterThanOrEqual(7)
    expect(ratio(LIGHT_READER_LINK_COLOR, '#ffffff')).toBeGreaterThanOrEqual(7)
    expect(ratio(DARK_READER_LINK_COLOR, '#24292e')).toBeGreaterThanOrEqual(7)
  })

  it('keeps explicit accessibility typography on the established body-copy selectors', () => {
    const css = buildCustomStyleCss({
      fontFamily: 'Merriweather, serif',
      fontWeight: 500,
      lineHeight: 1.6,
    })

    expect(css).toContain(
      'a, article, cite, div, li, p, pre, span, table, body {',
    )
    expect(css).toContain('font-family: Merriweather, serif !important;')
    expect(css).toContain('font-weight: 500 !important;')
    expect(css).toContain('line-height: 1.6 !important;')
  })
})

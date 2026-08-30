import { describe, expect, it, vi } from 'vitest'

import {
  contrastRatio,
  parseSrgbColor,
  remapOpaquePaletteForDarkTheme,
  resolveComputedSrgbColor,
  srgbToHex,
} from '../src/presentation-color'

describe('presentation colour model', () => {
  it('parses the bounded computed-style subset', () => {
    expect(parseSrgbColor('#f5d6e2')).toMatchObject({ a: 1 })
    const integer = parseSrgbColor('rgb(245, 214, 226)')!
    const percentage = parseSrgbColor('rgb(96.078% 83.922% 88.627%)')!
    expect(integer.r).toBeCloseTo(percentage.r, 4)
    expect(integer.g).toBeCloseTo(percentage.g, 4)
    expect(integer.b).toBeCloseTo(percentage.b, 4)
    expect(parseSrgbColor('rgba(245, 214, 226, 0.5)')?.a).toBe(0.5)
    expect(parseSrgbColor('transparent')).toBeUndefined()
    expect(parseSrgbColor('linear-gradient(red, blue)')).toBeUndefined()
  })

  it('maps the pink fixture into a readable dark pink without changing hue family', () => {
    const sourceSurface = parseSrgbColor('#f5d6e2')!
    const sourceText = parseSrgbColor('#241b20')!
    const canvas = parseSrgbColor('#111827')!
    const remap = remapOpaquePaletteForDarkTheme(
      sourceSurface,
      sourceText,
      canvas,
    )!

    expect(remap).toBeDefined()
    expect(Math.abs(remap.sourceHue - remap.mappedHue)).toBeLessThan(2)
    expect(contrastRatio(remap.text, remap.surface)).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(remap.surface, canvas)).toBeGreaterThanOrEqual(1.25)
    expect(srgbToHex(remap.surface)).not.toMatch(/^#([0-9a-f])\1\1\1\1\1$/)
  })

  it('resolves only the contextual CanvasText system colour', () => {
    const element = document.body
    expect(resolveComputedSrgbColor('CanvasText', element)).toEqual({
      r: 0,
      g: 0,
      b: 0,
      a: 1,
    })
    expect(resolveComputedSrgbColor('ButtonText', element)).toBeUndefined()

    element.style.colorScheme = 'dark'
    expect(resolveComputedSrgbColor('CanvasText', element)).toEqual({
      r: 1,
      g: 1,
      b: 1,
      a: 1,
    })
    element.style.removeProperty('color-scheme')
  })

  it('resolves CSS Color 4 through the browser paint pipeline', () => {
    const context = {
      clearRect: vi.fn(),
      fillRect: vi.fn(),
      fillStyle: '',
      getImageData: vi.fn(() => ({
        data: new Uint8ClampedArray([128, 64, 32, 255]),
      })),
    }
    const getContext = vi
      .spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue(context as unknown as CanvasRenderingContext2D)

    expect(
      resolveComputedSrgbColor('oklch(55% 0.2 30)', document.body),
    ).toEqual({
      r: 128 / 255,
      g: 64 / 255,
      b: 32 / 255,
      a: 1,
    })
    expect(context.fillRect).toHaveBeenCalledWith(0, 0, 1, 1)
    expect(context.getImageData).toHaveBeenCalledWith(0, 0, 1, 1)
    getContext.mockRestore()
  })

  it('preserves ambiguous or already dark relationships', () => {
    const canvas = parseSrgbColor('#111827')!
    expect(
      remapOpaquePaletteForDarkTheme(
        parseSrgbColor('rgba(245, 214, 226, 0.5)')!,
        parseSrgbColor('#241b20')!,
        canvas,
      ),
    ).toBeUndefined()
    expect(
      remapOpaquePaletteForDarkTheme(
        parseSrgbColor('#30343b')!,
        parseSrgbColor('#ffffff')!,
        canvas,
      ),
    ).toBeUndefined()
    expect(
      remapOpaquePaletteForDarkTheme(
        parseSrgbColor('#eeeeee')!,
        parseSrgbColor('#222222')!,
        canvas,
      ),
    ).toBeUndefined()
  })
})

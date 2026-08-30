/**
 * Bounded colour primitives for Presentation Engine operations.
 *
 * The module deliberately accepts only opaque sRGB colours. Browser computed
 * styles normalize the first v1 fixture to this subset; gradients, images,
 * transparency and other compositing models remain outside the operation.
 */

export const PRESENTATION_COLOR_MODEL_VERSION = 3 as const

export type SrgbColor = {
  r: number
  g: number
  b: number
  a: number
}

export type OklchColor = {
  l: number
  c: number
  h: number
}

export type DarkPaletteRemap = {
  surface: SrgbColor
  text: SrgbColor
  sourceHue: number
  mappedHue: number
  contrast: number
}

const clamp = (value: number, minimum = 0, maximum = 1): number =>
  Math.min(maximum, Math.max(minimum, value))

function parseChannel(token: string): number | undefined {
  const value = Number.parseFloat(token)
  if (!Number.isFinite(value)) return undefined
  return token.endsWith('%') ? clamp(value / 100) : clamp(value / 255)
}

function parseAlpha(token: string | undefined): number | undefined {
  if (token === undefined) return 1
  const value = Number.parseFloat(token)
  if (!Number.isFinite(value)) return undefined
  return token.endsWith('%') ? clamp(value / 100) : clamp(value)
}

/** Parse the opaque colour subset emitted by getComputedStyle in v1. */
export function parseSrgbColor(value: string): SrgbColor | undefined {
  const normalized = value.trim().toLowerCase()
  if (normalized === 'transparent') return undefined

  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(normalized)
  if (hex) {
    const expanded =
      hex[1]!.length === 3
        ? [...hex[1]!].map((part) => `${part}${part}`).join('')
        : hex[1]!
    const alpha =
      expanded.length === 8 ? parseInt(expanded.slice(6, 8), 16) / 255 : 1
    return {
      r: parseInt(expanded.slice(0, 2), 16) / 255,
      g: parseInt(expanded.slice(2, 4), 16) / 255,
      b: parseInt(expanded.slice(4, 6), 16) / 255,
      a: alpha,
    }
  }

  const functional = /^rgba?\((.*)\)$/i.exec(normalized)
  if (!functional) return undefined
  const commaSyntax = functional[1]!.includes(',')
  const [channelsPart, slashAlpha] = functional[1]!
    .split('/')
    .map((part) => part.trim())
  const tokens = commaSyntax
    ? channelsPart!.split(',').map((part) => part.trim())
    : channelsPart!.split(/\s+/).filter(Boolean)
  const inlineAlpha =
    commaSyntax && tokens.length === 4 ? tokens.pop() : undefined
  if (tokens.length !== 3) return undefined
  const channels = tokens.map(parseChannel)
  const alpha = parseAlpha(slashAlpha ?? inlineAlpha)
  if (
    channels.some((channel) => channel === undefined) ||
    alpha === undefined
  ) {
    return undefined
  }
  return {
    r: channels[0]!,
    g: channels[1]!,
    b: channels[2]!,
    a: alpha,
  }
}

const resolvedCssColorCache = new WeakMap<
  Document,
  Map<string, SrgbColor | null>
>()

/**
 * Let the browser colour engine convert CSS Color 4 values into the sRGB
 * canvas colour space. Reading one painted pixel is intentional: assigning
 * `fillStyle` alone may preserve an `oklch()`/`color()` serialization and does
 * not prove which colour is actually rendered.
 */
function resolveCssColor4(
  value: string,
  element: Element,
): SrgbColor | undefined {
  const normalized = value.trim().toLowerCase()
  if (!/^(?:oklab|oklch|lab|lch|color)\(/u.test(normalized)) {
    return undefined
  }
  const document = element.ownerDocument
  const cached = resolvedCssColorCache.get(document)?.get(normalized)
  if (cached !== undefined) return cached ?? undefined

  let cache = resolvedCssColorCache.get(document)
  if (!cache) {
    cache = new Map()
    resolvedCssColorCache.set(document, cache)
  }
  try {
    const probe = document.createElement('span')
    probe.style.color = value
    if (!probe.style.color) {
      cache.set(normalized, null)
      return undefined
    }
    const canvas = document.createElement('canvas')
    canvas.width = 1
    canvas.height = 1
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) {
      cache.set(normalized, null)
      return undefined
    }
    context.clearRect(0, 0, 1, 1)
    context.fillStyle = value
    context.fillRect(0, 0, 1, 1)
    const pixel = context.getImageData(0, 0, 1, 1).data
    const resolved = Object.freeze({
      r: pixel[0]! / 255,
      g: pixel[1]! / 255,
      b: pixel[2]! / 255,
      a: pixel[3]! / 255,
    })
    cache.set(normalized, resolved)
    return resolved
  } catch {
    cache.set(normalized, null)
    return undefined
  }
}

/**
 * Resolve the small system-colour subset that browsers may preserve in
 * `getComputedStyle()` instead of serialising to rgb(). CanvasText is the
 * browser default foreground for an EPUB that does not declare a colour.
 *
 * The result is intentionally conditional on the element's effective
 * `color-scheme`. Other system colours remain unknown: guessing operating
 * system palette values would make a paint repair unsafe.
 */
export function resolveComputedSrgbColor(
  value: string,
  element: Element,
): SrgbColor | undefined {
  const parsed = parseSrgbColor(value)
  if (parsed) return parsed
  const cssColor4 = resolveCssColor4(value, element)
  if (cssColor4) return cssColor4
  if (value.trim().toLowerCase() !== 'canvastext') return undefined

  const view = element.ownerDocument.defaultView
  if (!view) return undefined
  if (view.matchMedia?.('(forced-colors: active)').matches) return undefined

  const computed = view.getComputedStyle(element)
  const scheme = (
    computed.colorScheme ||
    computed.getPropertyValue('color-scheme') ||
    'normal'
  )
    .trim()
    .toLowerCase()
  if (!scheme || scheme === 'normal') {
    return { r: 0, g: 0, b: 0, a: 1 }
  }

  const tokens = scheme.split(/\s+/).filter((token) => token !== 'only')
  const supportsLight = tokens.includes('light')
  const supportsDark = tokens.includes('dark')
  if (!supportsLight && !supportsDark) return undefined
  if (supportsDark && !supportsLight) return { r: 1, g: 1, b: 1, a: 1 }
  if (supportsLight && !supportsDark) return { r: 0, g: 0, b: 0, a: 1 }

  const prefersDark = view.matchMedia?.('(prefers-color-scheme: dark)').matches
  return prefersDark ? { r: 1, g: 1, b: 1, a: 1 } : { r: 0, g: 0, b: 0, a: 1 }
}

export function srgbToHex(color: SrgbColor): string {
  const channel = (value: number): string =>
    Math.round(clamp(value) * 255)
      .toString(16)
      .padStart(2, '0')
  return `#${channel(color.r)}${channel(color.g)}${channel(color.b)}`
}

function srgbToLinear(value: number): number {
  return value <= 0.04045
    ? value / 12.92
    : Math.pow((value + 0.055) / 1.055, 2.4)
}

function linearToSrgb(value: number): number {
  return value <= 0.0031308
    ? 12.92 * value
    : 1.055 * Math.pow(value, 1 / 2.4) - 0.055
}

export function relativeLuminance(color: SrgbColor): number {
  return (
    0.2126 * srgbToLinear(color.r) +
    0.7152 * srgbToLinear(color.g) +
    0.0722 * srgbToLinear(color.b)
  )
}

export function contrastRatio(left: SrgbColor, right: SrgbColor): number {
  const lighter = Math.max(relativeLuminance(left), relativeLuminance(right))
  const darker = Math.min(relativeLuminance(left), relativeLuminance(right))
  return (lighter + 0.05) / (darker + 0.05)
}

export function srgbToOklch(color: SrgbColor): OklchColor {
  const r = srgbToLinear(color.r)
  const g = srgbToLinear(color.g)
  const b = srgbToLinear(color.b)
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b
  const lRoot = Math.cbrt(l)
  const mRoot = Math.cbrt(m)
  const sRoot = Math.cbrt(s)
  const labL = 0.2104542553 * lRoot + 0.793617785 * mRoot - 0.0040720468 * sRoot
  const labA = 1.9779984951 * lRoot - 2.428592205 * mRoot + 0.4505937099 * sRoot
  const labB = 0.0259040371 * lRoot + 0.7827717662 * mRoot - 0.808675766 * sRoot
  const c = Math.hypot(labA, labB)
  const rawHue = (Math.atan2(labB, labA) * 180) / Math.PI
  return {
    l: labL,
    c,
    h: c < 1e-7 ? 0 : (rawHue + 360) % 360,
  }
}

function oklchToRawSrgb(color: OklchColor): SrgbColor {
  const radians = (color.h * Math.PI) / 180
  const labA = color.c * Math.cos(radians)
  const labB = color.c * Math.sin(radians)
  const lRoot = color.l + 0.3963377774 * labA + 0.2158037573 * labB
  const mRoot = color.l - 0.1055613458 * labA - 0.0638541728 * labB
  const sRoot = color.l - 0.0894841775 * labA - 1.291485548 * labB
  const l = lRoot ** 3
  const m = mRoot ** 3
  const s = sRoot ** 3
  return {
    r: linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
    a: 1,
  }
}

function inSrgbGamut(color: SrgbColor): boolean {
  return [color.r, color.g, color.b].every(
    (channel) => Number.isFinite(channel) && channel >= 0 && channel <= 1,
  )
}

/** Preserve lightness and hue while reducing chroma to the sRGB boundary. */
export function oklchToSrgbGamut(color: OklchColor): SrgbColor {
  const direct = oklchToRawSrgb(color)
  if (inSrgbGamut(direct)) return direct

  let lower = 0
  let upper = Math.max(0, color.c)
  let mapped = oklchToRawSrgb({ ...color, c: 0 })
  for (let iteration = 0; iteration < 24; iteration += 1) {
    const candidateChroma = (lower + upper) / 2
    const candidate = oklchToRawSrgb({ ...color, c: candidateChroma })
    if (inSrgbGamut(candidate)) {
      lower = candidateChroma
      mapped = candidate
    } else {
      upper = candidateChroma
    }
  }
  return {
    r: clamp(mapped.r),
    g: clamp(mapped.g),
    b: clamp(mapped.b),
    a: 1,
  }
}

function hueDistance(left: number, right: number): number {
  const distance = Math.abs(left - right) % 360
  return Math.min(distance, 360 - distance)
}

export type DarkPaletteRemapOptions = {
  minimumTextContrast?: number
  minimumSurfaceContrast?: number
  minimumSourceChroma?: number
}

/**
 * Generate a dark surface only for a high-confidence opaque relationship.
 * Undefined is the preservation decision, not an error.
 */
export function remapOpaquePaletteForDarkTheme(
  sourceSurface: SrgbColor,
  sourceText: SrgbColor,
  canvas: SrgbColor,
  options: DarkPaletteRemapOptions = {},
): DarkPaletteRemap | undefined {
  if (sourceSurface.a < 0.999 || sourceText.a < 0.999 || canvas.a < 0.999) {
    return undefined
  }

  const minimumTextContrast = options.minimumTextContrast ?? 4.5
  const minimumSurfaceContrast = options.minimumSurfaceContrast ?? 1.25
  const minimumSourceChroma = options.minimumSourceChroma ?? 0.025
  const source = srgbToOklch(sourceSurface)
  const canvasLch = srgbToOklch(canvas)
  if (
    relativeLuminance(canvas) > 0.22 ||
    relativeLuminance(sourceSurface) < 0.45 ||
    source.c < minimumSourceChroma ||
    contrastRatio(sourceText, sourceSurface) < minimumTextContrast
  ) {
    return undefined
  }

  let targetLightness = clamp(canvasLch.l + 0.18, 0.27, 0.44)
  let surface = oklchToSrgbGamut({
    l: targetLightness,
    c: source.c * 0.9,
    h: source.h,
  })
  while (
    contrastRatio(surface, canvas) < minimumSurfaceContrast &&
    targetLightness < 0.5
  ) {
    targetLightness += 0.015
    surface = oklchToSrgbGamut({
      l: targetLightness,
      c: source.c * 0.9,
      h: source.h,
    })
  }

  const sourceTextLch = srgbToOklch(sourceText)
  let text = oklchToSrgbGamut({
    l: 0.94,
    c: Math.min(sourceTextLch.c, 0.035),
    h: sourceTextLch.h,
  })
  if (contrastRatio(text, surface) < minimumTextContrast) {
    text = { r: 1, g: 1, b: 1, a: 1 }
  }
  const contrast = contrastRatio(text, surface)
  const mappedHue = srgbToOklch(surface).h
  if (
    contrast < minimumTextContrast ||
    contrastRatio(surface, canvas) < minimumSurfaceContrast ||
    hueDistance(source.h, mappedHue) > 2
  ) {
    return undefined
  }

  return {
    surface,
    text,
    sourceHue: source.h,
    mappedHue,
    contrast,
  }
}

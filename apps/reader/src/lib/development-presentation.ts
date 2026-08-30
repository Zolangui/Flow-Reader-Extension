import type { PaginationLifecycleContext } from '@flow/epubjs'

import type { TypographyConfiguration } from '../state'

const TEST_BUILD_VALUE = 'true'
// Body text is held to the WCAG AAA normal-text target. The Presentation
// Engine still preserves authored hue/chroma and changes only proven
// low-contrast paint, but no longer stops at the visibly dim AA floor.
export const DEVELOPMENT_PRESENTATION_MINIMUM_TEXT_CONTRAST = 7

export function isDevelopmentPresentationTestBuild(
  value = process.env.NEXT_PUBLIC_LUMEN_PRESENTATION_TEST,
): boolean {
  return value === TEST_BUILD_VALUE
}

/**
 * Compile-time opt-in. Normal, production and packaged builds explicitly set
 * the environment value to false; only the dedicated test script enables it.
 */
export const DEVELOPMENT_PRESENTATION_TEST_ENABLED =
  isDevelopmentPresentationTestBuild()

export type DevelopmentPresentationConfiguration = {
  colorScheme: 'light' | 'dark'
  canvasColor: string
  typography: TypographyConfiguration
}

export function developmentPresentationConfigurationFingerprint(
  configuration: DevelopmentPresentationConfiguration,
): string {
  return JSON.stringify({
    pipeline: 'lumen-reader-presentation-test-v2',
    colorScheme: configuration.colorScheme,
    canvasColor: configuration.canvasColor,
    typography: {
      contentWidthPercent: configuration.typography.contentWidthPercent ?? null,
      fontFamily: configuration.typography.fontFamily ?? null,
      fontSize: configuration.typography.fontSize ?? null,
      fontWeight: configuration.typography.fontWeight ?? null,
      lineHeight: configuration.typography.lineHeight ?? null,
      spread: configuration.typography.spread ?? null,
      zoom: configuration.typography.zoom ?? null,
    },
  })
}

/**
 * Atlas identity contains only inputs that can change pagination. The selected
 * colour scheme remains relevant because an EPUB's authored dark stylesheet
 * may also change fonts or spacing. Canvas and contrast are included too:
 * they participate in the admission gate for that geometry-affecting authored
 * theme, so changing either can select Published instead of the author branch.
 */
export function developmentPresentationGeometryFingerprint(
  configuration: DevelopmentPresentationConfiguration,
): string {
  return JSON.stringify({
    pipeline: 'lumen-reader-presentation-geometry-v2',
    colorScheme: configuration.colorScheme,
    canvasColor: configuration.canvasColor,
    minimumTextContrast: DEVELOPMENT_PRESENTATION_MINIMUM_TEXT_CONTRAST,
    typography: {
      contentWidthPercent: configuration.typography.contentWidthPercent ?? null,
      fontFamily: configuration.typography.fontFamily ?? null,
      fontSize: configuration.typography.fontSize ?? null,
      fontWeight: configuration.typography.fontWeight ?? null,
      lineHeight: configuration.typography.lineHeight ?? null,
      spread: configuration.typography.spread ?? null,
      zoom: configuration.typography.zoom ?? null,
    },
  })
}

export function developmentPresentationRenderingFingerprint(
  configuration: DevelopmentPresentationConfiguration,
  context: PaginationLifecycleContext,
): string {
  return JSON.stringify({
    configuration:
      developmentPresentationConfigurationFingerprint(configuration),
    layout: {
      axis: context.axis,
      columnGap: context.layout.gap,
      columnWidth: context.layout.columnWidth,
      divisor: context.layout.divisor,
      flow: context.layout._flow,
      height: context.layout.height,
      name: context.layout.name,
      pageWidth: context.layout.pageWidth,
      width: context.layout.width,
      writingMode: context.writingMode,
    },
  })
}

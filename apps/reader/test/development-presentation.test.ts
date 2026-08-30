import { describe, expect, it } from 'vitest'

import {
  DEVELOPMENT_PRESENTATION_MINIMUM_TEXT_CONTRAST,
  developmentPresentationConfigurationFingerprint,
  developmentPresentationGeometryFingerprint,
  isDevelopmentPresentationTestBuild,
} from '../src/lib/development-presentation'

describe('development presentation build gate', () => {
  it('targets AAA contrast for normal reader text', () => {
    expect(DEVELOPMENT_PRESENTATION_MINIMUM_TEXT_CONTRAST).toBe(7)
  })

  it('enables only the dedicated exact build value', () => {
    expect(isDevelopmentPresentationTestBuild('true')).toBe(true)
    expect(isDevelopmentPresentationTestBuild('false')).toBe(false)
    expect(isDevelopmentPresentationTestBuild('1')).toBe(false)
    expect(isDevelopmentPresentationTestBuild(undefined)).toBe(false)
  })

  it('invalidates geometry identity when an authored-theme input changes', () => {
    const light = developmentPresentationConfigurationFingerprint({
      colorScheme: 'light',
      canvasColor: '#ffffff',
      typography: { fontSize: '100%', spread: 'auto' },
    })
    const dark = developmentPresentationConfigurationFingerprint({
      colorScheme: 'dark',
      canvasColor: '#24292e',
      typography: { fontSize: '100%', spread: 'auto' },
    })
    const larger = developmentPresentationConfigurationFingerprint({
      colorScheme: 'light',
      canvasColor: '#ffffff',
      typography: { fontSize: '120%', spread: 'auto' },
    })

    expect(dark).not.toBe(light)
    expect(larger).not.toBe(light)
    expect(
      developmentPresentationConfigurationFingerprint({
        colorScheme: 'light',
        canvasColor: '#ffffff',
        typography: { fontSize: '100%', spread: 'auto' },
      }),
    ).toBe(light)
  })

  it('invalidates geometry identity when canvas can change author-theme admission', () => {
    const first = developmentPresentationGeometryFingerprint({
      colorScheme: 'dark',
      canvasColor: '#111827',
      typography: { fontSize: '100%', spread: 'auto' },
    })
    const repainted = developmentPresentationGeometryFingerprint({
      colorScheme: 'dark',
      canvasColor: '#24292e',
      typography: { fontSize: '100%', spread: 'auto' },
    })
    const larger = developmentPresentationGeometryFingerprint({
      colorScheme: 'dark',
      canvasColor: '#24292e',
      typography: { fontSize: '120%', spread: 'auto' },
    })

    expect(repainted).not.toBe(first)
    expect(larger).not.toBe(first)
  })
})

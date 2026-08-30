import { useCallback, useEffect, useMemo } from 'react'

import {
  normalizeReaderBackgroundLevel,
  readerBackgroundClass,
  resolveReaderBackgroundColor,
  type ReaderBackgroundLevel,
} from '@flow/reader/lib/theme-colors'
import { useSettings } from '@flow/reader/state'

import { useColorScheme } from './useColorScheme'
import { useTheme } from './useTheme'

export function useBackground() {
  const [{ theme }, setSettings] = useSettings()
  const { dark } = useColorScheme()
  const rawTheme = useTheme()

  const setBackground = useCallback(
    (background: ReaderBackgroundLevel) => {
      setSettings((prev) => ({
        ...prev,
        theme: {
          ...prev.theme,
          background,
        },
      }))
    },
    [setSettings],
  )

  const level = normalizeReaderBackgroundLevel(theme?.background)

  const background = useMemo(
    () => readerBackgroundClass(Boolean(dark), level),
    [dark, level],
  )

  const backgroundColor = useMemo(() => {
    if (dark === undefined) return undefined
    return resolveReaderBackgroundColor(dark, level, rawTheme)
  }, [dark, level, rawTheme])

  useEffect(() => {
    if (backgroundColor) {
      document
        .querySelector('#theme-color')
        ?.setAttribute('content', backgroundColor)
    }
  }, [backgroundColor])

  return [background, setBackground, backgroundColor] as const
}

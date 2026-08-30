import { useCallback } from 'react'

import { normalizeThemeSourceColor } from '@flow/reader/lib/theme-colors'
import { useSettings } from '@flow/reader/state'

export function useSourceColor() {
  const [{ theme }, setSettings] = useSettings()

  const setSourceColor = useCallback(
    (source: string) => {
      const normalized = normalizeThemeSourceColor(source)
      setSettings((prev) => ({
        ...prev,
        theme: {
          ...prev.theme,
          source: normalized,
        },
      }))
    },
    [setSettings],
  )

  return {
    sourceColor: normalizeThemeSourceColor(theme?.source),
    setSourceColor,
  }
}

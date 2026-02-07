import { useCallback } from 'react'

import locales from '../../locales'
import { useSettings } from '../state'

export function useTranslation(scope?: string) {
  const [settings] = useSettings()
  const locale = settings.locale || 'en-US'

  return useCallback(
    (key: string, params?: Record<string, string | number>) => {
      const fullKey = scope ? `${scope}.${key}` : key
      // Fallback order: selected locale -> en-US -> key itself (never return empty string).
      // This prevents blank UI when a locale file is partial/incomplete.
      // @ts-ignore
      let translation =
        // @ts-ignore
        (locales[locale] && locales[locale][fullKey]) ||
        // @ts-ignore
        (locales['en-US'] && locales['en-US'][fullKey]) ||
        fullKey

      if (params) {
        Object.entries(params).forEach(([k, v]) => {
          translation = translation.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v))
        })
      }
      return translation
    },
    [locale, scope],
  )
}

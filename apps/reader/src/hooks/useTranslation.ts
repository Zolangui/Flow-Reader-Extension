import { useCallback } from 'react'

import locales from '../../locales'
import { useSettings } from '../state'

export function useTranslation(scope?: string) {
  const [settings] = useSettings()
  const locale = settings.locale || 'en-US'

  return useCallback(
    (key: string) => {
      if (!locale) {
        return ''
      }
      // @ts-ignore
      const translation = locales[locale][scope ? `${scope}.${key}` : key]
      return (translation as string) ?? ''
    },
    [locale, scope],
  )
}

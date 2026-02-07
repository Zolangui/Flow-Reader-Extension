import { useEventListener } from '@literal-ui/hooks'
import Dexie from 'dexie'
import React, { useEffect, useState } from 'react'

import {
  ColorScheme,
  useColorScheme,
  useTranslation,
} from '@flow/reader/hooks'
import { reader } from '@flow/reader/models'
import { useSettings } from '@flow/reader/state'
import {
  authorizeDropbox,
  clearDropboxRefreshToken,
  getDropboxRefreshToken,
  OAUTH_SUCCESS_MESSAGE,
} from '@flow/reader/sync'

export const Settings: React.FC = () => {
  const { scheme, setScheme } = useColorScheme()
  const [settings, setSettings] = useSettings()
  const t = useTranslation('settings')

  return (
    <div className="h-full overflow-y-auto bg-white dark:bg-gray-900">
      {/* Fixed Header */}
      <div className="fixed top-0 left-0 right-0 z-10 flex h-16 items-center border-b border-gray-200 bg-white px-4 dark:border-gray-700 dark:bg-gray-900">
        <button
          onClick={() => {
            if (reader.focusedGroup) {
              reader.removeTab(reader.focusedGroup.selectedIndex)
            }
          }}
          className="mr-2 rounded-full p-2 text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
        >
          <span className="material-symbols-outlined text-xl">arrow_back</span>
        </button>
        <h1 className="text-xl font-semibold text-gray-900 dark:text-white">
          {t('title')}
        </h1>
      </div>

      <div className="mx-auto max-w-3xl px-6 py-8 pt-24">
        <div className="space-y-8">
          {/* Language */}
          <div className="border-b border-gray-200 pb-8 dark:border-gray-700">
            <h2 className="text-lg font-medium text-gray-900 dark:text-white">
              {t('language')}
            </h2>
            <p className="mt-1 mb-3 text-sm text-gray-600 dark:text-gray-400">
              {t('language_desc')}
            </p>
            <div className="relative w-full max-w-sm">
              <select
                className="focus:ring-primary w-full appearance-none rounded-lg border-none bg-gray-100 p-3 pr-10 focus:ring-2 dark:bg-gray-800"
                style={{
                  WebkitAppearance: 'none',
                  MozAppearance: 'none',
                  backgroundImage: 'none',
                }}
                value={settings.locale || 'en-US'}
                onChange={(e) => {
                  setSettings({ ...settings, locale: e.target.value })
                }}
              >
                <option value="en-US">English</option>
                <option value="pt-BR">Português (Brasil)</option>
                <option value="es-ES">Español</option>
                <option value="fr-FR">Français</option>
                <option value="de-DE">Deutsch</option>
                <option value="zh-CN">简体中文</option>
                <option value="ja-JP">日本語</option>
              </select>
              <span className="material-symbols-outlined pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-gray-500">
                expand_more
              </span>
            </div>
          </div>

          {/* Color Scheme */}
          <div className="border-b border-gray-200 pb-8 dark:border-gray-700">
            <h2 className="text-lg font-medium text-gray-900 dark:text-white">
              {t('color_scheme')}
            </h2>
            <p className="mt-1 mb-3 text-sm text-gray-600 dark:text-gray-400">
              {t('color_scheme_desc')}
            </p>
            <div className="relative w-full max-w-sm">
              <select
                className="focus:ring-primary w-full appearance-none rounded-lg border-none bg-gray-100 p-3 pr-10 focus:ring-2 dark:bg-gray-800"
                style={{
                  WebkitAppearance: 'none',
                  MozAppearance: 'none',
                  backgroundImage: 'none',
                }}
                value={scheme}
                onChange={(e) => {
                  setScheme(e.target.value as ColorScheme)
                }}
              >
                <option value="system">{t('color_scheme.system')}</option>
                <option value="light">{t('color_scheme.light')}</option>
                <option value="dark">{t('color_scheme.dark')}</option>
              </select>
              <span className="material-symbols-outlined pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-gray-500">
                expand_more
              </span>
            </div>
          </div>

          {/* Synchronization */}
          <Synchronization />

          {/* Cache */}
          <div className="border-b border-gray-200 pb-8 dark:border-gray-700">
            <h2 className="text-lg font-medium text-gray-900 dark:text-white">
              {t('cache')}
            </h2>
            <p className="mt-1 mb-3 text-sm text-gray-600 dark:text-gray-400">
              {t('cache_desc')}
            </p>
            <button
              className="bg-error-container text-on-error-container rounded-full px-6 py-2 font-medium shadow-sm transition-all hover:shadow-md"
              onClick={() => {
                window.localStorage.clear()
                Dexie.getDatabaseNames().then((names) => {
                  names.forEach((n) => Dexie.delete(n))
                })
              }}
            >
              {t('cache.clear')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

const Synchronization: React.FC = () => {
  const [refreshToken, setRefreshToken] = useState<string | null>(null)
  const t = useTranslation('settings.synchronization')

  useEventListener('message', (e) => {
    if (e.data === OAUTH_SUCCESS_MESSAGE) {
      getDropboxRefreshToken().then((token) => setRefreshToken(token))
    }
  })

  useEffect(() => {
    let mounted = true
    getDropboxRefreshToken().then((token) => {
      if (mounted) setRefreshToken(token)
    })
    return () => {
      mounted = false
    }
  }, [])

  return (
    <div className="border-b border-gray-200 pb-8 dark:border-gray-700">
      <h2 className="text-lg font-medium text-gray-900 dark:text-white">
        {t('title')}
      </h2>
      <p className="mt-1 mb-3 text-sm text-gray-600 dark:text-gray-400">
        {t('synchronization_desc')}
      </p>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:gap-4">
        <div className="flex-grow">
          <label
            className="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300"
            htmlFor="sync-service"
          >
            {t('service')}
          </label>
          <div className="relative w-full">
            <select
              className="focus:ring-primary w-full appearance-none rounded-lg border-none bg-gray-100 p-3 pr-10 focus:ring-2 dark:bg-gray-800"
              style={{
                WebkitAppearance: 'none',
                MozAppearance: 'none',
                backgroundImage: 'none',
              }}
              id="sync-service"
            >
              <option value="dropbox">Dropbox</option>
            </select>
            <span className="material-symbols-outlined pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-gray-500">
              expand_more
            </span>
          </div>
        </div>
        <div className="sm:pb-0.5">
          {refreshToken ? (
            <button
              className="bg-primary text-on-primary w-full rounded-full px-6 py-2.5 font-medium shadow-sm transition-all hover:shadow-md sm:w-auto"
              onClick={async () => {
                await clearDropboxRefreshToken()
                setRefreshToken(null)
              }}
            >
              {t('unauthorize')}
            </button>
          ) : (
            <button
              className="bg-primary text-on-primary w-full rounded-full px-6 py-2.5 font-medium shadow-sm transition-all hover:shadow-md sm:w-auto"
              onClick={async () => {
                try {
                  await authorizeDropbox()
                  const token = await getDropboxRefreshToken()
                  setRefreshToken(token)
                } catch (err) {
                  console.error('Dropbox auth failed:', err)
                }
              }}
            >
              {t('authorize')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

Settings.displayName = 'settings'

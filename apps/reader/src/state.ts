import { IS_SERVER } from '@literal-ui/hooks'
import { atom, AtomEffect, useRecoilState } from 'recoil'

import { RenditionSpread } from '@flow/epubjs/types/rendition'

function localStorageEffect<T>(key: string, defaultValue: T): AtomEffect<T> {
  return ({ setSelf, onSet }) => {
    if (IS_SERVER) return

    const savedValue = localStorage.getItem(key)
    if (savedValue === null) {
      localStorage.setItem(key, JSON.stringify(defaultValue))
    } else {
      setSelf(JSON.parse(savedValue))
    }

    onSet((newValue, _, isReset) => {
      isReset
        ? localStorage.removeItem(key)
        : localStorage.setItem(key, JSON.stringify(newValue))
    })
  }
}

export const navbarState = atom<boolean>({
  key: 'navbar',
  default: false,
})

export const zenModeState = atom<boolean>({
  key: 'zen',
  default: false,
  effects: [localStorageEffect('zen', false)],
})

export function useZenMode() {
  return useRecoilState(zenModeState)
}

export const topBarVisibleState = atom<boolean>({
  key: 'topBarVisible',
  default: true,
})

export function useTopBarVisible() {
  return useRecoilState(topBarVisibleState)
}

export const bottomBarVisibleState = atom<boolean>({
  key: 'bottomBarVisible',
  default: true,
})

export function useBottomBarVisible() {
  return useRecoilState(bottomBarVisibleState)
}

export interface Settings extends TypographyConfiguration {
  theme?: ThemeConfiguration
}

export interface TypographyConfiguration {
  fontSize?: string
  fontWeight?: number
  fontFamily?: string
  lineHeight?: number
  spread?: RenditionSpread
  zoom?: number
}

interface ThemeConfiguration {
  source?: string
  background?: number
}

export const defaultSettings: Settings = {}

const settingsState = atom<Settings>({
  key: 'settings',
  default: defaultSettings,
  effects: [localStorageEffect('settings', defaultSettings)],
})

export function useSettings() {
  return useRecoilState(settingsState)
}

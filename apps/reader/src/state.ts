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
  effects: [localStorageEffect<boolean>('zen', false)],
})

export function useZenMode() {
  return useRecoilState(zenModeState)
}

export interface Settings extends TypographyConfiguration {
  theme?: ThemeConfiguration
  locale?: string
}

export interface TypographyConfiguration {
  fontSize?: string
  fontWeight?: number
  fontFamily?: string
  lineHeight?: number
  spread?: RenditionSpread
  zoom?: number
  contentWidthPercent?: number
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

export interface LibraryState {
  viewMode: 'grid' | 'list'
  filter: 'All' | 'Favorites' | 'Unread' | 'In Progress' | 'Finished'
}

export const libraryState = atom<LibraryState>({
  key: 'library',
  default: {
    viewMode: 'grid',
    filter: 'All',
  },
  effects: [localStorageEffect('library', { viewMode: 'grid', filter: 'All' })],
})

export function useLibraryState() {
  return useRecoilState(libraryState)
}

export interface ChatbotMeta {
  canSearchDeeper: boolean
  lastHadContext: boolean
  lastLanguage: string // BCP-47 LangTag (e.g., 'en', 'pt', 'ja', 'zh')
  lastIntent?: string
  lastDepth?: 'short' | 'balanced' | 'deep'
  lastScope?: 'book_only' | 'book_plus_discussion'
  lastQuery?: string
  lastEffectiveQuery?: string
  lastWasDeeper?: boolean
}

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  id: string
}

export interface ChatbotState {
  isOpen: boolean
  messages: ChatMessage[]
  isLoading: boolean
  apiKey?: string
  meta: ChatbotMeta
}

const defaultChatbotMeta: ChatbotMeta = {
  canSearchDeeper: false,
  lastHadContext: true,
  lastLanguage: 'en',
  lastEffectiveQuery: '',
  lastWasDeeper: false,
}

const defaultChatbotState: ChatbotState = {
  isOpen: false,
  messages: [],
  isLoading: false,
  apiKey: '',
  meta: defaultChatbotMeta,
}

function chatbotStorageEffect(
  key: string,
  defaultValue: ChatbotState,
): AtomEffect<ChatbotState> {
  return ({ setSelf, onSet }) => {
    if (IS_SERVER) return

    const savedValue = localStorage.getItem(key)
    if (savedValue === null) {
      localStorage.setItem(key, JSON.stringify(defaultValue))
      setSelf(defaultValue)
    } else {
      try {
        const parsed = JSON.parse(savedValue) as Partial<ChatbotState>
        const merged: ChatbotState = {
          ...defaultValue,
          ...parsed,
          meta: {
            ...defaultValue.meta,
            ...(parsed.meta || {}),
          },
          messages: Array.isArray(parsed.messages)
            ? (parsed.messages as any)
            : defaultValue.messages,
        }
        setSelf(merged)
      } catch {
        setSelf(defaultValue)
      }
    }

    onSet((newValue, _, isReset) => {
      isReset
        ? localStorage.removeItem(key)
        : localStorage.setItem(key, JSON.stringify(newValue))
    })
  }
}

export const chatbotState = atom<ChatbotState>({
  key: 'chatbot',
  default: defaultChatbotState,
  effects: [chatbotStorageEffect('chatbot', defaultChatbotState)],
})

export function useChatbotState() {
  return useRecoilState(chatbotState)
}

import { AISettings, AIProvider } from './lib/ai/config'

export { type AISettings, type AIProvider }

export const defaultAIConfig: AISettings = {
  provider: 'gemini',
  apiKey: '',
  model: 'gemini-1.5-flash',
  temperature: 0.3,
  systemPrompt:
    'You are a helpful assistant answering questions about the book. Use the provided context to answer accurately.',
  baseUrl: '',
  autoPersona: false,
  insightTriggers: false,
  deepThink: false,
  explainSelection: true,
  summarizeSelection: true,
  answerDepth: 'balanced',
  aiScope: 'book_only',
  downloadLocalModels: true,
}

export const aiSettingsState = atom<AISettings>({
  key: 'aiSettings',
  default: defaultAIConfig,
  effects: [localStorageEffect('aiSettings', defaultAIConfig)],
})

export function useAISettings() {
  return useRecoilState(aiSettingsState)
}

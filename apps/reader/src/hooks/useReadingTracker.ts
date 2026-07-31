import {
  createContext,
  createElement,
  type PropsWithChildren,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

import { reader, useReaderSnapshot } from '../models'

export interface ReadingSession {
  date: string // 'YYYY-MM-DD'
  bookId: string
  duration: number // minutes
  pagesRead: number
}

export interface ReadingStats {
  totalTimeMinutes: number
  currentStreak: number
  lastReadDate: string
  sessions: ReadingSession[]
}

const STORAGE_KEY = 'readingStats'
const PAGE_THRESHOLD_MS = 8000 // 8 seconds minimum to count as "read"

export interface ReadingTrackerValue {
  stats: ReadingStats
  todayTime: number
}
const ReadingTrackerContext = createContext<ReadingTrackerValue | null>(null)

function getTodayDate(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return [now.getFullYear(), month, day].join('-')
}

function loadStats(): ReadingStats {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored) {
      return JSON.parse(stored)
    }
  } catch (error) {
    console.error('Error loading reading stats:', error)
  }
  return {
    totalTimeMinutes: 0,
    currentStreak: 0,
    lastReadDate: '',
    sessions: [],
  }
}

function saveStats(stats: ReadingStats) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stats))
  } catch (error) {
    console.error('Error saving reading stats:', error)
  }
}

export function calculateStreak(lastReadDate: string, today: string): number {
  if (!lastReadDate) return 0

  const last = new Date(lastReadDate + 'T00:00:00')
  const current = new Date(today + 'T00:00:00')
  const diffTime = current.getTime() - last.getTime()
  const diffDays = Math.round(diffTime / (1000 * 60 * 60 * 24))

  // If last read was today, keep current streak
  if (diffDays === 0) return -1 // Signal to keep current

  // If last read was yesterday, increment streak
  if (diffDays === 1) return 1 // Signal to increment

  // If more than 1 day ago, reset streak
  return 0
}

export function useReadingTracker() {
  const { focusedBookTab } = useReaderSnapshot()
  const [stats, setStats] = useState<ReadingStats>(loadStats)
  const [activeSessionMinutes, setActiveSessionMinutes] = useState(0)
  const sessionStartTime = useRef<number>(0)
  const intervalRef = useRef<NodeJS.Timeout>()

  // Page tracking with 8-second threshold
  const lastPageTimestamp = useRef<number>(0)
  const lastPercentage = useRef<number>(0)
  const qualifiedPagesRead = useRef<number>(0)
  const sessionBookIdRef = useRef<string | undefined>(undefined)
  const focusedBookId = focusedBookTab?.book.id
  const focusedBookPercentage = focusedBookTab?.book.percentage as
    | number
    | undefined

  // On mount, recalculate streak if user hasn't read in 2+ days
  useEffect(() => {
    const stored = loadStats()
    const today = getTodayDate()
    const streakChange = calculateStreak(stored.lastReadDate, today)

    // If more than 1 day has passed, reset streak to 0
    if (streakChange === 0 && stored.currentStreak !== 0) {
      stored.currentStreak = 0
      saveStats(stored)
      setStats(stored)
    }
  }, [])

  // Initialize session when book opens
  useEffect(() => {
    if (!focusedBookId) {
      sessionBookIdRef.current = undefined
      sessionStartTime.current = 0
      setActiveSessionMinutes(0)
      return
    }

    setActiveSessionMinutes(0)
    sessionBookIdRef.current = focusedBookId
    sessionStartTime.current = Date.now()
    lastPageTimestamp.current = Date.now()
    lastPercentage.current =
      (reader.focusedBookTab?.book.percentage as number) || 0
    qualifiedPagesRead.current = 0

    // Update time every minute
    intervalRef.current = setInterval(() => {
      const elapsed = Math.floor(
        (Date.now() - sessionStartTime.current) / 60000,
      )
      setActiveSessionMinutes(elapsed)
    }, 60000)

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current)
      }
    }
  }, [focusedBookId])

  // Track page changes - monitor percentage changes
  useEffect(() => {
    if (focusedBookPercentage) {
      const currentPercentage = focusedBookPercentage

      // If percentage changed (page turn detected)
      if (
        lastPercentage.current > 0 &&
        Math.abs(currentPercentage - lastPercentage.current) > 0.001
      ) {
        const timeOnPage = Date.now() - lastPageTimestamp.current

        // Only count if user spent at least 8 seconds on the page
        if (timeOnPage >= PAGE_THRESHOLD_MS) {
          qualifiedPagesRead.current += 1
        }
      }

      // Update tracking
      lastPercentage.current = currentPercentage
      lastPageTimestamp.current = Date.now()
    }
  }, [focusedBookPercentage])

  // Save session on unmount or when switching books
  useEffect(() => {
    return () => {
      const sessionBookId = sessionBookIdRef.current
      if (sessionStartTime.current && sessionBookId) {
        const duration = Math.floor(
          (Date.now() - sessionStartTime.current) / 60000,
        )
        if (duration > 0) {
          const today = getTodayDate()
          const updatedStats = loadStats() // Reload to get latest

          // Update or create today's session
          const existingSession = updatedStats.sessions.find(
            (s) => s.date === today && s.bookId === sessionBookId,
          )

          if (existingSession) {
            existingSession.duration += duration
            existingSession.pagesRead += qualifiedPagesRead.current
          } else {
            updatedStats.sessions.push({
              date: today,
              bookId: sessionBookId,
              duration,
              pagesRead: qualifiedPagesRead.current,
            })
          }

          updatedStats.totalTimeMinutes += duration

          // Update streak
          const streakChange = calculateStreak(updatedStats.lastReadDate, today)
          if (streakChange === 1) {
            updatedStats.currentStreak += 1
          } else if (streakChange === 0) {
            updatedStats.currentStreak = 1
          }
          // If -1, keep current streak

          updatedStats.lastReadDate = today

          saveStats(updatedStats)
          setStats(updatedStats)
        }
      }
    }
  }, [focusedBookId])

  const todayTime = useMemo(() => {
    const today = getTodayDate()
    const recordedMinutes = stats.sessions.reduce(
      (total, session) =>
        session.date === today ? total + session.duration : total,
      0,
    )
    return recordedMinutes + activeSessionMinutes
  }, [activeSessionMinutes, stats.sessions])

  return {
    stats,
    todayTime,
  }
}

export function ReadingTrackerProvider({
  children,
}: PropsWithChildren<unknown>) {
  const value = useReadingTracker()
  return createElement(ReadingTrackerContext.Provider, { value }, children)
}

export function useReadingTrackerContext(): ReadingTrackerValue {
  const value = useContext(ReadingTrackerContext)
  if (!value) {
    throw new Error(
      'useReadingTrackerContext must be used inside ReadingTrackerProvider',
    )
  }
  return value
}

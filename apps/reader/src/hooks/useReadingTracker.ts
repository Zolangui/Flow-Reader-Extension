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

import type { CanonicalPosition, ProgressMetricSnapshot } from '@flow/epubjs'

import type { CanonicalMetricIdentity, CanonicalProgressRecord } from '../db'
import { isSupportedCanonicalProgressRecord } from '../db'
import { reader, useReaderSnapshot } from '../models'

/** Historical session shape retained exactly for existing users. */
export interface LegacyReadingSession {
  date: string // 'YYYY-MM-DD'
  bookId: string
  duration: number // whole legacy minutes
  pagesRead: number // legacy qualified page turns
}

/**
 * A v2 session records the underlying reading facts as well as their metric
 * interpretation. It never depends on a local visual page layout.
 *
 * `id` is optional only so an early v2 preview record can still be read. All
 * newly written records receive an id, which makes pagehide/cleanup flushing
 * idempotent.
 */
export interface CanonicalReadingSession {
  schemaVersion: 2
  id?: string
  date: string // 'YYYY-MM-DD'
  bookId: string
  startedAt: number
  endedAt: number
  durationSeconds: number
  startPosition: CanonicalPosition
  endPosition: CanonicalPosition
  startMetric: ProgressMetricSnapshot
  endMetric: ProgressMetricSnapshot
  /** Present on new sessions; omitted only by the early v2 preview format. */
  metricIdentity?: CanonicalMetricIdentity
  /** Sum of observed forward canonical movement during the foreground session. */
  unitsRead: number
}

export type ReadingSession = LegacyReadingSession | CanonicalReadingSession

export interface ReadingStats {
  totalTimeMinutes: number
  currentStreak: number
  lastReadDate: string
  sessions: ReadingSession[]
}

type StoredReadingStats = {
  schemaVersion: 2
  stats: ReadingStats
}

type ReadingContext = {
  bookId: string
  percentage?: number
  canonicalProgress?: CanonicalProgressRecord
}

type ActiveSegmentBase = {
  id: string
  bookId: string
  startedAt: number
  foregroundDurationMs: number
  /** Defined only while the reader page is foregrounded. */
  foregroundStartedAt?: number
}

type ActiveLegacySegment = ActiveSegmentBase & {
  kind: 'legacy'
  lastPageTimestamp: number
  lastPercentage: number
  qualifiedPagesRead: number
}

type ActiveCanonicalSegment = ActiveSegmentBase & {
  kind: 'canonical'
  startCanonical: CanonicalProgressRecord
  lastCanonical: CanonicalProgressRecord
  canonicalUnitsRead: number
  lastMovementAt: number
}

type ActiveReadingSegment = ActiveLegacySegment | ActiveCanonicalSegment

const STORAGE_KEY = 'readingStats'
const STORAGE_SCHEMA_VERSION = 2
const PAGE_THRESHOLD_MS = 8000 // legacy fallback only
const MIN_CANONICAL_SESSION_MS = 10_000
const MIN_LEGACY_SESSION_MS = 60_000
const READING_IDLE_TIMEOUT_MS = 5 * 60_000
const MIN_CANONICAL_MOVEMENT_DWELL_MS = 3000
const MAX_CANONICAL_BURST_UNITS = 2 * 1800
const MAX_CANONICAL_UNITS_PER_SECOND = 400
export const CANONICAL_UNITS_PER_READING_PAGE = 1800

function emptyStats(): ReadingStats {
  return {
    totalTimeMinutes: 0,
    currentStreak: 0,
    lastReadDate: '',
    sessions: [],
  }
}

export interface ReadingTrackerValue {
  stats: ReadingStats
  todayTime: number
}
const ReadingTrackerContext = createContext<ReadingTrackerValue | null>(null)

function getDateForTimestamp(timestamp: number): string {
  const date = new Date(timestamp)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return [date.getFullYear(), month, day].join('-')
}

function getTodayDate(): string {
  return getDateForTimestamp(Date.now())
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object'
}

function isFiniteNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isDateKey(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
}

function isCanonicalPosition(value: unknown): value is CanonicalPosition {
  if (!isRecord(value)) return false

  const validBase =
    typeof value.canonicalModelVersion === 'number' &&
    Number.isInteger(value.canonicalModelVersion) &&
    value.canonicalModelVersion > 0 &&
    typeof value.spineIndex === 'number' &&
    Number.isInteger(value.spineIndex) &&
    value.spineIndex >= 0 &&
    typeof value.resourceHref === 'string' &&
    typeof value.segmentId === 'string' &&
    typeof value.cfi === 'string'

  if (!validBase) return false
  if (
    value.spineItemId !== undefined &&
    typeof value.spineItemId !== 'string'
  ) {
    return false
  }

  if (value.kind === 'text') {
    return (
      isFiniteNonNegativeNumber(value.codePointOffset) &&
      isFiniteNonNegativeNumber(value.domUtf16Offset) &&
      typeof value.isCodePointBoundary === 'boolean'
    )
  }

  if (value.kind === 'atomic') {
    return (
      isFiniteNonNegativeNumber(value.atomIndex) &&
      (value.edge === 'before' || value.edge === 'after')
    )
  }

  return (
    value.kind === 'media' &&
    isFiniteNonNegativeNumber(value.mediaOffsetSeconds) &&
    (value.edge === 'before' || value.edge === 'after')
  )
}

function isProgressMetricSnapshot(
  value: unknown,
): value is ProgressMetricSnapshot {
  if (!isRecord(value)) return false

  return (
    typeof value.algorithmId === 'string' &&
    value.algorithmId.length > 0 &&
    typeof value.algorithmVersion === 'number' &&
    Number.isInteger(value.algorithmVersion) &&
    value.algorithmVersion >= 0 &&
    isFiniteNonNegativeNumber(value.completedUnits) &&
    isFiniteNonNegativeNumber(value.totalUnits) &&
    value.completedUnits <= value.totalUnits
  )
}

function isCanonicalMetricIdentity(
  value: unknown,
): value is CanonicalMetricIdentity {
  if (!isRecord(value)) return false

  const common =
    typeof value.publicationRevision === 'string' &&
    value.publicationRevision.length > 0 &&
    typeof value.canonicalModelVersion === 'number' &&
    Number.isInteger(value.canonicalModelVersion) &&
    value.canonicalModelVersion > 0
  if (!common) return false

  if (value.schemaVersion === 1) {
    return (
      typeof value.locationAlgorithmId === 'string' &&
      value.locationAlgorithmId.length > 0 &&
      typeof value.locationAlgorithmVersion === 'number' &&
      Number.isInteger(value.locationAlgorithmVersion) &&
      value.locationAlgorithmVersion >= 0 &&
      isFiniteNonNegativeNumber(value.markerCodePointInterval) &&
      value.markerCodePointInterval > 0 &&
      typeof value.progressMetricConfigurationFingerprint === 'string'
    )
  }

  return (
    value.schemaVersion === 2 &&
    typeof value.progressMetricAlgorithmId === 'string' &&
    value.progressMetricAlgorithmId.length > 0 &&
    typeof value.progressMetricAlgorithmVersion === 'number' &&
    Number.isInteger(value.progressMetricAlgorithmVersion) &&
    value.progressMetricAlgorithmVersion > 0 &&
    typeof value.progressMetricConfigurationFingerprint === 'string'
  )
}

function cloneCanonicalProgress(
  progress: CanonicalProgressRecord,
): CanonicalProgressRecord {
  return {
    schemaVersion: 1,
    position: { ...progress.position },
    metric: { ...progress.metric },
    ...(progress.metricIdentity
      ? { metricIdentity: { ...progress.metricIdentity } }
      : {}),
    updatedAt: progress.updatedAt,
  }
}

export function isCanonicalReadingSession(
  session: ReadingSession | unknown,
): session is CanonicalReadingSession {
  if (!isRecord(session)) return false

  return (
    session.schemaVersion === 2 &&
    (session.id === undefined || typeof session.id === 'string') &&
    isDateKey(session.date) &&
    typeof session.bookId === 'string' &&
    session.bookId.length > 0 &&
    isFiniteNonNegativeNumber(session.startedAt) &&
    isFiniteNonNegativeNumber(session.endedAt) &&
    session.endedAt >= session.startedAt &&
    isFiniteNonNegativeNumber(session.durationSeconds) &&
    isCanonicalPosition(session.startPosition) &&
    isCanonicalPosition(session.endPosition) &&
    isProgressMetricSnapshot(session.startMetric) &&
    isProgressMetricSnapshot(session.endMetric) &&
    (session.metricIdentity === undefined ||
      isCanonicalMetricIdentity(session.metricIdentity)) &&
    isFiniteNonNegativeNumber(session.unitsRead)
  )
}

function isLegacyReadingSession(value: unknown): value is LegacyReadingSession {
  if (!isRecord(value) || value.schemaVersion === 2) return false

  return (
    isDateKey(value.date) &&
    typeof value.bookId === 'string' &&
    value.bookId.length > 0 &&
    isFiniteNonNegativeNumber(value.duration) &&
    isFiniteNonNegativeNumber(value.pagesRead)
  )
}

function isReadingSession(value: unknown): value is ReadingSession {
  return isCanonicalReadingSession(value) || isLegacyReadingSession(value)
}

export function readingSessionDurationMinutes(session: ReadingSession): number {
  return isCanonicalReadingSession(session)
    ? session.durationSeconds / 60
    : session.duration
}

export function readingSessionEquivalentPages(session: ReadingSession): number {
  return isCanonicalReadingSession(session)
    ? session.unitsRead / CANONICAL_UNITS_PER_READING_PAGE
    : session.pagesRead
}

function normalizeStats(value: unknown): ReadingStats {
  const raw = value as Partial<ReadingStats> | undefined
  if (!raw || typeof raw !== 'object') return emptyStats()

  return {
    totalTimeMinutes: Number.isFinite(raw.totalTimeMinutes)
      ? Math.max(0, Number(raw.totalTimeMinutes))
      : 0,
    currentStreak: Number.isFinite(raw.currentStreak)
      ? Math.max(0, Number(raw.currentStreak))
      : 0,
    lastReadDate: isDateKey(raw.lastReadDate) ? raw.lastReadDate : '',
    // Valid v1 objects remain untouched. Invalid or incomplete records are
    // excluded so a damaged localStorage payload cannot poison averages.
    sessions: Array.isArray(raw.sessions)
      ? raw.sessions.filter(isReadingSession)
      : [],
  }
}

let futureStorageVersionDetected = false

function loadStats(): ReadingStats {
  if (typeof window === 'undefined') return emptyStats()

  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (!stored) return emptyStats()

    const parsed = JSON.parse(stored) as
      | Partial<StoredReadingStats>
      | ReadingStats
    if (
      isRecord(parsed) &&
      typeof parsed.schemaVersion === 'number' &&
      parsed.schemaVersion > STORAGE_SCHEMA_VERSION
    ) {
      futureStorageVersionDetected = true
      console.warn('Reading stats were written by a newer Lumen version')
      return emptyStats()
    }
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      (parsed as Partial<StoredReadingStats>).schemaVersion ===
        STORAGE_SCHEMA_VERSION &&
      (parsed as Partial<StoredReadingStats>).stats
    ) {
      return normalizeStats((parsed as StoredReadingStats).stats)
    }

    return normalizeStats(parsed)
  } catch (error) {
    console.error('Error loading reading stats:', error)
    return emptyStats()
  }
}

function saveStats(stats: ReadingStats) {
  if (typeof window === 'undefined') return
  if (futureStorageVersionDetected) return

  try {
    const payload: StoredReadingStats = {
      schemaVersion: STORAGE_SCHEMA_VERSION,
      stats,
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload))
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

  if (diffDays === 0) return -1
  if (diffDays === 1) return 1
  return 0
}

function sameMetric(
  left: ProgressMetricSnapshot,
  right: ProgressMetricSnapshot,
): boolean {
  return (
    left.algorithmId === right.algorithmId &&
    left.algorithmVersion === right.algorithmVersion &&
    left.totalUnits === right.totalUnits
  )
}

export function sameCanonicalMetricIdentity(
  left: CanonicalMetricIdentity | undefined,
  right: CanonicalMetricIdentity | undefined,
): boolean {
  if (!left || !right || left.schemaVersion !== right.schemaVersion) {
    return left === right
  }
  if (
    left.publicationRevision !== right.publicationRevision ||
    left.canonicalModelVersion !== right.canonicalModelVersion ||
    left.progressMetricConfigurationFingerprint !==
      right.progressMetricConfigurationFingerprint
  ) {
    return false
  }

  if (left.schemaVersion === 1 && right.schemaVersion === 1) {
    return (
      left.locationAlgorithmId === right.locationAlgorithmId &&
      left.locationAlgorithmVersion === right.locationAlgorithmVersion &&
      left.markerCodePointInterval === right.markerCodePointInterval
    )
  }
  return (
    left.schemaVersion === 2 &&
    right.schemaVersion === 2 &&
    left.progressMetricAlgorithmId === right.progressMetricAlgorithmId &&
    left.progressMetricAlgorithmVersion === right.progressMetricAlgorithmVersion
  )
}

function sameCanonicalMetric(
  left: CanonicalProgressRecord,
  right: CanonicalProgressRecord,
): boolean {
  if (!sameMetric(left.metric, right.metric)) return false

  return sameCanonicalMetricIdentity(left.metricIdentity, right.metricIdentity)
}

function totalRecordedMinutes(sessions: ReadingSession[]): number {
  return sessions.reduce(
    (total, session) => total + readingSessionDurationMinutes(session),
    0,
  )
}

function compactCanonicalSessions(
  sessions: ReadingSession[],
): ReadingSession[] {
  const compacted: ReadingSession[] = []
  const canonicalByKey = new Map<string, CanonicalReadingSession>()

  for (const session of sessions) {
    if (!isCanonicalReadingSession(session) || !session.metricIdentity) {
      compacted.push(session)
      continue
    }

    const key = JSON.stringify([
      session.date,
      session.bookId,
      session.metricIdentity,
      session.startMetric.algorithmId,
      session.startMetric.algorithmVersion,
      session.startMetric.totalUnits,
    ])
    const existing = canonicalByKey.get(key)
    if (!existing) {
      const cloned = { ...session }
      canonicalByKey.set(key, cloned)
      compacted.push(cloned)
      continue
    }

    existing.durationSeconds += session.durationSeconds
    existing.unitsRead += session.unitsRead
    if (session.startedAt < existing.startedAt) {
      existing.startedAt = session.startedAt
      existing.startPosition = session.startPosition
      existing.startMetric = session.startMetric
    }
    if (session.endedAt >= existing.endedAt) {
      existing.endedAt = session.endedAt
      existing.endPosition = session.endPosition
      existing.endMetric = session.endMetric
    }
  }

  return compacted
}

function createSessionId(): string {
  if (
    typeof crypto !== 'undefined' &&
    typeof crypto.randomUUID === 'function'
  ) {
    return crypto.randomUUID()
  }

  return `reading-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function segmentForegroundDuration(
  segment: ActiveReadingSegment,
  now: number,
): number {
  return (
    segment.foregroundDurationMs +
    (segment.foregroundStartedAt === undefined
      ? 0
      : Math.max(0, now - segment.foregroundStartedAt))
  )
}

export function qualifiedCanonicalMovementUnits(
  previous: ProgressMetricSnapshot,
  next: ProgressMetricSnapshot,
  elapsedMs: number,
): number {
  if (
    !sameMetric(previous, next) ||
    elapsedMs < MIN_CANONICAL_MOVEMENT_DWELL_MS
  ) {
    return 0
  }
  const forwardUnits = Math.max(
    0,
    next.completedUnits - previous.completedUnits,
  )
  const maximumPlausibleUnits = Math.max(
    MAX_CANONICAL_BURST_UNITS,
    (elapsedMs / 1000) * MAX_CANONICAL_UNITS_PER_SECOND,
  )
  return forwardUnits <= maximumPlausibleUnits ? forwardUnits : 0
}

export function useReadingTracker() {
  const { focusedBookTab, focusedIndex, groups } = useReaderSnapshot()
  const [stats, setStats] = useState<ReadingStats>(loadStats)
  const [activeSessionMinutes, setActiveSessionMinutes] = useState(0)
  const intervalRef = useRef<ReturnType<typeof setInterval>>()
  const activeSegmentRef = useRef<ActiveReadingSegment>()
  const focusedContextRef = useRef<ReadingContext>()
  const isForegroundRef = useRef(false)
  const lastActivityAtRef = useRef(Date.now())

  const focusedBookId = focusedBookTab?.book.id
  // A book can legitimately be open in two groups. The persisted book id is
  // not sufficient to identify the live rendition that owns this session.
  const focusedTabKey = focusedBookTab
    ? `${groups[focusedIndex]?.id ?? ''}:${focusedBookTab.instanceId}`
    : undefined
  const focusedBookPercentage = focusedBookTab?.book.percentage as
    | number
    | undefined
  const focusedCanonicalProgress = focusedBookTab?.book.canonicalProgress

  const refreshActiveTime = (now = Date.now()) => {
    const segment = activeSegmentRef.current
    const duration = segment ? segmentForegroundDuration(segment, now) : 0
    setActiveSessionMinutes(Math.floor(duration / 60_000))
  }

  const pauseActiveSegment = (now = Date.now()) => {
    const segment = activeSegmentRef.current
    if (!segment || segment.foregroundStartedAt === undefined) return

    segment.foregroundDurationMs = segmentForegroundDuration(segment, now)
    segment.foregroundStartedAt = undefined
  }

  const resumeActiveSegment = (now = Date.now()) => {
    const segment = activeSegmentRef.current
    if (!segment || segment.foregroundStartedAt !== undefined) return
    segment.foregroundStartedAt = now
  }

  const updateRecordedStats = (updatedStats: ReadingStats, date: string) => {
    updatedStats.sessions = compactCanonicalSessions(updatedStats.sessions)
    updatedStats.totalTimeMinutes = Math.round(
      totalRecordedMinutes(updatedStats.sessions),
    )

    const streakChange = calculateStreak(updatedStats.lastReadDate, date)
    if (streakChange === 1) {
      updatedStats.currentStreak += 1
    } else if (streakChange === 0) {
      updatedStats.currentStreak = 1
    }
    updatedStats.lastReadDate = date

    saveStats(updatedStats)
    setStats(updatedStats)
  }

  /**
   * Flushes exactly once because it clears the ref before touching storage.
   * `visibilitychange` and `pagehide` frequently arrive together.
   */
  const flushActiveSegment = (endedAt = Date.now()): boolean => {
    const segment = activeSegmentRef.current
    if (!segment) return false

    pauseActiveSegment(endedAt)
    activeSegmentRef.current = undefined
    setActiveSessionMinutes(0)

    const durationMs = segment.foregroundDurationMs
    if (segment.kind === 'canonical') {
      if (
        durationMs < MIN_CANONICAL_SESSION_MS ||
        !sameCanonicalMetric(segment.startCanonical, segment.lastCanonical)
      ) {
        return false
      }

      const updatedStats = loadStats()
      updatedStats.sessions.push({
        schemaVersion: 2,
        id: segment.id,
        date: getDateForTimestamp(segment.startedAt),
        bookId: segment.bookId,
        startedAt: segment.startedAt,
        endedAt,
        durationSeconds: Math.max(1, Math.floor(durationMs / 1000)),
        startPosition: segment.startCanonical.position,
        endPosition: segment.lastCanonical.position,
        startMetric: segment.startCanonical.metric,
        endMetric: segment.lastCanonical.metric,
        ...(segment.startCanonical.metricIdentity
          ? { metricIdentity: segment.startCanonical.metricIdentity }
          : {}),
        unitsRead: segment.canonicalUnitsRead,
      })
      updateRecordedStats(updatedStats, getDateForTimestamp(segment.startedAt))
      return true
    }

    if (durationMs < MIN_LEGACY_SESSION_MS) return false

    const updatedStats = loadStats()
    const duration = Math.floor(durationMs / 60_000)
    const date = getDateForTimestamp(segment.startedAt)
    const existingSession = updatedStats.sessions.find(
      (session): session is LegacyReadingSession =>
        isLegacyReadingSession(session) &&
        session.date === date &&
        session.bookId === segment.bookId,
    )

    if (existingSession) {
      existingSession.duration += duration
      existingSession.pagesRead += segment.qualifiedPagesRead
    } else {
      updatedStats.sessions.push({
        date,
        bookId: segment.bookId,
        duration,
        pagesRead: segment.qualifiedPagesRead,
      })
    }

    updateRecordedStats(updatedStats, date)
    return true
  }

  const startLegacySegment = (context: ReadingContext, now = Date.now()) => {
    activeSegmentRef.current = {
      id: createSessionId(),
      kind: 'legacy',
      bookId: context.bookId,
      startedAt: now,
      foregroundDurationMs: 0,
      foregroundStartedAt: isForegroundRef.current ? now : undefined,
      lastPageTimestamp: now,
      lastPercentage: Number.isFinite(context.percentage)
        ? context.percentage!
        : 0,
      qualifiedPagesRead: 0,
    }
    refreshActiveTime(now)
  }

  const startCanonicalSegment = (
    context: ReadingContext,
    progress: CanonicalProgressRecord,
    now = Date.now(),
  ) => {
    activeSegmentRef.current = {
      id: createSessionId(),
      kind: 'canonical',
      bookId: context.bookId,
      startedAt: now,
      foregroundDurationMs: 0,
      foregroundStartedAt: isForegroundRef.current ? now : undefined,
      startCanonical: cloneCanonicalProgress(progress),
      lastCanonical: cloneCanonicalProgress(progress),
      canonicalUnitsRead: 0,
      lastMovementAt: now,
    }
    refreshActiveTime(now)
  }

  const startSegmentForFocusedContext = (now = Date.now()) => {
    if (activeSegmentRef.current || !isForegroundRef.current) return

    const context = focusedContextRef.current
    if (!context) return

    if (context.canonicalProgress) {
      startCanonicalSegment(context, context.canonicalProgress, now)
    } else {
      startLegacySegment(context, now)
    }
  }

  const rollSegmentAtLocalMidnight = (now = Date.now()) => {
    let segment = activeSegmentRef.current
    while (
      segment &&
      getDateForTimestamp(segment.startedAt) !== getDateForTimestamp(now)
    ) {
      const start = new Date(segment.startedAt)
      const midnight = new Date(
        start.getFullYear(),
        start.getMonth(),
        start.getDate() + 1,
      ).getTime()
      flushActiveSegment(midnight)
      startSegmentForFocusedContext(midnight)
      segment = activeSegmentRef.current
    }
  }

  const markReadingActivity = (now = Date.now()) => {
    rollSegmentAtLocalMidnight(now)
    const idleBoundary = lastActivityAtRef.current + READING_IDLE_TIMEOUT_MS
    if (idleBoundary < now) {
      pauseActiveSegment(idleBoundary)
      const segment = activeSegmentRef.current
      if (segment?.kind === 'canonical') segment.lastMovementAt = now
    }
    lastActivityAtRef.current = now
    if (isForegroundRef.current) resumeActiveSegment(now)
  }

  /**
   * Receives each accepted BookTab relocation. This is deliberately a domain
   * event rather than a React snapshot so rapid relocations cannot coalesce.
   */
  const acceptCanonicalProgress = (
    incomingProgress: CanonicalProgressRecord,
    now = Date.now(),
  ) => {
    if (!isSupportedCanonicalProgressRecord(incomingProgress)) return

    markReadingActivity(now)

    const context = focusedContextRef.current
    if (!context) return

    const progress = cloneCanonicalProgress(incomingProgress)
    context.canonicalProgress = progress

    const segment = activeSegmentRef.current
    if (
      !segment ||
      !isForegroundRef.current ||
      segment.bookId !== context.bookId
    ) {
      return
    }

    // Never put pre-index legacy time in a canonical session. Flush that
    // segment at the exact first canonical snapshot and begin a new one.
    if (segment.kind === 'legacy') {
      flushActiveSegment(now)
      startCanonicalSegment(context, progress, now)
      return
    }

    // A metric upgrade/rebuilt index is a hard session boundary. The old
    // canonical units remain canonical; they must never fall back to page turns.
    if (!sameCanonicalMetric(segment.lastCanonical, progress)) {
      flushActiveSegment(now)
      startCanonicalSegment(context, progress, now)
      return
    }

    const elapsed = Math.max(0, now - segment.lastMovementAt)
    segment.canonicalUnitsRead += qualifiedCanonicalMovementUnits(
      segment.lastCanonical.metric,
      progress.metric,
      elapsed,
    )
    segment.lastCanonical = progress
    segment.lastMovementAt = now
  }

  const acceptLegacyPercentage = (percentage: number, now = Date.now()) => {
    markReadingActivity(now)
    const context = focusedContextRef.current
    if (context) context.percentage = percentage

    const segment = activeSegmentRef.current
    if (
      !segment ||
      !isForegroundRef.current ||
      segment.kind !== 'legacy' ||
      !Number.isFinite(percentage)
    ) {
      return
    }

    if (
      segment.lastPercentage > 0 &&
      Math.abs(percentage - segment.lastPercentage) > 0.001
    ) {
      const timeOnPage = now - segment.lastPageTimestamp
      if (timeOnPage >= PAGE_THRESHOLD_MS) {
        segment.qualifiedPagesRead += 1
      }
    }

    segment.lastPercentage = percentage
    segment.lastPageTimestamp = now
  }

  // On mount, recalculate streak if the last recorded reading day is stale.
  useEffect(() => {
    const stored = loadStats()
    const today = getTodayDate()
    const streakChange = calculateStreak(stored.lastReadDate, today)

    if (streakChange === 0 && stored.currentStreak !== 0) {
      stored.currentStreak = 0
      saveStats(stored)
      setStats(stored)
    }
  }, [])

  // A focused book owns exactly one active segment. The canonical event stream
  // is subscribed before its current value is sampled, closing the race between
  // a render snapshot and a rapid relocation.
  useEffect(() => {
    if (!focusedBookId) {
      focusedContextRef.current = undefined
      isForegroundRef.current = false
      setActiveSessionMinutes(0)
      return
    }

    const tab = reader.focusedBookTab
    if (!tab || tab.book.id !== focusedBookId) return

    const context: ReadingContext = {
      bookId: focusedBookId,
      percentage: focusedBookPercentage,
      canonicalProgress: isSupportedCanonicalProgressRecord(
        focusedCanonicalProgress,
      )
        ? cloneCanonicalProgress(focusedCanonicalProgress)
        : undefined,
    }
    focusedContextRef.current = context

    const unsubscribe = tab.subscribeCanonicalProgress((progress) => {
      if (focusedContextRef.current !== context) return
      acceptCanonicalProgress(progress)
    })

    // The event listener is already live, so this read only fills an initial
    // value that was accepted before subscription.
    if (isSupportedCanonicalProgressRecord(tab.book.canonicalProgress)) {
      context.canonicalProgress = cloneCanonicalProgress(
        tab.book.canonicalProgress,
      )
    }

    const now = Date.now()
    isForegroundRef.current = document.visibilityState !== 'hidden'
    lastActivityAtRef.current = now
    startSegmentForFocusedContext(now)

    const updateActiveTime = () => {
      const current = Date.now()
      rollSegmentAtLocalMidnight(current)
      const idleBoundary = lastActivityAtRef.current + READING_IDLE_TIMEOUT_MS
      if (idleBoundary <= current) pauseActiveSegment(idleBoundary)
      refreshActiveTime(current)
    }
    intervalRef.current = setInterval(updateActiveTime, 30_000)

    const onActivity = () => markReadingActivity()

    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        isForegroundRef.current = false
        // Persist synchronously before a background page can be discarded.
        flushActiveSegment()
      } else {
        isForegroundRef.current = true
        lastActivityAtRef.current = Date.now()
        startSegmentForFocusedContext()
        refreshActiveTime()
      }
    }
    const onBlur = () => {
      isForegroundRef.current = false
      pauseActiveSegment()
      refreshActiveTime()
    }
    const onFocus = () => {
      if (document.visibilityState === 'hidden') return
      isForegroundRef.current = true
      markReadingActivity()
      startSegmentForFocusedContext()
      refreshActiveTime()
    }
    const onPageHide = () => {
      isForegroundRef.current = false
      flushActiveSegment()
    }
    const onPageShow = () => {
      if (document.visibilityState === 'hidden') return
      isForegroundRef.current = true
      lastActivityAtRef.current = Date.now()
      startSegmentForFocusedContext()
      refreshActiveTime()
    }

    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('blur', onBlur)
    window.addEventListener('focus', onFocus)
    window.addEventListener('pagehide', onPageHide)
    window.addEventListener('pageshow', onPageShow)
    document.addEventListener('keydown', onActivity)
    document.addEventListener('pointerdown', onActivity)
    document.addEventListener('wheel', onActivity, { passive: true })

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('pagehide', onPageHide)
      window.removeEventListener('pageshow', onPageShow)
      document.removeEventListener('keydown', onActivity)
      document.removeEventListener('pointerdown', onActivity)
      document.removeEventListener('wheel', onActivity)
      unsubscribe()
      flushActiveSegment()
      isForegroundRef.current = false
      if (focusedContextRef.current === context) {
        focusedContextRef.current = undefined
      }
    }
    // The session is deliberately independent from percentage/progress renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusedBookId, focusedTabKey])

  // Legacy books still receive their old 8-second qualified page-turn metric.
  // Canonical books are updated only through BookTab's event stream above.
  useEffect(() => {
    if (!focusedBookId || !Number.isFinite(focusedBookPercentage)) return
    if (focusedContextRef.current?.bookId !== focusedBookId) return
    acceptLegacyPercentage(focusedBookPercentage!)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusedBookId, focusedBookPercentage])

  const todayTime = useMemo(() => {
    const today = getTodayDate()
    const recordedMinutes = stats.sessions.reduce(
      (total, session) =>
        session.date === today
          ? total + readingSessionDurationMinutes(session)
          : total,
      0,
    )
    return Math.floor(recordedMinutes) + activeSessionMinutes
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

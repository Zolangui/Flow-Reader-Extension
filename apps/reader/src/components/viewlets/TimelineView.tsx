import dayjs from 'dayjs'
import React, { useMemo } from 'react'

import {
  CANONICAL_UNITS_PER_READING_PAGE,
  CanonicalReadingSession,
  isCanonicalReadingSession,
  readingSessionDurationMinutes,
  readingSessionEquivalentPages,
  sameCanonicalMetricIdentity,
  useAction,
  useReadingTrackerContext,
  useTranslation,
} from '@flow/reader/hooks'
import { useReaderSnapshot } from '@flow/reader/models'

import { isSupportedCanonicalProgressRecord } from '../../db'
import { generateHeatmapGrid } from '../../utils/heatmap'
import { PaneViewProps } from '../base'

export const TimelineView: React.FC<PaneViewProps> = () => {
  const [, setAction] = useAction()
  const { stats, todayTime } = useReadingTrackerContext()
  const { focusedBookTab } = useReaderSnapshot()
  const t = useTranslation()

  // Calculate current book progress
  const currentBook = focusedBookTab?.book
  // The Atlas lives on the active tab, not BookRecord: it is exact only for
  // this browser/font/viewport and must never travel through sync or backup.
  const layoutAtlas = focusedBookTab?.layoutAtlasPresentationCompatible
    ? focusedBookTab.layoutAtlas
    : undefined
  const paginationMode = layoutAtlas?.paginationMode
  const hasDiscreteGlobalPagination = !layoutAtlas || paginationMode === 'paged'
  const atlasTotalPages = hasDiscreteGlobalPagination
    ? layoutAtlas?.totalPageCount
    : undefined
  const totalPages = layoutAtlas
    ? atlasTotalPages ?? 0
    : currentBook?.pageCount ?? 0
  const pageCountSource = layoutAtlas
    ? 'layout-atlas'
    : currentBook?.pageCountSource
  const isCalculatingPages =
    !layoutAtlas && (pageCountSource === 'calculating' || !totalPages)
  const isTotalEstimated =
    !layoutAtlas && pageCountSource === 'canonical-estimate'
  const bookPercentage = focusedBookTab?.book.percentage
  const percentage = Number.isFinite(bookPercentage)
    ? Math.max(0, Math.min(1, bookPercentage!))
    : 0
  const exactViewportPages = Array.from(
    new Set(
      (focusedBookTab?.layoutViewportPageIndexes ?? []).filter(
        (page) =>
          Number.isInteger(page) && page >= 0 && page < (atlasTotalPages ?? 0),
      ),
    ),
  ).sort((left, right) => left - right)
  const hasExactVisualPosition =
    !!atlasTotalPages && exactViewportPages.length > 0
  // The fallback is canonical percentage × visual total. It is useful, but
  // never advertised as an exact visual page before a safe atlas mapping is
  // available (for example RTL and forced blank pages need CFI boundaries).
  const pagesRead = hasExactVisualPosition
    ? exactViewportPages[exactViewportPages.length - 1]! + 1
    : Math.round(percentage * totalPages)
  const pagesReadLabel = hasExactVisualPosition
    ? exactViewportPages.length > 1
      ? `${exactViewportPages[0]! + 1}–${
          exactViewportPages[exactViewportPages.length - 1]! + 1
        }`
      : String(pagesRead)
    : String(pagesRead)
  const isPositionEstimated = !hasExactVisualPosition
  const pageTotalStatus = layoutAtlas
    ? isPositionEstimated
      ? t('timeline.page_position_estimated_total_current_layout')
      : t('timeline.page_total_current_layout')
    : isTotalEstimated
    ? t('timeline.page_total_estimated')
    : undefined
  const progress = totalPages > 0 ? percentage * 100 : 0

  // Calculate average speed and estimated finish
  const totalSessions = stats.sessions.filter(
    (s) => s.bookId === currentBook?.id,
  )
  const storedCanonicalProgress = currentBook?.canonicalProgress
  const currentCanonicalProgress = isSupportedCanonicalProgressRecord(
    storedCanonicalProgress,
  )
    ? storedCanonicalProgress
    : undefined
  const canonicalSessions = totalSessions.filter(
    (session): session is CanonicalReadingSession =>
      isCanonicalReadingSession(session) &&
      !!currentCanonicalProgress &&
      sameCanonicalMetricIdentity(
        session.metricIdentity,
        currentCanonicalProgress.metricIdentity,
      ) &&
      session.startMetric.algorithmId ===
        currentCanonicalProgress.metric.algorithmId &&
      session.startMetric.algorithmVersion ===
        currentCanonicalProgress.metric.algorithmVersion &&
      session.startMetric.totalUnits ===
        currentCanonicalProgress.metric.totalUnits,
  )
  const canonicalSeconds = canonicalSessions.reduce(
    (sum, session) => sum + session.durationSeconds,
    0,
  )
  const canonicalUnitsRead = canonicalSessions.reduce(
    (sum, session) => sum + session.unitsRead,
    0,
  )
  const canonicalUnitsPerHour =
    canonicalSeconds > 0 ? (canonicalUnitsRead / canonicalSeconds) * 3600 : 0
  const hasCanonicalSpeed = canonicalUnitsPerHour > 0

  const legacySessions = totalSessions.filter(
    (session) => !isCanonicalReadingSession(session),
  )
  const legacyMinutes = legacySessions.reduce(
    (sum, session) => sum + readingSessionDurationMinutes(session),
    0,
  )
  const legacyPagesRead = legacySessions.reduce(
    (sum, session) => sum + readingSessionEquivalentPages(session),
    0,
  )
  const legacyPagesPerHour =
    legacyMinutes > 0 ? (legacyPagesRead / legacyMinutes) * 60 : 0
  const avgSpeed = hasCanonicalSpeed
    ? Math.round(canonicalUnitsPerHour / CANONICAL_UNITS_PER_READING_PAGE)
    : Math.round(legacyPagesPerHour)
  // Cap display at 200+ to avoid unrealistic numbers breaking layout
  const avgSpeedDisplay = avgSpeed > 200 ? '200+' : avgSpeed.toString()

  const remainingPages = Math.max(0, totalPages - pagesRead)
  const canonicalMetric = currentCanonicalProgress?.metric
  const remainingCanonicalUnits = canonicalMetric
    ? Math.max(0, canonicalMetric.totalUnits - canonicalMetric.completedUnits)
    : 0
  const estFinishMinutes =
    hasCanonicalSpeed && canonicalUnitsPerHour > 0
      ? Math.round((remainingCanonicalUnits / canonicalUnitsPerHour) * 60)
      : avgSpeed > 0 && avgSpeed <= 200
      ? Math.round((remainingPages / avgSpeed) * 60)
      : 0
  const estFinishHours = Math.floor(estFinishMinutes / 60)
  const estFinishMins = estFinishMinutes % 60

  // Generate heatmap data (last 12 weeks = 84 days)
  const heatmapData = useMemo(() => {
    const today = dayjs()
    const data: { [key: string]: number } = {}

    // Initialize all days to 0
    for (let i = 0; i < 84; i++) {
      const date = today.subtract(83 - i, 'day').format('YYYY-MM-DD')
      data[date] = 0
    }

    // Fill in actual reading data
    stats.sessions.forEach((session) => {
      if (data[session.date] !== undefined) {
        data[session.date] += readingSessionDurationMinutes(session)
      }
    })

    const todayKey = today.format('YYYY-MM-DD')
    data[todayKey] = Math.max(data[todayKey] || 0, todayTime)

    return data
  }, [stats.sessions, todayTime])

  // Calculate grid and labels using verified utility
  const {
    grid: heatmapGrid,
    numberOfWeeks,
    monthLabels,
  } = useMemo(() => generateHeatmapGrid(heatmapData), [heatmapData])

  const getIntensityClass = (intensity: number) => {
    switch (intensity) {
      case 1:
        return 'bg-primary/20'
      case 2:
        return 'bg-primary/40'
      case 3:
        return 'bg-primary/70'
      case 4:
        return 'bg-primary'
      default:
        return 'bg-gray-200 dark:bg-gray-700/50'
    }
  }

  return (
    <div className="h-full w-full overflow-hidden bg-white dark:bg-gray-900">
      <div className="flex h-full min-w-[220px] flex-col">
        {/* Header */}
        <div className="flex h-16 shrink-0 items-center justify-between border-b border-gray-200 p-4 dark:border-gray-700">
          <div className="flex items-center">
            <button
              onClick={() => setAction(undefined)}
              className="rounded p-2 text-gray-600 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
            >
              <span className="material-symbols-outlined text-xl">
                bar_chart
              </span>
            </button>
            <h2 className="ml-2 font-semibold text-gray-800 dark:text-white">
              {t('timeline.header')}
            </h2>
          </div>
        </div>

        {/* Content */}
        <div className="flex flex-1 flex-col gap-6 overflow-y-auto p-4">
          {/* Stat Cards */}
          <div className="grid grid-cols-2 gap-4">
            <div className="flex flex-col gap-1 rounded-lg bg-white p-3 shadow-sm dark:bg-gray-800">
              <div className="text-primary flex items-center gap-1.5">
                <span className="material-symbols-outlined text-base">
                  schedule
                </span>
                <p className="text-xs font-medium text-gray-500 dark:text-gray-400">
                  {t('timeline.today_time')}
                </p>
              </div>
              <p className="text-xl font-bold text-gray-900 dark:text-white">
                {todayTime} min
              </p>
            </div>
            <div className="flex flex-col gap-1 rounded-lg bg-white p-3 shadow-sm dark:bg-gray-800">
              <div className="text-primary flex items-center gap-1.5">
                <span className="material-symbols-outlined text-base">
                  local_fire_department
                </span>
                <p className="text-xs font-medium text-gray-500 dark:text-gray-400">
                  {t('timeline.streak')}
                </p>
              </div>
              <p className="text-xl font-bold text-gray-900 dark:text-white">
                {stats.currentStreak}{' '}
                {stats.currentStreak === 1
                  ? t('timeline.day')
                  : t('timeline.days')}
              </p>
            </div>
          </div>

          {/* Current Book Progress */}
          {currentBook && (
            <div className="border-y border-gray-200 py-4 dark:border-gray-800">
              <h3 className="mb-3 text-sm font-semibold text-gray-900 dark:text-white">
                {t('timeline.current_book_progress')}
              </h3>
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between gap-4">
                  <p className="text-sm font-medium text-gray-900 dark:text-white">
                    {t('timeline.pages_read')}
                  </p>
                  <p className="text-xs font-medium text-gray-500 dark:text-gray-400">
                    {isCalculatingPages
                      ? t('timeline.calculating_pages')
                      : !hasDiscreteGlobalPagination
                      ? '—'
                      : `${isPositionEstimated ? '~' : ''}${pagesReadLabel} / ${
                          isTotalEstimated ? '~' : ''
                        }${totalPages}`}
                  </p>
                </div>
                {!isCalculatingPages && pageTotalStatus && (
                  <p className="text-right text-[11px] text-gray-500 dark:text-gray-400">
                    {pageTotalStatus}
                  </p>
                )}
                <div className="h-2 rounded-full bg-gray-200 dark:bg-gray-700">
                  <div
                    className="bg-primary h-2 rounded-full transition-all"
                    style={{ width: `${progress}%` }}
                  ></div>
                </div>
              </div>
              <div className="mt-4 grid grid-cols-2 gap-4">
                <div className="flex flex-col gap-0.5">
                  <p className="text-xs font-medium text-gray-500 dark:text-gray-400">
                    {t('timeline.avg_speed')}
                  </p>
                  <p className="text-sm font-semibold text-gray-900 dark:text-white">
                    {hasCanonicalSpeed ? '~' : ''}
                    {avgSpeedDisplay} pgs/hr
                  </p>
                </div>
                <div className="flex flex-col gap-0.5">
                  <p className="text-xs font-medium text-gray-500 dark:text-gray-400">
                    {t('timeline.est_finish')}
                  </p>
                  <p className="text-sm font-semibold text-gray-900 dark:text-white">
                    {estFinishHours > 0 || estFinishMins > 0
                      ? `~${estFinishHours}h ${estFinishMins}m`
                      : 'N/A'}
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Reading Calendar */}
          <div>
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-gray-900 dark:text-white">
                {t('timeline.reading_calendar')}
              </h3>
              <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
                <span>{t('timeline.less')}</span>
                <div className="flex gap-1">
                  <div className="size-2.5 rounded-sm bg-gray-200 dark:bg-gray-700"></div>
                  <div className="bg-primary/20 size-2.5 rounded-sm"></div>
                  <div className="bg-primary/40 size-2.5 rounded-sm"></div>
                  <div className="bg-primary/70 size-2.5 rounded-sm"></div>
                  <div className="bg-primary size-2.5 rounded-sm"></div>
                </div>
                <span>{t('timeline.more')}</span>
              </div>
            </div>
            <div className="flex flex-col gap-2">
              {/* Month labels row */}
              <div
                className="grid gap-0.5 text-center text-[10px] text-gray-500 dark:text-gray-400"
                style={{
                  gridTemplateColumns: `1.5rem repeat(${numberOfWeeks}, 1fr)`,
                }}
              >
                <div></div>
                {monthLabels.map((label, idx) => (
                  <span
                    key={idx}
                    style={{ gridColumn: label.col + 1 }}
                    className="text-left"
                  >
                    {label.month}
                  </span>
                ))}
              </div>
              {/* Heatmap grid with day labels */}
              <div
                className="grid-rows-7 grid gap-0.5"
                style={{
                  gridTemplateColumns: `1.5rem repeat(${numberOfWeeks}, 1fr)`,
                }}
              >
                {/* Day labels in first column */}
                {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((day, idx) => (
                  <span
                    key={day + idx}
                    className="self-center pr-1 text-right text-[10px] text-gray-500 dark:text-gray-400"
                    style={{ gridColumn: 1, gridRow: idx + 1 }}
                  >
                    {day}
                  </span>
                ))}
                {/* Heatmap cells */}
                {heatmapGrid.map((cell) => (
                  <div
                    key={cell.date}
                    className={`size-2.5 rounded-sm ${getIntensityClass(
                      cell.intensity,
                    )}`}
                    style={{ gridColumn: cell.col + 1, gridRow: cell.row }}
                    title={`${cell.date}: ${heatmapData[cell.date] || 0} min`}
                  ></div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

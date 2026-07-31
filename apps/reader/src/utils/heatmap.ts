import dayjs from 'dayjs'

export interface HeatmapCell {
  date: string
  col: number
  row: number
  intensity: number
}

export interface MonthLabel {
  month: string
  col: number
}

export function generateHeatmapGrid(heatmapData: { [key: string]: number }): {
  grid: HeatmapCell[]
  numberOfWeeks: number
  monthLabels: MonthLabel[]
} {
  const today = dayjs()
  const grid: HeatmapCell[] = []

  // Find the start of our 12-week window (84 days ago, aligned to Sunday)
  const startDate = today.subtract(83, 'day')
  const firstSunday = startDate.subtract(startDate.day(), 'day')
  const totalDays = today.diff(firstSunday, 'day') + 1
  const numberOfWeeks = Math.ceil(totalDays / 7)

  // Generate Grid
  for (let i = 0; i < totalDays; i++) {
    const date = firstSunday.add(i, 'day')

    // Skip days before our actual data range
    if (date.isBefore(startDate)) continue
    if (date.isAfter(today)) continue

    const dayOfWeek = date.day() // 0 = Sunday, 6 = Saturday
    const weekIndex = Math.floor(i / 7) // Which week column

    const minutes = heatmapData[date.format('YYYY-MM-DD')] || 0
    let intensity = 0
    if (minutes > 0 && minutes <= 15) intensity = 1
    else if (minutes > 15 && minutes <= 30) intensity = 2
    else if (minutes > 30 && minutes <= 60) intensity = 3
    else if (minutes > 60) intensity = 4

    grid.push({
      date: date.format('YYYY-MM-DD'),
      col: weekIndex + 1, // CSS grid is 1-indexed
      row: dayOfWeek + 1, // CSS grid is 1-indexed
      intensity,
    })
  }

  // Label the column that actually contains the first visible day of a month.
  const monthLabels: MonthLabel[] = []
  let lastMonth = -1

  for (let week = 0; week < numberOfWeeks; week++) {
    for (let day = 0; day < 7; day++) {
      const date = firstSunday.add(week * 7 + day, 'day')
      if (date.isBefore(startDate) || date.isAfter(today)) continue

      if (date.month() !== lastMonth) {
        monthLabels.push({
          month: date.format('MMM'),
          col: week + 1,
        })
        lastMonth = date.month()
      }
    }
  }

  return { grid, numberOfWeeks, monthLabels }
}

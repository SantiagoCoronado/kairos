// Hand-rolled date helpers for the calendar grids (the app avoids date libs;
// see src/core/schedule.ts for the same choice on the scheduler side).
// All math is local wall-clock; storage conversion happens at the edges.

export const DAY_MS = 86_400_000

export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

export function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)
}

export function addMonths(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + n, 1)
}

/** Monday-start week */
export function startOfWeek(d: Date): Date {
  const day = startOfDay(d)
  const offset = (day.getDay() + 6) % 7 // Mon=0 .. Sun=6
  return addDays(day, -offset)
}

export function weekDays(anchor: Date): Date[] {
  const first = startOfWeek(anchor)
  return Array.from({ length: 7 }, (_, i) => addDays(first, i))
}

/** 6×7 month grid (fixed height so the layout never jumps) */
export function monthGrid(anchor: Date): Date[] {
  const first = startOfWeek(new Date(anchor.getFullYear(), anchor.getMonth(), 1))
  return Array.from({ length: 42 }, (_, i) => addDays(first, i))
}

export function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  )
}

export function isToday(d: Date): boolean {
  return isSameDay(d, new Date())
}

/** YYYY-MM-DD in local time */
export function toDateKey(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

/** local midnight of a YYYY-MM-DD key */
export function fromDateKey(key: string): Date {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y, m - 1, d)
}

/** stored event boundary → Date: all-day rows hold date keys, timed rows ISO */
export function parseEventDate(s: string): Date {
  return s.length === 10 ? fromDateKey(s) : new Date(s)
}

export function minutesOfDay(d: Date): number {
  return d.getHours() * 60 + d.getMinutes()
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

export function fmtTime(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function fmtMonthTitle(d: Date): string {
  return `${d.toLocaleString('en-US', { month: 'long' })} ${d.getFullYear()}`
}

export function fmtDayTitle(d: Date): string {
  return `${WEEKDAYS[(d.getDay() + 6) % 7]}, ${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`
}

export function fmtWeekTitle(days: Date[]): string {
  const a = days[0]
  const b = days[days.length - 1]
  if (a.getMonth() === b.getMonth())
    return `${MONTHS[a.getMonth()]} ${a.getDate()} – ${b.getDate()}, ${b.getFullYear()}`
  return `${MONTHS[a.getMonth()]} ${a.getDate()} – ${MONTHS[b.getMonth()]} ${b.getDate()}, ${b.getFullYear()}`
}

/** 'HH:MM' input value from a Date */
export function toTimeKey(d: Date): string {
  return fmtTime(d)
}

/** combine a local date key + 'HH:MM' into a Date */
export function combineDateTime(dateKey: string, timeKey: string): Date {
  const d = fromDateKey(dateKey)
  const [h, m] = timeKey.split(':').map(Number)
  d.setHours(h || 0, m || 0, 0, 0)
  return d
}

import type { NoteRepeat, AgentSchedule } from './types'

// Pure date math for the main-process scheduler. All arithmetic uses local
// wall-clock time so a "9am daily" reminder stays 9am across DST changes.

/**
 * Next occurrence of a recurring reminder, strictly after `now`.
 * Skips missed occurrences (catch-up after sleep fires once, then resumes
 * the normal cadence). Monthly/yearly clamp to the last day of short months
 * while remembering the intended day (Jan 31 → Feb 28 → Mar 31).
 * Returns null for repeat 'none'.
 */
export function advanceReminder(
  remindAt: string,
  repeat: NoteRepeat,
  now: Date = new Date()
): string | null {
  if (repeat === 'none') return null
  const d = new Date(remindAt)
  if (Number.isNaN(d.getTime())) return null
  const wantDay = d.getDate()
  let months = 0
  let guard = 0
  while (d.getTime() <= now.getTime() && guard++ < 10_000) {
    switch (repeat) {
      case 'daily':
        d.setDate(d.getDate() + 1)
        break
      case 'weekly':
        d.setDate(d.getDate() + 7)
        break
      case 'monthly':
        months += 1
        setMonthClamped(d, new Date(remindAt), months, wantDay)
        break
      case 'yearly':
        months += 12
        setMonthClamped(d, new Date(remindAt), months, wantDay)
        break
    }
  }
  return d.toISOString()
}

export interface ScheduleFields {
  schedule: AgentSchedule
  /** 'HH:MM' local wall-clock */
  scheduled_time: string | null
  /** weekly: 0=Sun..6=Sat; monthly: 1..31 */
  scheduled_day: number | null
  /** once: full ISO datetime */
  scheduled_date: string | null
}

/**
 * Next execution of an agent task, strictly after `from`, as UTC ISO.
 * Local wall-clock semantics: a daily 08:00 task stays 08:00 across DST.
 * Returns null when there is no future occurrence (a lapsed 'once').
 */
export function computeNextRun(t: ScheduleFields, from: Date = new Date()): string | null {
  if (t.schedule === 'once') {
    if (!t.scheduled_date) return null
    const d = new Date(t.scheduled_date)
    if (Number.isNaN(d.getTime())) return null
    return d.getTime() > from.getTime() ? d.toISOString() : null
  }

  const [h, mi] = parseHHMM(t.scheduled_time)
  const d = new Date(from)
  d.setHours(h, mi, 0, 0)

  if (t.schedule === 'daily') {
    if (d.getTime() <= from.getTime()) d.setDate(d.getDate() + 1)
    return d.toISOString()
  }

  if (t.schedule === 'weekly') {
    const want = clampInt(t.scheduled_day ?? 1, 0, 6)
    let ahead = (want - d.getDay() + 7) % 7
    if (ahead === 0 && d.getTime() <= from.getTime()) ahead = 7
    d.setDate(d.getDate() + ahead)
    return d.toISOString()
  }

  // monthly
  const wantDay = clampInt(t.scheduled_day ?? 1, 1, 31)
  const candidate = (y: number, m: number): Date => {
    const daysInMonth = new Date(y, m + 1, 0).getDate()
    return new Date(y, m, Math.min(wantDay, daysInMonth), h, mi, 0, 0)
  }
  let c = candidate(from.getFullYear(), from.getMonth())
  if (c.getTime() <= from.getTime()) c = candidate(from.getFullYear(), from.getMonth() + 1)
  return c.toISOString()
}

function parseHHMM(v: string | null): [number, number] {
  const m = /^(\d{1,2}):(\d{2})$/.exec(v ?? '')
  if (!m) return [9, 0] // sensible default when the form left time empty
  return [clampInt(Number(m[1]), 0, 23), clampInt(Number(m[2]), 0, 59)]
}

function clampInt(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.trunc(n)))
}

/** set `d` to `base + months`, clamping the day-of-month to what exists */
function setMonthClamped(d: Date, base: Date, months: number, wantDay: number): void {
  const y = base.getFullYear()
  const m = base.getMonth() + months
  const daysInMonth = new Date(y, m + 1, 0).getDate()
  d.setFullYear(y)
  d.setDate(1)
  d.setMonth(m)
  d.setDate(Math.min(wantDay, daysInMonth))
  d.setHours(base.getHours(), base.getMinutes(), base.getSeconds(), base.getMilliseconds())
}

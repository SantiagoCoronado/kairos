import { describe, it, expect } from 'vitest'
import { advanceReminder, computeNextRun } from './schedule'

// helper: build a local-time date and return its ISO form
const local = (y: number, mo: number, d: number, h = 9, mi = 0): Date =>
  new Date(y, mo - 1, d, h, mi, 0, 0)

describe('advanceReminder', () => {
  it("returns null for repeat 'none'", () => {
    expect(advanceReminder(new Date().toISOString(), 'none')).toBeNull()
  })

  it('daily advances to the next day at the same wall-clock time', () => {
    const remind = local(2026, 7, 1, 9)
    const now = local(2026, 7, 1, 9, 5)
    const next = advanceReminder(remind.toISOString(), 'daily', now)
    expect(new Date(next!).getTime()).toBe(local(2026, 7, 2, 9).getTime())
  })

  it('daily catch-up after a long sleep lands on the next future slot (fires once)', () => {
    const remind = local(2026, 7, 1, 9)
    const now = local(2026, 7, 10, 12) // app closed for 9 days
    const next = advanceReminder(remind.toISOString(), 'daily', now)
    expect(new Date(next!).getTime()).toBe(local(2026, 7, 11, 9).getTime())
  })

  it('weekly advances by 7 days', () => {
    const remind = local(2026, 7, 1, 18)
    const now = local(2026, 7, 1, 18, 1)
    const next = advanceReminder(remind.toISOString(), 'weekly', now)
    expect(new Date(next!).getTime()).toBe(local(2026, 7, 8, 18).getTime())
  })

  it('monthly clamps Jan 31 → Feb 28 → Mar 31 (remembers the intended day)', () => {
    const remind = local(2026, 1, 31, 9)
    const feb = advanceReminder(remind.toISOString(), 'monthly', local(2026, 1, 31, 10))
    expect(new Date(feb!).getTime()).toBe(local(2026, 2, 28, 9).getTime())
    // advancing again from the ORIGINAL anchor past Feb lands on Mar 31
    const mar = advanceReminder(remind.toISOString(), 'monthly', local(2026, 3, 1, 0))
    expect(new Date(mar!).getTime()).toBe(local(2026, 3, 31, 9).getTime())
  })

  it('monthly keeps a mid-month day stable', () => {
    const remind = local(2026, 7, 15, 8)
    const next = advanceReminder(remind.toISOString(), 'monthly', local(2026, 7, 15, 8, 1))
    expect(new Date(next!).getTime()).toBe(local(2026, 8, 15, 8).getTime())
  })

  it('yearly advances a year; Feb 29 clamps to Feb 28 on non-leap years', () => {
    const remind = local(2024, 2, 29, 12)
    const next = advanceReminder(remind.toISOString(), 'yearly', local(2024, 3, 1, 0))
    expect(new Date(next!).getTime()).toBe(local(2025, 2, 28, 12).getTime())
  })

  it('keeps wall-clock time across a DST boundary (daily)', () => {
    // US DST 2026: springs forward Mar 8. 9am local stays 9am local.
    const remind = local(2026, 3, 7, 9)
    const next = advanceReminder(remind.toISOString(), 'daily', local(2026, 3, 7, 9, 1))
    const d = new Date(next!)
    expect(d.getHours()).toBe(9)
    expect(d.getDate()).toBe(8)
  })

  it('returns null on unparseable input', () => {
    expect(advanceReminder('garbage', 'daily')).toBeNull()
  })
})

describe('computeNextRun', () => {
  const fields = (
    schedule: 'once' | 'daily' | 'weekly' | 'monthly',
    over: Partial<{ scheduled_time: string | null; scheduled_day: number | null; scheduled_date: string | null }> = {}
  ): Parameters<typeof computeNextRun>[0] => ({
    schedule,
    scheduled_time: null,
    scheduled_day: null,
    scheduled_date: null,
    ...over
  })

  it('once: future date passes through, past date returns null', () => {
    const future = local(2026, 8, 1, 10)
    const from = local(2026, 7, 1, 12)
    expect(computeNextRun(fields('once', { scheduled_date: future.toISOString() }), from)).toBe(
      future.toISOString()
    )
    expect(
      computeNextRun(fields('once', { scheduled_date: local(2026, 6, 1).toISOString() }), from)
    ).toBeNull()
    expect(computeNextRun(fields('once'), from)).toBeNull()
  })

  it('daily: today at HH:MM if still ahead, else tomorrow', () => {
    const from = local(2026, 7, 1, 7, 30) // 07:30
    const todayRun = computeNextRun(fields('daily', { scheduled_time: '08:00' }), from)
    expect(new Date(todayRun!).getTime()).toBe(local(2026, 7, 1, 8).getTime())
    const tomorrowRun = computeNextRun(fields('daily', { scheduled_time: '07:00' }), from)
    expect(new Date(tomorrowRun!).getTime()).toBe(local(2026, 7, 2, 7).getTime())
  })

  it('weekly: next matching weekday, a full week when today already passed', () => {
    // 2026-07-01 is a Wednesday (day 3)
    const from = local(2026, 7, 1, 12)
    const friday = computeNextRun(
      fields('weekly', { scheduled_day: 5, scheduled_time: '09:00' }),
      from
    )
    expect(new Date(friday!).getTime()).toBe(local(2026, 7, 3, 9).getTime())
    // Wednesday 09:00 already lapsed at noon → next Wednesday
    const wednesday = computeNextRun(
      fields('weekly', { scheduled_day: 3, scheduled_time: '09:00' }),
      from
    )
    expect(new Date(wednesday!).getTime()).toBe(local(2026, 7, 8, 9).getTime())
  })

  it('monthly: this month if ahead, next month when lapsed, day clamped', () => {
    const from = local(2026, 7, 10, 12)
    const ahead = computeNextRun(
      fields('monthly', { scheduled_day: 15, scheduled_time: '08:00' }),
      from
    )
    expect(new Date(ahead!).getTime()).toBe(local(2026, 7, 15, 8).getTime())
    const lapsed = computeNextRun(
      fields('monthly', { scheduled_day: 5, scheduled_time: '08:00' }),
      from
    )
    expect(new Date(lapsed!).getTime()).toBe(local(2026, 8, 5, 8).getTime())
    // day 31 clamps in a 30-day month: from June 20 → June 30
    const clamped = computeNextRun(
      fields('monthly', { scheduled_day: 31, scheduled_time: '08:00' }),
      local(2026, 6, 20, 12)
    )
    expect(new Date(clamped!).getTime()).toBe(local(2026, 6, 30, 8).getTime())
  })

  it('defaults to 09:00 when time is missing', () => {
    const from = local(2026, 7, 1, 7)
    const next = computeNextRun(fields('daily'), from)
    expect(new Date(next!).getHours()).toBe(9)
  })
})

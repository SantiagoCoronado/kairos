import { describe, it, expect, beforeEach } from 'vitest'
import type { DbDriver } from './driver'
import { openNodeSqliteDb } from './drivers/node-sqlite'
import { migrate } from './migrations'
import { applySmartIntent, fixSpokenDates } from './smart-capture'
import * as people from './repo/people'
import * as tasks from './repo/tasks'
import * as notes from './repo/notes'
import * as calendar from './repo/calendar'

const T0 = new Date('2026-07-01T12:00:00')

let db: DbDriver
beforeEach(() => {
  db = openNodeSqliteDb(':memory:')
  migrate(db)
})

describe('applySmartIntent', () => {
  it('creates a task with clamped priority and validated due date', () => {
    const r = applySmartIntent(
      db,
      { kind: 'task', title: 'Pay rent', priority: 9, due_date: '2026-07-03', area: 'personal' },
      T0
    )
    expect(r).toMatchObject({ ok: true, entity: 'tasks', appEvent: 'task_created' })
    expect(r.message).toBe('Task: Pay rent (due 2026-07-03)')
    const [t] = tasks.listTasks(db, {})
    expect(t.priority).toBe(4)
  })

  it('rejects a garbage due date instead of storing it', () => {
    applySmartIntent(db, { kind: 'task', title: 'X', due_date: 'next friday-ish' }, T0)
    const [t] = tasks.listTasks(db, {})
    expect(t.due_date).toBeNull()
  })

  it('creates a note from content when no title is given', () => {
    const r = applySmartIntent(
      db,
      { kind: 'note', content: 'gift ideas: watch, espresso cups' },
      T0
    )
    expect(r.ok).toBe(true)
    const [n] = notes.listNotes(db, {})
    expect(n.title).toBe('gift ideas: watch, espresso cups')
  })

  it('creates a timed event and defaults the end to +1h', () => {
    const r = applySmartIntent(
      db,
      { kind: 'event', title: 'Dentist', start_at: '2026-07-15T15:00' },
      T0
    )
    expect(r).toMatchObject({ ok: true, entity: 'calendar_events' })
    expect(r.message).toBe('Event: Dentist (Jul 15, 3 PM)')
    const [e] = calendar.listEventsInRange(db, '2026-07-15T00:00', '2026-07-16T00:00')
    expect(e.end_at).toBe('2026-07-15T16:00')
    expect(e.all_day).toBeFalsy()
  })

  it('date-only start becomes an all-day event', () => {
    const r = applySmartIntent(db, { kind: 'event', title: 'Offsite', start_at: '2026-07-20' }, T0)
    expect(r.ok).toBe(true)
    expect(r.message).toBe('Event: Offsite (Jul 20)')
  })

  it('event without a usable time fails without writing', () => {
    const r = applySmartIntent(db, { kind: 'event', title: 'Sync', start_at: 'later' }, T0)
    expect(r.ok).toBe(false)
    expect(calendar.listEventsInRange(db, '2020-01-01', '2030-01-01')).toHaveLength(0)
  })

  it('logs an interaction against a fuzzy-matched person', () => {
    people.upsertPerson(db, { name: 'Anna Martinez' })
    const r = applySmartIntent(
      db,
      { kind: 'interaction', person: 'anna', summary: 'Talked about the reorg' },
      T0
    )
    expect(r).toMatchObject({ ok: true, entity: 'interactions' })
    expect(r.message).toBe('Logged for Anna Martinez')
  })

  it('unknown person fails cleanly', () => {
    const r = applySmartIntent(db, { kind: 'interaction', person: 'zoe', summary: 'lunch' }, T0)
    expect(r.ok).toBe(false)
    expect(r.message).toContain('zoe')
  })

  it('unknown kind fails cleanly', () => {
    const r = applySmartIntent(db, { kind: 'banana' as never }, T0)
    expect(r.ok).toBe(false)
  })
})

describe('fixSpokenDates', () => {
  // T0 is Wednesday 2026-07-01 → friday=07-03, tomorrow=07-02

  it('overrules an off-by-one task due date when a weekday was spoken', () => {
    const fixed = fixSpokenDates(
      'call the accountant on friday',
      { kind: 'task', title: 'Call', due_date: '2026-07-04' },
      T0
    )
    expect(fixed.due_date).toBe('2026-07-03')
  })

  it('keeps a correct date untouched', () => {
    const fixed = fixSpokenDates(
      'call the accountant on friday',
      { kind: 'task', title: 'Call', due_date: '2026-07-03' },
      T0
    )
    expect(fixed.due_date).toBe('2026-07-03')
  })

  it('leaves explicit non-weekday dates alone', () => {
    const fixed = fixSpokenDates(
      'pay rent on the 15th',
      { kind: 'task', title: 'Rent', due_date: '2026-07-15' },
      T0
    )
    expect(fixed.due_date).toBe('2026-07-15')
  })

  it('shifts a timed event to the spoken day, keeping the time', () => {
    const fixed = fixSpokenDates(
      'standup friday at 9 am',
      { kind: 'event', title: 'Standup', start_at: '2026-07-04T09:00', end_at: '2026-07-04T09:30' },
      T0
    )
    expect(fixed.start_at).toBe('2026-07-03T09:00')
    expect(fixed.end_at).toBe('2026-07-03T09:30')
  })

  it('handles "tomorrow" for events', () => {
    const fixed = fixSpokenDates(
      'dentist tomorrow at 3 pm',
      { kind: 'event', title: 'Dentist', start_at: '2026-07-03T15:00' },
      T0
    )
    expect(fixed.start_at).toBe('2026-07-02T15:00')
  })
})

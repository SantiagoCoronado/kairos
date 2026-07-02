import { describe, it, expect, beforeEach } from 'vitest'
import type { DbDriver } from './driver'
import { openNodeSqliteDb } from './drivers/node-sqlite'
import { migrate } from './migrations'
import { parseCapture, parseDue, executeCapture } from './capture'
import * as people from './repo/people'

const T0 = new Date('2026-07-01T12:00:00Z') // a Wednesday

let db: DbDriver
beforeEach(() => {
  db = openNodeSqliteDb(':memory:')
  migrate(db)
})

describe('parseDue', () => {
  it('handles iso, today, tomorrow, weekday', () => {
    expect(parseDue('2026-08-01', T0)).toBe('2026-08-01')
    expect(parseDue('today', T0)).toBe('2026-07-01')
    expect(parseDue('tomorrow', T0)).toBe('2026-07-02')
    expect(parseDue('fri', T0)).toBe('2026-07-03')
    // same weekday rolls a full week forward, never "today"
    expect(parseDue('wed', T0)).toBe('2026-07-08')
    expect(parseDue('nonsense', T0)).toBeUndefined()
  })
})

describe('parseCapture', () => {
  it('parses plain task', () => {
    expect(parseCapture('buy milk', T0)).toEqual({
      kind: 'task',
      title: 'buy milk',
      area: undefined,
      priority: undefined,
      due_date: undefined
    })
  })

  it('extracts modifiers anywhere in the text', () => {
    const r = parseCapture('ship the deck @work due:fri !1', T0)
    expect(r).toEqual({
      kind: 'task',
      title: 'ship the deck',
      area: 'work',
      priority: 1,
      due_date: '2026-07-03'
    })
  })

  it('keeps unparseable due: tokens in the title', () => {
    const r = parseCapture('read due:diligence report', T0)
    expect(r?.kind === 'task' && r.title).toBe('read due:diligence report')
  })

  it('parses interaction with bare and quoted names', () => {
    expect(parseCapture('p Anna coffee chat', T0)).toEqual({
      kind: 'interaction',
      personQuery: 'Anna',
      summary: 'coffee chat'
    })
    expect(parseCapture('p "Anna Martinez" quick call', T0)).toEqual({
      kind: 'interaction',
      personQuery: 'Anna Martinez',
      summary: 'quick call'
    })
  })
})

describe('executeCapture', () => {
  it('creates a task', () => {
    const r = executeCapture(db, 'buy milk due:tomorrow', T0)
    expect(r.ok && r.kind === 'task' && r.task.due_date).toBe('2026-07-02')
  })

  it('logs interaction against fuzzy-matched person', () => {
    people.upsertPerson(db, { name: 'Anna Martinez' }, T0)
    const r = executeCapture(db, 'p anna talked about skiing', T0)
    expect(r.ok && r.kind === 'interaction' && r.person.name).toBe('Anna Martinez')
  })

  it('errors cleanly when person is missing', () => {
    const r = executeCapture(db, 'p nobody hello', T0)
    expect(r.ok).toBe(false)
  })
})

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { DbDriver } from './driver'
import { openNodeSqliteDb } from './drivers/node-sqlite'
import { migrate } from './migrations'
import * as notes from './repo/notes'

const T0 = new Date('2026-07-01T12:00:00Z')

let db: DbDriver

beforeEach(() => {
  db = openNodeSqliteDb(':memory:')
  migrate(db)
})

afterEach(() => db.close())

describe('notes repo', () => {
  it('creates a plain note with defaults', () => {
    const n = notes.createNote(db, { title: 'Groceries', content: 'milk, eggs' }, T0)
    expect(n.note_type).toBe('note')
    expect(n.items).toEqual([])
    expect(n.pinned).toBe(0)
    expect(n.archived).toBe(0)
    expect(n.repeat).toBe('none')
    expect(n.source).toBe('user')
  })

  it('infers checklist type when items are given', () => {
    const n = notes.createNote(db, { items: [{ text: 'milk', done: false }] })
    expect(n.note_type).toBe('checklist')
    expect(n.items).toEqual([{ text: 'milk', done: false }])
  })

  it('normalizes labels to #-prefixed tags', () => {
    const n = notes.createNote(db, { title: 'x', labels: 'home  #errands' })
    expect(n.labels).toBe('#home #errands')
  })

  it('new notes land at the top of manual order', () => {
    const a = notes.createNote(db, { title: 'a' })
    const b = notes.createNote(db, { title: 'b' })
    const list = notes.listNotes(db)
    expect(list.map((n) => n.id)).toEqual([b.id, a.id])
  })

  it('pinned notes sort before unpinned regardless of order', () => {
    const a = notes.createNote(db, { title: 'a', pinned: true })
    const b = notes.createNote(db, { title: 'b' })
    expect(notes.listNotes(db).map((n) => n.id)).toEqual([a.id, b.id])
  })

  it('filters by label exactly (no substring bleed)', () => {
    notes.createNote(db, { title: 'a', labels: '#home' })
    notes.createNote(db, { title: 'b', labels: '#homework' })
    const hits = notes.listNotes(db, { label: '#home' })
    expect(hits).toHaveLength(1)
    expect(hits[0].title).toBe('a')
  })

  it('searches title, content, items, and labels', () => {
    notes.createNote(db, { title: 'alpha' })
    notes.createNote(db, { content: 'beta text' })
    notes.createNote(db, { items: [{ text: 'gamma item', done: false }] })
    expect(notes.listNotes(db, { search: 'alpha' })).toHaveLength(1)
    expect(notes.listNotes(db, { search: 'beta' })).toHaveLength(1)
    expect(notes.listNotes(db, { search: 'gamma' })).toHaveLength(1)
  })

  it('archived filter separates active and archived', () => {
    const a = notes.createNote(db, { title: 'a' })
    notes.createNote(db, { title: 'b' })
    notes.updateNote(db, a.id, { archived: true })
    expect(notes.listNotes(db).map((n) => n.title)).toEqual(['b'])
    expect(notes.listNotes(db, { archived: true }).map((n) => n.title)).toEqual(['a'])
  })

  it('toggleItem flips one row and leaves others alone', () => {
    const n = notes.createNote(db, {
      items: [
        { text: 'one', done: false },
        { text: 'two', done: false }
      ]
    })
    const after = notes.toggleItem(db, n.id, 1)
    expect(after.items).toEqual([
      { text: 'one', done: false },
      { text: 'two', done: true }
    ])
    expect(notes.toggleItem(db, n.id, 1).items[1].done).toBe(false)
  })

  it('toggleItem rejects out-of-range index', () => {
    const n = notes.createNote(db, { items: [{ text: 'one', done: false }] })
    expect(() => notes.toggleItem(db, n.id, 5)).toThrow(/out of range/)
  })

  it('moveNoteBefore reorders like tasks', () => {
    const a = notes.createNote(db, { title: 'a' })
    const b = notes.createNote(db, { title: 'b' })
    const c = notes.createNote(db, { title: 'c' })
    // current order: c, b, a — move a before b
    notes.moveNoteBefore(db, a.id, b.id)
    expect(notes.listNotes(db).map((n) => n.id)).toEqual([c.id, a.id, b.id])
    // move c to end
    notes.moveNoteBefore(db, c.id, null)
    expect(notes.listNotes(db).map((n) => n.id)).toEqual([a.id, b.id, c.id])
  })

  it('listLabels returns distinct sorted tags from active notes only', () => {
    notes.createNote(db, { title: 'a', labels: '#b #a' })
    const archived = notes.createNote(db, { title: 'x', labels: '#zzz' })
    notes.updateNote(db, archived.id, { archived: true })
    expect(notes.listLabels(db)).toEqual(['#a', '#b'])
  })

  it('changing remind_at clears the fired marker so it can fire again', () => {
    const n = notes.createNote(db, { title: 'r', remind_at: '2026-07-01T10:00:00Z' })
    db.run('UPDATE notes SET reminder_fired_at = ? WHERE id = ?', '2026-07-01T10:00:05Z', n.id)
    const moved = notes.updateNote(db, n.id, { remind_at: '2026-07-02T10:00:00Z' })
    expect(moved.reminder_fired_at).toBeNull()
    // unrelated patch keeps the marker
    db.run('UPDATE notes SET reminder_fired_at = ? WHERE id = ?', '2026-07-01T10:00:05Z', n.id)
    const renamed = notes.updateNote(db, n.id, { title: 'renamed' })
    expect(renamed.reminder_fired_at).toBe('2026-07-01T10:00:05Z')
  })

  it('due reminders: due once, not after fired, again after re-set', () => {
    const now = new Date('2026-07-01T12:00:00Z')
    const n = notes.createNote(db, { title: 'r', remind_at: '2026-07-01T11:00:00Z' })
    expect(notes.dueNoteCount(db, now)).toBe(1)
    expect(notes.listDueReminders(db, now).map((x) => x.id)).toEqual([n.id])
    db.run('UPDATE notes SET reminder_fired_at = ? WHERE id = ?', '2026-07-01T12:00:00.000Z', n.id)
    expect(notes.dueNoteCount(db, now)).toBe(0)
    // future reminder is not due
    notes.updateNote(db, n.id, { remind_at: '2026-07-01T13:00:00Z' })
    expect(notes.dueNoteCount(db, now)).toBe(0)
    // past re-set is due again (fired marker cleared by update)
    notes.updateNote(db, n.id, { remind_at: '2026-07-01T11:30:00Z' })
    expect(notes.dueNoteCount(db, now)).toBe(1)
  })

  it('tolerates corrupt items JSON', () => {
    const n = notes.createNote(db, { title: 'x' })
    db.run('UPDATE notes SET items = ? WHERE id = ?', 'not-json', n.id)
    expect(notes.getNote(db, n.id)!.items).toEqual([])
  })
})

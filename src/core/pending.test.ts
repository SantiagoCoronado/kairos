import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { DbDriver } from './driver'
import { openNodeSqliteDb } from './drivers/node-sqlite'
import { migrate } from './migrations'
import * as people from './repo/people'
import * as interactions from './repo/interactions'
import * as tasks from './repo/tasks'
import * as notes from './repo/notes'
import * as comms from './repo/comms'
import { pendingItems } from './repo/pending'

const T0 = new Date('2026-07-01T12:00:00Z')
const daysAgo = (n: number, from: Date = T0): Date =>
  new Date(from.getTime() - n * 24 * 60 * 60 * 1000)

let db: DbDriver
let accountId: string

beforeEach(() => {
  db = openNodeSqliteDb(':memory:')
  migrate(db)
  accountId = comms.upsertAccount(
    db,
    { provider: 'gmail', external_id: 'me@example.com', display_name: 'me' },
    T0
  ).id
})

afterEach(() => db.close())

function seedThread(
  id: string,
  opts: {
    unread?: number
    archived?: boolean
    syncEnabled?: boolean
    labels?: string
    lastMessageAt?: string
  } = {}
): void {
  db.run(
    `INSERT INTO comms_threads
       (id, account_id, provider, external_id, kind, title, snippet, last_message_at,
        unread_count, sync_enabled, is_archived, labels, created_at, updated_at)
     VALUES (?, ?, 'gmail', ?, 'email', ?, 'snippet…', ?, ?, ?, ?, ?, ?, ?)`,
    id,
    accountId,
    `ext-${id}`,
    `Thread ${id}`,
    opts.lastMessageAt ?? daysAgo(1).toISOString(),
    opts.unread ?? 1,
    opts.syncEnabled === false ? 0 : 1,
    opts.archived ? 1 : 0,
    opts.labels ?? '',
    T0.toISOString(),
    T0.toISOString()
  )
}

function overlayRow(
  key: string,
  fingerprint: string,
  patch: { snoozed_until?: string; dismissed_at?: string } = {}
): void {
  db.run(
    `INSERT INTO pending_overlay (item_key, fingerprint, snoozed_until, dismissed_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
    key,
    fingerprint,
    patch.snoozed_until ?? null,
    patch.dismissed_at ?? null,
    T0.toISOString()
  )
}

describe('sources', () => {
  it('collects overdue and due-today tasks, skips future/undated/done', () => {
    tasks.createTask(db, { title: 'overdue', due_date: '2026-06-28' }, T0)
    tasks.createTask(db, { title: 'today', due_date: '2026-07-01' }, T0)
    tasks.createTask(db, { title: 'future', due_date: '2026-07-05' }, T0)
    tasks.createTask(db, { title: 'undated' }, T0)
    const done = tasks.createTask(db, { title: 'done', due_date: '2026-06-20' }, T0)
    tasks.completeTask(db, done.id, T0)

    const { items } = pendingItems(db, T0)
    const taskItems = items.filter((i) => i.kind === 'task')
    expect(taskItems.map((i) => i.title)).toEqual(['overdue', 'today'])
    expect(taskItems[0].subtitle).toBe('overdue since 2026-06-28')
    expect(taskItems[0].fingerprint).toBe('todo:2026-06-28')
    expect(taskItems[1].subtitle).toBe('due today')
  })

  it('collects followups due, keyed by person and fingerprinted by last interaction', () => {
    const p = people.upsertPerson(db, { name: 'Anna', cadence_days: 21 }, daysAgo(100))
    interactions.logInteraction(
      db,
      { person_id: p.id, summary: 'coffee', occurred_at: daysAgo(30).toISOString() },
      daysAgo(30)
    )
    const { items } = pendingItems(db, T0)
    const f = items.find((i) => i.kind === 'followup')!
    expect(f.key).toBe(`followup:${p.id}`)
    expect(f.title).toBe('Anna')
    expect(f.subtitle).toBe('9d overdue · every 21d')
    expect(f.fingerprint).toBe(daysAgo(30).toISOString())
  })

  it('collects due note reminders, falling back to first content line as title', () => {
    notes.createNote(db, { content: 'water plants\nback row too', remind_at: daysAgo(1).toISOString() }, T0)
    notes.createNote(db, { title: 'later', remind_at: '2026-07-09T09:00:00Z' }, T0)
    const { items } = pendingItems(db, T0)
    const reminders = items.filter((i) => i.kind === 'reminder')
    expect(reminders).toHaveLength(1)
    expect(reminders[0].title).toBe('water plants')
  })

  it('keeps a reminder pending after the scheduler fires its notification', () => {
    // delivery is not resolution: the scheduler's fired watermark silences
    // the OS notification, not the triage item
    const n = notes.createNote(db, { title: 'water plants', remind_at: '2026-07-01T09:00:00Z' }, T0)
    db.run(`UPDATE notes SET reminder_fired_at = '2026-07-01T09:00:05Z' WHERE id = ?`, n.id)
    const reminders = pendingItems(db, T0).items.filter((i) => i.kind === 'reminder')
    expect(reminders).toHaveLength(1)
    expect(reminders[0].id).toBe(n.id)
  })

  it('collects unread threads only from synced, unarchived threads', () => {
    seedThread('a')
    seedThread('read', { unread: 0 })
    seedThread('arch', { archived: true })
    seedThread('nosync', { syncEnabled: false })
    const { items, total } = pendingItems(db, T0)
    expect(items.filter((i) => i.kind === 'thread').map((i) => i.id)).toEqual(['a'])
    expect(total).toBe(1)
  })

  it('floats action-needed threads above plain unread and gives them accent tone', () => {
    seedThread('plain', { lastMessageAt: daysAgo(1).toISOString() })
    seedThread('urgent', {
      labels: 'action-needed,finance',
      lastMessageAt: daysAgo(2).toISOString()
    })
    const threads = pendingItems(db, T0).items.filter((i) => i.kind === 'thread')
    expect(threads.map((i) => i.id)).toEqual(['urgent', 'plain'])
    expect(threads[0].tone).toBe('accent')
    expect(threads[1].tone).toBe('muted')
  })

  it('caps threads at 15 but counts the tail in more_threads and total', () => {
    for (let i = 0; i < 18; i++)
      seedThread(`t${String(i).padStart(2, '0')}`, {
        lastMessageAt: daysAgo(i).toISOString()
      })
    const payload = pendingItems(db, T0)
    expect(payload.items.filter((i) => i.kind === 'thread')).toHaveLength(15)
    expect(payload.more_threads).toBe(3)
    expect(payload.total).toBe(18)
  })
})

describe('overlay', () => {
  it('hides snoozed items until the snooze lapses', () => {
    const t = tasks.createTask(db, { title: 'snoozed', due_date: '2026-06-28' }, T0)
    overlayRow(`task:${t.id}`, 'todo:2026-06-28', {
      snoozed_until: '2026-07-02T09:00:00Z'
    })
    expect(pendingItems(db, T0).items).toHaveLength(0)
    expect(pendingItems(db, new Date('2026-07-02T09:00:01Z')).items).toHaveLength(1)
  })

  it('hides dismissed items while the fingerprint matches, resurfaces on renewal', () => {
    seedThread('a', { lastMessageAt: '2026-06-30T10:00:00Z' })
    overlayRow('thread:a', '2026-06-30T10:00:00Z', { dismissed_at: T0.toISOString() })
    expect(pendingItems(db, T0).items).toHaveLength(0)

    // a new inbound message moves last_message_at → fingerprint mismatch
    db.run(`UPDATE comms_threads SET last_message_at = '2026-07-01T08:00:00Z' WHERE id = 'a'`)
    const { items } = pendingItems(db, T0)
    expect(items.map((i) => i.key)).toEqual(['thread:a'])
  })

  it('excludes overlay-hidden threads from total and more_threads (SQL count path)', () => {
    seedThread('kept', { lastMessageAt: '2026-06-30T10:00:00Z' })
    seedThread('dismissed', { lastMessageAt: '2026-06-29T10:00:00Z' })
    seedThread('snoozed', { lastMessageAt: '2026-06-28T10:00:00Z' })
    overlayRow('thread:dismissed', '2026-06-29T10:00:00Z', { dismissed_at: T0.toISOString() })
    overlayRow('thread:snoozed', 'whatever', { snoozed_until: '2026-07-09T00:00:00Z' })
    const payload = pendingItems(db, T0)
    expect(payload.items.map((i) => i.id)).toEqual(['kept'])
    expect(payload.total).toBe(1)
    expect(payload.more_threads).toBe(0)
  })

  it('a dismissed follow-up stays hidden until an interaction lands (documented guarantee)', () => {
    const p = people.upsertPerson(db, { name: 'Anna', cadence_days: 14 }, daysAgo(100))
    const fp = pendingItems(db, T0).items.find((i) => i.kind === 'followup')!.fingerprint
    overlayRow(`followup:${p.id}`, fp, { dismissed_at: T0.toISOString() })
    // still overdue two weeks later — dismissal holds because nothing can
    // renew the fingerprint while the person is still due
    expect(
      pendingItems(db, new Date('2026-07-15T12:00:00Z')).items.filter((i) => i.kind === 'followup')
    ).toHaveLength(0)
    // an interaction resolves the item the domain way (and would reset the
    // fingerprint for the next time the cadence lapses)
    interactions.logInteraction(
      db,
      { person_id: p.id, summary: 'lunch', occurred_at: T0.toISOString() },
      T0
    )
    expect(pendingItems(db, T0).items.filter((i) => i.kind === 'followup')).toHaveLength(0)
  })
})

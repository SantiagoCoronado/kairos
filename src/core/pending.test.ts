import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { DbDriver } from './driver'
import { openNodeSqliteDb } from './drivers/node-sqlite'
import { migrate } from './migrations'
import * as people from './repo/people'
import * as interactions from './repo/interactions'
import * as tasks from './repo/tasks'
import * as notes from './repo/notes'
import * as comms from './repo/comms'
import * as agentTasks from './repo/agent-tasks'
import {
  pendingItems,
  snoozeItem,
  unsnoozeItem,
  dismissItem,
  undismissItem,
  markAllSeen,
  unseenRunCount
} from './repo/pending'

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

  it('materializes visible threads even when dismissed rows dominate recency', () => {
    // 60 unread, the 50 newest dismissed: the fetch bound applies to VISIBLE
    // rows, so the 10 older pending threads must all render — never an empty
    // section under a non-zero badge
    const pad = (i: number): string => String(i).padStart(2, '0')
    for (let i = 0; i < 60; i++)
      seedThread(`t${pad(i)}`, { lastMessageAt: daysAgo(i).toISOString() })
    for (let i = 0; i < 50; i++)
      overlayRow(`thread:t${pad(i)}`, daysAgo(i).toISOString(), {
        dismissed_at: T0.toISOString()
      })
    const payload = pendingItems(db, T0)
    expect(payload.items.map((i) => i.id)).toEqual(
      Array.from({ length: 10 }, (_, i) => `t${pad(50 + i)}`)
    )
    expect(payload.total).toBe(10)
    expect(payload.more_threads).toBe(0)
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

describe('triage writes', () => {
  const later = (h: number): Date => new Date(T0.getTime() + h * 60 * 60 * 1000)

  it('snoozeItem hides until the timestamp; unsnoozeItem restores immediately', () => {
    const t = tasks.createTask(db, { title: 'later', due_date: '2026-06-28' }, T0)
    snoozeItem(db, `task:${t.id}`, later(2).toISOString(), T0)
    expect(pendingItems(db, T0).items).toHaveLength(0)
    expect(pendingItems(db, later(3)).items).toHaveLength(1)
    snoozeItem(db, `task:${t.id}`, later(5).toISOString(), later(3))
    unsnoozeItem(db, `task:${t.id}`, later(3))
    expect(pendingItems(db, later(3)).items).toHaveLength(1)
  })

  it('dismissItem hides at the current fingerprint; renewal resurfaces; undismiss restores', () => {
    seedThread('a', { lastMessageAt: '2026-06-30T10:00:00Z' })
    dismissItem(db, 'thread:a', T0)
    expect(pendingItems(db, T0).items).toHaveLength(0)
    db.run(`UPDATE comms_threads SET last_message_at = '2026-07-01T08:00:00Z' WHERE id = 'a'`)
    expect(pendingItems(db, T0).items.map((i) => i.key)).toEqual(['thread:a'])
    dismissItem(db, 'thread:a', T0)
    expect(pendingItems(db, T0).items).toHaveLength(0)
    undismissItem(db, 'thread:a', T0)
    expect(pendingItems(db, T0).items).toHaveLength(1)
  })

  it('normalizes offset-form ISO snoozes to UTC so string compares stay sound', () => {
    // 9pm Denver: a valid offset-form timestamp one hour in the future would
    // sort BEFORE nowIso() if stored verbatim — a silent no-op snooze
    const t = tasks.createTask(db, { title: 'later', due_date: '2026-06-28' }, T0)
    snoozeItem(db, `task:${t.id}`, '2026-07-01T07:00:00-06:00', T0) // = T0 + 1h
    expect(pendingItems(db, T0).items).toHaveLength(0)
    expect(pendingItems(db, later(2)).items).toHaveLength(1)
  })

  it('rejects unparseable snooze timestamps instead of storing garbage', () => {
    const t = tasks.createTask(db, { title: 'later', due_date: '2026-06-28' }, T0)
    expect(() => snoozeItem(db, `task:${t.id}`, 'mañana', T0)).toThrow(/bad snooze timestamp/)
    expect(pendingItems(db, T0).items).toHaveLength(1)
  })

  it('writes on a resolved item throw', () => {
    expect(() => dismissItem(db, 'task:nope', T0)).toThrow(/not pending/)
    seedThread('read', { unread: 0 })
    expect(() => snoozeItem(db, 'thread:read', later(1).toISOString(), T0)).toThrow(/not pending/)
  })

  it('threads beyond the display cap can still be triaged', () => {
    const pad = (i: number): string => String(i).padStart(2, '0')
    for (let i = 0; i < 17; i++)
      seedThread(`t${pad(i)}`, { lastMessageAt: daysAgo(i).toISOString() })
    // t16 is oldest — outside the 15 shown, but the badge counts it
    expect(pendingItems(db, T0).items.map((i) => i.id)).not.toContain('t16')
    dismissItem(db, 'thread:t16', T0)
    expect(pendingItems(db, T0).total).toBe(16)
  })

  it('markAllSeen clears unseen; arrivals and renewals count as unseen again', () => {
    const t = tasks.createTask(db, { title: 'due', due_date: '2026-06-28' }, T0)
    seedThread('a', { lastMessageAt: '2026-06-30T10:00:00Z' })
    expect(pendingItems(db, T0).unseen).toBe(2)
    markAllSeen(db, T0)
    expect(pendingItems(db, T0).unseen).toBe(0)
    expect(pendingItems(db, T0).total).toBe(2)

    seedThread('b') // new arrival
    db.run(`UPDATE comms_threads SET last_message_at = '2026-07-01T09:00:00Z' WHERE id = 'a'`) // renewal
    tasks.updateTask(db, t.id, { due_date: '2026-06-29' }, T0) // renewal (still overdue)
    expect(pendingItems(db, T0).unseen).toBe(3)
  })

  it('markAllSeen includes threads beyond the display cap so the badge can clear', () => {
    const pad = (i: number): string => String(i).padStart(2, '0')
    for (let i = 0; i < 18; i++)
      seedThread(`t${pad(i)}`, { lastMessageAt: daysAgo(i).toISOString() })
    markAllSeen(db, T0)
    expect(pendingItems(db, T0).unseen).toBe(0)
  })

  it('markAllSeen never revives a stale dismissal', () => {
    seedThread('a', { lastMessageAt: '2026-06-30T10:00:00Z' })
    dismissItem(db, 'thread:a', T0)
    db.run(`UPDATE comms_threads SET last_message_at = '2026-07-01T08:00:00Z' WHERE id = 'a'`)
    markAllSeen(db, T0) // stamps the new fingerprint — must clear dismissed_at
    expect(pendingItems(db, T0).items.map((i) => i.key)).toEqual(['thread:a'])
    expect(pendingItems(db, T0).unseen).toBe(0)
  })

  it('triage writes garbage-collect rows for resolved items, keep still-snoozed ones', () => {
    const gone = tasks.createTask(db, { title: 'gone', due_date: '2026-06-28' }, T0)
    dismissItem(db, `task:${gone.id}`, T0)
    const parked = tasks.createTask(db, { title: 'parked', due_date: '2026-06-28' }, T0)
    snoozeItem(db, `task:${parked.id}`, '2026-07-09T00:00:00Z', T0)
    tasks.completeTask(db, gone.id, T0)
    tasks.completeTask(db, parked.id, T0)

    const live = tasks.createTask(db, { title: 'live', due_date: '2026-06-28' }, T0)
    dismissItem(db, `task:${live.id}`, T0) // any write triggers GC
    const keys = db
      .all<{ item_key: string }>('SELECT item_key FROM pending_overlay')
      .map((r) => r.item_key)
      .sort()
    // gone: resolved + no snooze → deleted; parked: snooze still running → kept
    expect(keys).toEqual([`task:${live.id}`, `task:${parked.id}`].sort())
  })
})

describe('failure-state sources', () => {
  function seedOutbox(
    id: string,
    opts: {
      status?: string
      error?: string
      provider?: string
      threadId?: string
      toJson?: string
      createdAt?: string
      body?: string
    } = {}
  ): void {
    db.run(
      `INSERT INTO comms_outbox (id, account_id, thread_id, provider, to_json, body_text, status, error, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'app', ?)`,
      id,
      accountId,
      opts.threadId ?? null,
      opts.provider ?? 'whatsapp',
      opts.toJson ?? '{}',
      opts.body ?? 'hola que tal',
      opts.status ?? 'failed',
      opts.error ?? null,
      opts.createdAt ?? daysAgo(1).toISOString()
    )
  }

  function seedMeeting(
    id: string,
    opts: { status?: string; error?: string; summarizedAt?: string; endedAt?: string } = {}
  ): void {
    db.run(
      `INSERT INTO meetings (id, title, status, error, started_at, ended_at, summarized_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      `Meeting ${id}`,
      opts.status ?? 'ready',
      opts.error ?? null,
      daysAgo(1).toISOString(),
      opts.endedAt ?? daysAgo(1).toISOString(),
      opts.summarizedAt ?? null,
      T0.toISOString(),
      T0.toISOString()
    )
  }

  it('failed sends are danger items; fresh queued rows are not stuck yet', () => {
    seedOutbox('ob-fail', { status: 'failed', error: 'socket closed', toJson: '{}' })
    seedOutbox('ob-fresh', { status: 'queued', createdAt: T0.toISOString() })
    seedOutbox('ob-stuck', { status: 'queued', createdAt: daysAgo(1).toISOString() })
    seedOutbox('ob-sent', { status: 'sent' })
    const items = pendingItems(db, T0).items.filter((i) => i.kind === 'outbox')
    expect(items.map((i) => i.id).sort()).toEqual(['ob-fail', 'ob-stuck'])
    const fail = items.find((i) => i.id === 'ob-fail')!
    expect(fail.tone).toBe('danger')
    expect(fail.subtitle).toBe('socket closed')
    expect(fail.provider).toBe('whatsapp')
    expect(pendingItems(db, T0).danger).toBe(1)
  })

  it('outbox items use the thread title, then to_json, then provider as destination', () => {
    seedThread('th-dest')
    seedOutbox('ob-1', { threadId: 'th-dest' })
    seedOutbox('ob-2', { provider: 'gmail', toJson: '{"to":["ana@x.com"],"subject":"Q2"}' })
    seedOutbox('ob-3', { toJson: '{}' })
    const titles = pendingItems(db, T0)
      .items.filter((i) => i.kind === 'outbox')
      .map((i) => i.title)
    expect(titles).toContain('Send failed — Thread th-dest')
    expect(titles).toContain('Send failed — Q2')
    expect(titles).toContain('Send failed — whatsapp')
  })

  it('deleteOutboxItem refuses sent rows', () => {
    seedOutbox('ob-x', { status: 'failed' })
    seedOutbox('ob-sent', { status: 'sent' })
    expect(comms.deleteOutboxItem(db, 'ob-x')).toBe(true)
    expect(comms.deleteOutboxItem(db, 'ob-sent')).toBe(false)
    expect(db.all('SELECT id FROM comms_outbox')).toHaveLength(1)
  })

  it('errored meetings are danger; ready-unsummarized surfaces after the grace window', () => {
    seedMeeting('m-err', { status: 'error', error: 'whisper died' })
    seedMeeting('m-old', { status: 'ready' }) // ended yesterday, never summarized
    seedMeeting('m-fresh', { status: 'ready', endedAt: new Date(T0.getTime() - 5 * 60_000).toISOString() })
    seedMeeting('m-done', { status: 'ready', summarizedAt: T0.toISOString() })
    const items = pendingItems(db, T0).items.filter((i) => i.kind === 'meeting')
    expect(items.map((i) => i.id).sort()).toEqual(['m-err', 'm-old'])
    expect(items.find((i) => i.id === 'm-err')!.tone).toBe('danger')
    expect(items.find((i) => i.id === 'm-err')!.subtitle).toBe('whisper died')
    expect(items.find((i) => i.id === 'm-old')!.tone).toBe('muted')
  })

  it('finished runs surface within the window with status tones; running and aged-out do not', () => {
    const task = agentTasks.createAgentTask(db, { name: 'Daily digest', prompt: 'p' }, T0)
    const ok = agentTasks.createRun(db, task.id, null, daysAgo(1))
    agentTasks.finishRun(db, ok.id, { status: 'success', result: 'sent 3 emails' }, daysAgo(1))
    const bad = agentTasks.createRun(db, task.id, null, daysAgo(1))
    agentTasks.finishRun(db, bad.id, { status: 'error', error: 'rate limited' }, daysAgo(1))
    const old = agentTasks.createRun(db, task.id, null, daysAgo(5))
    agentTasks.finishRun(db, old.id, { status: 'success' }, daysAgo(5))
    agentTasks.createRun(db, task.id, null, T0) // still running

    const items = pendingItems(db, T0).items.filter((i) => i.kind === 'agent_run')
    expect(items.map((i) => i.id).sort()).toEqual([bad.id, ok.id].sort())
    expect(items.find((i) => i.id === ok.id)!.tone).toBe('accent')
    expect(items.find((i) => i.id === ok.id)!.subtitle).toBe('sent 3 emails')
    expect(items.find((i) => i.id === bad.id)!.tone).toBe('danger')
    expect(items.find((i) => i.id === bad.id)!.subtitle).toBe('rate limited')
    expect(items.find((i) => i.id === ok.id)!.title).toBe('Daily digest')
  })

  it('unseenRunCount matches the overlay and markAllSeen scoping leaves other kinds alone', () => {
    const task = agentTasks.createAgentTask(db, { name: 't', prompt: 'p' }, T0)
    const r1 = agentTasks.createRun(db, task.id, null, daysAgo(1))
    agentTasks.finishRun(db, r1.id, { status: 'success' }, daysAgo(1))
    tasks.createTask(db, { title: 'due', due_date: '2026-06-28' }, T0)

    expect(unseenRunCount(db, T0)).toBe(1)
    expect(pendingItems(db, T0).unseen).toBe(2)
    markAllSeen(db, T0, 'agent_run')
    expect(unseenRunCount(db, T0)).toBe(0)
    // the task's watermark was NOT touched by the scoped stamp
    expect(pendingItems(db, T0).unseen).toBe(1)
  })

  it('triage writes work on the new kinds (fingerprint resolves via fixedItems)', () => {
    seedOutbox('ob-1', { status: 'failed', error: 'boom' })
    dismissItem(db, 'outbox:ob-1', T0)
    expect(pendingItems(db, T0).items).toHaveLength(0)
    // a different failure reason is a renewed condition
    db.run(`UPDATE comms_outbox SET error = 'other reason' WHERE id = 'ob-1'`)
    expect(pendingItems(db, T0).items.map((i) => i.key)).toEqual(['outbox:ob-1'])
  })
})

describe('review round: danger persistence and run cap', () => {
  it('danger persists through markAllSeen — glancing is not fixing', () => {
    db.run(
      `INSERT INTO comms_outbox (id, account_id, provider, to_json, body_text, status, error, source, created_at)
       VALUES ('ob-1', ?, 'whatsapp', '{}', 'hola', 'failed', 'boom', 'app', ?)`,
      accountId,
      daysAgo(1).toISOString()
    )
    expect(pendingItems(db, T0)).toMatchObject({ total: 1, unseen: 1, danger: 1 })
    markAllSeen(db, T0)
    // seen zeroes the unseen count but the failure stays actionable: the
    // sidebar renders on unseen || danger, so the badge must stay lit
    expect(pendingItems(db, T0)).toMatchObject({ total: 1, unseen: 0, danger: 1 })
    const item = pendingItems(db, T0).items[0]
    expect(item.status).toBe('failed')
    expect(item.provider).toBe('whatsapp')
  })

  it('runs are capped, badge and list share the bound', () => {
    const task = agentTasks.createAgentTask(db, { name: 't', prompt: 'p' }, T0)
    for (let i = 0; i < 35; i++) {
      const r = agentTasks.createRun(db, task.id, null, new Date(T0.getTime() - i * 60_000))
      agentTasks.finishRun(db, r.id, { status: 'success' }, new Date(T0.getTime() - i * 60_000))
    }
    const payload = pendingItems(db, T0)
    expect(payload.items.filter((i) => i.kind === 'agent_run')).toHaveLength(30)
    expect(unseenRunCount(db, T0)).toBe(30)
    markAllSeen(db, T0)
    expect(unseenRunCount(db, T0)).toBe(0)
  })
})

describe('review round 2: errors are un-croppable', () => {
  it('a lone error survives 35 later successes crowding the run cap', () => {
    const task = agentTasks.createAgentTask(db, { name: 't', prompt: 'p' }, T0)
    const hoursAgo = (h: number): Date => new Date(T0.getTime() - h * 60 * 60_000)
    const bad = agentTasks.createRun(db, task.id, null, hoursAgo(40))
    agentTasks.finishRun(db, bad.id, { status: 'error', error: 'boom' }, hoursAgo(40))
    for (let i = 0; i < 35; i++) {
      const r = agentTasks.createRun(db, task.id, null, hoursAgo(30 - i / 2))
      agentTasks.finishRun(db, r.id, { status: 'success' }, hoursAgo(30 - i / 2))
    }
    const payload = pendingItems(db, T0)
    const runs = payload.items.filter((i) => i.kind === 'agent_run')
    expect(runs).toHaveLength(30)
    // the error floats above the cap line — 30 successes can never displace it
    expect(runs[0].id).toBe(bad.id)
    expect(runs[0].tone).toBe('danger')
    expect(payload.danger).toBe(1)
  })
})

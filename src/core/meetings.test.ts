import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { DbDriver } from './driver'
import { openNodeSqliteDb } from './drivers/node-sqlite'
import { migrate, migrations, applyMigration } from './migrations'
import * as meetings from './repo/meetings'
import * as tasks from './repo/tasks'
import * as calendar from './repo/calendar'

const T0 = new Date('2026-07-28T12:00:00Z')
const later = (mins: number): Date => new Date(T0.getTime() + mins * 60_000)

let db: DbDriver

beforeEach(() => {
  db = openNodeSqliteDb(':memory:')
  migrate(db)
})

afterEach(() => db.close())

describe('migration 020', () => {
  it('upgrades a 019 database without touching existing tasks', () => {
    const old = openNodeSqliteDb(':memory:')
    // simulate a DB that stopped at migration 019
    migrations.slice(0, 19).forEach((_m, i) => {
      applyMigration(old, i)
      old.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))`)
      old.run('INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)', i + 1)
    })
    // raw insert: repo code targets the migrated schema (it now writes
    // meeting_id), so pre-020 rows must be seeded with 019-era SQL
    old.run(
      `INSERT INTO tasks (id, title, notes, status, area, priority, sort_order, created_at, updated_at)
       VALUES (?, ?, '', 'todo', 'personal', 2, 0, ?, ?)`,
      '01PRE020TASK00000000000000',
      'pre-020 task',
      T0.toISOString(),
      T0.toISOString()
    )

    migrate(old)

    const after = tasks.getTask(old, '01PRE020TASK00000000000000')!
    expect(after.title).toBe('pre-020 task')
    expect(after.meeting_id).toBeNull()
    old.close()
  })
})

describe('meetings repo', () => {
  it('creates with recording status, ULID id and timestamps', () => {
    const m = meetings.createMeeting(db, { title: 'standup' }, T0)
    expect(m.id).toHaveLength(26)
    expect(m.status).toBe('recording')
    expect(m.title).toBe('standup')
    expect(m.started_at).toBe(T0.toISOString())
    expect(m.created_at).toBe(T0.toISOString())
    expect(m.summary).toEqual({ action_items: [], decisions: [], participants: [] })
    expect(m.audio_deleted_at).toBeNull()
  })

  it('lists newest-first with status and event filters', () => {
    const ev = calendar.createEvent(
      db,
      { title: 'sync', start_at: T0.toISOString(), end_at: later(30).toISOString() },
      T0
    )
    const a = meetings.createMeeting(db, { started_at: later(0).toISOString() }, T0)
    const b = meetings.createMeeting(
      db,
      { started_at: later(60).toISOString(), calendar_event_id: ev.id },
      T0
    )
    meetings.updateMeeting(db, a.id, { status: 'ready' }, later(30))

    expect(meetings.listMeetings(db).map((m) => m.id)).toEqual([b.id, a.id])
    expect(meetings.listMeetings(db, { status: 'ready' }).map((m) => m.id)).toEqual([a.id])
    expect(meetings.listMeetings(db, { status: ['ready', 'error'] }).map((m) => m.id)).toEqual([
      a.id
    ])
    expect(meetings.listMeetings(db, { calendar_event_id: ev.id }).map((m) => m.id)).toEqual([b.id])
    expect(meetings.listMeetings(db, { limit: 1 }).map((m) => m.id)).toEqual([b.id])
  })

  it('patches stop fields and rejects unknown ids', () => {
    const m = meetings.createMeeting(db, {}, T0)
    const stopped = meetings.updateMeeting(
      db,
      m.id,
      {
        status: 'ready',
        ended_at: later(45).toISOString(),
        duration_seconds: 2700,
        mic_path: '/tmp/mic.webm',
        system_path: '/tmp/system.webm'
      },
      later(45)
    )
    expect(stopped.status).toBe('ready')
    expect(stopped.duration_seconds).toBe(2700)
    expect(stopped.ended_at).toBe(later(45).toISOString())
    expect(stopped.updated_at).toBe(later(45).toISOString())
    expect(() => meetings.updateMeeting(db, 'nope', { status: 'error' })).toThrow(/not found/)
  })

  it('summary round-trips typed through summary_json', () => {
    const m = meetings.createMeeting(db, {}, T0)
    const summary = {
      action_items: [{ text: 'ship it', person_id: null, task_id: null }],
      decisions: ['go local-first'],
      participants: ['Santiago']
    }
    meetings.updateMeeting(db, m.id, { summary, summary_md: '## notes' }, later(1))
    const got = meetings.getMeeting(db, m.id)!
    expect(got.summary).toEqual(summary)
    expect(got.summary_md).toBe('## notes')
  })

  it('tolerates corrupt summary_json as empty summary', () => {
    const m = meetings.createMeeting(db, {}, T0)
    db.run(`UPDATE meetings SET summary_json = 'not json' WHERE id = ?`, m.id)
    expect(meetings.getMeeting(db, m.id)!.summary).toEqual({
      action_items: [],
      decisions: [],
      participants: []
    })
  })

  it('deleting the calendar event nulls the link, keeps the meeting', () => {
    const ev = calendar.createEvent(
      db,
      { title: 'sync', start_at: T0.toISOString(), end_at: later(30).toISOString() },
      T0
    )
    const m = meetings.createMeeting(db, { calendar_event_id: ev.id }, T0)
    db.run('DELETE FROM calendar_events WHERE id = ?', ev.id)
    expect(meetings.getMeeting(db, m.id)!.calendar_event_id).toBeNull()
  })

  it('deleting a meeting cascades its transcript and nulls task links', () => {
    const m = meetings.createMeeting(db, {}, T0)
    meetings.setTranscript(db, m.id, {
      segments: [{ t0: 0, t1: 1.5, channel: 'me', text: 'hello' }]
    })
    const t = tasks.createTask(db, { title: 'follow up' }, T0)
    db.run('UPDATE tasks SET meeting_id = ? WHERE id = ?', m.id, t.id)

    meetings.deleteMeeting(db, m.id)

    expect(meetings.getTranscript(db, m.id)).toBeUndefined()
    expect(
      db.get<{ n: number }>('SELECT COUNT(*) AS n FROM meeting_transcripts')!.n
    ).toBe(0)
    expect(tasks.getTask(db, t.id)!.meeting_id).toBeNull()
  })

  it('markAudioDeleted sets the marker and leaves the transcript', () => {
    const m = meetings.createMeeting(db, {}, T0)
    meetings.setTranscript(db, m.id, {
      segments: [{ t0: 0, t1: 1, channel: 'them', text: 'hi' }]
    })
    const marked = meetings.markAudioDeleted(db, m.id, later(5))
    expect(marked.audio_deleted_at).toBe(later(5).toISOString())
    expect(meetings.getTranscript(db, m.id)!.segments).toHaveLength(1)
  })
})

describe('transcripts', () => {
  it('round-trips typed segments and derives text when omitted', () => {
    const m = meetings.createMeeting(db, {}, T0)
    const tr = meetings.setTranscript(db, m.id, {
      segments: [
        { t0: 0, t1: 2, channel: 'me', text: 'hello' },
        { t0: 2, t1: 4, channel: 'them', text: 'hey there' }
      ],
      language: 'en',
      model: 'whisper-large-v3-turbo'
    })
    expect(tr.segments[1]).toEqual({ t0: 2, t1: 4, channel: 'them', text: 'hey there' })
    expect(tr.text).toBe('hello\nhey there')
    expect(tr.language).toBe('en')
  })

  it('second write for the same meeting replaces the first', () => {
    const m = meetings.createMeeting(db, {}, T0)
    meetings.setTranscript(db, m.id, {
      segments: [{ t0: 0, t1: 1, channel: 'me', text: 'v1' }]
    })
    const tr = meetings.setTranscript(db, m.id, {
      segments: [{ t0: 0, t1: 1, channel: 'me', text: 'v2' }],
      model: 'base'
    })
    expect(tr.segments[0].text).toBe('v2')
    expect(tr.model).toBe('base')
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM meeting_transcripts')!.n).toBe(1)
  })

  it('rejects transcripts for unknown meetings', () => {
    expect(() => meetings.setTranscript(db, 'nope', { segments: [] })).toThrow(/not found/)
  })

  it('tolerates corrupt segments JSON as empty', () => {
    const m = meetings.createMeeting(db, {}, T0)
    meetings.setTranscript(db, m.id, { segments: [{ t0: 0, t1: 1, channel: 'me', text: 'x' }] })
    db.run(`UPDATE meeting_transcripts SET segments = '{oops' WHERE meeting_id = ?`, m.id)
    expect(meetings.getTranscript(db, m.id)!.segments).toEqual([])
  })
})

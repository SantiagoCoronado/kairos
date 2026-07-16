import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { DbDriver } from './driver'
import { openNodeSqliteDb } from './drivers/node-sqlite'
import { migrate } from './migrations'
import { appendChatMessage, listChatMessages } from './repo/chat'

let db: DbDriver

beforeEach(() => {
  db = openNodeSqliteDb(':memory:')
  migrate(db)
  db.run(
    "INSERT INTO chat_sessions (id, title, created_at, updated_at) VALUES ('s1', 't', '2026-01-01', '2026-01-01')"
  )
})

afterEach(() => db.close())

describe('chat message repo', () => {
  it('appends messages with monotonic seq and reads them back in order', () => {
    appendChatMessage(db, 's1', 'user', 'hello')
    appendChatMessage(db, 's1', 'assistant', 'hi there', ['comms_search', 'tasks_list'])
    appendChatMessage(db, 's1', 'error', 'boom')

    const msgs = listChatMessages(db, 's1')
    expect(msgs.map((m) => m.seq)).toEqual([1, 2, 3])
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'error'])
    expect(JSON.parse(msgs[1].tools)).toEqual(['comms_search', 'tasks_list'])
    expect(JSON.parse(msgs[0].tools)).toEqual([])
  })

  it('scopes messages by session', () => {
    db.run(
      "INSERT INTO chat_sessions (id, title, created_at, updated_at) VALUES ('s2', 't', '2026-01-01', '2026-01-01')"
    )
    appendChatMessage(db, 's1', 'user', 'a')
    appendChatMessage(db, 's2', 'user', 'b')
    expect(listChatMessages(db, 's1').map((m) => m.text)).toEqual(['a'])
    expect(listChatMessages(db, 's2').map((m) => m.text)).toEqual(['b'])
    // seq restarts per session
    expect(listChatMessages(db, 's2')[0].seq).toBe(1)
  })
})

describe('migration 016 — session origin', () => {
  it('backfills automation origin from agent_task_runs linkage', async () => {
    const { migrations } = await import('./migrations')
    // simulate a DB that stopped at migration 015 with a chat + an automation session
    const old = openNodeSqliteDb(':memory:')
    old.exec(`CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );`)
    for (let i = 0; i < 15; i++) old.exec(migrations[i])
    old.run(`INSERT INTO schema_migrations (version) VALUES ${Array.from({ length: 15 }, (_, i) => `(${i + 1})`).join(', ')}`)
    old.run("INSERT INTO chat_sessions (id, title, created_at, updated_at) VALUES ('plain', 'Chat', '2026-01-01', '2026-01-01')")
    old.run("INSERT INTO chat_sessions (id, title, created_at, updated_at) VALUES ('run-sess', '⚙ Daily brief', '2026-01-01', '2026-01-01')")
    old.run("INSERT INTO agent_tasks (id, name, prompt, schedule, created_at, updated_at) VALUES ('t1', 'Daily brief', 'p', 'daily', '2026-01-01', '2026-01-01')")
    old.run("INSERT INTO agent_task_runs (id, task_id, started_at, status, session_id) VALUES ('r1', 't1', '2026-01-01', 'success', 'run-sess')")

    migrate(old)

    const rows = old.all<{ id: string; origin: string }>('SELECT id, origin FROM chat_sessions ORDER BY id')
    expect(rows).toEqual([
      { id: 'plain', origin: 'chat' },
      { id: 'run-sess', origin: 'automation' }
    ])
    old.close()
  })

  it('defaults new sessions to chat origin', () => {
    db.run("INSERT INTO chat_sessions (id, title, created_at, updated_at) VALUES ('s9', 't', '2026-01-01', '2026-01-01')")
    expect(db.get<{ origin: string }>("SELECT origin FROM chat_sessions WHERE id = 's9'")!.origin).toBe('chat')
  })
})

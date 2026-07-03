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

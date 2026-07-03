import type { DbDriver } from '../driver'
import { newId, nowIso } from '../ids'
import type { ChatMessage, ChatMessageRole } from '../types'

/** append one turn to a session's transcript, auto-assigning the next seq */
export function appendChatMessage(
  db: DbDriver,
  sessionId: string,
  role: ChatMessageRole,
  text: string,
  tools: string[] = [],
  now: Date = new Date()
): void {
  const seq =
    (db.get<{ m: number }>('SELECT COALESCE(MAX(seq), 0) AS m FROM chat_messages WHERE session_id = ?', sessionId)
      ?.m ?? 0) + 1
  db.run(
    `INSERT INTO chat_messages (id, session_id, seq, role, text, tools, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    newId(),
    sessionId,
    seq,
    role,
    text,
    JSON.stringify(tools),
    nowIso(now)
  )
}

export function listChatMessages(db: DbDriver, sessionId: string): ChatMessage[] {
  return db.all<ChatMessage>(
    'SELECT * FROM chat_messages WHERE session_id = ? ORDER BY seq ASC',
    sessionId
  )
}

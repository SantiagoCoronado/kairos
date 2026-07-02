import type { DbDriver } from '../driver'
import type { Interaction, NewInteraction } from '../types'
import { newId, nowIso } from '../ids'

export function logInteraction(
  db: DbDriver,
  input: NewInteraction,
  now: Date = new Date()
): Interaction {
  const id = newId()
  const ts = nowIso(now)
  db.run(
    `INSERT INTO interactions (id, person_id, occurred_at, kind, summary, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    id,
    input.person_id,
    input.occurred_at ?? ts,
    input.kind ?? 'other',
    input.summary,
    ts
  )
  // an interaction naturally clears any snooze — the clock has reset anyway
  db.run('UPDATE people SET snoozed_until = NULL, updated_at = ? WHERE id = ?', ts, input.person_id)
  return db.get<Interaction>('SELECT * FROM interactions WHERE id = ?', id)!
}

export function listInteractions(db: DbDriver, personId: string, limit = 100): Interaction[] {
  return db.all<Interaction>(
    'SELECT * FROM interactions WHERE person_id = ? ORDER BY occurred_at DESC LIMIT ?',
    personId,
    limit
  )
}

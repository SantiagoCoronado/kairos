import type { DbDriver } from '../driver'
import type { FollowupDue } from '../types'
import { nowIso } from '../ids'

// Cadence is computed, never stored: days since last interaction (or since
// the person was created) minus cadence_days. `now` is a parameter so tests
// can inject a clock. Plain `?` placeholders only — better-sqlite3 does not
// support numbered (?1) parameters, and this SQL runs on both drivers.

const FOLLOWUP_SQL = `
SELECT
  p.id, p.name, p.area, p.cadence_days, p.snoozed_until,
  MAX(i.occurred_at) AS last_interaction_at,
  CAST(julianday(?) - julianday(COALESCE(MAX(i.occurred_at), p.created_at)) AS INTEGER) AS days_since,
  CAST(julianday(?) - julianday(COALESCE(MAX(i.occurred_at), p.created_at)) AS INTEGER) - p.cadence_days AS days_overdue
FROM people p
LEFT JOIN interactions i ON i.person_id = p.id
WHERE p.cadence_days IS NOT NULL AND p.archived_at IS NULL
GROUP BY p.id
`

export function followupsDue(db: DbDriver, now: Date = new Date()): FollowupDue[] {
  const ts = nowIso(now)
  return db.all<FollowupDue>(
    `${FOLLOWUP_SQL}
     HAVING days_overdue >= 0 AND (p.snoozed_until IS NULL OR p.snoozed_until <= date(?))
     ORDER BY days_overdue DESC`,
    ts,
    ts,
    ts
  )
}

/** All people with a cadence, due or not — for the People view's cadence column. */
export function followupStatuses(db: DbDriver, now: Date = new Date()): FollowupDue[] {
  const ts = nowIso(now)
  return db.all<FollowupDue>(`${FOLLOWUP_SQL} ORDER BY days_overdue DESC`, ts, ts)
}

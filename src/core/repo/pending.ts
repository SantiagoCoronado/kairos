import type { DbDriver } from '../driver'
import type { PendingItem, PendingPayload, Task } from '../types'
import { localDate, nowIso } from '../ids'
import { followupsDue } from './followups'

// The Pending inbox aggregator. Everything is computed live from the source
// domains so items can never go stale; the pending_overlay table contributes
// only visibility (snooze/dismiss) and, later, seen state. Sources appear in
// section order: tasks, followups, note reminders, unread threads. Reads are
// pure — overlay garbage collection belongs to the triage write paths.

/** unread threads shown before the "N more in Inbox" tail row */
const THREAD_CAP = 15

interface OverlayRow {
  item_key: string
  fingerprint: string
  snoozed_until: string | null
  dismissed_at: string | null
  seen_at: string | null
}

function taskItems(db: DbDriver, today: string): PendingItem[] {
  const rows = db.all<Task>(
    `SELECT * FROM tasks
     WHERE status IN ('todo','in_progress') AND due_date IS NOT NULL AND due_date <= ?
     ORDER BY due_date, priority`,
    today
  )
  return rows.map((t) => ({
    key: `task:${t.id}`,
    kind: 'task' as const,
    id: t.id,
    title: t.title,
    subtitle: t.due_date === today ? 'due today' : `overdue since ${t.due_date}`,
    tone: 'accent' as const,
    at: t.due_date,
    fingerprint: `${t.status}:${t.due_date}`
  }))
}

function followupItems(db: DbDriver, now: Date): PendingItem[] {
  return followupsDue(db, now).map((f) => ({
    key: `followup:${f.id}`,
    kind: 'followup' as const,
    id: f.id,
    title: f.name,
    subtitle:
      f.days_overdue === 0
        ? `due today · every ${f.cadence_days}d`
        : `${f.days_overdue}d overdue · every ${f.cadence_days}d`,
    tone: 'accent' as const,
    at: f.last_interaction_at,
    // Last interaction is what resets the cadence, so it is the renewal
    // signal. Deliberate consequence, unlike the other sources: nothing can
    // renew this fingerprint while the person is still due (logging an
    // interaction also resolves the item), so dismissing a follow-up means
    // "quiet until we actually talk" — stronger than the date-bound domain
    // snooze, and the row stays until an interaction lands.
    fingerprint: f.last_interaction_at ?? 'never',
  }))
}

function reminderItems(db: DbDriver, now: Date): PendingItem[] {
  // NOT notes.listDueReminders: its predicate excludes fired reminders
  // because it answers "what should the scheduler still notify about". For
  // triage, delivery is not resolution — a reminder that already produced
  // its notification stays pending until dismissed here or resolved in
  // Notes. A repeating note advances remind_at, so the fingerprint renews
  // and a dismissal expires on the next occurrence.
  const rows = db.all<{ id: string; title: string; content: string; remind_at: string }>(
    `SELECT id, title, content, remind_at FROM notes
     WHERE archived = 0 AND remind_at IS NOT NULL AND remind_at <= ?
     ORDER BY remind_at`,
    nowIso(now)
  )
  return rows.map((n) => ({
    key: `reminder:${n.id}`,
    kind: 'reminder' as const,
    id: n.id,
    title: n.title || n.content.split('\n')[0] || 'Untitled note',
    subtitle: 'reminder',
    tone: 'accent' as const,
    at: n.remind_at,
    fingerprint: n.remind_at
  }))
}

const UNREAD_THREAD = `sync_enabled = 1 AND is_archived = 0 AND unread_count > 0`

/** THE copy of the thread overlay-visibility predicate: hidden while snoozed,
 *  or while dismissed with an unchanged fingerprint (= last_message_at).
 *  Fetch and count both use it, so LIMIT applies to *visible* rows and the
 *  materialized list can never go empty while the count says otherwise.
 *  Takes one `?` (now as ISO). */
const THREAD_VISIBLE = `NOT EXISTS (
  SELECT 1 FROM pending_overlay o
  WHERE o.item_key = 'thread:' || t.id
    AND ((o.snoozed_until IS NOT NULL AND o.snoozed_until > ?)
      OR (o.dismissed_at IS NOT NULL
          AND o.fingerprint = COALESCE(t.last_message_at, '')))
)`

/** Visible unread threads — action-needed first, capped for display. */
function threadItems(db: DbDriver, ts: string): PendingItem[] {
  const rows = db.all<{
    id: string
    title: string
    snippet: string
    last_message_at: string | null
    labels: string
  }>(
    `SELECT id, title, snippet, last_message_at, labels FROM comms_threads t
     WHERE ${UNREAD_THREAD} AND ${THREAD_VISIBLE}
     ORDER BY instr(',' || labels || ',', ',action-needed,') > 0 DESC, last_message_at DESC
     LIMIT ${THREAD_CAP}`,
    ts
  )
  return rows.map((r) => {
    const actionNeeded = r.labels.split(',').includes('action-needed')
    return {
      key: `thread:${r.id}`,
      kind: 'thread' as const,
      id: r.id,
      title: r.title,
      subtitle: r.snippet,
      // autoLabel is off by default, so plain unread is the baseline signal
      // and the classifier's action-needed verdict is the elevation
      tone: actionNeeded ? ('accent' as const) : ('muted' as const),
      at: r.last_message_at,
      fingerprint: r.last_message_at ?? ''
    }
  })
}

/** Exact count of visible unread threads (uncapped). */
function visibleThreadCount(db: DbDriver, ts: string): number {
  return (
    db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM comms_threads t
       WHERE ${UNREAD_THREAD} AND ${THREAD_VISIBLE}`,
      ts
    )?.n ?? 0
  )
}

export function pendingItems(db: DbDriver, now: Date = new Date()): PendingPayload {
  const ts = nowIso(now)
  const today = localDate(now)

  const fixed = [...taskItems(db, today), ...followupItems(db, now), ...reminderItems(db, now)]
  // threads apply the overlay in SQL (THREAD_VISIBLE); only the small fixed
  // sources need the JS pass
  const overlays = new Map<string, OverlayRow>(
    db.all<OverlayRow>('SELECT * FROM pending_overlay').map((r) => [r.item_key, r])
  )
  const visible = (it: PendingItem): boolean => {
    const o = overlays.get(it.key)
    if (!o) return true
    if (o.snoozed_until && o.snoozed_until > ts) return false
    if (o.dismissed_at && o.fingerprint === it.fingerprint) return false
    return true
  }

  const visFixed = fixed.filter(visible)
  const shownThreads = threadItems(db, ts)
  const threadTotal = visibleThreadCount(db, ts)
  return {
    items: [...visFixed, ...shownThreads],
    more_threads: threadTotal - shownThreads.length,
    total: visFixed.length + threadTotal
  }
}

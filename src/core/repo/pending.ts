import type { DbDriver } from '../driver'
import type { PendingItem, PendingPayload, Task } from '../types'
import { localDate, nowIso } from '../ids'
import { followupsDue } from './followups'
import { listDueReminders } from './notes'

// The Pending inbox aggregator. Everything is computed live from the source
// domains so items can never go stale; the pending_overlay table contributes
// only visibility (snooze/dismiss) and, later, seen state. Sources appear in
// section order: tasks, followups, note reminders, unread threads.

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
    // last interaction is what resets the cadence, so it is the renewal signal
    fingerprint: f.last_interaction_at ?? 'never',
  }))
}

function reminderItems(db: DbDriver, now: Date): PendingItem[] {
  return listDueReminders(db, now).map((n) => ({
    key: `reminder:${n.id}`,
    kind: 'reminder' as const,
    id: n.id,
    title: n.title || n.content.split('\n')[0] || 'Untitled note',
    subtitle: 'reminder',
    tone: 'accent' as const,
    at: n.remind_at,
    fingerprint: n.remind_at ?? '',
  }))
}

/** All unread, sync-enabled, unarchived threads — action-needed ones first. */
function threadItems(db: DbDriver): PendingItem[] {
  const rows = db.all<{
    id: string
    title: string
    snippet: string
    last_message_at: string | null
    labels: string
  }>(
    `SELECT id, title, snippet, last_message_at, labels FROM comms_threads
     WHERE sync_enabled = 1 AND is_archived = 0 AND unread_count > 0
     ORDER BY last_message_at DESC`
  )
  const items = rows.map((r) => {
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
      fingerprint: r.last_message_at ?? '',
      actionNeeded
    }
  })
  return items
    .sort((a, b) => Number(b.actionNeeded) - Number(a.actionNeeded))
    .map(({ actionNeeded: _actionNeeded, ...item }) => item)
}

export function pendingItems(db: DbDriver, now: Date = new Date()): PendingPayload {
  const ts = nowIso(now)
  const today = localDate(now)

  const fixed = [...taskItems(db, today), ...followupItems(db, now), ...reminderItems(db, now)]
  const threads = threadItems(db)

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

  // GC: overlay rows whose item is no longer pending at all and whose snooze
  // has lapsed have nothing left to say — a resolved item that becomes
  // pending again gets a fresh fingerprint anyway.
  const liveKeys = new Set([...fixed, ...threads].map((i) => i.key))
  for (const o of overlays.values()) {
    if (!liveKeys.has(o.item_key) && (!o.snoozed_until || o.snoozed_until <= ts)) {
      db.run('DELETE FROM pending_overlay WHERE item_key = ?', o.item_key)
    }
  }

  const visFixed = fixed.filter(visible)
  const visThreads = threads.filter(visible)
  const shownThreads = visThreads.slice(0, THREAD_CAP)
  return {
    items: [...visFixed, ...shownThreads],
    more_threads: visThreads.length - shownThreads.length,
    total: visFixed.length + visThreads.length
  }
}

/** sidebar badge */
export function pendingCount(db: DbDriver, now: Date = new Date()): number {
  return pendingItems(db, now).total
}

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

/** An item is "seen" only while the fingerprint it was seen at still holds —
 *  a renewed condition makes it unseen again, mirroring dismissal scoping. */
const THREAD_SEEN = `EXISTS (
  SELECT 1 FROM pending_overlay o
  WHERE o.item_key = 'thread:' || t.id
    AND o.seen_at IS NOT NULL
    AND o.fingerprint = COALESCE(t.last_message_at, '')
)`

/** Exact count of visible unread threads (uncapped); unseen-only variant. */
function visibleThreadCount(db: DbDriver, ts: string, unseenOnly = false): number {
  return (
    db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM comms_threads t
       WHERE ${UNREAD_THREAD} AND ${THREAD_VISIBLE}${unseenOnly ? ` AND NOT ${THREAD_SEEN}` : ''}`,
      ts
    )?.n ?? 0
  )
}

/** The non-thread sources, pre-overlay. */
function fixedItems(db: DbDriver, now: Date): PendingItem[] {
  const today = localDate(now)
  return [...taskItems(db, today), ...followupItems(db, now), ...reminderItems(db, now)]
}

function loadOverlays(db: DbDriver): Map<string, OverlayRow> {
  return new Map(db.all<OverlayRow>('SELECT * FROM pending_overlay').map((r) => [r.item_key, r]))
}

/** JS twin of THREAD_VISIBLE, for the fixed sources — the one place the
 *  overlay-visibility rule lives outside SQL. */
function hiddenBy(o: OverlayRow | undefined, fingerprint: string, ts: string): boolean {
  if (!o) return false
  if (o.snoozed_until && o.snoozed_until > ts) return true
  if (o.dismissed_at && o.fingerprint === fingerprint) return true
  return false
}

export function pendingItems(db: DbDriver, now: Date = new Date()): PendingPayload {
  const ts = nowIso(now)

  const fixed = fixedItems(db, now)
  // threads apply the overlay in SQL (THREAD_VISIBLE); only the small fixed
  // sources need the JS pass
  const overlays = loadOverlays(db)
  const visible = (it: PendingItem): boolean => !hiddenBy(overlays.get(it.key), it.fingerprint, ts)
  const seen = (it: PendingItem): boolean => {
    const o = overlays.get(it.key)
    return Boolean(o?.seen_at && o.fingerprint === it.fingerprint)
  }

  const visFixed = fixed.filter(visible)
  const shownThreads = threadItems(db, ts)
  const threadTotal = visibleThreadCount(db, ts)
  return {
    items: [...visFixed, ...shownThreads],
    more_threads: threadTotal - shownThreads.length,
    total: visFixed.length + threadTotal,
    unseen: visFixed.filter((i) => !seen(i)).length + visibleThreadCount(db, ts, true)
  }
}

// ---------- triage writes ----------
// Snooze/dismiss are inbox-local: they never touch the source domain. Every
// write stamps the item's CURRENT fingerprint — resolved server-side so
// callers (view rows, MCP tools) only ever pass a key — and resets the other
// visibility fields: a write is only reachable while the item is visible,
// which means any dismissed_at/snoozed_until already on the row is stale, and
// carrying it forward under the fresh fingerprint would wrongly re-hide.

/** Current fingerprint of a still-pending item; undefined once resolved. */
function currentFingerprint(db: DbDriver, key: string, now: Date): string | undefined {
  if (key.startsWith('thread:')) {
    const row = db.get<{ fp: string }>(
      `SELECT COALESCE(last_message_at, '') AS fp FROM comms_threads
       WHERE id = ? AND ${UNREAD_THREAD}`,
      key.slice('thread:'.length)
    )
    return row?.fp
  }
  return fixedItems(db, now).find((i) => i.key === key)?.fingerprint
}

function writeOverlay(
  db: DbDriver,
  key: string,
  patch: { snoozed_until: string | null; dismissed_at: string | null },
  now: Date
): void {
  const fp = currentFingerprint(db, key, now)
  if (fp === undefined) throw new Error(`not pending: ${key}`)
  const ts = nowIso(now)
  db.run(
    `INSERT INTO pending_overlay (item_key, fingerprint, snoozed_until, dismissed_at, seen_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(item_key) DO UPDATE SET
       fingerprint = excluded.fingerprint,
       snoozed_until = excluded.snoozed_until,
       dismissed_at = excluded.dismissed_at,
       seen_at = excluded.seen_at,
       updated_at = excluded.updated_at`,
    key,
    fp,
    patch.snoozed_until,
    patch.dismissed_at,
    ts, // triaging an item is seeing it
    ts
  )
  gcOverlay(db, now)
}

export function snoozeItem(db: DbDriver, key: string, untilIso: string, now: Date = new Date()): void {
  // normalize to UTC …Z form: both comparison sites are lexicographic string
  // compares against nowIso(), which is only sound if every stored value uses
  // the same form — MCP callers hand us local-offset ISO all the time, and
  // stored verbatim it sorts as already-lapsed (a silent no-op snooze)
  const until = new Date(untilIso)
  if (Number.isNaN(until.getTime())) throw new Error(`bad snooze timestamp: ${untilIso}`)
  writeOverlay(db, key, { snoozed_until: until.toISOString(), dismissed_at: null }, now)
}

export function dismissItem(db: DbDriver, key: string, now: Date = new Date()): void {
  writeOverlay(db, key, { snoozed_until: null, dismissed_at: nowIso(now) }, now)
}

/** Undo paths: clear one visibility field, leave the rest of the row alone. */
export function unsnoozeItem(db: DbDriver, key: string, now: Date = new Date()): void {
  db.run(
    'UPDATE pending_overlay SET snoozed_until = NULL, updated_at = ? WHERE item_key = ?',
    nowIso(now),
    key
  )
}

export function undismissItem(db: DbDriver, key: string, now: Date = new Date()): void {
  db.run(
    'UPDATE pending_overlay SET dismissed_at = NULL, updated_at = ? WHERE item_key = ?',
    nowIso(now),
    key
  )
}

/** Stamp every currently-visible item as seen at its current fingerprint.
 *  Includes threads beyond the display cap: the badge counts them, so
 *  opening the view must clear them too. Rows already seen at the same
 *  fingerprint are skipped to avoid write churn on every view visit. */
export function markAllSeen(db: DbDriver, now: Date = new Date()): void {
  const ts = nowIso(now)
  const overlays = loadOverlays(db)
  const stamp: { key: string; fp: string }[] = []

  for (const it of fixedItems(db, now)) {
    const o = overlays.get(it.key)
    if (hiddenBy(o, it.fingerprint, ts)) continue // not on screen, stays unseen
    if (o?.seen_at && o.fingerprint === it.fingerprint) continue
    stamp.push({ key: it.key, fp: it.fingerprint })
  }
  const threads = db.all<{ id: string; fp: string }>(
    `SELECT id, COALESCE(last_message_at, '') AS fp FROM comms_threads t
     WHERE ${UNREAD_THREAD} AND ${THREAD_VISIBLE} AND NOT ${THREAD_SEEN}`,
    ts
  )
  for (const t of threads) stamp.push({ key: `thread:${t.id}`, fp: t.fp })

  // steady state on an open view: everything already stamped — make the
  // common case free instead of paying fixedItems + GC on every pending:list
  if (stamp.length === 0) return

  for (const s of stamp) {
    // visible ⇒ any snooze on the row lapsed and any dismissal mismatched;
    // reset them so the fresh fingerprint can't revive a stale dismissal
    db.run(
      `INSERT INTO pending_overlay (item_key, fingerprint, snoozed_until, dismissed_at, seen_at, updated_at)
       VALUES (?, ?, NULL, NULL, ?, ?)
       ON CONFLICT(item_key) DO UPDATE SET
         fingerprint = excluded.fingerprint,
         snoozed_until = NULL,
         dismissed_at = NULL,
         seen_at = excluded.seen_at,
         updated_at = excluded.updated_at`,
      s.key,
      s.fp,
      ts,
      ts
    )
  }
  gcOverlay(db, now)
}

/** Delete rows whose item is no longer pending at all and whose snooze has
 *  lapsed — nothing left to say; a re-pending item gets a fresh fingerprint.
 *  Runs on every triage write, never on read. */
function gcOverlay(db: DbDriver, now: Date): void {
  const ts = nowIso(now)
  const live = new Set(fixedItems(db, now).map((i) => i.key))
  for (const r of db.all<{ id: string }>(`SELECT id FROM comms_threads WHERE ${UNREAD_THREAD}`))
    live.add(`thread:${r.id}`)
  for (const o of db.all<{ item_key: string; snoozed_until: string | null }>(
    'SELECT item_key, snoozed_until FROM pending_overlay'
  )) {
    if (!live.has(o.item_key) && (!o.snoozed_until || o.snoozed_until <= ts)) {
      db.run('DELETE FROM pending_overlay WHERE item_key = ?', o.item_key)
    }
  }
}

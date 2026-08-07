import type { DbDriver } from '../driver'
import type { PendingItem, PendingKind, PendingPayload, Task } from '../types'
import { localDate, nowIso } from '../ids'
import { followupsDue } from './followups'
import { listOutboxPending } from './comms'
import { listMeetings } from './meetings'

// The Pending inbox aggregator. Everything is computed live from the source
// domains so items can never go stale; the pending_overlay table contributes
// only visibility (snooze/dismiss) and, later, seen state. Sources appear in
// section order: tasks, followups, note reminders, unread threads. Reads are
// pure — overlay garbage collection belongs to the triage write paths.

/** unread threads shown before the "N more in Inbox" tail row */
const THREAD_CAP = 15
/** queued/sending outbox rows older than this count as stuck (the drain loop
 *  normally empties in seconds; restart requeues sending → queued) */
const STUCK_OUTBOX_MS = 10 * 60_000
/** a ready meeting is allowed this long to get its summary before "ready —
 *  not summarized" surfaces (the summarizer runs right after transcription) */
const UNSUMMARIZED_GRACE_MS = 15 * 60_000
/** finished agent runs surface for review this long, then age out */
const RUN_WINDOW_MS = 48 * 60 * 60_000
/** newest runs shown within the window — same "not a second mail client"
 *  argument as THREAD_CAP; hourly automations would otherwise put hundreds
 *  of rows here. All run paths (items, unseen count) share the bound, so
 *  the badge and the list stay consistent. */
const RUN_CAP = 30

const snippet = (s: string | null): string => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, 120)

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

/** Google Calendar invitations awaiting our answer: we are an attendee, our
 *  responseStatus is still needsAction, and the event isn't over. The self
 *  entry is found the same way the RSVP write path finds it (self flag, else
 *  email match against the account) so detect and respond can never disagree
 *  about who "we" are. */
function inviteItems(db: DbDriver, now: Date): PendingItem[] {
  const rows = db.all<{
    id: string
    title: string
    start_at: string
    all_day: number
    etag: string | null
    updated_at: string
    recurring_event_id: string | null
    attendees: string
  }>(
    // end_at > now, not start_at: an invite for a meeting already in progress
    // is still answerable. All-day date-only strings compare correctly against
    // ISO datetimes here for the same reason listEventsInRange's overlap does.
    `SELECT e.id, e.title, e.start_at, e.all_day, e.etag, e.updated_at,
            e.recurring_event_id, e.attendees
     FROM calendar_events e
     JOIN calendar_calendars c ON c.id = e.calendar_id
     JOIN calendar_accounts a ON a.id = c.account_id
     WHERE e.status != 'cancelled' AND e.sync_status != 'pending_delete'
       AND c.is_visible = 1
       AND e.end_at > ?
       AND EXISTS (
         SELECT 1 FROM json_each(e.attendees) je
         WHERE json_extract(je.value, '$.responseStatus') = 'needsAction'
           AND (json_extract(je.value, '$.self') = 1
                OR lower(json_extract(je.value, '$.email')) = a.external_id)
       )
     ORDER BY e.start_at`,
    nowIso(now)
  )
  // one row per series: a weekly invite is one question, not N expanded
  // instances. The earliest upcoming instance represents it — when that
  // occurrence passes, the key rolls to the next instance and any dismissal
  // expires with it, the same renewed-nag semantics as repeating reminders.
  const seenSeries = new Set<string>()
  const out: PendingItem[] = []
  for (const e of rows) {
    const series = e.recurring_event_id ?? e.id
    if (seenSeries.has(series)) continue
    seenSeries.add(series)
    let organizer: string | undefined
    try {
      const att = JSON.parse(e.attendees) as { email?: string; displayName?: string; organizer?: boolean }[]
      const o = att.find((x) => x.organizer)
      organizer = o?.displayName || o?.email
    } catch {
      // corrupted json: the EXISTS above can't have matched, but stay safe
    }
    const start = new Date(e.start_at)
    const when = e.all_day
      ? e.start_at
      : `${localDate(start)} ${String(start.getHours()).padStart(2, '0')}:${String(start.getMinutes()).padStart(2, '0')}`
    out.push({
      key: `invite:${e.id}`,
      kind: 'invite' as const,
      id: e.id,
      title: e.title || 'Untitled event',
      subtitle: organizer ? `${organizer} · ${when}` : when,
      tone: 'accent' as const,
      at: e.start_at,
      // etag changes on every remote modification (reschedule, forwarded
      // update), so a dismissal survives exactly until the invite changes
      fingerprint: e.etag ?? e.updated_at
    })
  }
  return out
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

/** Failed sends and stuck queue rows — work that is otherwise invisible
 *  after a reload (only the still-open composer knows about a failure). */
function outboxItems(db: DbDriver, now: Date): PendingItem[] {
  return listOutboxPending(db, now, STUCK_OUTBOX_MS).map((o) => {
    const failed = o.status === 'failed'
    let dest = o.thread_title ?? ''
    if (!dest) {
      try {
        const j = JSON.parse(o.to_json) as { to?: string[]; subject?: string }
        dest = j.subject || (Array.isArray(j.to) ? j.to.join(', ') : '') || o.provider
      } catch {
        dest = o.provider
      }
    }
    return {
      key: `outbox:${o.id}`,
      kind: 'outbox' as const,
      id: o.id,
      title: failed ? `Send failed — ${dest}` : `Send still queued — ${dest}`,
      subtitle: failed ? (o.error ?? (snippet(o.body_text) || 'unknown error')) : snippet(o.body_text),
      tone: failed ? ('danger' as const) : ('accent' as const),
      at: o.created_at,
      fingerprint: `${o.status}:${o.error ?? ''}`,
      // retry is only duplicate-safe where delivered units are tracked
      // per-message (WhatsApp); a gmail ambiguous accept would re-send
      provider: o.provider,
      status: o.status
    }
  })
}

function meetingItems(db: DbDriver, now: Date): PendingItem[] {
  const errored = listMeetings(db, { status: 'error' }).map((m) => ({
    key: `meeting:${m.id}`,
    kind: 'meeting' as const,
    id: m.id,
    title: m.title || 'Meeting',
    subtitle: m.error ?? 'processing failed',
    tone: 'danger' as const,
    at: m.started_at,
    fingerprint: `${m.status}:${m.summarized_at ?? ''}`,
    status: m.status
  }))
  // summarize failures leave status='ready' with summarized_at NULL and no
  // error — this predicate is their only trace outside a warn log line
  const grace = new Date(now.getTime() - UNSUMMARIZED_GRACE_MS).toISOString()
  const unsummarized = listMeetings(db, { status: 'ready' })
    .filter((m) => !m.summarized_at && m.ended_at != null && m.ended_at < grace)
    .map((m) => ({
      key: `meeting:${m.id}`,
      kind: 'meeting' as const,
      id: m.id,
      title: m.title || 'Meeting',
      subtitle: 'ready — not summarized',
      tone: 'muted' as const,
      at: m.started_at,
      fingerprint: `${m.status}:${m.summarized_at ?? ''}`,
      status: m.status
    }))
  return [...errored, ...unsummarized]
}

/** Finished runs from the review window: error runs loud, results quieter.
 *  They age out after RUN_WINDOW_MS instead of accumulating forever. */
function runItems(db: DbDriver, now: Date): PendingItem[] {
  const cutoff = new Date(now.getTime() - RUN_WINDOW_MS).toISOString()
  const rows = db.all<{
    id: string
    status: string
    finished_at: string
    error: string | null
    result: string | null
    task_name: string
  }>(
    `SELECT r.id, r.status, r.finished_at, r.error, r.result, t.name AS task_name
     FROM agent_task_runs r JOIN agent_tasks t ON t.id = r.task_id
     WHERE r.finished_at IS NOT NULL AND r.finished_at > ?
     ORDER BY (r.status = 'error') DESC, r.finished_at DESC
     LIMIT ${RUN_CAP}`,
    cutoff
  )
  // errors float above the cap line so 30 successes can never displace one
  // failure — bound the list on the axis you're willing to lose. Truncation
  // is deliberately silent (no "N more" tail like threads): nothing below
  // the line is danger-tone, and stale successes age out of the window anyway.
  return rows.map((r) => ({
    key: `agent_run:${r.id}`,
    kind: 'agent_run' as const,
    id: r.id,
    title: r.task_name,
    subtitle:
      r.status === 'success' ? snippet(r.result) || 'finished' : (r.error ?? r.status),
    tone:
      r.status === 'error'
        ? ('danger' as const)
        : r.status === 'success'
          ? ('accent' as const)
          : ('muted' as const),
    at: r.finished_at,
    // a run is immutable once finished — dismissing one is final, and the
    // row ages out of the window anyway
    fingerprint: r.finished_at,
    status: r.status
  }))
}

/** The non-thread sources, pre-overlay. `only` scopes which sources are even
 *  computed — the Automations hot path (agentTasks:activity fires per tool
 *  call) must not pay for six queries it throws away. */
function fixedItems(db: DbDriver, now: Date, only?: PendingKind): PendingItem[] {
  const want = (k: PendingKind): boolean => !only || only === k
  const out: PendingItem[] = []
  if (want('outbox')) out.push(...outboxItems(db, now))
  if (want('invite')) out.push(...inviteItems(db, now))
  if (want('task')) out.push(...taskItems(db, localDate(now)))
  if (want('followup')) out.push(...followupItems(db, now))
  if (want('reminder')) out.push(...reminderItems(db, now))
  if (want('meeting')) out.push(...meetingItems(db, now))
  if (want('agent_run')) out.push(...runItems(db, now))
  return out
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
    unseen: visFixed.filter((i) => !seen(i)).length + visibleThreadCount(db, ts, true),
    // threads are never danger-tone, so the fixed set is the whole story
    danger: visFixed.filter((i) => i.tone === 'danger').length
  }
}

/** Unseen finished runs for the Automations badge — same overlay watermarks
 *  the Pending badge counts, so the two can never disagree. */
export function unseenRunCount(db: DbDriver, now: Date = new Date()): number {
  const ts = nowIso(now)
  const overlays = loadOverlays(db)
  return runItems(db, now).filter((it) => {
    const o = overlays.get(it.key)
    if (hiddenBy(o, it.fingerprint, ts)) return false
    return !(o?.seen_at && o.fingerprint === it.fingerprint)
  }).length
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
 *  fingerprint are skipped to avoid write churn on every view visit.
 *  `onlyKind` scopes the stamp — the Automations view marks agent_run items
 *  seen without touching anyone else's watermarks. Returns the stamped keys
 *  so callers can cross-notify exactly when something changed (e.g. Pending
 *  stamping a run must refresh the Automations badge, and only then).
 *
 *  INVARIANT: cross-notify loop-safety rests on every fingerprint being
 *  stable between writes — a stamp at fingerprint F must find nothing to
 *  stamp on the next pass. A time-derived fingerprint (anything computed
 *  from `now`) would re-stamp forever and turn the "only when stamped"
 *  broadcast guard into an infinite loop. */
export function markAllSeen(
  db: DbDriver,
  now: Date = new Date(),
  onlyKind?: PendingKind
): string[] {
  const ts = nowIso(now)
  const overlays = loadOverlays(db)
  const stamp: { key: string; fp: string }[] = []

  for (const it of fixedItems(db, now, onlyKind)) {
    const o = overlays.get(it.key)
    if (hiddenBy(o, it.fingerprint, ts)) continue // not on screen, stays unseen
    if (o?.seen_at && o.fingerprint === it.fingerprint) continue
    stamp.push({ key: it.key, fp: it.fingerprint })
  }
  if (!onlyKind || onlyKind === 'thread') {
    const threads = db.all<{ id: string; fp: string }>(
      `SELECT id, COALESCE(last_message_at, '') AS fp FROM comms_threads t
       WHERE ${UNREAD_THREAD} AND ${THREAD_VISIBLE} AND NOT ${THREAD_SEEN}`,
      ts
    )
    for (const t of threads) stamp.push({ key: `thread:${t.id}`, fp: t.fp })
  }

  // steady state on an open view: everything already stamped — make the
  // common case free instead of paying fixedItems + GC on every pending:list
  if (stamp.length === 0) return []

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
  return stamp.map((s) => s.key)
}

/** Delete rows whose item is no longer pending at all and whose snooze has
 *  lapsed — nothing left to say; a re-pending item gets a fresh fingerprint.
 *  Runs on every triage write, never on read.
 *
 *  The `live` set here must ALWAYS be global — never thread an `onlyKind`
 *  scope through: a partial set would read every kind it didn't compute as
 *  "gone" and silently wipe their snooze/dismiss state on each pass. */
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

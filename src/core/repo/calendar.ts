import type { DbDriver, SqlValue } from '../driver'
import type {
  CalendarAccount,
  CalendarAccountStatus,
  CalendarAttendee,
  CalendarCalendar,
  CalendarEventPatch,
  CalendarEventRecord,
  CalendarEventStatus,
  NewCalendarEvent
} from '../types'
import { newId, nowIso } from '../ids'

/** the seeded pseudo-calendar for events that never sync anywhere */
export const LOCAL_CALENDAR_ID = 'local'

// ---------- accounts ----------

export function listCalendarAccounts(db: DbDriver): CalendarAccount[] {
  return db.all<CalendarAccount>('SELECT * FROM calendar_accounts ORDER BY created_at')
}

export function getCalendarAccount(db: DbDriver, id: string): CalendarAccount | undefined {
  return db.get<CalendarAccount>('SELECT * FROM calendar_accounts WHERE id = ?', id)
}

export function upsertCalendarAccount(
  db: DbDriver,
  input: { external_id: string; display_name: string },
  now: Date = new Date()
): CalendarAccount {
  const ts = nowIso(now)
  const existing = db.get<CalendarAccount>(
    "SELECT * FROM calendar_accounts WHERE provider = 'gcal' AND external_id = ?",
    input.external_id
  )
  if (existing) {
    db.run(
      `UPDATE calendar_accounts SET display_name = ?, status = 'connected', error = NULL, updated_at = ? WHERE id = ?`,
      input.display_name,
      ts,
      existing.id
    )
    return getCalendarAccount(db, existing.id)!
  }
  const id = newId()
  db.run(
    `INSERT INTO calendar_accounts (id, provider, external_id, display_name, status, created_at, updated_at)
     VALUES (?, 'gcal', ?, ?, 'connected', ?, ?)`,
    id,
    input.external_id,
    input.display_name,
    ts,
    ts
  )
  return getCalendarAccount(db, id)!
}

export function setCalendarAccountStatus(
  db: DbDriver,
  id: string,
  status: CalendarAccountStatus,
  error: string | null = null,
  now: Date = new Date()
): void {
  db.run(
    'UPDATE calendar_accounts SET status = ?, error = ?, updated_at = ? WHERE id = ?',
    status,
    error,
    nowIso(now),
    id
  )
}

export function touchCalendarAccountSync(db: DbDriver, id: string, now: Date = new Date()): void {
  db.run('UPDATE calendar_accounts SET last_sync_at = ?, updated_at = ? WHERE id = ?', nowIso(now), nowIso(now), id)
}

/** Calendars, events and credentials cascade via FK. */
export function deleteCalendarAccount(db: DbDriver, id: string): void {
  db.run('DELETE FROM calendar_accounts WHERE id = ?', id)
}

// ---------- credentials (opaque ciphertext; encryption lives in Electron main) ----------

export function setCalendarCredentialCipher(db: DbDriver, accountId: string, cipher: string): void {
  db.run(
    `INSERT INTO calendar_credentials (account_id, cipher) VALUES (?, ?)
     ON CONFLICT(account_id) DO UPDATE SET cipher = excluded.cipher`,
    accountId,
    cipher
  )
}

export function getCalendarCredentialCipher(db: DbDriver, accountId: string): string | undefined {
  return db.get<{ cipher: string }>(
    'SELECT cipher FROM calendar_credentials WHERE account_id = ?',
    accountId
  )?.cipher
}

// ---------- calendars ----------

export function listCalendars(db: DbDriver): CalendarCalendar[] {
  // local pseudo-calendar first, then google calendars grouped by account
  return db.all<CalendarCalendar>(
    `SELECT * FROM calendar_calendars
     ORDER BY account_id IS NOT NULL, account_id, is_primary DESC, summary COLLATE NOCASE`
  )
}

export function getCalendar(db: DbDriver, id: string): CalendarCalendar | undefined {
  return db.get<CalendarCalendar>('SELECT * FROM calendar_calendars WHERE id = ?', id)
}

export function listAccountCalendars(db: DbDriver, accountId: string): CalendarCalendar[] {
  return db.all<CalendarCalendar>(
    'SELECT * FROM calendar_calendars WHERE account_id = ? ORDER BY is_primary DESC, summary COLLATE NOCASE',
    accountId
  )
}

export interface GoogleCalendarUpsert {
  google_calendar_id: string
  summary: string
  color: string | null
  is_primary: boolean
  is_writable: boolean
}

export function upsertCalendarFromGoogle(
  db: DbDriver,
  accountId: string,
  input: GoogleCalendarUpsert,
  now: Date = new Date()
): CalendarCalendar {
  const ts = nowIso(now)
  const existing = db.get<CalendarCalendar>(
    'SELECT * FROM calendar_calendars WHERE account_id = ? AND google_calendar_id = ?',
    accountId,
    input.google_calendar_id
  )
  if (existing) {
    db.run(
      `UPDATE calendar_calendars SET summary = ?, color = ?, is_primary = ?, is_writable = ?, updated_at = ?
       WHERE id = ?`,
      input.summary,
      input.color,
      input.is_primary ? 1 : 0,
      input.is_writable ? 1 : 0,
      ts,
      existing.id
    )
    return getCalendar(db, existing.id)!
  }
  const id = newId()
  db.run(
    `INSERT INTO calendar_calendars
       (id, account_id, google_calendar_id, summary, color, is_primary, is_writable, is_visible, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    id,
    accountId,
    input.google_calendar_id,
    input.summary,
    input.color,
    input.is_primary ? 1 : 0,
    input.is_writable ? 1 : 0,
    ts,
    ts
  )
  return getCalendar(db, id)!
}

/** Drop calendars (and their events, via FK) that vanished from the account's calendarList. */
export function deleteCalendarsNotIn(db: DbDriver, accountId: string, keepGoogleIds: string[]): number {
  const rows = db.all<{ id: string; google_calendar_id: string }>(
    'SELECT id, google_calendar_id FROM calendar_calendars WHERE account_id = ?',
    accountId
  )
  const keep = new Set(keepGoogleIds)
  let removed = 0
  for (const row of rows) {
    if (keep.has(row.google_calendar_id)) continue
    db.run('DELETE FROM calendar_calendars WHERE id = ?', row.id)
    removed++
  }
  return removed
}

export function setCalendarVisible(db: DbDriver, id: string, visible: boolean, now: Date = new Date()): void {
  db.run(
    'UPDATE calendar_calendars SET is_visible = ?, updated_at = ? WHERE id = ?',
    visible ? 1 : 0,
    nowIso(now),
    id
  )
}

export function setCalendarSyncToken(db: DbDriver, id: string, token: string | null, now: Date = new Date()): void {
  db.run('UPDATE calendar_calendars SET sync_token = ?, updated_at = ? WHERE id = ?', token, nowIso(now), id)
}

// ---------- events ----------

interface EventRow extends Omit<CalendarEventRecord, 'attendees'> {
  attendees: string
}

function parseEvent(row: EventRow): CalendarEventRecord {
  let attendees: CalendarAttendee[] = []
  try {
    attendees = JSON.parse(row.attendees) as CalendarAttendee[]
  } catch {
    // corrupted json: present as no attendees
  }
  return { ...row, attendees }
}

export function getEvent(db: DbDriver, id: string): CalendarEventRecord | undefined {
  const row = db.get<EventRow>('SELECT * FROM calendar_events WHERE id = ?', id)
  return row ? parseEvent(row) : undefined
}

/**
 * Events overlapping [startIso, endIso) on visible calendars. Works for both
 * storage formats: date-only strings ('2026-07-03') compare correctly against
 * ISO datetimes lexicographically for overlap purposes, and all-day ends are
 * exclusive by construction.
 */
export function listEventsInRange(
  db: DbDriver,
  startIso: string,
  endIso: string,
  opts: { calendarId?: string; includeHidden?: boolean } = {}
): CalendarEventRecord[] {
  const where: string[] = [
    "e.status != 'cancelled'",
    "e.sync_status != 'pending_delete'",
    'e.start_at < ?',
    'e.end_at > ?'
  ]
  const params: SqlValue[] = [endIso, startIso]
  if (!opts.includeHidden) where.push('c.is_visible = 1')
  if (opts.calendarId) {
    where.push('e.calendar_id = ?')
    params.push(opts.calendarId)
  }
  return db
    .all<EventRow>(
      `SELECT e.* FROM calendar_events e
       JOIN calendar_calendars c ON c.id = e.calendar_id
       WHERE ${where.join(' AND ')}
       ORDER BY e.all_day DESC, e.start_at`,
      ...params
    )
    .map(parseEvent)
}

function assertRange(startAt: string, endAt: string): void {
  if (endAt <= startAt) throw new Error('event end must be after start')
}

export function createEvent(db: DbDriver, input: NewCalendarEvent, now: Date = new Date()): CalendarEventRecord {
  const calendarId = input.calendar_id ?? LOCAL_CALENDAR_ID
  const calendar = getCalendar(db, calendarId)
  if (!calendar) throw new Error(`calendar not found: ${calendarId}`)
  if (!calendar.is_writable) throw new Error(`calendar is read-only: ${calendar.summary}`)
  assertRange(input.start_at, input.end_at)
  const id = newId()
  const ts = nowIso(now)
  db.run(
    `INSERT INTO calendar_events
       (id, calendar_id, title, description, location, start_at, end_at, all_day, timezone,
        color, attendees, conferencing_url, status, sync_status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, ?, ?)`,
    id,
    calendarId,
    input.title,
    input.description ?? null,
    input.location ?? null,
    input.start_at,
    input.end_at,
    input.all_day ? 1 : 0,
    input.timezone ?? null,
    input.color ?? null,
    JSON.stringify(input.attendees ?? []),
    input.conferencing_url ?? null,
    calendar.account_id ? 'pending_create' : 'synced',
    ts,
    ts
  )
  return getEvent(db, id)!
}

const PATCHABLE = [
  'title',
  'description',
  'location',
  'start_at',
  'end_at',
  'timezone',
  'color',
  'conferencing_url',
  'status'
] as const

export function updateEvent(
  db: DbDriver,
  id: string,
  patch: CalendarEventPatch,
  now: Date = new Date()
): CalendarEventRecord {
  const existing = getEvent(db, id)
  if (!existing) throw new Error(`event not found: ${id}`)
  if (existing.recurring_event_id) {
    throw new Error('recurring event instances are read-only in Kairos — edit them in Google Calendar')
  }

  const sets: string[] = []
  const params: SqlValue[] = []
  for (const key of PATCHABLE) {
    if (patch[key] === undefined) continue
    sets.push(`${key} = ?`)
    params.push(patch[key] as SqlValue)
  }
  if (patch.all_day !== undefined) {
    sets.push('all_day = ?')
    params.push(patch.all_day ? 1 : 0)
  }
  if (patch.attendees !== undefined) {
    sets.push('attendees = ?')
    params.push(JSON.stringify(patch.attendees))
  }

  // moving between calendars is only possible before the event exists on
  // Google — a remote "move" is a different API operation, out of scope in v1
  let calendar = getCalendar(db, existing.calendar_id)!
  if (patch.calendar_id !== undefined && patch.calendar_id !== existing.calendar_id) {
    if (existing.google_event_id) {
      throw new Error('events already synced to Google cannot be moved between calendars')
    }
    const target = getCalendar(db, patch.calendar_id)
    if (!target) throw new Error(`calendar not found: ${patch.calendar_id}`)
    if (!target.is_writable) throw new Error(`calendar is read-only: ${target.summary}`)
    sets.push('calendar_id = ?')
    params.push(target.id)
    calendar = target
  }
  if (sets.length === 0) return existing

  const startAt = patch.start_at ?? existing.start_at
  const endAt = patch.end_at ?? existing.end_at
  assertRange(startAt, endAt)

  // dirty-flag escalation: events without a remote counterpart always need an
  // insert (covers local→google calendar moves); synced remote events need a
  // patch; pending_create/pending_update stay as they are
  let syncStatus = existing.sync_status
  if (!calendar.account_id) {
    syncStatus = 'synced'
  } else if (!existing.google_event_id) {
    syncStatus = 'pending_create'
  } else if (syncStatus === 'synced') {
    syncStatus = 'pending_update'
  }
  sets.push('sync_status = ?', 'updated_at = ?')
  params.push(syncStatus, nowIso(now))

  db.run(`UPDATE calendar_events SET ${sets.join(', ')} WHERE id = ?`, ...params, id)
  return getEvent(db, id)!
}

/**
 * Local-calendar events and never-pushed creates delete immediately; events
 * that exist on Google flip to pending_delete and are hard-deleted after the
 * push drain confirms the remote delete.
 */
export function deleteEvent(db: DbDriver, id: string, now: Date = new Date()): void {
  const existing = getEvent(db, id)
  if (!existing) return
  if (existing.recurring_event_id) {
    throw new Error('recurring event instances are read-only in Kairos — delete them in Google Calendar')
  }
  if (!existing.google_event_id) {
    db.run('DELETE FROM calendar_events WHERE id = ?', id)
    return
  }
  db.run(
    "UPDATE calendar_events SET sync_status = 'pending_delete', updated_at = ? WHERE id = ?",
    nowIso(now),
    id
  )
}

export function hardDeleteEvent(db: DbDriver, id: string): void {
  db.run('DELETE FROM calendar_events WHERE id = ?', id)
}

/** Dirty events on one account's calendars, oldest first — the push-drain work list. */
export function listDirtyEvents(db: DbDriver, accountId: string): CalendarEventRecord[] {
  return db
    .all<EventRow>(
      `SELECT e.* FROM calendar_events e
       JOIN calendar_calendars c ON c.id = e.calendar_id
       WHERE c.account_id = ? AND e.sync_status != 'synced'
       ORDER BY e.updated_at`,
      accountId
    )
    .map(parseEvent)
}

export function markEventSynced(
  db: DbDriver,
  id: string,
  remote: { google_event_id: string; etag: string | null },
  now: Date = new Date()
): void {
  db.run(
    `UPDATE calendar_events SET sync_status = 'synced', google_event_id = ?, etag = ?, updated_at = ? WHERE id = ?`,
    remote.google_event_id,
    remote.etag,
    nowIso(now),
    id
  )
}

/** Remote event fields as mapped by the main-process Google client (repo stays network-free). */
export interface RemoteEvent {
  google_event_id: string
  etag: string | null
  recurring_event_id: string | null
  title: string
  description: string | null
  location: string | null
  start_at: string
  end_at: string
  all_day: boolean
  timezone: string | null
  color: string | null
  attendees: CalendarAttendee[]
  conferencing_url: string | null
  status: CalendarEventStatus
}

/**
 * Upsert one event from a Google feed. Remote-cancelled rows delete locally.
 * A locally-dirty row is only overwritten when the remote actually changed
 * (different etag) — remote-wins on real conflicts, but an unchanged remote
 * copy (e.g. during a full resync) must not revert queued local edits.
 */
export function applyRemoteEvent(
  db: DbDriver,
  calendarId: string,
  remote: RemoteEvent,
  now: Date = new Date()
): void {
  const existing = db.get<EventRow>(
    'SELECT * FROM calendar_events WHERE calendar_id = ? AND google_event_id = ?',
    calendarId,
    remote.google_event_id
  )

  if (remote.status === 'cancelled') {
    if (existing) db.run('DELETE FROM calendar_events WHERE id = ?', existing.id)
    return
  }

  const ts = nowIso(now)
  if (existing) {
    if (existing.sync_status !== 'synced' && existing.etag === remote.etag) return
    db.run(
      `UPDATE calendar_events SET
         etag = ?, recurring_event_id = ?, title = ?, description = ?, location = ?,
         start_at = ?, end_at = ?, all_day = ?, timezone = ?, color = ?, attendees = ?,
         conferencing_url = ?, status = ?, sync_status = 'synced', updated_at = ?
       WHERE id = ?`,
      remote.etag,
      remote.recurring_event_id,
      remote.title,
      remote.description,
      remote.location,
      remote.start_at,
      remote.end_at,
      remote.all_day ? 1 : 0,
      remote.timezone,
      remote.color,
      JSON.stringify(remote.attendees),
      // Google has no field for pasted third-party links, so a locally-stored
      // URL survives pulls where the remote carries no conference data
      remote.conferencing_url ?? existing.conferencing_url,
      remote.status,
      ts,
      existing.id
    )
    return
  }

  db.run(
    `INSERT INTO calendar_events
       (id, calendar_id, google_event_id, etag, recurring_event_id, title, description, location,
        start_at, end_at, all_day, timezone, color, attendees, conferencing_url, status, sync_status,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'synced', ?, ?)`,
    newId(),
    calendarId,
    remote.google_event_id,
    remote.etag,
    remote.recurring_event_id,
    remote.title,
    remote.description,
    remote.location,
    remote.start_at,
    remote.end_at,
    remote.all_day ? 1 : 0,
    remote.timezone,
    remote.color,
    JSON.stringify(remote.attendees),
    remote.conferencing_url,
    remote.status,
    ts,
    ts
  )
}

/** Distinct attendee emails seen on past events matching `q` — autocomplete
 *  fodder for the invite field (merged with the people table in the handler). */
export function suggestAttendees(
  db: DbDriver,
  q: string,
  limit = 8
): { email: string; name: string | null }[] {
  const like = `%${q}%`
  return db.all<{ email: string; name: string | null }>(
    `SELECT DISTINCT lower(json_extract(je.value, '$.email')) AS email,
            json_extract(je.value, '$.displayName') AS name
     FROM calendar_events e, json_each(e.attendees) je
     WHERE json_extract(je.value, '$.email') IS NOT NULL
       AND (json_extract(je.value, '$.email') LIKE ? OR json_extract(je.value, '$.displayName') LIKE ?)
     ORDER BY email LIMIT ?`,
    like,
    like,
    limit
  )
}

/** Store a Google-generated Meet link without dirtying the row (the link was
 *  written remotely by the addMeet patch — the row is in sync). */
export function setEventConferencing(
  db: DbDriver,
  id: string,
  url: string | null,
  etag: string | null,
  now: Date = new Date()
): void {
  db.run(
    'UPDATE calendar_events SET conferencing_url = ?, etag = COALESCE(?, etag), updated_at = ? WHERE id = ?',
    url,
    etag,
    nowIso(now),
    id
  )
}

/**
 * After a full (windowed) resync, drop synced rows the feed no longer
 * contains — they were deleted remotely while we had no syncToken. Dirty rows
 * survive so queued local work is never lost.
 */
export function deleteEventsMissingFromFullSync(
  db: DbDriver,
  calendarId: string,
  seenGoogleIds: string[],
  windowStartIso: string,
  windowEndIso: string
): number {
  const rows = db.all<{ id: string; google_event_id: string }>(
    `SELECT id, google_event_id FROM calendar_events
     WHERE calendar_id = ? AND google_event_id IS NOT NULL AND sync_status = 'synced'
       AND start_at < ? AND end_at > ?`,
    calendarId,
    windowEndIso,
    windowStartIso
  )
  const seen = new Set(seenGoogleIds)
  let removed = 0
  for (const row of rows) {
    if (seen.has(row.google_event_id)) continue
    db.run('DELETE FROM calendar_events WHERE id = ?', row.id)
    removed++
  }
  return removed
}

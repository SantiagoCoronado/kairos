import type { DbDriver, SqlValue } from '../driver'
import type { Note, NoteItem, NoteFilter, NewNote, NotePatch } from '../types'
import { newId, nowIso } from '../ids'

/** raw row: items is a JSON string in SQLite */
type NoteRow = Omit<Note, 'items'> & { items: string }

function parseRow(row: NoteRow): Note {
  let items: NoteItem[] = []
  try {
    const parsed = JSON.parse(row.items)
    if (Array.isArray(parsed))
      items = parsed
        .filter((it) => it && typeof it === 'object')
        .map((it) => ({ text: String(it.text ?? ''), done: Boolean(it.done) }))
  } catch {
    // tolerate bad JSON — treat as empty checklist
  }
  return { ...row, items }
}

export function getNote(db: DbDriver, id: string): Note | undefined {
  const row = db.get<NoteRow>('SELECT * FROM notes WHERE id = ?', id)
  return row ? parseRow(row) : undefined
}

export function listNotes(db: DbDriver, f: NoteFilter = {}): Note[] {
  const where: string[] = ['archived = ?']
  const params: SqlValue[] = [f.archived ? 1 : 0]
  if (f.label) {
    where.push(`' ' || labels || ' ' LIKE ?`)
    params.push(`% ${f.label} %`)
  }
  if (f.search) {
    where.push('(title LIKE ? OR content LIKE ? OR items LIKE ? OR labels LIKE ?)')
    const q = `%${f.search}%`
    params.push(q, q, q, q)
  }
  const orderBy = f.archived ? 'updated_at DESC' : 'pinned DESC, sort_order, updated_at DESC'
  const rows = db.all<NoteRow>(
    `SELECT * FROM notes WHERE ${where.join(' AND ')} ORDER BY ${orderBy}`,
    ...params
  )
  return rows.map(parseRow)
}

export function createNote(db: DbDriver, input: NewNote, now: Date = new Date()): Note {
  const id = newId()
  const ts = nowIso(now)
  db.run(
    `INSERT INTO notes (id, title, content, items, note_type, color, labels, pinned, remind_at, repeat, source, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MIN(sort_order), 1) - 1 FROM notes), ?, ?)`,
    id,
    input.title ?? '',
    input.content ?? '',
    JSON.stringify(input.items ?? []),
    input.note_type ?? (input.items?.length ? 'checklist' : 'note'),
    input.color ?? null,
    normalizeLabels(input.labels ?? ''),
    input.pinned ? 1 : 0,
    input.remind_at ?? null,
    input.repeat ?? 'none',
    input.source ?? 'user',
    ts,
    ts
  )
  return getNote(db, id)!
}

export function updateNote(
  db: DbDriver,
  id: string,
  patch: NotePatch,
  now: Date = new Date()
): Note {
  const existing = getNote(db, id)
  if (!existing) throw new Error(`note not found: ${id}`)
  const ts = nowIso(now)

  const next = { ...existing, ...stripUndefined(patch) }
  // a re-set reminder must be allowed to fire again
  const reminderChanged = patch.remind_at !== undefined && patch.remind_at !== existing.remind_at
  db.run(
    `UPDATE notes SET title=?, content=?, items=?, note_type=?, color=?, labels=?, pinned=?, archived=?, remind_at=?, repeat=?, reminder_fired_at=?, agent_session_id=?, updated_at=? WHERE id=?`,
    next.title,
    next.content,
    JSON.stringify(next.items),
    next.note_type,
    next.color,
    normalizeLabels(next.labels),
    next.pinned ? 1 : 0,
    next.archived ? 1 : 0,
    next.remind_at,
    next.repeat,
    reminderChanged ? null : existing.reminder_fired_at,
    next.agent_session_id,
    ts,
    id
  )
  return getNote(db, id)!
}

export function deleteNote(db: DbDriver, id: string): void {
  db.run('DELETE FROM notes WHERE id = ?', id)
}

export function toggleItem(db: DbDriver, id: string, index: number, now: Date = new Date()): Note {
  const note = getNote(db, id)
  if (!note) throw new Error(`note not found: ${id}`)
  if (index < 0 || index >= note.items.length) throw new Error(`item index out of range: ${index}`)
  const items = note.items.map((it, i) => (i === index ? { ...it, done: !it.done } : it))
  db.run(
    'UPDATE notes SET items = ?, updated_at = ? WHERE id = ?',
    JSON.stringify(items),
    nowIso(now),
    id
  )
  return getNote(db, id)!
}

/**
 * Drag-and-drop move: place `id` immediately before `beforeId` in manual
 * order (or at the end when beforeId is null). Renumbers the whole table in
 * one transaction — same approach as moveTaskBefore.
 */
export function moveNoteBefore(
  db: DbDriver,
  id: string,
  beforeId: string | null,
  now: Date = new Date()
): void {
  db.transaction(() => {
    const rows = db.all<{ id: string }>('SELECT id FROM notes ORDER BY sort_order, id')
    if (!rows.some((r) => r.id === id)) throw new Error(`note not found: ${id}`)
    const ids = rows.map((r) => r.id).filter((x) => x !== id)
    const at = beforeId === null ? ids.length : ids.indexOf(beforeId)
    if (at < 0) throw new Error(`note not found: ${beforeId}`)
    ids.splice(at, 0, id)
    ids.forEach((nid, i) => db.run('UPDATE notes SET sort_order = ? WHERE id = ?', i + 1, nid))
    db.run('UPDATE notes SET updated_at = ? WHERE id = ?', nowIso(now), id)
  })
}

/** distinct #tags across unarchived notes, alphabetical */
export function listLabels(db: DbDriver): string[] {
  const rows = db.all<{ labels: string }>(
    `SELECT labels FROM notes WHERE archived = 0 AND labels != ''`
  )
  const tags = new Set<string>()
  for (const r of rows) for (const t of r.labels.split(/\s+/)) if (t) tags.add(t)
  return [...tags].sort()
}

/** unarchived notes whose reminder is due now or overdue (for the sidebar badge) */
export function dueNoteCount(db: DbDriver, now: Date = new Date()): number {
  const row = db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM notes
     WHERE archived = 0 AND remind_at IS NOT NULL AND remind_at <= ?
       AND (reminder_fired_at IS NULL OR reminder_fired_at < remind_at)`,
    nowIso(now)
  )
  return row?.n ?? 0
}

/** notes with a due, un-fired reminder — the scheduler's work queue */
export function listDueReminders(db: DbDriver, now: Date = new Date()): Note[] {
  const rows = db.all<NoteRow>(
    `SELECT * FROM notes
     WHERE archived = 0 AND remind_at IS NOT NULL AND remind_at <= ?
       AND (reminder_fired_at IS NULL OR reminder_fired_at < remind_at)`,
    nowIso(now)
  )
  return rows.map(parseRow)
}

/** notes whose reminder falls in [startIso, endIso) — calendar overlay chips */
export function listNotesRemindBetween(db: DbDriver, startIso: string, endIso: string): Note[] {
  const rows = db.all<NoteRow>(
    `SELECT * FROM notes
     WHERE archived = 0 AND remind_at IS NOT NULL AND remind_at >= ? AND remind_at < ?
     ORDER BY remind_at`,
    startIso,
    endIso
  )
  return rows.map(parseRow)
}

/** canonical label form: '#'-prefixed, single-space separated */
function normalizeLabels(raw: string): string {
  return raw
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => (t.startsWith('#') ? t : `#${t}`))
    .join(' ')
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>
}

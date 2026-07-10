import type { DbDriver, SqlValue } from '../driver'
import type { Person, PersonUpsert, PeopleFilter, PersonDetail, Task, Interaction } from '../types'
import { newId, nowIso } from '../ids'
import { canonicalPhoneDigits } from './comms'

export function listPeople(db: DbDriver, f: PeopleFilter = {}): Person[] {
  const where: string[] = []
  const params: SqlValue[] = []
  if (!f.includeArchived) where.push('archived_at IS NULL')
  if (f.area) {
    where.push('area = ?')
    params.push(f.area)
  }
  if (f.search) {
    where.push('(name LIKE ? OR nickname LIKE ? OR company LIKE ? OR email LIKE ?)')
    const q = `%${f.search}%`
    params.push(q, q, q, q)
  }
  const sql = `SELECT * FROM people ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY name COLLATE NOCASE`
  return db.all<Person>(sql, ...params)
}

export function getPerson(db: DbDriver, id: string): Person | undefined {
  return db.get<Person>('SELECT * FROM people WHERE id = ?', id)
}

/**
 * Dedupe lookup for the Contacts autocomplete: does any non-archived person
 * already own one of these emails/phones? Phones compare by canonical digits
 * with an 8-digit-suffix tolerance (country-code formatting differences),
 * mirroring the WhatsApp contact matching in repo/comms.
 */
export function findPersonByContact(
  db: DbDriver,
  emails: string[],
  phones: string[]
): Person | undefined {
  for (const email of emails) {
    const p = db.get<Person>(
      'SELECT * FROM people WHERE archived_at IS NULL AND email IS NOT NULL AND lower(email) = lower(?)',
      email
    )
    if (p) return p
  }
  const digits = phones
    .map((p) => canonicalPhoneDigits(p.replace(/\D/g, '')))
    .filter((d) => d.length >= 7)
  if (digits.length === 0) return undefined
  const candidates = db.all<Person>(
    "SELECT * FROM people WHERE archived_at IS NULL AND phone IS NOT NULL AND phone != ''"
  )
  for (const person of candidates) {
    const pd = canonicalPhoneDigits(person.phone!.replace(/\D/g, ''))
    if (pd.length < 7) continue
    if (digits.some((d) => d === pd || (d.length >= 8 && pd.length >= 8 && d.slice(-8) === pd.slice(-8)))) {
      return person
    }
  }
  return undefined
}

export function getPersonDetail(db: DbDriver, id: string): PersonDetail | undefined {
  const person = getPerson(db, id)
  if (!person) return undefined
  const interactions = db.all<Interaction>(
    'SELECT * FROM interactions WHERE person_id = ? ORDER BY occurred_at DESC LIMIT 50',
    id
  )
  const open_tasks = db.all<Task>(
    "SELECT * FROM tasks WHERE person_id = ? AND status IN ('todo','in_progress') ORDER BY due_date IS NULL, due_date",
    id
  )
  return { person, interactions, open_tasks }
}

/**
 * Upsert semantics: by id when given; otherwise by case-insensitive exact
 * name match among non-archived people (lets the MCP/agent say "update Anna"
 * without knowing ids); otherwise insert.
 */
export function upsertPerson(db: DbDriver, input: PersonUpsert, now: Date = new Date()): Person {
  const ts = nowIso(now)
  const existing = input.id
    ? getPerson(db, input.id)
    : db.get<Person>(
        'SELECT * FROM people WHERE archived_at IS NULL AND lower(name) = lower(?)',
        input.name
      )

  if (existing) {
    const merged = {
      name: input.name ?? existing.name,
      nickname: input.nickname === undefined ? existing.nickname : input.nickname,
      email: input.email === undefined ? existing.email : input.email,
      phone: input.phone === undefined ? existing.phone : input.phone,
      company: input.company === undefined ? existing.company : input.company,
      role: input.role === undefined ? existing.role : input.role,
      area: input.area ?? existing.area,
      cadence_days: input.cadence_days === undefined ? existing.cadence_days : input.cadence_days,
      notes: input.notes === undefined ? existing.notes : input.notes
    }
    db.run(
      `UPDATE people SET name=?, nickname=?, email=?, phone=?, company=?, role=?, area=?, cadence_days=?, notes=?, updated_at=? WHERE id=?`,
      merged.name,
      merged.nickname,
      merged.email,
      merged.phone,
      merged.company,
      merged.role,
      merged.area,
      merged.cadence_days,
      merged.notes,
      ts,
      existing.id
    )
    return getPerson(db, existing.id)!
  }

  const id = newId()
  db.run(
    `INSERT INTO people (id, name, nickname, email, phone, company, role, area, cadence_days, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    input.name,
    input.nickname ?? null,
    input.email ?? null,
    input.phone ?? null,
    input.company ?? null,
    input.role ?? null,
    input.area ?? 'personal',
    input.cadence_days ?? null,
    input.notes ?? '',
    ts,
    ts
  )
  return getPerson(db, id)!
}

/** Resolve a loose person reference: id, exact name/nickname, then first search hit. */
export function resolvePersonRef(db: DbDriver, ref: string): Person | undefined {
  const byId = getPerson(db, ref)
  if (byId) return byId
  const exact = db.get<Person>(
    'SELECT * FROM people WHERE archived_at IS NULL AND (lower(name) = lower(?) OR lower(nickname) = lower(?))',
    ref,
    ref
  )
  if (exact) return exact
  return listPeople(db, { search: ref })[0]
}

export function archivePerson(db: DbDriver, id: string, now: Date = new Date()): void {
  db.run('UPDATE people SET archived_at = ?, updated_at = ? WHERE id = ?', nowIso(now), nowIso(now), id)
}

export function snoozeFollowup(db: DbDriver, personId: string, untilDate: string, now: Date = new Date()): void {
  db.run(
    'UPDATE people SET snoozed_until = ?, updated_at = ? WHERE id = ?',
    untilDate,
    nowIso(now),
    personId
  )
}

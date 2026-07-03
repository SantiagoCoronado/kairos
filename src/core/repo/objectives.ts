import type { DbDriver, SqlValue } from '../driver'
import type {
  Objective,
  ObjectiveWithKRs,
  ObjectivePatch,
  NewObjective,
  KeyResult,
  KrPatch,
  Task,
  Area,
  ObjectiveStatus
} from '../types'
import { newId, nowIso } from '../ids'

export function listObjectives(
  db: DbDriver,
  f: { period?: string; area?: Area; status?: ObjectiveStatus } = {}
): ObjectiveWithKRs[] {
  const where: string[] = []
  const params: SqlValue[] = []
  if (f.period) {
    where.push('period = ?')
    params.push(f.period)
  }
  if (f.area) {
    where.push('area = ?')
    params.push(f.area)
  }
  if (f.status) {
    where.push('status = ?')
    params.push(f.status)
  }
  const objectives = db.all<Objective>(
    `SELECT * FROM objectives ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY period DESC, sort_order, area, title`,
    ...params
  )
  return objectives.map((o) => withKRs(db, o))
}

export function getObjective(db: DbDriver, id: string): ObjectiveWithKRs | undefined {
  const o = db.get<Objective>('SELECT * FROM objectives WHERE id = ?', id)
  return o && withKRs(db, o)
}

function withKRs(db: DbDriver, o: Objective): ObjectiveWithKRs {
  const key_results = db.all<KeyResult>(
    'SELECT * FROM key_results WHERE objective_id = ? ORDER BY sort_order, id',
    o.id
  )
  const ratios = key_results.map((kr) => {
    const span = kr.target_value - kr.start_value
    if (span === 0) return kr.current_value >= kr.target_value ? 1 : 0
    return Math.max(0, Math.min(1, (kr.current_value - kr.start_value) / span))
  })
  const progress = ratios.length ? ratios.reduce((a, b) => a + b, 0) / ratios.length : 0
  return { ...o, key_results, progress }
}

export function createObjective(
  db: DbDriver,
  input: NewObjective,
  now: Date = new Date()
): ObjectiveWithKRs {
  const ts = nowIso(now)
  const id = newId()
  db.transaction(() => {
    db.run(
      `INSERT INTO objectives (id, title, description, area, period, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM objectives), ?, ?)`,
      id,
      input.title,
      input.description ?? '',
      input.area ?? 'personal',
      input.period,
      ts,
      ts
    )
    input.key_results?.forEach((kr, i) => {
      db.run(
        `INSERT INTO key_results (id, objective_id, title, unit, start_value, target_value, current_value, sort_order, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        newId(),
        id,
        kr.title,
        kr.unit ?? '',
        kr.start_value ?? 0,
        kr.target_value ?? 100,
        kr.start_value ?? 0,
        i,
        ts
      )
    })
  })
  return getObjective(db, id)!
}

export function updateObjective(
  db: DbDriver,
  id: string,
  patch: ObjectivePatch,
  now: Date = new Date()
): ObjectiveWithKRs {
  const existing = db.get<Objective>('SELECT * FROM objectives WHERE id = ?', id)
  if (!existing) throw new Error(`objective not found: ${id}`)
  const next = {
    ...existing,
    ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined))
  }
  db.run(
    'UPDATE objectives SET title=?, description=?, area=?, period=?, status=?, updated_at=? WHERE id=?',
    next.title,
    next.description,
    next.area,
    next.period,
    next.status,
    nowIso(now),
    id
  )
  return getObjective(db, id)!
}

export function deleteObjective(db: DbDriver, id: string): void {
  // key_results and task_key_results rows cascade via FKs; tasks are untouched
  db.run('DELETE FROM objectives WHERE id = ?', id)
}

/**
 * Drag-and-drop move: place `id` immediately before `beforeId` in manual
 * order (or at the end when beforeId is null). Renumbers the whole table in
 * one transaction.
 */
export function moveObjectiveBefore(
  db: DbDriver,
  id: string,
  beforeId: string | null,
  now: Date = new Date()
): void {
  db.transaction(() => {
    const rows = db.all<{ id: string }>('SELECT id FROM objectives ORDER BY sort_order, id')
    if (!rows.some((r) => r.id === id)) throw new Error(`objective not found: ${id}`)
    const ids = rows.map((r) => r.id).filter((x) => x !== id)
    const at = beforeId === null ? ids.length : ids.indexOf(beforeId)
    if (at < 0) throw new Error(`objective not found: ${beforeId}`)
    ids.splice(at, 0, id)
    ids.forEach((oid, i) => db.run('UPDATE objectives SET sort_order = ? WHERE id = ?', i + 1, oid))
    db.run('UPDATE objectives SET updated_at = ? WHERE id = ?', nowIso(now), id)
  })
}

/** Distinct periods present in the DB, newest first — drives the filter chips. */
export function listPeriods(db: DbDriver): string[] {
  return db
    .all<{ period: string }>('SELECT DISTINCT period FROM objectives ORDER BY period DESC')
    .map((r) => r.period)
}

export function addKeyResult(
  db: DbDriver,
  objectiveId: string,
  kr: { title: string; unit?: string; start_value?: number; target_value?: number },
  now: Date = new Date()
): KeyResult {
  const id = newId()
  const maxOrder =
    db.get<{ m: number | null }>(
      'SELECT MAX(sort_order) AS m FROM key_results WHERE objective_id = ?',
      objectiveId
    )?.m ?? -1
  db.run(
    `INSERT INTO key_results (id, objective_id, title, unit, start_value, target_value, current_value, sort_order, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    objectiveId,
    kr.title,
    kr.unit ?? '',
    kr.start_value ?? 0,
    kr.target_value ?? 100,
    kr.start_value ?? 0,
    maxOrder + 1,
    nowIso(now)
  )
  return db.get<KeyResult>('SELECT * FROM key_results WHERE id = ?', id)!
}

export function updateKrProgress(
  db: DbDriver,
  krId: string,
  currentValue: number,
  now: Date = new Date()
): KeyResult {
  db.run(
    'UPDATE key_results SET current_value = ?, updated_at = ? WHERE id = ?',
    currentValue,
    nowIso(now),
    krId
  )
  const kr = db.get<KeyResult>('SELECT * FROM key_results WHERE id = ?', krId)
  if (!kr) throw new Error(`key result not found: ${krId}`)
  return kr
}

export function updateKeyResult(
  db: DbDriver,
  krId: string,
  patch: KrPatch,
  now: Date = new Date()
): KeyResult {
  const existing = db.get<KeyResult>('SELECT * FROM key_results WHERE id = ?', krId)
  if (!existing) throw new Error(`key result not found: ${krId}`)
  const next = {
    ...existing,
    ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined))
  }
  db.run(
    'UPDATE key_results SET title=?, unit=?, start_value=?, target_value=?, current_value=?, updated_at=? WHERE id=?',
    next.title,
    next.unit,
    next.start_value,
    next.target_value,
    next.current_value,
    nowIso(now),
    krId
  )
  return db.get<KeyResult>('SELECT * FROM key_results WHERE id = ?', krId)!
}

export function deleteKeyResult(db: DbDriver, krId: string): void {
  db.run('DELETE FROM key_results WHERE id = ?', krId)
}

export function linkTaskToKr(db: DbDriver, taskId: string, krId: string): void {
  db.run(
    'INSERT OR IGNORE INTO task_key_results (task_id, key_result_id) VALUES (?, ?)',
    taskId,
    krId
  )
}

export function unlinkTaskFromKr(db: DbDriver, taskId: string, krId: string): void {
  db.run('DELETE FROM task_key_results WHERE task_id = ? AND key_result_id = ?', taskId, krId)
}

export function tasksForKr(db: DbDriver, krId: string): Task[] {
  return db.all<Task>(
    `SELECT t.* FROM tasks t
     JOIN task_key_results tk ON tk.task_id = t.id
     WHERE tk.key_result_id = ?
     ORDER BY t.status, t.due_date IS NULL, t.due_date`,
    krId
  )
}

export function krsForTask(db: DbDriver, taskId: string): KeyResult[] {
  return db.all<KeyResult>(
    `SELECT k.* FROM key_results k
     JOIN task_key_results tk ON tk.key_result_id = k.id
     WHERE tk.task_id = ?`,
    taskId
  )
}

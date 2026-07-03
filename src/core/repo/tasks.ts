import type { DbDriver, SqlValue } from '../driver'
import type { Task, TaskFilter, NewTask, TaskPatch } from '../types'
import { newId, nowIso } from '../ids'

export function getTask(db: DbDriver, id: string): Task | undefined {
  return db.get<Task>('SELECT * FROM tasks WHERE id = ?', id)
}

export function listTasks(db: DbDriver, f: TaskFilter = {}): Task[] {
  const where: string[] = []
  const params: SqlValue[] = []
  if (f.status) {
    const statuses = Array.isArray(f.status) ? f.status : [f.status]
    where.push(`status IN (${statuses.map(() => '?').join(',')})`)
    params.push(...statuses)
  }
  if (f.area) {
    where.push('area = ?')
    params.push(f.area)
  }
  if (f.project_id) {
    where.push('project_id = ?')
    params.push(f.project_id)
  }
  if (f.person_id) {
    where.push('person_id = ?')
    params.push(f.person_id)
  }
  if (f.due_before) {
    where.push('due_date IS NOT NULL AND due_date <= ?')
    params.push(f.due_before)
  }
  if (f.search) {
    where.push('(title LIKE ? OR notes LIKE ?)')
    params.push(`%${f.search}%`, `%${f.search}%`)
  }
  const statusRank = `CASE status WHEN 'in_progress' THEN 0 WHEN 'todo' THEN 1 WHEN 'done' THEN 2 ELSE 3 END`
  const orderBy = {
    manual: `${statusRank}, sort_order`,
    due: `${statusRank}, due_date IS NULL, due_date, priority, created_at DESC`,
    priority: `${statusRank}, priority, due_date IS NULL, due_date, created_at DESC`
  }[f.sort ?? 'manual']
  const sql = `
    SELECT * FROM tasks
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY ${orderBy}`
  return db.all<Task>(sql, ...params)
}

export function createTask(db: DbDriver, input: NewTask, now: Date = new Date()): Task {
  const id = newId()
  const ts = nowIso(now)
  db.run(
    `INSERT INTO tasks (id, title, notes, status, area, priority, project_id, person_id, due_date, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, 'todo', ?, ?, ?, ?, ?, (SELECT COALESCE(MIN(sort_order), 1) - 1 FROM tasks), ?, ?)`,
    id,
    input.title,
    input.notes ?? '',
    input.area ?? 'personal',
    input.priority ?? 2,
    input.project_id ?? null,
    input.person_id ?? null,
    input.due_date ?? null,
    ts,
    ts
  )
  return getTask(db, id)!
}

export function updateTask(
  db: DbDriver,
  id: string,
  patch: TaskPatch,
  now: Date = new Date()
): Task {
  const existing = getTask(db, id)
  if (!existing) throw new Error(`task not found: ${id}`)
  const ts = nowIso(now)

  const next = { ...existing, ...stripUndefined(patch) }
  // status transitions maintain completed_at
  if (patch.status && patch.status !== existing.status) {
    next.completed_at = patch.status === 'done' ? ts : null
  }
  db.run(
    `UPDATE tasks SET title=?, notes=?, status=?, area=?, priority=?, project_id=?, person_id=?, due_date=?, completed_at=?, updated_at=? WHERE id=?`,
    next.title,
    next.notes,
    next.status,
    next.area,
    next.priority,
    next.project_id,
    next.person_id,
    next.due_date,
    next.completed_at,
    ts,
    id
  )
  return getTask(db, id)!
}

export function completeTask(db: DbDriver, id: string, now: Date = new Date()): Task {
  return updateTask(db, id, { status: 'done' }, now)
}

export function deleteTask(db: DbDriver, id: string): void {
  db.run('DELETE FROM tasks WHERE id = ?', id)
}

/**
 * Drag-and-drop move: place `id` immediately before `beforeId` in manual
 * order (or at the end when beforeId is null). Renumbers the whole table in
 * one transaction — trivially correct, and personal-scale tables are tiny.
 */
export function moveTaskBefore(
  db: DbDriver,
  id: string,
  beforeId: string | null,
  now: Date = new Date()
): void {
  db.transaction(() => {
    const rows = db.all<{ id: string }>('SELECT id FROM tasks ORDER BY sort_order, id')
    if (!rows.some((r) => r.id === id)) throw new Error(`task not found: ${id}`)
    const ids = rows.map((r) => r.id).filter((x) => x !== id)
    const at = beforeId === null ? ids.length : ids.indexOf(beforeId)
    if (at < 0) throw new Error(`task not found: ${beforeId}`)
    ids.splice(at, 0, id)
    ids.forEach((tid, i) => db.run('UPDATE tasks SET sort_order = ? WHERE id = ?', i + 1, tid))
    db.run('UPDATE tasks SET updated_at = ? WHERE id = ?', nowIso(now), id)
  })
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>
}

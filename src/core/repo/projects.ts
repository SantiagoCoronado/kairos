import type { DbDriver, SqlValue } from '../driver'
import type { Project, NewProject, ProjectStatus, Area } from '../types'
import { newId, nowIso } from '../ids'

export function listProjects(
  db: DbDriver,
  f: { status?: ProjectStatus; area?: Area } = {}
): Project[] {
  const where: string[] = []
  const params: SqlValue[] = []
  if (f.status) {
    where.push('status = ?')
    params.push(f.status)
  }
  if (f.area) {
    where.push('area = ?')
    params.push(f.area)
  }
  return db.all<Project>(
    `SELECT * FROM projects ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY name COLLATE NOCASE`,
    ...params
  )
}

export function createProject(db: DbDriver, input: NewProject, now: Date = new Date()): Project {
  const id = newId()
  const ts = nowIso(now)
  db.run(
    `INSERT INTO projects (id, name, area, status, description, created_at, updated_at)
     VALUES (?, ?, ?, 'active', ?, ?, ?)`,
    id,
    input.name,
    input.area ?? 'personal',
    input.description ?? '',
    ts,
    ts
  )
  return db.get<Project>('SELECT * FROM projects WHERE id = ?', id)!
}

export function updateProject(
  db: DbDriver,
  id: string,
  patch: { name?: string; area?: Area; status?: ProjectStatus; description?: string },
  now: Date = new Date()
): Project {
  const existing = db.get<Project>('SELECT * FROM projects WHERE id = ?', id)
  if (!existing) throw new Error(`project not found: ${id}`)
  const next = { ...existing, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) }
  db.run(
    'UPDATE projects SET name=?, area=?, status=?, description=?, updated_at=? WHERE id=?',
    next.name,
    next.area,
    next.status,
    next.description,
    nowIso(now),
    id
  )
  return db.get<Project>('SELECT * FROM projects WHERE id = ?', id)!
}

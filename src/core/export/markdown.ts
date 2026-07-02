import { mkdirSync, rmSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import type { DbDriver } from '../driver'
import type { Person, Interaction, Task, Project, ObjectiveWithKRs } from '../types'
import { listPeople } from '../repo/people'
import { listInteractions } from '../repo/interactions'
import { listTasks } from '../repo/tasks'
import { listProjects } from '../repo/projects'
import { listObjectives } from '../repo/objectives'

// One-way export: SQLite is the source of truth, these files are a readable
// backup (Obsidian/git friendly). Regenerated wholesale; never read back.
// Serialization is deterministic so unchanged data produces identical bytes.

export function exportMarkdown(db: DbDriver, outDir: string): { files: number } {
  let files = 0
  for (const sub of ['people', 'tasks', 'objectives']) {
    rmSync(join(outDir, sub), { recursive: true, force: true })
    mkdirSync(join(outDir, sub), { recursive: true })
  }

  const write = (relPath: string, content: string): void => {
    const abs = join(outDir, relPath)
    const tmp = `${abs}.tmp`
    writeFileSync(tmp, content)
    renameSync(tmp, abs)
    files++
  }

  for (const person of listPeople(db, { includeArchived: true })) {
    write(join('people', fileSlug(person.name, person.id)), personMd(person, listInteractions(db, person.id, 1000)))
  }

  const projects = listProjects(db)
  const tasks = listTasks(db)
  write(join('tasks', 'tasks.md'), tasksMd(tasks, projects))

  for (const o of listObjectives(db)) {
    write(join('objectives', fileSlug(`${o.period} ${o.title}`, o.id)), objectiveMd(o))
  }

  return { files }
}

function fileSlug(name: string, id: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return `${base || 'untitled'}-${id.slice(-6).toLowerCase()}.md`
}

function fm(pairs: [string, string | number | null][]): string {
  const lines = pairs
    .filter(([, v]) => v !== null && v !== '')
    .map(([k, v]) => `${k}: ${String(v)}`)
  return `---\n${lines.join('\n')}\n---\n`
}

function personMd(p: Person, interactions: Interaction[]): string {
  let md = fm([
    ['id', p.id],
    ['name', p.name],
    ['nickname', p.nickname],
    ['email', p.email],
    ['phone', p.phone],
    ['company', p.company],
    ['role', p.role],
    ['area', p.area],
    ['cadence_days', p.cadence_days],
    ['archived', p.archived_at],
    ['updated_at', p.updated_at]
  ])
  md += `\n# ${p.name}\n`
  if (p.notes) md += `\n${p.notes}\n`
  if (interactions.length) {
    md += `\n## Interactions\n\n`
    for (const i of interactions) {
      md += `- **${i.occurred_at.slice(0, 10)}** (${i.kind}) — ${i.summary}\n`
    }
  }
  return md
}

function tasksMd(tasks: Task[], projects: Project[]): string {
  const projectName = new Map(projects.map((p) => [p.id, p.name]))
  let md = `# Tasks\n`
  const open = tasks.filter((t) => t.status === 'todo' || t.status === 'in_progress')
  const done = tasks.filter((t) => t.status === 'done')

  const line = (t: Task): string => {
    const parts = [
      `- [${t.status === 'done' ? 'x' : ' '}] ${t.title}`,
      t.due_date ? `(due ${t.due_date})` : '',
      `#${t.area}`,
      t.priority !== 2 ? `!${t.priority}` : '',
      t.project_id ? `[${projectName.get(t.project_id) ?? 'unknown project'}]` : ''
    ]
    return parts.filter(Boolean).join(' ')
  }

  if (open.length) md += `\n## Open\n\n${open.map(line).join('\n')}\n`
  if (done.length) md += `\n## Done\n\n${done.map(line).join('\n')}\n`
  return md
}

function objectiveMd(o: ObjectiveWithKRs): string {
  let md = fm([
    ['id', o.id],
    ['period', o.period],
    ['area', o.area],
    ['status', o.status],
    ['progress', `${Math.round(o.progress * 100)}%`],
    ['updated_at', o.updated_at]
  ])
  md += `\n# ${o.title}\n`
  if (o.description) md += `\n${o.description}\n`
  if (o.key_results.length) {
    md += `\n## Key results\n\n`
    for (const kr of o.key_results) {
      md += `- ${kr.title}: ${kr.current_value} / ${kr.target_value}${kr.unit ? ` ${kr.unit}` : ''}\n`
    }
  }
  return md
}

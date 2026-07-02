import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { DbDriver } from '../driver'
import { openNodeSqliteDb } from '../drivers/node-sqlite'
import { migrate } from '../migrations'
import { exportMarkdown } from './markdown'
import * as people from '../repo/people'
import * as interactions from '../repo/interactions'
import * as tasks from '../repo/tasks'
import * as objectives from '../repo/objectives'

const T0 = new Date('2026-07-01T12:00:00Z')

let db: DbDriver
let dir: string

beforeEach(() => {
  db = openNodeSqliteDb(':memory:')
  migrate(db)
  dir = mkdtempSync(join(tmpdir(), 'cc-export-'))
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

function snapshot(root: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const sub of readdirSync(root)) {
    for (const f of readdirSync(join(root, sub))) {
      out.set(`${sub}/${f}`, readFileSync(join(root, sub, f), 'utf8'))
    }
  }
  return out
}

describe('markdown export', () => {
  it('exports people, tasks, objectives and is byte-stable across runs', () => {
    const p = people.upsertPerson(
      db,
      { name: 'Anna Martinez', company: 'Acme', cadence_days: 21, notes: 'met at conf' },
      T0
    )
    interactions.logInteraction(
      db,
      { person_id: p.id, kind: 'coffee', summary: 'reorg talk', occurred_at: T0.toISOString() },
      T0
    )
    tasks.createTask(db, { title: 'Ship deck', area: 'work', due_date: '2026-07-10' }, T0)
    objectives.createObjective(
      db,
      { title: 'Get fit', period: '2026-Q3', key_results: [{ title: 'Run 100km', unit: 'km' }] },
      T0
    )

    const first = exportMarkdown(db, dir)
    expect(first.files).toBe(3)
    const a = snapshot(dir)

    const second = exportMarkdown(db, dir)
    expect(second.files).toBe(3)
    const b = snapshot(dir)

    expect([...b.keys()].sort()).toEqual([...a.keys()].sort())
    for (const [k, v] of a) expect(b.get(k)).toBe(v)

    const personFile = [...a.keys()].find((k) => k.startsWith('people/anna-martinez'))!
    expect(a.get(personFile)).toContain('cadence_days: 21')
    expect(a.get(personFile)).toContain('reorg talk')
    expect(a.get('tasks/tasks.md')).toContain('- [ ] Ship deck (due 2026-07-10) #work')
  })
})

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { DbDriver } from './driver'
import { openNodeSqliteDb } from './drivers/node-sqlite'
import { migrate, migrations } from './migrations'
import * as people from './repo/people'
import * as interactions from './repo/interactions'
import * as followups from './repo/followups'
import * as tasks from './repo/tasks'
import * as projects from './repo/projects'
import * as objectives from './repo/objectives'
import { todayAgenda } from './repo/today'

// Tests run on the node:sqlite adapter (plain-Node ABI). The better-sqlite3
// adapter is byte-for-byte the same mapping and is exercised by the app and
// the packaged smoke test.

const T0 = new Date('2026-07-01T12:00:00Z')
const daysAgo = (n: number, from: Date = T0): Date =>
  new Date(from.getTime() - n * 24 * 60 * 60 * 1000)

let db: DbDriver

beforeEach(() => {
  db = openNodeSqliteDb(':memory:')
  migrate(db)
})

afterEach(() => db.close())

describe('migrations', () => {
  it('is idempotent', () => {
    migrate(db)
    migrate(db)
    const rows = db.all<{ version: number }>('SELECT version FROM schema_migrations')
    expect(rows).toHaveLength(migrations.length)
  })
})

describe('tasks', () => {
  it('creates, lists, and completes', () => {
    const t = tasks.createTask(db, { title: 'Ship Q3 review', area: 'work', due_date: '2026-07-10' }, T0)
    expect(t.status).toBe('todo')
    expect(tasks.listTasks(db, { area: 'work' })).toHaveLength(1)

    const done = tasks.completeTask(db, t.id, T0)
    expect(done.status).toBe('done')
    expect(done.completed_at).toBe(T0.toISOString())

    const reopened = tasks.updateTask(db, t.id, { status: 'todo' }, T0)
    expect(reopened.completed_at).toBeNull()
  })

  it('filters by due_before and status', () => {
    tasks.createTask(db, { title: 'a', due_date: '2026-07-01' }, T0)
    tasks.createTask(db, { title: 'b', due_date: '2026-07-20' }, T0)
    tasks.createTask(db, { title: 'c' }, T0)
    expect(tasks.listTasks(db, { due_before: '2026-07-05', status: 'todo' })).toHaveLength(1)
  })

  it('project delete leaves tasks orphaned, not deleted', () => {
    const p = projects.createProject(db, { name: 'Home lab' }, T0)
    const t = tasks.createTask(db, { title: 'rack the mac mini', project_id: p.id }, T0)
    db.run('DELETE FROM projects WHERE id = ?', p.id)
    expect(tasks.getTask(db, t.id)?.project_id).toBeNull()
  })
})

describe('people + upsert', () => {
  it('upserts by case-insensitive name when no id given', () => {
    const a = people.upsertPerson(db, { name: 'Anna Smith', company: 'Acme' }, T0)
    const b = people.upsertPerson(db, { name: 'anna smith', role: 'CTO' }, T0)
    expect(b.id).toBe(a.id)
    expect(b.company).toBe('Acme') // merge keeps unspecified fields
    expect(b.role).toBe('CTO')
    expect(people.listPeople(db)).toHaveLength(1)
  })

  it('search matches name/company', () => {
    people.upsertPerson(db, { name: 'Jane Doe', company: 'Initech' }, T0)
    expect(people.listPeople(db, { search: 'initech' })).toHaveLength(1)
    expect(people.listPeople(db, { search: 'nobody' })).toHaveLength(0)
  })
})

describe('followup cadence math (injected clock)', () => {
  it('is due when days since last interaction exceed cadence', () => {
    const p = people.upsertPerson(db, { name: 'Anna', cadence_days: 21 }, daysAgo(100))
    interactions.logInteraction(
      db,
      { person_id: p.id, summary: 'coffee', occurred_at: daysAgo(25).toISOString() },
      daysAgo(25)
    )
    const due = followups.followupsDue(db, T0)
    expect(due).toHaveLength(1)
    expect(due[0].days_overdue).toBe(4)
    expect(due[0].days_since).toBe(25)
  })

  it('logging an interaction resets the clock', () => {
    const p = people.upsertPerson(db, { name: 'Anna', cadence_days: 21 }, daysAgo(100))
    interactions.logInteraction(
      db,
      { person_id: p.id, summary: 'old', occurred_at: daysAgo(30).toISOString() },
      daysAgo(30)
    )
    expect(followups.followupsDue(db, T0)).toHaveLength(1)
    interactions.logInteraction(
      db,
      { person_id: p.id, summary: 'lunch today', occurred_at: T0.toISOString() },
      T0
    )
    expect(followups.followupsDue(db, T0)).toHaveLength(0)
  })

  it('falls back to created_at when there are no interactions', () => {
    people.upsertPerson(db, { name: 'NewGuy', cadence_days: 7 }, daysAgo(10))
    const due = followups.followupsDue(db, T0)
    expect(due).toHaveLength(1)
    expect(due[0].days_overdue).toBe(3)
  })

  it('snooze suppresses until date, interaction clears snooze', () => {
    const p = people.upsertPerson(db, { name: 'Anna', cadence_days: 7 }, daysAgo(30))
    people.snoozeFollowup(db, p.id, '2026-07-15', T0)
    expect(followups.followupsDue(db, T0)).toHaveLength(0)
    // past the snooze date it comes back
    expect(followups.followupsDue(db, new Date('2026-07-16T12:00:00Z'))).toHaveLength(1)
    // an interaction clears the snooze and resets the clock
    interactions.logInteraction(db, { person_id: p.id, summary: 'call' }, T0)
    expect(people.getPerson(db, p.id)?.snoozed_until).toBeNull()
  })

  it('archived people and people without cadence never appear', () => {
    people.upsertPerson(db, { name: 'NoCadence' }, daysAgo(100))
    const p = people.upsertPerson(db, { name: 'Archived', cadence_days: 1 }, daysAgo(100))
    people.archivePerson(db, p.id, T0)
    expect(followups.followupsDue(db, T0)).toHaveLength(0)
  })
})

describe('objectives', () => {
  it('computes progress across KRs, clamped', () => {
    const o = objectives.createObjective(
      db,
      {
        title: 'Get fit',
        period: '2026-Q3',
        key_results: [
          { title: 'Run 100km', unit: 'km', target_value: 100 },
          { title: 'Weight 80->75', start_value: 80, target_value: 75 }
        ]
      },
      T0
    )
    expect(o.progress).toBe(0)
    objectives.updateKrProgress(db, o.key_results[0].id, 50, T0) // 50%
    objectives.updateKrProgress(db, o.key_results[1].id, 74, T0) // >100% -> clamped to 1
    const after = objectives.getObjective(db, o.id)!
    expect(after.progress).toBeCloseTo(0.75)
  })

  it('links tasks to KRs both ways', () => {
    const o = objectives.createObjective(
      db,
      { title: 'x', period: '2026-Q3', key_results: [{ title: 'kr' }] },
      T0
    )
    const t = tasks.createTask(db, { title: 'related work' }, T0)
    objectives.linkTaskToKr(db, t.id, o.key_results[0].id)
    expect(objectives.tasksForKr(db, o.key_results[0].id)).toHaveLength(1)
    expect(objectives.krsForTask(db, t.id)).toHaveLength(1)
    // idempotent link
    objectives.linkTaskToKr(db, t.id, o.key_results[0].id)
    expect(objectives.tasksForKr(db, o.key_results[0].id)).toHaveLength(1)
  })
})

describe('today agenda', () => {
  it('splits overdue vs due-today and includes followups', () => {
    tasks.createTask(db, { title: 'overdue', due_date: '2026-06-28' }, T0)
    tasks.createTask(db, { title: 'today', due_date: '2026-07-01' }, T0)
    tasks.createTask(db, { title: 'later', due_date: '2026-08-01' }, T0)
    const doneTask = tasks.createTask(db, { title: 'done overdue', due_date: '2026-06-01' }, T0)
    tasks.completeTask(db, doneTask.id, T0)
    people.upsertPerson(db, { name: 'Anna', cadence_days: 7 }, daysAgo(30))

    // note: todayAgenda uses local dates; T0 noon UTC avoids TZ edge flake
    const agenda = todayAgenda(db, T0)
    expect(agenda.overdue_tasks.map((t) => t.title)).toEqual(['overdue'])
    expect(agenda.due_today_tasks.map((t) => t.title)).toEqual(['today'])
    expect(agenda.followups).toHaveLength(1)
  })
})

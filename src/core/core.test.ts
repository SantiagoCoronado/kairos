import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { DbDriver } from './driver'
import { openNodeSqliteDb } from './drivers/node-sqlite'
import { migrate, applyMigration, migrations } from './migrations'
import * as people from './repo/people'
import * as interactions from './repo/interactions'
import * as followups from './repo/followups'
import * as tasks from './repo/tasks'
import * as projects from './repo/projects'
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

  it('003 backfills sort_order preserving the pre-003 visible order', () => {
    // simulate a DB that stopped at migration 002 with existing tasks
    const old = openNodeSqliteDb(':memory:')
    old.exec(`CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );`)
    applyMigration(old, 0)
    applyMigration(old, 1)
    old.run('INSERT INTO schema_migrations (version) VALUES (1), (2)')
    const ins = (id: string, title: string, due: string | null, priority: number): void => {
      old.run(
        `INSERT INTO tasks (id, title, status, priority, due_date, created_at, updated_at)
         VALUES (?, ?, 'todo', ?, ?, '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z')`,
        id,
        title,
        priority,
        due
      )
    }
    ins('t1', 'no due', null, 2)
    ins('t2', 'due soon', '2026-07-02', 3)
    ins('t3', 'due later', '2026-08-01', 1)

    migrate(old)
    // pre-003 order was: due soon, due later, no due — manual sort must match
    expect(tasks.listTasks(old).map((t) => t.title)).toEqual(['due soon', 'due later', 'no due'])
    old.close()
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

  it('creates directly into a status (board column add)', () => {
    const t = tasks.createTask(db, { title: 'wip', status: 'in_progress' }, T0)
    expect(t.status).toBe('in_progress')
    expect(t.completed_at).toBeNull()

    const d = tasks.createTask(db, { title: 'already shipped', status: 'done' }, T0)
    expect(d.status).toBe('done')
    expect(d.completed_at).toBe(T0.toISOString())
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

  it('manual sort is the default: newest on top, moveTaskBefore reorders', () => {
    const a = tasks.createTask(db, { title: 'a' }, T0)
    const b = tasks.createTask(db, { title: 'b' }, T0)
    const c = tasks.createTask(db, { title: 'c' }, T0)
    expect(a.sort_order).toBeGreaterThan(b.sort_order)
    expect(b.sort_order).toBeGreaterThan(c.sort_order)
    expect(tasks.listTasks(db).map((t) => t.title)).toEqual(['c', 'b', 'a'])

    // drag c below b (place c before a)
    tasks.moveTaskBefore(db, c.id, a.id, T0)
    expect(tasks.listTasks(db).map((t) => t.title)).toEqual(['b', 'c', 'a'])
    // drag b to the end
    tasks.moveTaskBefore(db, b.id, null, T0)
    expect(tasks.listTasks(db).map((t) => t.title)).toEqual(['c', 'a', 'b'])
    expect(() => tasks.moveTaskBefore(db, a.id, 'nope', T0)).toThrow()
    expect(() => tasks.moveTaskBefore(db, 'nope', a.id, T0)).toThrow()
  })

  it('manual order survives edits', () => {
    const a = tasks.createTask(db, { title: 'a' }, T0)
    tasks.createTask(db, { title: 'b' }, T0)
    tasks.updateTask(db, a.id, { title: 'a2', priority: 1 }, T0)
    expect(tasks.getTask(db, a.id)?.sort_order).toBe(a.sort_order)
  })

  it('sort=due and sort=priority override manual order', () => {
    tasks.createTask(db, { title: 'late', due_date: '2026-08-01', priority: 1 }, T0)
    tasks.createTask(db, { title: 'soon', due_date: '2026-07-02', priority: 3 }, T0)
    tasks.createTask(db, { title: 'nodate', priority: 2 }, T0)
    expect(tasks.listTasks(db, { sort: 'due' }).map((t) => t.title)).toEqual([
      'soon',
      'late',
      'nodate'
    ])
    expect(tasks.listTasks(db, { sort: 'priority' }).map((t) => t.title)).toEqual([
      'late',
      'nodate',
      'soon'
    ])
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

  it('archive → archived list → unarchive → delete lifecycle', () => {
    const p = people.upsertPerson(db, { name: 'Vero' }, T0)
    people.archivePerson(db, p.id, T0)
    expect(people.listPeople(db)).toHaveLength(0)
    expect(people.listPeople(db, { archived: true }).map((x) => x.name)).toEqual(['Vero'])

    people.unarchivePerson(db, p.id, T0)
    expect(people.listPeople(db)).toHaveLength(1)
    expect(people.listPeople(db, { archived: true })).toHaveLength(0)

    people.deletePerson(db, p.id)
    expect(people.getPerson(db, p.id)).toBeUndefined()
  })

  it('clearSnooze empties snoozed_until', () => {
    const p = people.upsertPerson(db, { name: 'Anna' }, T0)
    people.snoozeFollowup(db, p.id, '2026-08-01', T0)
    expect(people.getPerson(db, p.id)?.snoozed_until).toBe('2026-08-01')
    people.clearSnooze(db, p.id, T0)
    expect(people.getPerson(db, p.id)?.snoozed_until).toBeNull()
  })

  it('findPersonByContact matches email exactly and phones by canonical suffix', () => {
    const anna = people.upsertPerson(db, { name: 'Anna', email: 'Anna@Example.com' }, T0)
    const bo = people.upsertPerson(db, { name: 'Bo', phone: '55 1234 5678' }, T0)

    expect(people.findPersonByContact(db, ['anna@example.com'], [])?.id).toBe(anna.id)
    // formatting + country-code differences still match (canonical last-8)
    expect(people.findPersonByContact(db, [], ['+52 1 55 1234 5678'])?.id).toBe(bo.id)
    expect(people.findPersonByContact(db, ['x@y.z'], ['999'])).toBeUndefined()

    // archived people never dedupe-match
    people.archivePerson(db, anna.id, T0)
    expect(people.findPersonByContact(db, ['anna@example.com'], [])).toBeUndefined()
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

  it('a snooze until tomorrow holds through the local evening (UTC already rolled over)', () => {
    // 2026-07-02T03:00Z is the local EVENING of July 1 in any UTC-negative
    // timezone: snoozed_until is a local day, so "tomorrow" must still hold.
    // (On a UTC/positive-offset machine both dates coincide and this passes
    // trivially — the assertion bites where the bug bit: the Americas.)
    const eveningUtcRolled = new Date('2026-07-02T03:00:00Z')
    const localTomorrow = (() => {
      const d = new Date(eveningUtcRolled)
      d.setDate(d.getDate() + 1)
      const y = d.getFullYear()
      const m = String(d.getMonth() + 1).padStart(2, '0')
      const day = String(d.getDate()).padStart(2, '0')
      return `${y}-${m}-${day}`
    })()
    const p = people.upsertPerson(db, { name: 'Anna', cadence_days: 7 }, daysAgo(30))
    people.snoozeFollowup(db, p.id, localTomorrow, eveningUtcRolled)
    expect(followups.followupsDue(db, eveningUtcRolled)).toHaveLength(0)
  })

  it('archived people and people without cadence never appear', () => {
    people.upsertPerson(db, { name: 'NoCadence' }, daysAgo(100))
    const p = people.upsertPerson(db, { name: 'Archived', cadence_days: 1 }, daysAgo(100))
    people.archivePerson(db, p.id, T0)
    expect(followups.followupsDue(db, T0)).toHaveLength(0)
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

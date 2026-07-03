import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { DbDriver } from './driver'
import { openNodeSqliteDb } from './drivers/node-sqlite'
import { migrate } from './migrations'
import * as at from './repo/agent-tasks'

let db: DbDriver

beforeEach(() => {
  db = openNodeSqliteDb(':memory:')
  migrate(db)
})

afterEach(() => db.close())

const in1h = (): string => new Date(Date.now() + 3600_000).toISOString()
const ago1h = (): string => new Date(Date.now() - 3600_000).toISOString()

describe('agent tasks repo', () => {
  it('create computes next_run for a future once task', () => {
    const date = in1h()
    const t = at.createAgentTask(db, { name: 'x', prompt: 'p', schedule: 'once', scheduled_date: date })
    expect(t.next_run).toBe(new Date(date).toISOString())
    expect(t.status).toBe('active')
    expect(t.notify).toBe(1)
  })

  it('create computes next_run for daily schedule', () => {
    const t = at.createAgentTask(db, {
      name: 'daily',
      prompt: 'p',
      schedule: 'daily',
      scheduled_time: '09:00'
    })
    expect(t.next_run).not.toBeNull()
    expect(new Date(t.next_run!).getTime()).toBeGreaterThan(Date.now())
  })

  it('listDue picks only active tasks whose next_run arrived', () => {
    const due = at.createAgentTask(db, { name: 'due', prompt: 'p', schedule: 'once', scheduled_date: in1h() })
    db.run('UPDATE agent_tasks SET next_run = ? WHERE id = ?', ago1h(), due.id)
    const future = at.createAgentTask(db, { name: 'future', prompt: 'p', schedule: 'once', scheduled_date: in1h() })
    const paused = at.createAgentTask(db, { name: 'paused', prompt: 'p', schedule: 'once', scheduled_date: in1h() })
    db.run('UPDATE agent_tasks SET next_run = ? WHERE id = ?', ago1h(), paused.id)
    at.pauseAgentTask(db, paused.id)
    const ids = at.listDue(db).map((t) => t.id)
    expect(ids).toEqual([due.id])
    expect(ids).not.toContain(future.id)
  })

  it('claimForRun nulls next_run for once and advances it for recurring', () => {
    const once = at.createAgentTask(db, { name: 'o', prompt: 'p', schedule: 'once', scheduled_date: in1h() })
    at.claimForRun(db, once.id)
    expect(at.getAgentTask(db, once.id)!.next_run).toBeNull()

    const daily = at.createAgentTask(db, { name: 'd', prompt: 'p', schedule: 'daily', scheduled_time: '09:00' })
    db.run('UPDATE agent_tasks SET next_run = ? WHERE id = ?', ago1h(), daily.id)
    at.claimForRun(db, daily.id)
    const after = at.getAgentTask(db, daily.id)!
    expect(new Date(after.next_run!).getTime()).toBeGreaterThan(Date.now())
  })

  it('run lifecycle: create → steps → finish updates the task', () => {
    const t = at.createAgentTask(db, { name: 'x', prompt: 'p', schedule: 'once', scheduled_date: in1h() })
    const run = at.createRun(db, t.id, 'sonnet')
    expect(run.status).toBe('running')
    db.run(
      "INSERT INTO chat_sessions (id, title, created_at, updated_at) VALUES ('session-1', 't', '2026-01-01', '2026-01-01')"
    )
    at.setRunSession(db, run.id, 'session-1')
    at.appendRunStep(db, run.id, 'tasks_list')
    at.appendRunStep(db, run.id, 'note_create')
    at.finishRun(db, run.id, { status: 'success', result: 'all good' })

    const [r] = at.listRuns(db, t.id)
    expect(r.status).toBe('success')
    expect(r.result).toBe('all good')
    expect(r.finished_at).not.toBeNull()
    expect(JSON.parse(r.steps).map((s: { tool: string }) => s.tool)).toEqual(['tasks_list', 'note_create'])

    const task = at.getAgentTask(db, t.id)!
    expect(task.run_count).toBe(1)
    expect(task.last_run).not.toBeNull()
    expect(task.session_id).toBe('session-1')
    expect(task.status).toBe('completed') // once tasks complete after their run
  })

  it('recurring tasks stay active after a run', () => {
    const t = at.createAgentTask(db, { name: 'd', prompt: 'p', schedule: 'daily', scheduled_time: '09:00' })
    const run = at.createRun(db, t.id, null)
    at.finishRun(db, run.id, { status: 'success', result: 'ok' })
    expect(at.getAgentTask(db, t.id)!.status).toBe('active')
  })

  it('pause/resume: resume recomputes next_run', () => {
    const t = at.createAgentTask(db, { name: 'd', prompt: 'p', schedule: 'daily', scheduled_time: '09:00' })
    at.pauseAgentTask(db, t.id)
    expect(at.getAgentTask(db, t.id)!.status).toBe('paused')
    db.run('UPDATE agent_tasks SET next_run = NULL WHERE id = ?', t.id)
    const resumed = at.resumeAgentTask(db, t.id)
    expect(resumed.status).toBe('active')
    expect(resumed.next_run).not.toBeNull()
  })

  it('editing the schedule revives a completed once task', () => {
    const t = at.createAgentTask(db, { name: 'o', prompt: 'p', schedule: 'once', scheduled_date: in1h() })
    const run = at.createRun(db, t.id, null)
    at.claimForRun(db, t.id)
    at.finishRun(db, run.id, { status: 'success' })
    expect(at.getAgentTask(db, t.id)!.status).toBe('completed')
    const revived = at.updateAgentTask(db, t.id, { scheduled_date: in1h() })
    expect(revived.status).toBe('active')
    expect(revived.next_run).not.toBeNull()
  })

  it('recentRuns joins the task name', () => {
    const t = at.createAgentTask(db, { name: 'named task', prompt: 'p', schedule: 'once', scheduled_date: in1h() })
    const run = at.createRun(db, t.id, null)
    at.finishRun(db, run.id, { status: 'error', error: 'boom' })
    const [r] = at.recentRuns(db)
    expect(r.task_name).toBe('named task')
    expect(r.error).toBe('boom')
  })

  it('reconcileStuckRuns closes runs left running by a dead session', () => {
    const t = at.createAgentTask(db, { name: 'x', prompt: 'p', schedule: 'once', scheduled_date: in1h() })
    const stuck = at.createRun(db, t.id, null) // status 'running', never finished
    const done = at.createRun(db, t.id, null)
    at.finishRun(db, done.id, { status: 'success', result: 'ok' })

    const n = at.reconcileStuckRuns(db)
    expect(n).toBe(1)
    const reconciled = at.listRuns(db, t.id).find((r) => r.id === stuck.id)!
    expect(reconciled.status).toBe('stopped')
    expect(reconciled.finished_at).not.toBeNull()
    expect(reconciled.error).toMatch(/restart/i)
    // a second pass is a no-op — nothing left running
    expect(at.reconcileStuckRuns(db)).toBe(0)
  })

  it('getRunBySession finds the run that owns a chat session', () => {
    const t = at.createAgentTask(db, { name: 'x', prompt: 'p', schedule: 'once', scheduled_date: in1h() })
    const run = at.createRun(db, t.id, null)
    db.run(
      "INSERT INTO chat_sessions (id, title, created_at, updated_at) VALUES ('sess-x', 't', '2026-01-01', '2026-01-01')"
    )
    at.setRunSession(db, run.id, 'sess-x')
    expect(at.getRunBySession(db, 'sess-x')?.id).toBe(run.id)
    expect(at.getRunBySession(db, 'nope')).toBeUndefined()
  })

  it('finishRun stores token usage and usageByTask rolls up 7d/30d windows', () => {
    const t = at.createAgentTask(db, { name: 'watch', prompt: 'p', schedule: 'daily', scheduled_time: '09:00' })
    // recent run (inside 7d): 1k in + 2k out, $0.05
    const r1 = at.createRun(db, t.id, 'sonnet')
    at.finishRun(db, r1.id, {
      status: 'success',
      result: 'ok',
      usage: { input_tokens: 1000, output_tokens: 2000, cache_read_tokens: 50_000, cache_creation_tokens: 500, cost_usd: 0.05 }
    })
    // old run (10 days ago, inside 30d only): 3k in + 4k out, $0.10
    const r2 = at.createRun(db, t.id, 'haiku')
    at.finishRun(db, r2.id, {
      status: 'success',
      usage: { input_tokens: 3000, output_tokens: 4000, cache_read_tokens: 0, cache_creation_tokens: 0, cost_usd: 0.1 }
    })
    const tenDaysAgo = new Date(Date.now() - 10 * 86400_000).toISOString()
    db.run('UPDATE agent_task_runs SET started_at = ? WHERE id = ?', tenDaysAgo, r2.id)
    // pre-tracking run (no usage) must not break sums
    const r3 = at.createRun(db, t.id, null)
    at.finishRun(db, r3.id, { status: 'success' })

    const stored = at.listRuns(db, t.id).find((r) => r.id === r1.id)!
    expect(stored.input_tokens).toBe(1000)
    expect(stored.cache_read_tokens).toBe(50_000)
    expect(stored.cost_usd).toBeCloseTo(0.05)

    const [u] = at.usageByTask(db).filter((x) => x.task_id === t.id)
    expect(u.runs_7d).toBe(2) // r1 + r3
    expect(u.tokens_7d).toBe(3000) // r1 only; r3 has no usage
    expect(u.cost_7d).toBeCloseTo(0.05)
    expect(u.runs_30d).toBe(3)
    expect(u.tokens_30d).toBe(10_000)
    expect(u.cost_30d).toBeCloseTo(0.15)
  })

  it('rejects a then_task_id chain cycle', () => {
    const a = at.createAgentTask(db, { name: 'a', prompt: 'p', schedule: 'once', scheduled_date: in1h() })
    const b = at.createAgentTask(db, { name: 'b', prompt: 'p', schedule: 'once', scheduled_date: in1h() })
    at.updateAgentTask(db, a.id, { then_task_id: b.id })
    expect(() => at.updateAgentTask(db, b.id, { then_task_id: a.id })).toThrow(/cycle/)
    expect(() => at.updateAgentTask(db, a.id, { then_task_id: a.id })).toThrow(/cycle/)
  })

  it('event tasks get no next_run and are excluded from listDue', () => {
    const t = at.createAgentTask(db, {
      name: 'ev',
      prompt: 'p',
      trigger_type: 'event',
      trigger_event: 'note_created'
    })
    expect(t.next_run).toBeNull()
    expect(t.trigger_type).toBe('event')
    expect(t.trigger_count).toBe(1)
    expect(at.listDue(db)).toHaveLength(0)
    expect(at.listEventTasks(db, 'note_created').map((x) => x.id)).toEqual([t.id])
    expect(at.listEventTasks(db, 'email_received')).toHaveLength(0)
  })

  it('bumpTriggerCounter fires every N and resets', () => {
    const t = at.createAgentTask(db, {
      name: 'ev3',
      prompt: 'p',
      trigger_type: 'event',
      trigger_event: 'email_received',
      trigger_count: 3
    })
    expect(at.bumpTriggerCounter(db, t.id)).toBe(false)
    expect(at.bumpTriggerCounter(db, t.id)).toBe(false)
    expect(at.getAgentTask(db, t.id)!.trigger_counter).toBe(2)
    expect(at.bumpTriggerCounter(db, t.id)).toBe(true)
    expect(at.getAgentTask(db, t.id)!.trigger_counter).toBe(0)
    expect(at.bumpTriggerCounter(db, t.id)).toBe(false) // next cycle starts fresh
  })

  it('paused event tasks are not listed; resume keeps next_run null', () => {
    const t = at.createAgentTask(db, {
      name: 'ev',
      prompt: 'p',
      trigger_type: 'event',
      trigger_event: 'note_created'
    })
    at.pauseAgentTask(db, t.id)
    expect(at.listEventTasks(db, 'note_created')).toHaveLength(0)
    const resumed = at.resumeAgentTask(db, t.id)
    expect(resumed.status).toBe('active')
    expect(resumed.next_run).toBeNull()
  })

  it('switching trigger_type event↔schedule recomputes next_run correctly', () => {
    const t = at.createAgentTask(db, {
      name: 'x',
      prompt: 'p',
      schedule: 'daily',
      scheduled_time: '09:00'
    })
    expect(t.next_run).not.toBeNull()
    const asEvent = at.updateAgentTask(db, t.id, {
      trigger_type: 'event',
      trigger_event: 'task_created'
    })
    expect(asEvent.next_run).toBeNull()
    const backToSchedule = at.updateAgentTask(db, t.id, { trigger_type: 'schedule' })
    expect(backToSchedule.next_run).not.toBeNull()
    expect(backToSchedule.trigger_event).toBeNull() // cleared when not event
  })

  it('event tasks stay active after a run (never auto-complete)', () => {
    const t = at.createAgentTask(db, {
      name: 'ev',
      prompt: 'p',
      trigger_type: 'event',
      trigger_event: 'note_created'
    })
    const run = at.createRun(db, t.id, null)
    at.finishRun(db, run.id, { status: 'success', result: 'ok' })
    expect(at.getAgentTask(db, t.id)!.status).toBe('active')
  })

  it('event tasks claimForRun keeps next_run null', () => {
    const t = at.createAgentTask(db, {
      name: 'ev',
      prompt: 'p',
      trigger_type: 'event',
      trigger_event: 'note_created'
    })
    at.claimForRun(db, t.id)
    expect(at.getAgentTask(db, t.id)!.next_run).toBeNull()
  })

  it('deleting a task cascades its runs', () => {
    const t = at.createAgentTask(db, { name: 'x', prompt: 'p', schedule: 'once', scheduled_date: in1h() })
    const run = at.createRun(db, t.id, null)
    at.deleteAgentTask(db, t.id)
    expect(db.get('SELECT * FROM agent_task_runs WHERE id = ?', run.id)).toBeUndefined()
  })
})

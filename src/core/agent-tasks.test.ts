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

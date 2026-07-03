import type { DbDriver } from '../driver'
import type {
  AgentTask,
  AgentTaskRun,
  AgentRunStatus,
  AppEventName,
  NewAgentTask,
  AgentTaskPatch
} from '../types'
import { computeNextRun } from '../schedule'
import { newId, nowIso } from '../ids'

export function getAgentTask(db: DbDriver, id: string): AgentTask | undefined {
  return db.get<AgentTask>('SELECT * FROM agent_tasks WHERE id = ?', id)
}

export function listAgentTasks(db: DbDriver): AgentTask[] {
  // active first, then by next run soonest; paused/completed sink to the bottom
  return db.all<AgentTask>(
    `SELECT * FROM agent_tasks
     ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END,
              next_run IS NULL, next_run, created_at DESC`
  )
}

export function createAgentTask(db: DbDriver, input: NewAgentTask, now: Date = new Date()): AgentTask {
  const id = newId()
  const ts = nowIso(now)
  const schedule = input.schedule ?? 'once'
  const triggerType = input.trigger_type ?? 'schedule'
  // event tasks are driven by the event bus, never by the schedule scanner
  const next =
    triggerType === 'event'
      ? null
      : computeNextRun(
          {
            schedule,
            scheduled_time: input.scheduled_time ?? null,
            scheduled_day: input.scheduled_day ?? null,
            scheduled_date: input.scheduled_date ?? null
          },
          now
        )
  db.run(
    `INSERT INTO agent_tasks (id, name, prompt, schedule, scheduled_time, scheduled_day, scheduled_date, trigger_type, trigger_event, trigger_count, next_run, model, max_turns, notify, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    input.name,
    input.prompt,
    schedule,
    input.scheduled_time ?? null,
    input.scheduled_day ?? null,
    input.scheduled_date ?? null,
    triggerType,
    input.trigger_event ?? null,
    Math.max(1, input.trigger_count ?? 1),
    next,
    input.model ?? null,
    input.max_turns ?? null,
    input.notify === false ? 0 : 1,
    ts,
    ts
  )
  return getAgentTask(db, id)!
}

export function updateAgentTask(
  db: DbDriver,
  id: string,
  patch: AgentTaskPatch,
  now: Date = new Date()
): AgentTask {
  const existing = getAgentTask(db, id)
  if (!existing) throw new Error(`agent task not found: ${id}`)
  if (patch.then_task_id) assertNoChainCycle(db, id, patch.then_task_id)
  const next = { ...existing, ...stripUndefined(patch) }

  // schedule/trigger edits re-derive next_run (and can revive a lapsed 'once')
  const scheduleChanged =
    patch.schedule !== undefined ||
    patch.scheduled_time !== undefined ||
    patch.scheduled_day !== undefined ||
    patch.scheduled_date !== undefined ||
    patch.trigger_type !== undefined
  const nextRun =
    next.trigger_type === 'event'
      ? null
      : scheduleChanged
        ? computeNextRun(next, now)
        : existing.next_run
  const status =
    scheduleChanged &&
    existing.status === 'completed' &&
    (nextRun || next.trigger_type === 'event')
      ? 'active'
      : existing.status

  db.run(
    `UPDATE agent_tasks SET name=?, prompt=?, schedule=?, scheduled_time=?, scheduled_day=?, scheduled_date=?, trigger_type=?, trigger_event=?, trigger_count=?, next_run=?, status=?, model=?, max_turns=?, notify=?, then_task_id=?, updated_at=? WHERE id=?`,
    next.name,
    next.prompt,
    next.schedule,
    next.scheduled_time,
    next.scheduled_day,
    next.scheduled_date,
    next.trigger_type,
    next.trigger_type === 'event' ? next.trigger_event : null,
    Math.max(1, next.trigger_count),
    nextRun,
    status,
    next.model,
    next.max_turns,
    patch.notify === undefined ? existing.notify : patch.notify ? 1 : 0,
    next.then_task_id,
    nowIso(now),
    id
  )
  return getAgentTask(db, id)!
}

export function deleteAgentTask(db: DbDriver, id: string): void {
  db.run('DELETE FROM agent_tasks WHERE id = ?', id)
}

export function pauseAgentTask(db: DbDriver, id: string, now: Date = new Date()): AgentTask {
  db.run(`UPDATE agent_tasks SET status='paused', updated_at=? WHERE id=?`, nowIso(now), id)
  return getAgentTask(db, id)!
}

export function resumeAgentTask(db: DbDriver, id: string, now: Date = new Date()): AgentTask {
  const t = getAgentTask(db, id)
  if (!t) throw new Error(`agent task not found: ${id}`)
  const nextRun = t.trigger_type === 'event' ? null : computeNextRun(t, now)
  db.run(
    `UPDATE agent_tasks SET status='active', next_run=?, updated_at=? WHERE id=?`,
    nextRun,
    nowIso(now),
    id
  )
  return getAgentTask(db, id)!
}

/** active tasks whose next_run has arrived — the scheduler's work queue */
export function listDue(db: DbDriver, now: Date = new Date()): AgentTask[] {
  return db.all<AgentTask>(
    `SELECT * FROM agent_tasks WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= ?`,
    nowIso(now)
  )
}

/** active automations whose next_run falls in [startIso, endIso) — calendar overlay chips */
export function listAgentTasksNextRunBetween(db: DbDriver, startIso: string, endIso: string): AgentTask[] {
  return db.all<AgentTask>(
    `SELECT * FROM agent_tasks
     WHERE status = 'active' AND next_run IS NOT NULL AND next_run >= ? AND next_run < ?
     ORDER BY next_run`,
    startIso,
    endIso
  )
}

/**
 * Claim a due task for execution: advance next_run past this occurrence so
 * the next scheduler tick cannot double-fire it while the run is in flight.
 * 'once' tasks get next_run = NULL (finishRun marks them completed).
 */
export function claimForRun(db: DbDriver, id: string, now: Date = new Date()): void {
  const t = getAgentTask(db, id)
  if (!t) return
  const nextRun =
    t.trigger_type === 'event' || t.schedule === 'once' ? null : computeNextRun(t, now)
  db.run('UPDATE agent_tasks SET next_run = ?, updated_at = ? WHERE id = ?', nextRun, nowIso(now), id)
}

/** active event-triggered tasks listening for one event */
export function listEventTasks(db: DbDriver, event: AppEventName): AgentTask[] {
  return db.all<AgentTask>(
    `SELECT * FROM agent_tasks WHERE status = 'active' AND trigger_type = 'event' AND trigger_event = ?`,
    event
  )
}

/**
 * Count one event occurrence toward the task's every-N threshold.
 * Returns true when the threshold is reached (counter resets, task fires).
 */
export function bumpTriggerCounter(db: DbDriver, id: string, now: Date = new Date()): boolean {
  return db.transaction(() => {
    const t = getAgentTask(db, id)
    if (!t) return false
    const counter = t.trigger_counter + 1
    const fire = counter >= Math.max(1, t.trigger_count)
    db.run(
      'UPDATE agent_tasks SET trigger_counter = ?, updated_at = ? WHERE id = ?',
      fire ? 0 : counter,
      nowIso(now),
      id
    )
    return fire
  })
}

// ---------- runs ----------

export function createRun(
  db: DbDriver,
  taskId: string,
  model: string | null,
  now: Date = new Date()
): AgentTaskRun {
  const id = newId()
  db.run(
    `INSERT INTO agent_task_runs (id, task_id, started_at, status, model) VALUES (?, ?, ?, 'running', ?)`,
    id,
    taskId,
    nowIso(now),
    model
  )
  return db.get<AgentTaskRun>('SELECT * FROM agent_task_runs WHERE id = ?', id)!
}

export function setRunSession(db: DbDriver, runId: string, sessionId: string): void {
  db.run('UPDATE agent_task_runs SET session_id = ? WHERE id = ?', sessionId, runId)
}

export function appendRunStep(db: DbDriver, runId: string, tool: string, now: Date = new Date()): void {
  const run = db.get<AgentTaskRun>('SELECT * FROM agent_task_runs WHERE id = ?', runId)
  if (!run) return
  let steps: { tool: string; at: string }[] = []
  try {
    const parsed = JSON.parse(run.steps)
    if (Array.isArray(parsed)) steps = parsed
  } catch {
    /* keep empty */
  }
  steps.push({ tool, at: nowIso(now) })
  db.run('UPDATE agent_task_runs SET steps = ? WHERE id = ?', JSON.stringify(steps), runId)
}

/** close the run and update the owning task's bookkeeping in one transaction */
export function finishRun(
  db: DbDriver,
  runId: string,
  outcome: { status: Exclude<AgentRunStatus, 'running'>; result?: string | null; error?: string | null },
  now: Date = new Date()
): void {
  const ts = nowIso(now)
  db.transaction(() => {
    const run = db.get<AgentTaskRun>('SELECT * FROM agent_task_runs WHERE id = ?', runId)
    if (!run) return
    db.run(
      `UPDATE agent_task_runs SET status=?, finished_at=?, result=?, error=? WHERE id=?`,
      outcome.status,
      ts,
      outcome.result ?? null,
      outcome.error ?? null,
      runId
    )
    const task = getAgentTask(db, run.task_id)
    if (!task) return
    // only clock-scheduled one-shots complete; event tasks keep listening
    const completed =
      task.trigger_type === 'schedule' && task.schedule === 'once' && task.status === 'active'
    db.run(
      `UPDATE agent_tasks SET last_run=?, run_count=run_count+1, session_id=COALESCE(?, session_id), status=?, updated_at=? WHERE id=?`,
      ts,
      run.session_id,
      completed ? 'completed' : task.status,
      ts,
      task.id
    )
  })
}

export function listRuns(db: DbDriver, taskId: string, limit = 30): AgentTaskRun[] {
  return db.all<AgentTaskRun>(
    'SELECT * FROM agent_task_runs WHERE task_id = ? ORDER BY started_at DESC LIMIT ?',
    taskId,
    limit
  )
}

export type RecentRun = AgentTaskRun & { task_name: string }

export function recentRuns(db: DbDriver, limit = 20): RecentRun[] {
  return db.all<RecentRun>(
    `SELECT r.*, t.name AS task_name FROM agent_task_runs r
     JOIN agent_tasks t ON t.id = r.task_id
     ORDER BY r.started_at DESC LIMIT ?`,
    limit
  )
}

/** walking then_task_id from `target` must never reach `id` (or loop) */
function assertNoChainCycle(db: DbDriver, id: string, target: string): void {
  let cursor: string | null = target
  const seen = new Set<string>()
  while (cursor) {
    if (cursor === id) throw new Error('task chain would form a cycle')
    if (seen.has(cursor)) throw new Error('task chain already contains a cycle')
    seen.add(cursor)
    cursor = getAgentTask(db, cursor)?.then_task_id ?? null
  }
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>
}

import type { DbDriver } from '../driver'
import type { TodayPayload, Task } from '../types'
import { localDate } from '../ids'
import { followupsDue } from './followups'
import { listObjectives } from './objectives'

export function todayAgenda(db: DbDriver, now: Date = new Date()): TodayPayload {
  const today = localDate(now)
  const overdue_tasks = db.all<Task>(
    `SELECT * FROM tasks
     WHERE status IN ('todo','in_progress') AND due_date IS NOT NULL AND due_date < ?
     ORDER BY due_date, priority`,
    today
  )
  const due_today_tasks = db.all<Task>(
    `SELECT * FROM tasks
     WHERE status IN ('todo','in_progress') AND due_date = ?
     ORDER BY priority, created_at`,
    today
  )
  return {
    overdue_tasks,
    due_today_tasks,
    followups: followupsDue(db, now),
    objectives: listObjectives(db, { status: 'active' })
  }
}

import { Notification, powerMonitor, app } from 'electron'
import type { DbDriver } from '../core/driver'
import type { Note } from '../core/types'
import type { AgentTaskRunner } from './chat/task-runner'
import * as notes from '../core/repo/notes'
import * as agentTasks from '../core/repo/agent-tasks'
import { advanceReminder } from '../core/schedule'
import { nowIso } from '../core/ids'
import { broadcast } from './ipc'
import { createMainWindow } from './windows/main-window'
import { getSettings } from './settings'
import { logLine } from './logger'

const TICK_MS = 30_000
const FIRST_TICK_MS = 5_000

/** headline + body for a note reminder, mirroring the card's content */
function reminderText(note: Note): { title: string; body: string } {
  const title = note.title.trim() || 'Reminder'
  const pending = note.items.filter((it) => !it.done).map((it) => it.text.trim()).filter(Boolean)
  if (pending.length > 0) {
    const shown = pending.slice(0, 6).map((t) => `· ${t}`)
    if (pending.length > 6) shown.push(`…and ${pending.length - 6} more`)
    return { title, body: shown.join('\n') }
  }
  return { title, body: note.content.trim().slice(0, 300) }
}

/**
 * Main-process reminder scheduler. Everything derives from persisted columns
 * (remind_at / reminder_fired_at / repeat), so restarts are safe: an overdue
 * never-fired reminder fires exactly once on the first tick after launch.
 */
export class Scheduler {
  private timer: NodeJS.Timeout | null = null
  private firstTimer: NodeJS.Timeout | null = null

  constructor(
    private db: DbDriver,
    private runner: AgentTaskRunner | null = null
  ) {}

  start(): void {
    this.firstTimer = setTimeout(() => this.tick(), FIRST_TICK_MS)
    this.timer = setInterval(() => this.tick(), TICK_MS)
    // reminders that came due during sleep should fire promptly on wake
    powerMonitor.on('resume', () => this.tick())
    logLine('info', 'scheduler', 'started')
  }

  stop(): void {
    if (this.firstTimer) clearTimeout(this.firstTimer)
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  tick(): void {
    try {
      const due = notes.listDueReminders(this.db)
      for (const note of due) this.fireNoteReminder(note)
    } catch (err) {
      logLine('error', 'scheduler', `tick failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`)
    }
    try {
      // master switch: when off, nothing fires automatically (run-now bypasses
      // the scheduler, so it still works)
      if (this.runner && getSettings().automationsEnabled) {
        // a lapsed task (app was closed) runs exactly once: claimForRun inside
        // the runner advances next_run past every missed occurrence
        for (const task of agentTasks.listDue(this.db)) this.runner.enqueue(task.id)
      }
    } catch (err) {
      logLine('error', 'scheduler', `agent-task tick failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`)
    }
  }

  private fireNoteReminder(note: Note): void {
    const now = new Date()
    const { title, body } = reminderText(note)

    // bookkeeping FIRST so a notification error can never re-fire the loop
    const next = advanceReminder(note.remind_at!, note.repeat, now)
    this.db.transaction(() => {
      if (next) {
        // recurring: advance and re-arm
        this.db.run(
          'UPDATE notes SET remind_at = ?, reminder_fired_at = NULL, updated_at = ? WHERE id = ?',
          next,
          nowIso(now),
          note.id
        )
      } else {
        this.db.run(
          'UPDATE notes SET reminder_fired_at = ?, updated_at = ? WHERE id = ?',
          nowIso(now),
          note.id
        )
      }
    })
    broadcast('db:changed', { entity: 'notes' })

    this.deliver(note, title, body)
    logLine('info', 'scheduler', `note reminder fired: ${note.id} "${title}"${next ? ` (next ${next})` : ''}`)
  }

  /** delivery fanout point — extra channels (email/ntfy/webhook) plug in here */
  private deliver(note: Note, title: string, body: string): void {
    if (!Notification.isSupported()) {
      logLine('warn', 'scheduler', 'notifications unsupported on this system')
      return
    }
    const n = new Notification({ title, body, silent: false })
    n.on('click', () => {
      const win = createMainWindow()
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
      app.focus({ steal: true })
      broadcast('nav:goto', { view: 'notes', id: note.id })
    })
    n.show()
  }
}

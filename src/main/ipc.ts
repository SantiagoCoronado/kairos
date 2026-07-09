import { ipcMain, BrowserWindow } from 'electron'
import { join } from 'node:path'
import type { IpcApi, IpcEvents } from '../shared/ipc-contract'
import { getDb, DATA_DIR } from './db'
import { exportMarkdown } from '../core/export/markdown'
import { calendarToday } from './calendar'
import { ChatManager } from './chat/agent'
import { getSettings, saveSettings } from './settings'
import { getClaudeLimits, getClaudeUsageStats, getClaudeUsageToday } from './claude-usage'
import { reregisterCaptureHotkey } from './hotkey'
import { execFile } from 'node:child_process'
import * as tasks from '../core/repo/tasks'
import * as notes from '../core/repo/notes'
import * as agentTasksRepo from '../core/repo/agent-tasks'
import { AgentTaskRunner, parseTaskDraft } from './chat/task-runner'
import { emitAppEvent, onAppEvent } from './events'
import type { AppEventName } from '../core/types'
import * as projects from '../core/repo/projects'
import * as people from '../core/repo/people'
import * as interactions from '../core/repo/interactions'
import * as followups from '../core/repo/followups'
import * as objectives from '../core/repo/objectives'
import { todayAgenda } from '../core/repo/today'
import { executeCapture } from '../core/capture'
import { hideCaptureWindow } from './windows/capture-window'
import * as comms from '../core/repo/comms'
import * as calendarRepo from '../core/repo/calendar'
import { localDate } from '../core/ids'
import { CommsSyncManager } from './comms/manager'
import { CalendarSyncManager } from './gcal/manager'
import { TerminalManager } from './terminal'
import { spawn as ptySpawn } from 'node-pty'
import { logLine } from './logger'

const SLOW_IPC_MS = 300

function handle<K extends keyof IpcApi>(
  channel: K,
  fn: (...args: Parameters<IpcApi[K]>) => ReturnType<IpcApi[K]>
): void {
  ipcMain.handle(channel, async (_event, ...args) => {
    const started = Date.now()
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return await (fn as any)(...args)
    } catch (err) {
      logLine('error', 'ipc', `${channel} failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`)
      throw err
    } finally {
      const ms = Date.now() - started
      if (ms > SLOW_IPC_MS && channel !== 'log:renderer')
        logLine('warn', 'ipc', `slow ${channel}: ${ms}ms`)
    }
  })
}

export function broadcast<K extends keyof IpcEvents>(channel: K, payload: IpcEvents[K]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload)
  }
}

let commsManager: CommsSyncManager | null = null

export function getCommsManager(): CommsSyncManager | null {
  return commsManager
}

let taskRunner: AgentTaskRunner | null = null

export function getTaskRunner(): AgentTaskRunner | null {
  return taskRunner
}

let terminalManager: TerminalManager | null = null

export function getTerminalManager(): TerminalManager | null {
  return terminalManager
}

let calendarManager: CalendarSyncManager | null = null

export function getCalendarManager(): CalendarSyncManager | null {
  return calendarManager
}

export function registerIpc(): void {
  const db = getDb()

  handle('app:ping', () => 'pong')
  handle('log:renderer', (level, message) => logLine(level, 'renderer', message.slice(0, 4000)))

  handle('tasks:list', (f) => tasks.listTasks(db, f))
  handle('tasks:create', (input) => {
    const t = tasks.createTask(db, input)
    broadcast('db:changed', { entity: 'tasks' })
    emitAppEvent('task_created')
    return t
  })
  handle('tasks:update', (id, patch) => {
    const t = tasks.updateTask(db, id, patch)
    broadcast('db:changed', { entity: 'tasks' })
    return t
  })
  handle('tasks:delete', (id) => {
    tasks.deleteTask(db, id)
    broadcast('db:changed', { entity: 'tasks' })
  })
  handle('tasks:reorder', (id, beforeId) => {
    tasks.moveTaskBefore(db, id, beforeId)
    broadcast('db:changed', { entity: 'tasks' })
  })

  handle('notes:list', (f) => notes.listNotes(db, f))
  handle('notes:create', (input) => {
    const n = notes.createNote(db, input)
    broadcast('db:changed', { entity: 'notes' })
    emitAppEvent('note_created')
    return n
  })
  handle('notes:update', (id, patch) => {
    const n = notes.updateNote(db, id, patch)
    broadcast('db:changed', { entity: 'notes' })
    return n
  })
  handle('notes:delete', (id) => {
    notes.deleteNote(db, id)
    broadcast('db:changed', { entity: 'notes' })
  })
  handle('notes:reorder', (id, beforeId) => {
    notes.moveNoteBefore(db, id, beforeId)
    broadcast('db:changed', { entity: 'notes' })
  })
  handle('notes:toggleItem', (id, index) => {
    const n = notes.toggleItem(db, id, index)
    broadcast('db:changed', { entity: 'notes' })
    return n
  })
  handle('notes:labels', () => notes.listLabels(db))
  handle('notes:dueCount', () => notes.dueNoteCount(db))

  const runner = new AgentTaskRunner(
    db,
    (entity) => broadcast('db:changed', { entity }),
    (view, id) => broadcast('nav:goto', { view, id })
  )
  taskRunner = runner

  handle('agentTasks:list', () => agentTasksRepo.listAgentTasks(db))
  handle('agentTasks:create', (input) => {
    const t = agentTasksRepo.createAgentTask(db, input)
    broadcast('db:changed', { entity: 'agent_tasks' })
    return t
  })
  handle('agentTasks:update', (id, patch) => {
    const t = agentTasksRepo.updateAgentTask(db, id, patch)
    broadcast('db:changed', { entity: 'agent_tasks' })
    return t
  })
  handle('agentTasks:delete', (id) => {
    runner.stop(id)
    agentTasksRepo.deleteAgentTask(db, id)
    broadcast('db:changed', { entity: 'agent_tasks' })
  })
  handle('agentTasks:pause', (id) => {
    const t = agentTasksRepo.pauseAgentTask(db, id)
    broadcast('db:changed', { entity: 'agent_tasks' })
    return t
  })
  handle('agentTasks:resume', (id) => {
    const t = agentTasksRepo.resumeAgentTask(db, id)
    broadcast('db:changed', { entity: 'agent_tasks' })
    return t
  })
  handle('agentTasks:runNow', (id) => {
    runner.enqueue(id)
  })
  handle('agentTasks:stop', (id) => {
    runner.stop(id)
  })
  handle('agentTasks:runs', (taskId, limit) => agentTasksRepo.listRuns(db, taskId, limit))
  handle('agentTasks:recentRuns', (limit) => agentTasksRepo.recentRuns(db, limit))
  handle('agentTasks:usage', () => agentTasksRepo.usageByTask(db))
  handle('agentTasks:parse', (text) => parseTaskDraft(text))

  // event-triggered automations: count occurrences, fire on every Nth.
  // A task never triggers itself (isRunning guard) and nothing fires while
  // the master switch is off.
  const TRIGGERABLE: AppEventName[] = [
    'email_received',
    'message_received',
    'task_created',
    'note_created',
    'interaction_logged'
  ]
  for (const eventName of TRIGGERABLE) {
    onAppEvent(eventName, () => {
      if (!getSettings().automationsEnabled) return
      let changed = false
      for (const t of agentTasksRepo.listEventTasks(db, eventName)) {
        if (runner.isRunning(t.id)) continue
        changed = true
        if (agentTasksRepo.bumpTriggerCounter(db, t.id)) runner.enqueue(t.id)
      }
      if (changed) broadcast('db:changed', { entity: 'agent_tasks' })
    })
  }

  handle('projects:list', (f) => projects.listProjects(db, f))
  handle('projects:create', (input) => {
    const p = projects.createProject(db, input)
    broadcast('db:changed', { entity: 'projects' })
    return p
  })

  handle('people:list', (f) => people.listPeople(db, f))
  handle('people:detail', (id) => people.getPersonDetail(db, id) ?? null)
  handle('people:upsert', (input) => {
    const p = people.upsertPerson(db, input)
    broadcast('db:changed', { entity: 'people' })
    return p
  })
  handle('people:archive', (id) => {
    people.archivePerson(db, id)
    broadcast('db:changed', { entity: 'people' })
  })

  handle('interactions:log', (input) => {
    const i = interactions.logInteraction(db, input)
    broadcast('db:changed', { entity: 'interactions' })
    broadcast('db:changed', { entity: 'people' })
    emitAppEvent('interaction_logged')
    return i
  })

  handle('followups:due', () => followups.followupsDue(db))
  handle('followups:statuses', () => followups.followupStatuses(db))
  handle('followups:snooze', (personId, untilDate) => {
    people.snoozeFollowup(db, personId, untilDate)
    broadcast('db:changed', { entity: 'people' })
  })

  handle('objectives:list', (f) => objectives.listObjectives(db, f))
  handle('objectives:create', (input) => {
    const o = objectives.createObjective(db, input)
    broadcast('db:changed', { entity: 'objectives' })
    return o
  })
  handle('objectives:update', (id, patch) => {
    const o = objectives.updateObjective(db, id, patch)
    broadcast('db:changed', { entity: 'objectives' })
    return o
  })
  handle('objectives:delete', (id) => {
    objectives.deleteObjective(db, id)
    broadcast('db:changed', { entity: 'objectives' })
    broadcast('db:changed', { entity: 'tasks' }) // task-KR links cascade
  })
  handle('objectives:reorder', (id, beforeId) => {
    objectives.moveObjectiveBefore(db, id, beforeId)
    broadcast('db:changed', { entity: 'objectives' })
  })
  handle('objectives:periods', () => objectives.listPeriods(db))
  handle('krs:add', (objectiveId, kr) => {
    const k = objectives.addKeyResult(db, objectiveId, kr)
    broadcast('db:changed', { entity: 'objectives' })
    return k
  })
  handle('krs:update', (id, patch) => {
    const k = objectives.updateKeyResult(db, id, patch)
    broadcast('db:changed', { entity: 'objectives' })
    return k
  })
  handle('krs:updateProgress', (id, value) => {
    const k = objectives.updateKrProgress(db, id, value)
    broadcast('db:changed', { entity: 'objectives' })
    return k
  })
  handle('krs:delete', (id) => {
    objectives.deleteKeyResult(db, id)
    broadcast('db:changed', { entity: 'objectives' })
  })
  handle('krs:linkTask', (krId, taskId) => {
    objectives.linkTaskToKr(db, taskId, krId)
    broadcast('db:changed', { entity: 'objectives' })
  })
  handle('krs:unlinkTask', (krId, taskId) => {
    objectives.unlinkTaskFromKr(db, taskId, krId)
    broadcast('db:changed', { entity: 'objectives' })
  })
  handle('krs:tasks', (krId) => objectives.tasksForKr(db, krId))

  handle('today:get', () => todayAgenda(db))

  handle('calendar:today', () => calendarToday())

  // DB-backed calendar: local CRUD on SQLite, with the CalendarSyncManager
  // pushing dirty rows to Google and pulling remote changes in the background.
  const calManager = new CalendarSyncManager(
    db,
    (event) => broadcast('calendar:event', event),
    (entity) => broadcast('db:changed', { entity })
  )
  calendarManager = calManager

  handle('calendarEvents:list', (startIso, endIso) =>
    calendarRepo.listEventsInRange(db, startIso, endIso)
  )
  handle('calendarEvents:create', (input) => {
    const e = calendarRepo.createEvent(db, input)
    broadcast('db:changed', { entity: 'calendar_events' })
    calManager.pokePush()
    return e
  })
  handle('calendarEvents:update', (id, patch) => {
    const e = calendarRepo.updateEvent(db, id, patch)
    broadcast('db:changed', { entity: 'calendar_events' })
    calManager.pokePush()
    return e
  })
  handle('calendarEvents:delete', (id) => {
    calendarRepo.deleteEvent(db, id)
    broadcast('db:changed', { entity: 'calendar_events' })
    calManager.pokePush()
  })
  handle('calendarEvents:addMeet', (id) => calManager.addMeet(id))
  handle('calendar:calendars', () => calendarRepo.listCalendars(db))
  handle('calendar:setVisible', (calendarId, visible) => {
    calendarRepo.setCalendarVisible(db, calendarId, visible)
    broadcast('db:changed', { entity: 'calendars' })
    broadcast('db:changed', { entity: 'calendar_events' })
    // a newly-visible google calendar may never have synced (visibility gates the pull)
    if (visible) {
      const cal = calendarRepo.getCalendar(db, calendarId)
      if (cal?.account_id) calManager.syncNow(cal.account_id)
    }
  })
  handle('calendar:accounts', () => calendarRepo.listCalendarAccounts(db))
  handle('calendar:connectGoogle', async () => {
    try {
      return { ok: true as const, account: await calManager.connectGoogle() }
    } catch (err) {
      return { ok: false as const, message: err instanceof Error ? err.message : String(err) }
    }
  })
  handle('calendar:disconnect', async (accountId) => {
    calManager.disconnect(accountId)
  })
  handle('calendar:syncNow', (accountId) => calManager.syncNow(accountId))
  handle('calendar:pokeSync', () => calManager.pokePull())
  handle('calendar:attendeeSuggest', (query) => {
    const q = query.trim()
    if (!q) return []
    // people first (named contacts beat raw addresses), then past attendees
    const fromPeople = people
      .listPeople(db, { search: q })
      .filter((p) => p.email)
      .map((p) => ({ email: p.email!.toLowerCase(), name: p.name as string | null }))
    const fromEvents = calendarRepo.suggestAttendees(db, q)
    const seen = new Set<string>()
    const out: { email: string; name: string | null }[] = []
    for (const s of [...fromPeople, ...fromEvents]) {
      if (seen.has(s.email)) continue
      seen.add(s.email)
      out.push(s)
      if (out.length >= 8) break
    }
    return out
  })
  handle('calendar:overlay', (startIso, endIso) => ({
    // tasks carry date-only due dates (local-day concept) — convert the ISO
    // window bounds to local dates before comparing
    tasks: tasks.listTasksDueBetween(db, localDate(new Date(startIso)), localDate(new Date(endIso))),
    notes: notes.listNotesRemindBetween(db, startIso, endIso),
    agentTasks: agentTasksRepo.listAgentTasksNextRunBetween(db, startIso, endIso)
  }))

  handle('capture:submit', (raw) => {
    const result = executeCapture(db, raw)
    if (!result.ok) return { ok: false as const, message: result.message }
    broadcast('db:changed', {
      entity:
        result.kind === 'task' ? 'tasks' : result.kind === 'note' ? 'notes' : 'interactions'
    })
    if (result.kind === 'interaction') broadcast('db:changed', { entity: 'people' })
    emitAppEvent(
      result.kind === 'task'
        ? 'task_created'
        : result.kind === 'note'
          ? 'note_created'
          : 'interaction_logged'
    )
    return {
      ok: true as const,
      message:
        result.kind === 'task'
          ? `Task: ${result.task.title}${result.task.due_date ? ` (due ${result.task.due_date})` : ''}`
          : result.kind === 'note'
            ? `Note: ${result.note.title}`
            : `Logged for ${result.person.name}`
    }
  })
  handle('capture:hide', () => hideCaptureWindow())

  handle('export:markdown', () => {
    const dir = join(DATA_DIR, 'export')
    const { files } = exportMarkdown(db, dir)
    return { files, dir }
  })

  const chat = new ChatManager(
    db,
    (event) => broadcast('chat:event', event),
    (entity) => broadcast('db:changed', { entity })
  )
  handle('chat:send', (localSessionId, text) => chat.send(localSessionId, text))
  handle('notes:solve', (id, itemIndex) => {
    const note = notes.getNote(db, id)
    if (!note) throw new Error(`note not found: ${id}`)
    const { localSessionId } = chat.send(null, buildSolvePrompt(note, itemIndex))
    notes.updateNote(db, id, { agent_session_id: localSessionId })
    broadcast('db:changed', { entity: 'notes' })
    return { sessionId: localSessionId }
  })
  handle('chat:interrupt', (localSessionId) => chat.interrupt(localSessionId))
  handle('chat:sessions', () => chat.listSessions())
  handle('chat:history', (localSessionId) => chat.getHistory(localSessionId))
  handle('chat:draft', (input) => chat.draftReply(input))

  const terminals = new TerminalManager(ptySpawn, (event) => broadcast('terminal:event', event))
  terminalManager = terminals
  handle('terminal:create', () => terminals.create())
  handle('terminal:list', () => terminals.list())
  handle('terminal:attach', (sessionId) => terminals.attach(sessionId))
  handle('terminal:input', (sessionId, data) => terminals.input(sessionId, data))
  handle('terminal:resize', (sessionId, cols, rows) => terminals.resize(sessionId, cols, rows))
  handle('terminal:kill', (sessionId) => terminals.kill(sessionId))

  const manager = new CommsSyncManager(
    db,
    (event) => broadcast('comms:event', event),
    () => broadcast('db:changed', { entity: 'comms' }),
    (provider) => {
      emitAppEvent('message_received')
      if (provider === 'gmail') emitAppEvent('email_received')
    }
  )
  commsManager = manager

  handle('comms:accounts', () => comms.listAccounts(db))
  handle('comms:unreadTotal', () => comms.unreadTotal(db))
  handle('comms:threads', (f) => comms.listThreads(db, f))
  handle('comms:accountThreads', (accountId) => comms.listAccountThreads(db, accountId))
  handle('comms:messages', (threadId) => comms.listMessages(db, threadId))
  handle('comms:markRead', (threadId) => {
    manager.markRead(threadId) // local immediately; gmail propagation in background
    broadcast('db:changed', { entity: 'comms' })
  })
  handle('comms:markUnread', (threadId) => {
    manager.markUnread(threadId)
    broadcast('db:changed', { entity: 'comms' })
  })
  handle('comms:pinThread', (threadId, pinned) => {
    comms.setThreadPinned(db, threadId, pinned)
    broadcast('db:changed', { entity: 'comms' })
  })
  handle('comms:archiveThread', (threadId, archived) => manager.setThreadArchived(threadId, archived))
  handle('comms:deleteThread', (threadId) => manager.deleteThread(threadId))
  handle('comms:reorderAccount', (id, beforeId) => {
    comms.moveAccountBefore(db, id, beforeId)
    broadcast('db:changed', { entity: 'comms' })
  })
  handle('comms:send', (input) => manager.sendNow(input))
  handle('comms:syncNow', (accountId) => manager.syncNow(accountId))
  handle('comms:linkSender', (provider, handle_, personId) => {
    comms.linkHandleToPerson(db, provider, handle_.trim().toLowerCase(), personId)
    broadcast('db:changed', { entity: 'comms' })
  })
  handle('comms:setThreadSync', (threadId, enabled) => {
    comms.setThreadSyncEnabled(db, threadId, enabled)
    if (enabled) {
      const thread = comms.getThread(db, threadId)
      if (thread) manager.syncNow(thread.account_id)
    }
    broadcast('db:changed', { entity: 'comms' })
  })
  handle('comms:setThreadsSync', (threadIds, enabled) => {
    comms.setThreadsSyncEnabled(db, threadIds, enabled)
    if (enabled && threadIds.length > 0) {
      const thread = comms.getThread(db, threadIds[0])
      if (thread) manager.syncNow(thread.account_id)
    }
    broadcast('db:changed', { entity: 'comms' })
  })
  handle('comms:refreshChannels', (accountId) => manager.refreshChannels(accountId))
  handle('comms:connectGmail', () => wrapConnect(manager.connectGmail()))
  handle('comms:connectSlack', () => wrapConnect(manager.connectSlack()))
  handle('comms:connectWhatsApp', () =>
    wrapConnect(Promise.resolve().then(() => manager.connectWhatsApp()))
  )
  handle('comms:disconnect', async (accountId) => {
    manager.disconnect(accountId)
  })

  handle('settings:get', () => getSettings())
  handle('settings:set', (patch) => {
    const before = getSettings().captureHotkey
    const next = saveSettings(patch)
    if (next.captureHotkey !== before) reregisterCaptureHotkey(next.captureHotkey)
    broadcast('db:changed', { entity: 'settings' })
    return next
  })
  handle('settings:authStatus', () => checkAuthStatus())
  handle('usage:claudeToday', () => getClaudeUsageToday())
  handle('usage:claudeStats', () => getClaudeUsageStats())
  handle('usage:claudeLimits', () => getClaudeLimits())
}

/** turn a note (or one of its checklist items) into an agent instruction */
function buildSolvePrompt(
  note: import('../core/types').Note,
  itemIndex?: number
): string {
  const lines: string[] = []
  if (itemIndex !== undefined && note.items[itemIndex]) {
    lines.push(
      `Help me complete this item from my note "${note.title || 'untitled'}" (note id ${note.id}):`,
      `- ${note.items[itemIndex].text}`,
      '',
      `Do the work with your tools where possible. When it is done, check it off with note_toggle_item (id "${note.id}", index ${itemIndex}), then summarize briefly.`
    )
    return lines.join('\n')
  }
  lines.push(`Help me work through this note (note id ${note.id}):`)
  if (note.title) lines.push(`Title: ${note.title}`)
  if (note.content) lines.push(`Content: ${note.content}`)
  const open = note.items
    .map((it, i) => ({ ...it, i }))
    .filter((it) => !it.done)
  if (open.length > 0) {
    lines.push('Open items:')
    for (const it of open) lines.push(`- [index ${it.i}] ${it.text}`)
  }
  lines.push(
    '',
    `Do the work with your tools where possible. Check off items you complete with note_toggle_item (id "${note.id}", the index shown), and finish with a short summary of what you did and what still needs me.`
  )
  return lines.join('\n')
}

async function wrapConnect(
  p: Promise<import('../core/comms-types').CommsAccount>
): Promise<import('../shared/ipc-contract').CommsConnectResult> {
  try {
    return { ok: true, account: await p }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}

function checkAuthStatus(): Promise<import('../shared/ipc-contract').AuthStatus> {
  return new Promise((resolve) => {
    const env = { ...process.env }
    delete env['ANTHROPIC_API_KEY']
    env['PATH'] = [env['PATH'], '/opt/homebrew/bin', '/usr/local/bin'].filter(Boolean).join(':')
    execFile('claude', ['auth', 'status'], { env, timeout: 15_000 }, (err, stdout) => {
      if (err) {
        resolve({ ok: false, message: 'claude CLI not reachable — is Claude Code installed?' })
        return
      }
      try {
        const s = JSON.parse(stdout) as {
          loggedIn: boolean
          email?: string
          subscriptionType?: string
        }
        resolve(
          s.loggedIn
            ? { ok: true, email: s.email ?? '?', subscriptionType: s.subscriptionType ?? '?' }
            : { ok: false, message: 'not logged in — run `claude login` in a terminal' }
        )
      } catch {
        resolve({ ok: false, message: 'could not parse `claude auth status` output' })
      }
    })
  })
}

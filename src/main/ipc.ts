import { ipcMain, BrowserWindow } from 'electron'
import { join } from 'node:path'
import type { IpcApi, IpcEvents } from '../shared/ipc-contract'
import { getDb, DATA_DIR } from './db'
import { exportMarkdown } from '../core/export/markdown'
import { calendarToday } from './calendar'
import { ChatManager } from './chat/agent'
import { getSettings, saveSettings } from './settings'
import { reregisterCaptureHotkey } from './hotkey'
import { execFile } from 'node:child_process'
import * as tasks from '../core/repo/tasks'
import * as projects from '../core/repo/projects'
import * as people from '../core/repo/people'
import * as interactions from '../core/repo/interactions'
import * as followups from '../core/repo/followups'
import * as objectives from '../core/repo/objectives'
import { todayAgenda } from '../core/repo/today'
import { executeCapture } from '../core/capture'
import { hideCaptureWindow } from './windows/capture-window'
import * as comms from '../core/repo/comms'
import { CommsSyncManager } from './comms/manager'
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

export function registerIpc(): void {
  const db = getDb()

  handle('app:ping', () => 'pong')
  handle('log:renderer', (level, message) => logLine(level, 'renderer', message.slice(0, 4000)))

  handle('tasks:list', (f) => tasks.listTasks(db, f))
  handle('tasks:create', (input) => {
    const t = tasks.createTask(db, input)
    broadcast('db:changed', { entity: 'tasks' })
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

  handle('capture:submit', (raw) => {
    const result = executeCapture(db, raw)
    if (!result.ok) return { ok: false as const, message: result.message }
    broadcast('db:changed', { entity: result.kind === 'task' ? 'tasks' : 'interactions' })
    if (result.kind === 'interaction') broadcast('db:changed', { entity: 'people' })
    return {
      ok: true as const,
      message:
        result.kind === 'task'
          ? `Task: ${result.task.title}${result.task.due_date ? ` (due ${result.task.due_date})` : ''}`
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
  handle('chat:interrupt', (localSessionId) => chat.interrupt(localSessionId))
  handle('chat:sessions', () => chat.listSessions())
  handle('chat:draft', (input) => chat.draftReply(input))

  const manager = new CommsSyncManager(
    db,
    (event) => broadcast('comms:event', event),
    () => broadcast('db:changed', { entity: 'comms' })
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
    return next
  })
  handle('settings:authStatus', () => checkAuthStatus())
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

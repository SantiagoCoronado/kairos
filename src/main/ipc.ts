import { ipcMain, BrowserWindow } from 'electron'
import type { IpcApi, IpcEvents } from '../shared/ipc-contract'
import { getDb } from './db'
import * as tasks from '../core/repo/tasks'
import * as projects from '../core/repo/projects'
import * as people from '../core/repo/people'
import * as interactions from '../core/repo/interactions'
import * as followups from '../core/repo/followups'
import * as objectives from '../core/repo/objectives'
import { todayAgenda } from '../core/repo/today'

function handle<K extends keyof IpcApi>(
  channel: K,
  fn: (...args: Parameters<IpcApi[K]>) => ReturnType<IpcApi[K]>
): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ipcMain.handle(channel, (_event, ...args) => (fn as any)(...args))
}

export function broadcast<K extends keyof IpcEvents>(channel: K, payload: IpcEvents[K]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload)
  }
}

export function registerIpc(): void {
  const db = getDb()

  handle('app:ping', () => 'pong')

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
  handle('krs:add', (objectiveId, kr) => {
    const k = objectives.addKeyResult(db, objectiveId, kr)
    broadcast('db:changed', { entity: 'objectives' })
    return k
  })
  handle('krs:updateProgress', (id, value) => {
    const k = objectives.updateKrProgress(db, id, value)
    broadcast('db:changed', { entity: 'objectives' })
    return k
  })
  handle('krs:linkTask', (krId, taskId) => {
    objectives.linkTaskToKr(db, taskId, krId)
    broadcast('db:changed', { entity: 'objectives' })
  })
  handle('krs:tasks', (krId) => objectives.tasksForKr(db, krId))

  handle('today:get', () => todayAgenda(db))

  // real implementation arrives with the Swift EventKit helper (M8)
  handle('calendar:today', () => ({ error: 'helper-missing' as const }))
}

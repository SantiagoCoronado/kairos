// Single source of truth for everything that crosses the IPC boundary.
// Main implements IpcApi; preload exposes it promisified as window.api.
import type {
  Area,
  Task,
  TaskFilter,
  NewTask,
  TaskPatch,
  Project,
  NewProject,
  ProjectStatus,
  Person,
  PersonUpsert,
  PeopleFilter,
  PersonDetail,
  Interaction,
  NewInteraction,
  FollowupDue,
  ObjectiveWithKRs,
  NewObjective,
  ObjectivePatch,
  ObjectiveStatus,
  KeyResult,
  TodayPayload
} from '../core/types'

export interface CalendarEvent {
  title: string
  start: string
  end: string
  allDay: boolean
  calendar: string
  location: string | null
}

export type CalendarResult =
  | { events: CalendarEvent[] }
  | { error: 'not-authorized' | 'helper-missing' | 'helper-failed' }

export interface IpcApi {
  'app:ping': () => string

  'tasks:list': (f: TaskFilter) => Task[]
  'tasks:create': (input: NewTask) => Task
  'tasks:update': (id: string, patch: TaskPatch) => Task
  'tasks:delete': (id: string) => void

  'projects:list': (f: { status?: ProjectStatus; area?: Area }) => Project[]
  'projects:create': (input: NewProject) => Project

  'people:list': (f: PeopleFilter) => Person[]
  'people:detail': (id: string) => PersonDetail | null
  'people:upsert': (input: PersonUpsert) => Person
  'people:archive': (id: string) => void

  'interactions:log': (input: NewInteraction) => Interaction

  'followups:due': () => FollowupDue[]
  'followups:statuses': () => FollowupDue[]
  'followups:snooze': (personId: string, untilDate: string) => void

  'objectives:list': (f: {
    period?: string
    area?: Area
    status?: ObjectiveStatus
  }) => ObjectiveWithKRs[]
  'objectives:create': (input: NewObjective) => ObjectiveWithKRs
  'objectives:update': (id: string, patch: ObjectivePatch) => ObjectiveWithKRs
  'krs:add': (
    objectiveId: string,
    kr: { title: string; unit?: string; start_value?: number; target_value?: number }
  ) => KeyResult
  'krs:updateProgress': (id: string, value: number) => KeyResult
  'krs:linkTask': (krId: string, taskId: string) => void
  'krs:tasks': (krId: string) => Task[]

  'today:get': () => TodayPayload

  'calendar:today': () => Promise<CalendarResult>

  'capture:submit': (raw: string) => CaptureSubmitResult
  'capture:hide': () => void

  'export:markdown': () => { files: number; dir: string }
}

export type CaptureSubmitResult =
  | { ok: true; message: string }
  | { ok: false; message: string }

export interface IpcEvents {
  'db:changed': { entity: import('../core/types').DbEntity }
  'capture:reset': Record<string, never>
}

export type IpcChannel = keyof IpcApi
export type IpcEventChannel = keyof IpcEvents
export type DbEntity = IpcEvents['db:changed']['entity']

// What the renderer sees: same channels, promisified returns.
export type RendererApi = {
  invoke<K extends IpcChannel>(
    channel: K,
    ...args: Parameters<IpcApi[K]>
  ): Promise<Awaited<ReturnType<IpcApi[K]>>>
  on<K extends IpcEventChannel>(channel: K, cb: (payload: IpcEvents[K]) => void): () => void
}

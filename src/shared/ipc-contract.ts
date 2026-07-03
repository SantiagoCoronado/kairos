// Single source of truth for everything that crosses the IPC boundary.
// Main implements IpcApi; preload exposes it promisified as window.api.
import type {
  Area,
  Task,
  TaskFilter,
  NewTask,
  TaskPatch,
  KrPatch,
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
import type {
  CommsAccount,
  CommsThread,
  CommsThreadListItem,
  CommsMessage,
  CommsProvider,
  ThreadFilter
} from '../core/comms-types'

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
  /** append a renderer-side event to ~/Kairos/logs/app.log */
  'log:renderer': (level: 'info' | 'warn' | 'error', message: string) => void

  'tasks:list': (f: TaskFilter) => Task[]
  'tasks:create': (input: NewTask) => Task
  'tasks:update': (id: string, patch: TaskPatch) => Task
  'tasks:delete': (id: string) => void
  /** place a task before another in manual order (null = move to end) */
  'tasks:reorder': (id: string, beforeId: string | null) => void

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
  'objectives:delete': (id: string) => void
  /** place an objective before another in manual order (null = move to end) */
  'objectives:reorder': (id: string, beforeId: string | null) => void
  /** distinct periods present in the DB, newest first */
  'objectives:periods': () => string[]
  'krs:add': (
    objectiveId: string,
    kr: { title: string; unit?: string; start_value?: number; target_value?: number }
  ) => KeyResult
  'krs:update': (id: string, patch: KrPatch) => KeyResult
  'krs:updateProgress': (id: string, value: number) => KeyResult
  'krs:delete': (id: string) => void
  'krs:linkTask': (krId: string, taskId: string) => void
  'krs:unlinkTask': (krId: string, taskId: string) => void
  'krs:tasks': (krId: string) => Task[]

  'today:get': () => TodayPayload

  'calendar:today': () => Promise<CalendarResult>

  'capture:submit': (raw: string) => CaptureSubmitResult
  'capture:hide': () => void

  'export:markdown': () => { files: number; dir: string }

  'chat:send': (localSessionId: string | null, text: string) => { localSessionId: string }
  'chat:interrupt': (localSessionId: string) => void
  'chat:sessions': () => ChatSessionInfo[]
  /** one-shot AI reply draft for a comms thread — only ever called on user command */
  'chat:draft': (input: ChatDraftInput) => Promise<ChatDraftResult>

  'settings:get': () => AppSettings
  'settings:set': (patch: Partial<AppSettings>) => AppSettings
  'settings:authStatus': () => Promise<AuthStatus>

  'comms:accounts': () => CommsAccount[]
  'comms:unreadTotal': () => number
  'comms:threads': (f: ThreadFilter) => CommsThreadListItem[]
  /** every thread of one account, incl. inactive/disabled — for channel opt-in UI */
  'comms:accountThreads': (accountId: string) => CommsThread[]
  'comms:messages': (threadId: string) => CommsMessage[]
  'comms:markRead': (threadId: string) => void
  /** archive/unarchive; gmail propagates remotely, others are local-only */
  'comms:archiveThread': (threadId: string, archived: boolean) => Promise<CommsArchiveResult>
  /** gmail only: trash the thread remotely and remove it locally */
  'comms:deleteThread': (threadId: string) => Promise<CommsArchiveResult>
  /** place an account before another in the rail (null = move to end) */
  'comms:reorderAccount': (id: string, beforeId: string | null) => void
  'comms:send': (input: CommsSendInput) => Promise<CommsSendResult>
  'comms:syncNow': (accountId?: string) => void
  'comms:linkSender': (provider: CommsProvider, handle: string, personId: string) => void
  'comms:setThreadSync': (threadId: string, enabled: boolean) => void
  'comms:connectGmail': () => Promise<CommsConnectResult>
  'comms:connectSlack': () => Promise<CommsConnectResult>
  'comms:connectWhatsApp': () => Promise<CommsConnectResult>
  'comms:disconnect': (accountId: string) => Promise<void>
}

export interface CommsSendInput {
  accountId: string
  /** reply into an existing thread; recipients/subject derived when omitted */
  threadId?: string
  /** new email only */
  to?: string[]
  subject?: string
  body: string
}

export type CommsSendResult = { ok: true; outboxId: string } | { ok: false; message: string }

export type CommsArchiveResult = { ok: true } | { ok: false; message: string }

export interface ChatDraftInput {
  threadId: string
  /** optional user guidance, e.g. "decline politely" */
  instruction?: string
}

export type ChatDraftResult = { ok: true; draft: string } | { ok: false; message: string }

export type CommsConnectResult = { ok: true; account: CommsAccount } | { ok: false; message: string }

export type CommsEvent = { accountId?: string } & (
  | {
      kind: 'sync'
      status: 'syncing' | 'idle' | 'error' | 'connected' | 'needs_auth'
      message?: string
    }
  | { kind: 'wa_qr'; qrDataUrl: string }
)

export type ChatProvider = 'claude'
export type ChatEffort = 'low' | 'medium' | 'high' | 'max'

export interface AppSettings {
  captureHotkey: string
  claudePath: string | null
  /** 0–60: how much desktop shows through the window (%) */
  translucency: number
  chatProvider: ChatProvider
  /** model alias ('opus', 'sonnet', …) or full id; null = Claude Code default */
  chatModel: string | null
  /** reasoning effort; null = model default */
  chatEffort: ChatEffort | null
  /** OAuth client for the user's own Google Cloud project (installed-app
   *  client secrets are not confidential per Google's docs) */
  googleClientId: string | null
  googleClientSecret: string | null
  /** OAuth client for the user's own Slack app */
  slackClientId: string | null
  slackClientSecret: string | null
}

export type AuthStatus =
  | { ok: true; email: string; subscriptionType: string }
  | { ok: false; message: string }

export interface ChatSessionInfo {
  id: string
  title: string
  updated_at: string
}

export type ChatStreamEvent = { localSessionId: string } & (
  | { kind: 'delta'; text: string }
  | { kind: 'tool'; name: string }
  | { kind: 'assistant_done' }
  | { kind: 'done' }
  | { kind: 'error'; message: string }
)

export type CaptureSubmitResult =
  | { ok: true; message: string }
  | { ok: false; message: string }

export interface IpcEvents {
  'db:changed': { entity: import('../core/types').DbEntity }
  'capture:reset': Record<string, never>
  'chat:event': ChatStreamEvent
  'comms:event': CommsEvent
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

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
  TodayPayload,
  Note,
  NoteFilter,
  NewNote,
  NotePatch,
  AgentTask,
  AgentTaskRun,
  AgentTaskUsage,
  NewAgentTask,
  AgentTaskPatch,
  AgentTaskDraft,
  CalendarAccount,
  CalendarCalendar,
  CalendarEventRecord,
  NewCalendarEvent,
  CalendarEventPatch
} from '../core/types'
import type {
  CommsAccount,
  CommsAttachment,
  CommsIdentity,
  CommsThread,
  CommsThreadListItem,
  CommsMessage,
  CommsProvider,
  MessageSearchHit,
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

export interface MacContact {
  name: string
  /** organization name; helpers built before the org field omit it */
  org?: string
  phones: string[]
  emails: string[]
}

export type ContactsResult =
  | { contacts: MacContact[] }
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

  'notes:list': (f: NoteFilter) => Note[]
  'notes:create': (input: NewNote) => Note
  'notes:update': (id: string, patch: NotePatch) => Note
  'notes:delete': (id: string) => void
  /** place a note before another in manual order (null = move to end) */
  'notes:reorder': (id: string, beforeId: string | null) => void
  /** flip one checklist item's done state */
  'notes:toggleItem': (id: string, index: number) => Note
  /** distinct #tags across unarchived notes */
  'notes:labels': () => string[]
  /** count of due/overdue unfired reminders (sidebar badge) */
  'notes:dueCount': () => number
  /** hand the note (or one checklist item) to the chat agent; returns the session */
  'notes:solve': (id: string, itemIndex?: number) => { sessionId: string }

  'agentTasks:list': () => AgentTask[]
  'agentTasks:create': (input: NewAgentTask) => AgentTask
  'agentTasks:update': (id: string, patch: AgentTaskPatch) => AgentTask
  'agentTasks:delete': (id: string) => void
  'agentTasks:pause': (id: string) => AgentTask
  /** resume recomputes next_run from now */
  'agentTasks:resume': (id: string) => AgentTask
  /** queue an immediate run (skips the schedule) */
  'agentTasks:runNow': (id: string) => void
  /** interrupt an in-flight run (or drop it from the queue) */
  'agentTasks:stop': (id: string) => void
  'agentTasks:runs': (taskId: string, limit?: number) => AgentTaskRun[]
  'agentTasks:recentRuns': (limit?: number) => (AgentTaskRun & { task_name: string })[]
  /** per-task token/cost rollup over trailing 7d and 30d windows */
  'agentTasks:usage': () => AgentTaskUsage[]
  /** NL → structured draft for the create form (one-shot model call) */
  'agentTasks:parse': (text: string) => Promise<AgentTaskParseResult>
  /** sidebar badge: in-flight runs + finished runs not yet seen */
  'agentTasks:activity': () => { running: number; unseenFinished: number }
  /** renderer reports Automations view visibility; while open, runs are seen */
  'agentTasks:setViewActive': (active: boolean) => void

  'projects:list': (f: { status?: ProjectStatus; area?: Area }) => Project[]
  'projects:create': (input: NewProject) => Project

  'people:list': (f: PeopleFilter) => Person[]
  'people:detail': (id: string) => PersonDetail | null
  'people:upsert': (input: PersonUpsert) => Person
  'people:archive': (id: string) => void
  'people:unarchive': (id: string) => void
  /** hard delete — interactions/identity links cascade, tasks/messages unlink */
  'people:delete': (id: string) => void
  /** linked comms handles for the detail view's unlink list */
  'people:identities': (personId: string) => CommsIdentity[]
  /** dedupe lookup against the FULL roster (email exact, phone canonical-suffix) */
  'people:findByContact': (emails: string[], phones: string[]) => Person | null

  'interactions:log': (input: NewInteraction) => Interaction

  'followups:due': () => FollowupDue[]
  'followups:statuses': () => FollowupDue[]
  'followups:snooze': (personId: string, untilDate: string) => void
  'followups:clearSnooze': (personId: string) => void

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

  /** macOS address-book autocomplete for the People view (TCC-gated) */
  'contacts:search': (query: string) => Promise<ContactsResult>

  /** DB-backed calendar (local events + google sync) — distinct from the
   *  read-only macOS EventKit 'calendar:today' above */
  'calendarEvents:list': (startIso: string, endIso: string) => CalendarEventRecord[]
  'calendarEvents:create': (input: NewCalendarEvent) => CalendarEventRecord
  /** drag/resize is a start_at/end_at patch on this same channel */
  'calendarEvents:update': (id: string, patch: CalendarEventPatch) => CalendarEventRecord
  'calendarEvents:delete': (id: string) => void
  /** attach a Google Meet link (writable google-calendar events only) */
  'calendarEvents:addMeet': (id: string) => Promise<CalendarEventRecord>
  'calendar:calendars': () => CalendarCalendar[]
  'calendar:setVisible': (calendarId: string, visible: boolean) => void
  'calendar:accounts': () => CalendarAccount[]
  'calendar:connectGoogle': () => Promise<CalendarConnectResult>
  'calendar:disconnect': (accountId: string) => Promise<void>
  'calendar:syncNow': (accountId?: string) => void
  /** throttled opportunistic pull — fired when the calendar view opens */
  'calendar:pokeSync': () => void
  /** the app's own dated items for the visible range, rendered as chips */
  'calendar:overlay': (startIso: string, endIso: string) => CalendarOverlay
  /** invite-field autocomplete: people with emails + past event attendees */
  'calendar:attendeeSuggest': (query: string) => AttendeeSuggestion[]

  'capture:submit': (raw: string) => CaptureSubmitResult
  'capture:hide': () => void

  'export:markdown': () => { files: number; dir: string }

  'chat:send': (localSessionId: string | null, text: string) => { localSessionId: string }
  /** stage files for the next message via the OS file picker */
  'chat:attach': () => Promise<ChatAttachment[]>
  /** stage dropped files (renderer resolves File → absolute path first) */
  'chat:attachPaths': (paths: string[]) => ChatAttachment[]
  'chat:interrupt': (localSessionId: string) => void
  'chat:sessions': () => ChatSessionInfo[]
  /** replay a session's persisted transcript; falls back to an automation run's stored result */
  'chat:history': (localSessionId: string) => ChatHistoryMessage[]
  /** one-shot AI reply draft for a comms thread — only ever called on user command */
  'chat:draft': (input: ChatDraftInput) => Promise<ChatDraftResult>

  'terminal:create': () => TerminalSessionInfo
  'terminal:list': () => TerminalSessionInfo[]
  /** (re)subscribe to a session: returns buffered output to replay into a fresh xterm */
  'terminal:attach': (sessionId: string) => { backlog: string } | null
  'terminal:input': (sessionId: string, data: string) => void
  'terminal:resize': (sessionId: string, cols: number, rows: number) => void
  'terminal:kill': (sessionId: string) => void
  /** renderer reports Terminal view visibility; opening clears attention flags */
  'terminal:setViewActive': (active: boolean) => void
  /** sessions that rang the bell (agent finished) since the view was open */
  'terminal:attentionCount': () => number

  'settings:get': () => AppSettings
  'settings:set': (patch: Partial<AppSettings>) => AppSettings
  'settings:authStatus': () => Promise<AuthStatus>

  /** remote-access (phone/browser) server: live state + connect URLs */
  'remote:status': () => Promise<RemoteStatus>

  /** today's Claude Code token usage, parsed from ~/.claude session transcripts */
  'usage:claudeToday': () => Promise<ClaudeUsageToday>
  /** all-time Claude Code stats: heatmap days, streaks, totals */
  'usage:claudeStats': () => Promise<ClaudeUsageStats>
  /** rate-limit windows from the Claude OAuth usage endpoint; null when unavailable */
  'usage:claudeLimits': () => Promise<ClaudeLimits | null>

  'comms:accounts': () => CommsAccount[]
  'comms:unreadTotal': () => number
  'comms:threads': (f: ThreadFilter) => CommsThreadListItem[]
  /** one thread as a list row — for opening search hits not in the current list */
  'comms:thread': (threadId: string) => CommsThreadListItem | null
  /** message-body search across all boxes (LIKE over body/sender/title) */
  'comms:search': (
    query: string,
    opts?: { accountId?: string; provider?: CommsProvider; limit?: number }
  ) => MessageSearchHit[]
  /** every thread of one account, incl. inactive/disabled — for channel opt-in UI */
  'comms:accountThreads': (accountId: string) => CommsThread[]
  'comms:messages': (threadId: string) => CommsMessage[]
  /** attachment metadata for every message in a thread (one query per pane) */
  'comms:threadAttachments': (threadId: string) => CommsAttachment[]
  /** fetch the bytes (cached on disk after the first download), then open the file */
  'comms:downloadAttachment': (attachmentId: string) => Promise<CommsDownloadResult>
  /** fetch the bytes as a data URL for in-app rendering (voice notes) */
  'comms:attachmentData': (attachmentId: string) => Promise<CommsAttachmentDataResult>
  'comms:markRead': (threadId: string) => void
  /** re-flag the newest inbound message unread; gmail propagates remotely */
  'comms:markUnread': (threadId: string) => void
  /** pin/unpin to the top of the list; local-only, all providers */
  'comms:pinThread': (threadId: string, pinned: boolean) => void
  /** distinct labels present on any thread — the filter chips */
  'comms:labels': () => string[]
  /** manual label override (empty array clears; auto-label may refill later) */
  'comms:setThreadLabels': (threadId: string, labels: string[]) => void
  /** archive/unarchive; gmail propagates remotely, others are local-only */
  'comms:archiveThread': (threadId: string, archived: boolean) => Promise<CommsArchiveResult>
  /** gmail only: trash the thread remotely and remove it locally */
  'comms:deleteThread': (threadId: string) => Promise<CommsArchiveResult>
  /** place an account before another in the rail (null = move to end) */
  'comms:reorderAccount': (id: string, beforeId: string | null) => void
  'comms:send': (input: CommsSendInput) => Promise<CommsSendResult>
  'comms:syncNow': (accountId?: string) => void
  'comms:linkSender': (provider: CommsProvider, handle: string, personId: string) => void
  /** inverse of linkSender: drop the identity and clear person_id on its messages */
  'comms:unlinkSender': (provider: CommsProvider, handle: string) => void
  'comms:setThreadSync': (threadId: string, enabled: boolean) => void
  /** bulk channel opt-in/out — one db:changed instead of one per checkbox */
  'comms:setThreadsSync': (threadIds: string[], enabled: boolean) => void
  /** slack only: re-list conversations now instead of waiting out the 15 min cache */
  'comms:refreshChannels': (accountId: string) => Promise<CommsArchiveResult>
  'comms:connectGmail': () => Promise<CommsConnectResult>
  'comms:connectSlack': () => Promise<CommsConnectResult>
  'comms:connectWhatsApp': () => Promise<CommsConnectResult>
  'comms:disconnect': (accountId: string) => Promise<void>
}

export type CommsDownloadResult = { ok: true; path: string } | { ok: false; message: string }
export type CommsAttachmentDataResult =
  | { ok: true; dataUrl: string }
  | { ok: false; message: string }

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

/** a file staged into chat-uploads, ready to reference in a prompt */
export interface ChatAttachment {
  name: string
  /** absolute path of the staged copy (inside DATA_DIR/chat-uploads) */
  path: string
  size: number
}

export type CommsConnectResult = { ok: true; account: CommsAccount } | { ok: false; message: string }

export type CalendarConnectResult =
  | { ok: true; account: CalendarAccount }
  | { ok: false; message: string }

export interface CalendarOverlay {
  tasks: Task[]
  notes: Note[]
  agentTasks: AgentTask[]
}

export interface AttendeeSuggestion {
  email: string
  name: string | null
}

export type CalendarSyncEvent = {
  accountId?: string
  kind: 'sync'
  status: 'syncing' | 'idle' | 'error' | 'connected' | 'needs_auth'
  message?: string
}

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
  /** master switch: when false, no automation fires automatically
   *  (schedules and event triggers alike); run-now still works */
  automationsEnabled: boolean
  /** 0–60: how much desktop shows through the window (%) */
  translucency: number
  /** show today's Claude Code token usage on the Today view */
  showClaudeUsage: boolean
  /** background email auto-labeling (haiku batches via the Claude Code login) */
  autoLabel: boolean
  /** native notifications for new messages: DMs + action-needed email
   *  ('important'), everything ('all'), or never ('off') */
  notifyInbox: 'off' | 'important' | 'all'
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
  /** UI cursor, not a user preference: newest automation run already seen
   *  in the Automations view (drives the sidebar unseen-runs badge) */
  automationsSeenAt: string | null
  /** serve the UI over HTTP+WebSocket so a phone/browser can connect */
  remoteAccess: boolean
  /** bearer token required on the WebSocket handshake; generated on first enable */
  remoteToken: string | null
  remotePort: number
}

export interface RemoteStatus {
  running: boolean
  port: number
  token: string | null
  /** connect URLs, one per usable interface (tailscale/LAN), token in the hash */
  urls: string[]
  /** https://<mac>.<tailnet>.ts.net/#token=… when the Tailscale CLI is present —
   *  the URL the iPhone should use (secure context: PWA install + push) */
  httpsUrl: string | null
  /** whether `tailscale serve` is currently proxying to our port */
  serveActive: boolean
  clients: number
  /** last bind/start failure, if any (e.g. port in use) */
  error: string | null
}

export type AuthStatus =
  | { ok: true; email: string; subscriptionType: string }
  | { ok: false; message: string }

export interface ClaudeUsageModel {
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  totalTokens: number
  /** null when the model isn't in the local price table */
  costUsd: number | null
}

export interface ClaudeUsageToday {
  /** deduplicated assistant messages */
  messages: number
  sessions: number
  totalTokens: number
  /** sum over models with known pricing */
  costUsd: number
  /** true when some model had no price — costUsd undercounts */
  costIsPartial: boolean
  byModel: ClaudeUsageModel[]
}

export interface ClaudeUsageStats {
  sessions: number
  messages: number
  totalTokens: number
  activeDays: number
  /** consecutive active days ending today (or yesterday if today is quiet) */
  currentStreak: number
  longestStreak: number
  /** 0–23 local hour with the most messages; null when no data */
  peakHour: number | null
  favoriteModel: string | null
  /** per-day token totals for the heatmap, oldest→today, Monday-aligned */
  days: { date: string; tokens: number }[]
}

export interface ClaudeLimitBucket {
  key: string
  label: string
  /** 0–100 percent used */
  utilization: number
  resetsAt: string | null
}

export interface ClaudeLimits {
  fetchedAt: string
  buckets: ClaudeLimitBucket[]
}

export interface ChatSessionInfo {
  id: string
  title: string
  updated_at: string
}

/** a replayable transcript turn returned by chat:history */
export interface ChatHistoryMessage {
  role: 'user' | 'assistant' | 'error'
  text: string
  tools: string[]
}

export type ChatStreamEvent = { localSessionId: string } & (
  | { kind: 'delta'; text: string }
  | { kind: 'tool'; name: string }
  | { kind: 'assistant_done' }
  | { kind: 'done' }
  | { kind: 'error'; message: string }
)

export interface TerminalSessionInfo {
  id: string
  /** shell basename, e.g. "zsh" */
  title: string
}

export type TerminalEvent = { sessionId: string } & (
  | { kind: 'data'; data: string }
  | { kind: 'exit'; exitCode: number }
)

export type CaptureSubmitResult =
  | { ok: true; message: string }
  | { ok: false; message: string }

export type AgentTaskParseResult =
  | { ok: true; draft: AgentTaskDraft }
  | { ok: false; message: string }

/** views addressable by main-process deep links (notification clicks) */
export type NavView =
  | 'today'
  | 'inbox'
  | 'people'
  | 'tasks'
  | 'notes'
  | 'objectives'
  | 'automations'
  | 'calendar'
  | 'chat'
  | 'terminal'

export interface IpcEvents {
  'db:changed': { entity: import('../core/types').DbEntity }
  /** main → renderer: focus a view (e.g. a clicked reminder notification) */
  'nav:goto': { view: NavView; id?: string }
  'capture:reset': Record<string, never>
  'chat:event': ChatStreamEvent
  'comms:event': CommsEvent
  'calendar:event': CalendarSyncEvent
  'terminal:event': TerminalEvent
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
  /** absolute path of a DataTransfer File (webUtils bridge; drag-drop only) */
  pathForFile(file: File): string
}

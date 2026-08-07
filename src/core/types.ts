// Domain row types + input shapes. Shared by the Electron app, the MCP
// server, and the in-app agent tools. Pure types, no runtime imports.

export type Area = 'personal' | 'work'

/** entities announced in change notifications (IPC db:changed) */
export type DbEntity =
  | 'tasks'
  | 'people'
  | 'interactions'
  | 'objectives'
  | 'projects'
  | 'comms'
  | 'notes'
  | 'agent_tasks'
  | 'calendar_events'
  | 'calendars'
  | 'calendar_accounts'
  | 'meetings'
  | 'settings'
  | 'terminal'
  | 'pending'
  | 'all'

export type InteractionKind = 'call' | 'message' | 'email' | 'meeting' | 'coffee' | 'other'
export type TaskStatus = 'todo' | 'in_progress' | 'done' | 'cancelled'
export type ProjectStatus = 'active' | 'paused' | 'done' | 'archived'
export type ObjectiveStatus = 'active' | 'achieved' | 'dropped'

export interface Person {
  id: string
  name: string
  nickname: string | null
  email: string | null
  phone: string | null
  company: string | null
  role: string | null
  area: Area
  cadence_days: number | null
  snoozed_until: string | null
  notes: string
  created_at: string
  updated_at: string
  archived_at: string | null
}

export interface Interaction {
  id: string
  person_id: string
  occurred_at: string
  kind: InteractionKind
  summary: string
  created_at: string
}

export interface Project {
  id: string
  name: string
  area: Area
  status: ProjectStatus
  description: string
  created_at: string
  updated_at: string
}

export interface Task {
  id: string
  title: string
  notes: string
  status: TaskStatus
  area: Area
  priority: number // 1=urgent .. 4=someday
  project_id: string | null
  person_id: string | null
  meeting_id: string | null // action item extracted from a recorded meeting
  due_date: string | null // YYYY-MM-DD
  completed_at: string | null
  sort_order: number
  created_at: string
  updated_at: string
}

export interface Objective {
  id: string
  title: string
  description: string
  area: Area
  period: string // e.g. '2026-Q3'
  status: ObjectiveStatus
  sort_order: number
  created_at: string
  updated_at: string
}

export interface KeyResult {
  id: string
  objective_id: string
  title: string
  unit: string
  start_value: number
  target_value: number
  current_value: number
  sort_order: number
  updated_at: string
}

export type NoteType = 'note' | 'checklist'
export type NoteRepeat = 'none' | 'daily' | 'weekly' | 'monthly' | 'yearly'

export interface NoteItem {
  text: string
  done: boolean
}

/** Keep-style note. `items` is stored as JSON in SQLite; the repo parses at
 *  the boundary so consumers always see the array form. */
export interface Note {
  id: string
  title: string
  content: string
  items: NoteItem[]
  note_type: NoteType
  color: string | null
  /** whitespace-separated #tags, e.g. '#home #errands' */
  labels: string
  pinned: number // sqlite bool
  archived: number // sqlite bool
  remind_at: string | null // ISO datetime; doubles as the reminder
  repeat: NoteRepeat
  reminder_fired_at: string | null
  source: 'user' | 'agent'
  agent_session_id: string | null
  sort_order: number
  created_at: string
  updated_at: string
}

export type AgentSchedule = 'once' | 'daily' | 'weekly' | 'monthly'
export type AgentTaskStatus = 'active' | 'paused' | 'completed'
export type AgentRunStatus = 'running' | 'success' | 'error' | 'stopped'
export type AgentTriggerType = 'schedule' | 'event'

/** app events that can trigger automations (fired by the main process only —
 *  MCP-twin writes happen in another process and cannot trigger these) */
export type AppEventName =
  | 'email_received'
  | 'message_received'
  | 'task_created'
  | 'note_created'
  | 'interaction_logged'

/** a scheduled agent job ("Automation"): a prompt the agent runs on a schedule */
export interface AgentTask {
  id: string
  name: string
  prompt: string
  schedule: AgentSchedule
  /** 'HH:MM' local wall-clock (daily/weekly/monthly) */
  scheduled_time: string | null
  /** weekly: 0=Sun..6=Sat; monthly: 1..31 (clamped to short months) */
  scheduled_day: number | null
  /** once: full ISO datetime */
  scheduled_date: string | null
  cron_expression: string | null
  trigger_type: AgentTriggerType
  trigger_event: AppEventName | null
  /** fire every N occurrences of the event */
  trigger_count: number
  trigger_counter: number
  next_run: string | null
  last_run: string | null
  status: AgentTaskStatus
  run_count: number
  /** chat session holding the latest run's transcript */
  session_id: string | null
  model: string | null
  max_turns: number | null
  notify: number // sqlite bool
  then_task_id: string | null
  created_at: string
  updated_at: string
}

export interface AgentTaskRun {
  id: string
  task_id: string
  started_at: string
  finished_at: string | null
  status: AgentRunStatus
  result: string | null
  error: string | null
  /** JSON [{tool, at}] — the run's tool-call log */
  steps: string
  session_id: string | null
  model: string | null
  // token usage from the SDK result message; null for pre-tracking runs
  input_tokens: number | null
  output_tokens: number | null
  cache_read_tokens: number | null
  cache_creation_tokens: number | null
  cost_usd: number | null
}

/** token usage reported at the end of a run */
export interface RunUsage {
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_creation_tokens: number
  cost_usd: number
}

/** per-task usage rollup for the Automations view (7-day and 30-day windows) */
export interface AgentTaskUsage {
  task_id: string
  task_name: string
  model: string | null
  runs_7d: number
  tokens_7d: number
  cost_7d: number
  runs_30d: number
  tokens_30d: number
  cost_30d: number
}

/** structured draft produced by NL parsing, prefills the create form */
export interface AgentTaskDraft {
  name: string
  prompt: string
  schedule: AgentSchedule
  scheduled_time: string | null
  scheduled_day: number | null
  scheduled_date: string | null
}

// ---------- calendar ----------

export type CalendarAccountStatus = 'connected' | 'needs_auth' | 'error' | 'disabled'
export type CalendarEventStatus = 'confirmed' | 'tentative' | 'cancelled'
export type CalendarSyncStatus = 'synced' | 'pending_create' | 'pending_update' | 'pending_delete'

export interface CalendarAccount {
  id: string
  provider: 'gcal'
  external_id: string // google account email
  display_name: string
  status: CalendarAccountStatus
  error: string | null
  last_sync_at: string | null
  created_at: string
  updated_at: string
}

/** A calendar events belong to. account_id NULL = the seeded 'local' pseudo-calendar. */
export interface CalendarCalendar {
  id: string
  account_id: string | null
  google_calendar_id: string | null
  summary: string
  /** hex from Google's calendarList (calendar-level default color) */
  color: string | null
  is_primary: number // sqlite bool
  is_writable: number // sqlite bool
  is_visible: number // sqlite bool
  sync_token: string | null
  created_at: string
  updated_at: string
}

export interface CalendarAttendee {
  email: string
  displayName?: string
  responseStatus?: 'needsAction' | 'declined' | 'tentative' | 'accepted'
  organizer?: boolean
  self?: boolean
}

/**
 * Timed events: start_at/end_at are UTC ISO datetimes; `timezone` (IANA) is
 * captured at create and used only when pushing to Google. All-day events:
 * all_day=1 and start_at/end_at hold YYYY-MM-DD with an EXCLUSIVE end,
 * matching Google's start.date/end.date. `attendees` is stored as JSON; the
 * repo parses at the boundary. `recurring_event_id` non-null marks a
 * Google-expanded recurring instance — read-only in Kairos v1.
 */
export interface CalendarEventRecord {
  id: string
  calendar_id: string
  google_event_id: string | null
  etag: string | null
  recurring_event_id: string | null
  title: string
  description: string | null
  location: string | null
  start_at: string
  end_at: string
  all_day: number // sqlite bool
  timezone: string | null
  /** Google colorId '1'..'11'; null = calendar default */
  color: string | null
  attendees: CalendarAttendee[]
  conferencing_url: string | null
  status: CalendarEventStatus
  sync_status: CalendarSyncStatus
  created_at: string
  updated_at: string
}

export interface NewCalendarEvent {
  calendar_id?: string // default 'local'
  title: string
  description?: string | null
  location?: string | null
  start_at: string
  end_at: string
  all_day?: boolean
  timezone?: string | null
  color?: string | null
  attendees?: CalendarAttendee[]
  conferencing_url?: string | null
}

export interface CalendarEventPatch {
  calendar_id?: string
  title?: string
  description?: string | null
  location?: string | null
  start_at?: string
  end_at?: string
  all_day?: boolean
  timezone?: string | null
  color?: string | null
  attendees?: CalendarAttendee[]
  conferencing_url?: string | null
  status?: CalendarEventStatus
}

export type MeetingStatus = 'recording' | 'processing' | 'ready' | 'error'

export interface MeetingActionItem {
  text: string
  person_id?: string | null
  task_id?: string | null // set once fanned out into a task
}

/** parsed form of meetings.summary_json */
export interface MeetingSummaryData {
  action_items: MeetingActionItem[]
  decisions: string[]
  participants: string[]
}

export interface Meeting {
  id: string
  calendar_event_id: string | null
  title: string
  status: MeetingStatus
  error: string | null
  started_at: string
  ended_at: string | null
  duration_seconds: number | null
  mic_path: string | null // ~/Kairos/recordings/<id>/mic.webm
  system_path: string | null
  audio_deleted_at: string | null // transcript survives audio deletion
  summary_md: string | null
  summary: MeetingSummaryData
  summary_model: string | null
  summarized_at: string | null
  created_at: string
  updated_at: string
}

export interface TranscriptSegment {
  t0: number // seconds from meeting start
  t1: number
  channel: 'me' | 'them' // mic vs system audio — never mixed
  text: string
}

export interface MeetingTranscript {
  meeting_id: string
  segments: TranscriptSegment[]
  text: string // merged plain text for search/export
  language: string | null
  model: string | null
  transcribed_at: string | null
  created_at: string
}

export interface NewMeeting {
  calendar_event_id?: string | null
  title?: string
  started_at?: string
}

export interface MeetingPatch {
  calendar_event_id?: string | null
  title?: string
  status?: MeetingStatus
  error?: string | null
  ended_at?: string | null
  duration_seconds?: number | null
  mic_path?: string | null
  system_path?: string | null
  summary_md?: string | null
  summary?: MeetingSummaryData
  summary_model?: string | null
  summarized_at?: string | null
}

export interface MeetingFilter {
  status?: MeetingStatus | MeetingStatus[]
  calendar_event_id?: string
  limit?: number
}

export interface NewTranscript {
  segments: TranscriptSegment[]
  text?: string // derived from segments when omitted
  language?: string | null
  model?: string | null
  transcribed_at?: string | null
}

export interface ChatSession {
  id: string
  sdk_session_id: string | null
  title: string
  created_at: string
  updated_at: string
}

export type ChatMessageRole = 'user' | 'assistant' | 'error'

/** one persisted turn of a chat/automation transcript, replayed on reopen */
export interface ChatMessage {
  id: string
  session_id: string
  seq: number
  role: ChatMessageRole
  text: string
  /** JSON string[] — tool names invoked during this assistant turn */
  tools: string
  created_at: string
}

// ---------- computed shapes ----------

export interface FollowupDue {
  id: string // person id
  name: string
  area: Area
  cadence_days: number
  snoozed_until: string | null
  last_interaction_at: string | null
  days_since: number
  days_overdue: number
}

export interface ObjectiveWithKRs extends Objective {
  key_results: KeyResult[]
  /** 0..1 average of KR completion ratios */
  progress: number
}

// ---------- input shapes ----------

export interface PeopleFilter {
  area?: Area
  search?: string
  includeArchived?: boolean
  /** true = only archived people (the Archived section) */
  archived?: boolean
}

export interface PersonUpsert {
  id?: string
  name: string
  nickname?: string | null
  email?: string | null
  phone?: string | null
  company?: string | null
  role?: string | null
  area?: Area
  cadence_days?: number | null
  notes?: string
}

export interface NewInteraction {
  person_id: string
  kind?: InteractionKind
  summary: string
  occurred_at?: string
}

export type TaskSort = 'manual' | 'due' | 'priority'

export interface TaskFilter {
  status?: TaskStatus | TaskStatus[]
  area?: Area
  project_id?: string
  person_id?: string
  due_before?: string // YYYY-MM-DD inclusive
  search?: string
  sort?: TaskSort
}

export interface NewTask {
  /** action item extracted from a recorded meeting */
  meeting_id?: string | null
  title: string
  notes?: string
  status?: TaskStatus
  area?: Area
  priority?: number
  project_id?: string | null
  person_id?: string | null
  due_date?: string | null
}

export interface TaskPatch {
  title?: string
  notes?: string
  status?: TaskStatus
  area?: Area
  priority?: number
  project_id?: string | null
  person_id?: string | null
  due_date?: string | null
}

export interface NoteFilter {
  archived?: boolean
  /** single #tag, e.g. '#home' */
  label?: string
  search?: string
}

export interface NewNote {
  title?: string
  content?: string
  items?: NoteItem[]
  note_type?: NoteType
  color?: string | null
  labels?: string
  pinned?: boolean
  remind_at?: string | null
  repeat?: NoteRepeat
  source?: 'user' | 'agent'
}

export interface NotePatch {
  title?: string
  content?: string
  items?: NoteItem[]
  note_type?: NoteType
  color?: string | null
  labels?: string
  pinned?: boolean
  archived?: boolean
  remind_at?: string | null
  repeat?: NoteRepeat
  agent_session_id?: string | null
}

export interface NewAgentTask {
  name: string
  prompt: string
  schedule?: AgentSchedule
  scheduled_time?: string | null
  scheduled_day?: number | null
  scheduled_date?: string | null
  trigger_type?: AgentTriggerType
  trigger_event?: AppEventName | null
  trigger_count?: number
  model?: string | null
  max_turns?: number | null
  notify?: boolean
}

export interface AgentTaskPatch {
  name?: string
  prompt?: string
  schedule?: AgentSchedule
  scheduled_time?: string | null
  scheduled_day?: number | null
  scheduled_date?: string | null
  trigger_type?: AgentTriggerType
  trigger_event?: AppEventName | null
  trigger_count?: number
  model?: string | null
  max_turns?: number | null
  notify?: boolean
  then_task_id?: string | null
}

export interface NewProject {
  name: string
  area?: Area
  description?: string
}

export interface NewObjective {
  title: string
  description?: string
  area?: Area
  period: string
  key_results?: { title: string; unit?: string; start_value?: number; target_value?: number }[]
}

export interface ObjectivePatch {
  title?: string
  description?: string
  area?: Area
  period?: string
  status?: ObjectiveStatus
}

export interface KrPatch {
  title?: string
  unit?: string
  start_value?: number
  target_value?: number
  current_value?: number
}

export interface PersonDetail {
  person: Person
  interactions: Interaction[]
  open_tasks: Task[]
}

export interface TodayPayload {
  overdue_tasks: Task[]
  due_today_tasks: Task[]
  followups: FollowupDue[]
  objectives: ObjectiveWithKRs[]
}

// ---------- pending inbox ----------

export type PendingKind =
  | 'task'
  | 'followup'
  | 'reminder'
  | 'thread'
  | 'outbox'
  | 'meeting'
  | 'agent_run'
  | 'invite'

/**
 * One entry in the Pending inbox. Computed live from its source domain —
 * never stored. `key` is the stable identity the pending_overlay table keys
 * snooze/dismiss/seen state on; `fingerprint` changes when the underlying
 * condition renews (new due date, new inbound message), which is what lets a
 * dismissal expire instead of hiding the item forever.
 */
export interface PendingItem {
  key: string // `${kind}:${id}`
  kind: PendingKind
  /** id of the source object (task id, person id, note id, thread id …) */
  id: string
  title: string
  subtitle: string
  tone: 'accent' | 'danger' | 'muted'
  /** the timestamp that makes it pending (due date, remind_at, last message) */
  at: string | null
  fingerprint: string
}

export interface PendingPayload {
  items: PendingItem[]
  /** unread threads beyond the display cap — the "N more in Inbox" tail row */
  more_threads: number
  /** full actionable count including capped threads */
  total: number
  /** items not yet seen at their current fingerprint — the sidebar badge;
   *  a renewed condition (new message, re-missed due date) counts as unseen
   *  again even if the item was seen before */
  unseen: number
}

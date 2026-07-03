// Domain row types + input shapes. Shared by the Electron app, the MCP
// server, and the in-app agent tools. Pure types, no runtime imports.

export type Area = 'personal' | 'work'

/** entities announced in change notifications (IPC db:changed) */
export type DbEntity = 'tasks' | 'people' | 'interactions' | 'objectives' | 'projects' | 'comms' | 'all'

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
  due_date: string | null // YYYY-MM-DD
  completed_at: string | null
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

export interface ChatSession {
  id: string
  sdk_session_id: string | null
  title: string
  created_at: string
  updated_at: string
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

export interface TaskFilter {
  status?: TaskStatus | TaskStatus[]
  area?: Area
  project_id?: string
  person_id?: string
  due_before?: string // YYYY-MM-DD inclusive
  search?: string
}

export interface NewTask {
  title: string
  notes?: string
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

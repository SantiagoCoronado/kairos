import { z } from 'zod'
import { join } from 'node:path'
import type { DbDriver } from './driver'
import type { DbEntity, Area, InteractionKind, TaskStatus, Person } from './types'
import * as people from './repo/people'
import * as interactions from './repo/interactions'
import * as followups from './repo/followups'
import * as tasks from './repo/tasks'
import * as projects from './repo/projects'
import * as objectives from './repo/objectives'
import { todayAgenda } from './repo/today'
import { exportMarkdown } from './export/markdown'
import { readMemory, saveMemory } from './memory'
import * as comms from './repo/comms'
import type { CommsProvider } from './comms-types'

// Shared tool definitions for BOTH Claude surfaces:
//  - the standalone stdio MCP server (terminal Claude Code)
//  - the in-app Agent SDK MCP server (chat panel)
// One list, so the two can never drift.

export interface ToolCtx {
  dataDir: string
  onMutate: (entity: DbEntity) => void
}

export interface ToolDef {
  name: string
  description: string
  // zod raw shape; both the MCP SDK and the Agent SDK take this directly
  schema: z.ZodRawShape
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (args: any) => unknown
}

const area = z.enum(['personal', 'work'])
const taskStatus = z.enum(['todo', 'in_progress', 'done', 'cancelled'])
const interactionKind = z.enum(['call', 'message', 'email', 'meeting', 'coffee', 'other'])
const commsProvider = z.enum(['gmail', 'slack', 'whatsapp'])

/** keep tool output lean: drop raw_json and cap the body */
function trimMessage<T extends { raw_json?: string | null; body_text: string }>(m: T): Omit<T, 'raw_json'> {
  const { raw_json: _raw, ...rest } = m
  return { ...rest, body_text: m.body_text.slice(0, 2000) }
}

function mustResolvePerson(db: DbDriver, ref: string): Person {
  const p = people.resolvePersonRef(db, ref)
  if (!p) throw new Error(`No person found matching "${ref}". Use people_search or person_upsert first.`)
  return p
}

export function buildToolDefs(db: DbDriver, ctx: ToolCtx): ToolDef[] {
  return [
    {
      name: 'people_search',
      description:
        'Search people by name/nickname/company/email substring. Returns basic person records.',
      schema: {
        query: z.string().optional().describe('substring to match; omit to list everyone'),
        area: area.optional()
      },
      handler: (a: { query?: string; area?: Area }) =>
        people.listPeople(db, { search: a.query, area: a.area })
    },
    {
      name: 'person_get',
      description:
        'Full detail for one person: record, recent interactions, open tasks. Accepts id or name.',
      schema: { person: z.string().describe('person id or (partial) name') },
      handler: (a: { person: string }) => {
        const p = mustResolvePerson(db, a.person)
        return people.getPersonDetail(db, p.id)
      }
    },
    {
      name: 'person_upsert',
      description:
        'Create or update a person. Matches by id if given, else by exact name (case-insensitive). Only provided fields change.',
      schema: {
        id: z.string().optional(),
        name: z.string(),
        nickname: z.string().nullable().optional(),
        email: z.string().nullable().optional(),
        phone: z.string().nullable().optional(),
        company: z.string().nullable().optional(),
        role: z.string().nullable().optional(),
        area: area.optional(),
        cadence_days: z
          .number()
          .int()
          .positive()
          .nullable()
          .optional()
          .describe('follow-up cadence in days; null clears it'),
        notes: z.string().optional()
      },
      handler: (a: Parameters<typeof people.upsertPerson>[1]) => {
        const p = people.upsertPerson(db, a)
        ctx.onMutate('people')
        return p
      }
    },
    {
      name: 'interaction_log',
      description:
        'Log an interaction with a person (resets their follow-up clock and clears any snooze).',
      schema: {
        person: z.string().describe('person id or name'),
        summary: z.string(),
        kind: interactionKind.optional(),
        occurred_at: z.string().optional().describe('ISO datetime; defaults to now')
      },
      handler: (a: {
        person: string
        summary: string
        kind?: InteractionKind
        occurred_at?: string
      }) => {
        const p = mustResolvePerson(db, a.person)
        const i = interactions.logInteraction(db, {
          person_id: p.id,
          summary: a.summary,
          kind: a.kind,
          occurred_at: a.occurred_at
        })
        ctx.onMutate('interactions')
        ctx.onMutate('people')
        return { person: p.name, interaction: i }
      }
    },
    {
      name: 'followups_due',
      description:
        'People whose follow-up cadence is due or overdue, sorted by most overdue first.',
      schema: {},
      handler: () => followups.followupsDue(db)
    },
    {
      name: 'followup_snooze',
      description: "Snooze a person's follow-up until a date (YYYY-MM-DD).",
      schema: {
        person: z.string().describe('person id or name'),
        until_date: z.string().describe('YYYY-MM-DD')
      },
      handler: (a: { person: string; until_date: string }) => {
        const p = mustResolvePerson(db, a.person)
        people.snoozeFollowup(db, p.id, a.until_date)
        ctx.onMutate('people')
        return { snoozed: p.name, until: a.until_date }
      }
    },
    {
      name: 'tasks_list',
      description: 'List tasks with optional filters.',
      schema: {
        status: taskStatus.optional().describe('omit for all statuses'),
        area: area.optional(),
        project: z.string().optional().describe('project id or name'),
        person: z.string().optional().describe('person id or name'),
        due_before: z.string().optional().describe('YYYY-MM-DD inclusive'),
        search: z.string().optional()
      },
      handler: (a: {
        status?: TaskStatus
        area?: Area
        project?: string
        person?: string
        due_before?: string
        search?: string
      }) => {
        const project = a.project
          ? projects.listProjects(db).find(
              (p) => p.id === a.project || p.name.toLowerCase() === a.project!.toLowerCase()
            )
          : undefined
        const person = a.person ? mustResolvePerson(db, a.person) : undefined
        return tasks.listTasks(db, {
          status: a.status,
          area: a.area,
          project_id: project?.id,
          person_id: person?.id,
          due_before: a.due_before,
          search: a.search
        })
      }
    },
    {
      name: 'task_create',
      description: 'Create a task.',
      schema: {
        title: z.string(),
        notes: z.string().optional(),
        area: area.optional().describe('defaults to personal'),
        priority: z.number().int().min(1).max(4).optional().describe('1=urgent … 4=someday'),
        due_date: z.string().optional().describe('YYYY-MM-DD'),
        project: z.string().optional().describe('project id or name (must exist)'),
        person: z.string().optional().describe('optional person this task relates to')
      },
      handler: (a: {
        title: string
        notes?: string
        area?: Area
        priority?: number
        due_date?: string
        project?: string
        person?: string
      }) => {
        const project = a.project
          ? projects.listProjects(db).find(
              (p) => p.id === a.project || p.name.toLowerCase() === a.project!.toLowerCase()
            )
          : undefined
        if (a.project && !project) throw new Error(`No project matching "${a.project}"`)
        const person = a.person ? mustResolvePerson(db, a.person) : undefined
        const t = tasks.createTask(db, {
          title: a.title,
          notes: a.notes,
          area: a.area,
          priority: a.priority,
          due_date: a.due_date ?? null,
          project_id: project?.id ?? null,
          person_id: person?.id ?? null
        })
        ctx.onMutate('tasks')
        return t
      }
    },
    {
      name: 'task_update',
      description: 'Patch a task by id (title, status, priority, due_date, notes, area).',
      schema: {
        id: z.string(),
        title: z.string().optional(),
        notes: z.string().optional(),
        status: taskStatus.optional(),
        area: area.optional(),
        priority: z.number().int().min(1).max(4).optional(),
        due_date: z.string().nullable().optional()
      },
      handler: ({ id, ...patch }: { id: string } & Parameters<typeof tasks.updateTask>[2]) => {
        const t = tasks.updateTask(db, id, patch)
        ctx.onMutate('tasks')
        return t
      }
    },
    {
      name: 'task_complete',
      description: 'Mark a task done by id.',
      schema: { id: z.string() },
      handler: (a: { id: string }) => {
        const t = tasks.completeTask(db, a.id)
        ctx.onMutate('tasks')
        return t
      }
    },
    {
      name: 'projects_list',
      description: 'List projects.',
      schema: { area: area.optional() },
      handler: (a: { area?: Area }) => projects.listProjects(db, { area: a.area })
    },
    {
      name: 'project_create',
      description: 'Create a project.',
      schema: {
        name: z.string(),
        area: area.optional(),
        description: z.string().optional()
      },
      handler: (a: { name: string; area?: Area; description?: string }) => {
        const p = projects.createProject(db, a)
        ctx.onMutate('projects')
        return p
      }
    },
    {
      name: 'objectives_review',
      description:
        'Objectives with key results, progress fraction, and tasks linked to each KR. Filter by period like 2026-Q3.',
      schema: {
        period: z.string().optional(),
        area: area.optional()
      },
      handler: (a: { period?: string; area?: Area }) =>
        objectives.listObjectives(db, { period: a.period, area: a.area }).map((o) => ({
          ...o,
          key_results: o.key_results.map((kr) => ({
            ...kr,
            linked_tasks: objectives.tasksForKr(db, kr.id)
          }))
        }))
    },
    {
      name: 'objective_create',
      description: 'Create an objective with optional initial key results.',
      schema: {
        title: z.string(),
        period: z.string().describe('e.g. 2026-Q3'),
        area: area.optional(),
        description: z.string().optional(),
        key_results: z
          .array(
            z.object({
              title: z.string(),
              unit: z.string().optional(),
              start_value: z.number().optional(),
              target_value: z.number().optional()
            })
          )
          .optional()
      },
      handler: (a: Parameters<typeof objectives.createObjective>[1]) => {
        const o = objectives.createObjective(db, a)
        ctx.onMutate('objectives')
        return o
      }
    },
    {
      name: 'kr_update_progress',
      description: "Set a key result's current value.",
      schema: { id: z.string(), value: z.number() },
      handler: (a: { id: string; value: number }) => {
        const kr = objectives.updateKrProgress(db, a.id, a.value)
        ctx.onMutate('objectives')
        return kr
      }
    },
    {
      name: 'kr_link_task',
      description: 'Link an existing task to a key result.',
      schema: { kr_id: z.string(), task_id: z.string() },
      handler: (a: { kr_id: string; task_id: string }) => {
        objectives.linkTaskToKr(db, a.task_id, a.kr_id)
        ctx.onMutate('objectives')
        return { linked: true }
      }
    },
    {
      name: 'today_agenda',
      description:
        'The Today dashboard payload: overdue tasks, tasks due today, follow-ups due, active objectives with progress.',
      schema: {},
      handler: () => todayAgenda(db)
    },
    {
      name: 'export_markdown',
      description: 'Regenerate the one-way Markdown export of all data.',
      schema: {},
      handler: () => {
        const dir = join(ctx.dataDir, 'export')
        return { ...exportMarkdown(db, dir), dir }
      }
    },
    {
      name: 'memory_read',
      description:
        'Read your persistent memory file (durable facts and preferences noted in past conversations).',
      schema: {},
      handler: () => ({ content: readMemory(ctx.dataDir) })
    },
    {
      name: 'memory_save',
      description:
        'Save a durable fact/preference to persistent memory so future conversations know it. Use append for new facts; replace only to rewrite the whole file (e.g. pruning stale entries).',
      schema: {
        content: z.string().describe('markdown to remember; keep it short and factual'),
        mode: z.enum(['append', 'replace']).optional().describe('default append')
      },
      handler: (a: { content: string; mode?: 'append' | 'replace' }) =>
        saveMemory(ctx.dataDir, a.content, a.mode ?? 'append')
    },
    {
      name: 'comms_accounts_list',
      description:
        'List connected communication accounts (gmail/slack/whatsapp) with their sync status. Message sync only runs while the Kairos app is open.',
      schema: {},
      handler: () =>
        comms.listAccounts(db).map(({ id, provider, display_name, status, error, last_sync_at }) => ({
          id,
          provider,
          display_name,
          status,
          error,
          last_sync_at
        }))
    },
    {
      name: 'comms_search',
      description:
        'Search synced messages (email/slack/whatsapp) by text. Returns messages with their thread id, thread title, and account. Use comms_thread_get to read the surrounding conversation.',
      schema: {
        query: z.string().describe('substring to match in body, sender name, or thread title'),
        provider: commsProvider.optional(),
        person: z.string().optional().describe('person id or name — only their messages'),
        limit: z.number().int().min(1).max(100).optional().describe('default 20')
      },
      handler: (a: { query: string; provider?: CommsProvider; person?: string; limit?: number }) => {
        const person = a.person ? mustResolvePerson(db, a.person) : undefined
        return comms
          .searchMessages(db, a.query, { provider: a.provider, personId: person?.id, limit: a.limit })
          .map(trimMessage)
      }
    },
    {
      name: 'comms_thread_get',
      description: 'One conversation (email thread / slack channel / whatsapp chat) with its recent messages, oldest first.',
      schema: {
        thread_id: z.string(),
        limit: z.number().int().min(1).max(200).optional().describe('default 50 most recent')
      },
      handler: (a: { thread_id: string; limit?: number }) => {
        const thread = comms.getThread(db, a.thread_id)
        if (!thread) throw new Error(`No thread with id "${a.thread_id}". Use comms_search first.`)
        return {
          thread: {
            id: thread.id,
            provider: thread.provider,
            kind: thread.kind,
            title: thread.title,
            account_id: thread.account_id
          },
          messages: comms.listMessages(db, thread.id, a.limit ?? 50).map(trimMessage)
        }
      }
    },
    {
      name: 'comms_send',
      description:
        'Send a message as the user. IMPORTANT: show the user the exact draft and recipient and get their approval BEFORE calling this; then pass confirm_send: true. account_id must come from comms_accounts_list. Reply into a conversation with thread_id, or send a new email with to + subject. The message is queued and delivers within seconds while the Kairos app is running (otherwise on next app launch).',
      schema: {
        account_id: z.string(),
        thread_id: z.string().optional().describe('reply into this conversation'),
        to: z.array(z.string()).optional().describe('new email only: recipient addresses'),
        subject: z.string().optional().describe('new email only'),
        body: z.string(),
        confirm_send: z.literal(true).describe('must be true — confirms the user approved this exact draft')
      },
      handler: (a: {
        account_id: string
        thread_id?: string
        to?: string[]
        subject?: string
        body: string
        confirm_send: true
      }) => {
        const account = comms.getAccount(db, a.account_id)
        if (!account) throw new Error(`No account "${a.account_id}". Use comms_accounts_list.`)
        if (a.thread_id) {
          const thread = comms.getThread(db, a.thread_id)
          if (!thread) throw new Error(`No thread "${a.thread_id}".`)
          if (thread.account_id !== account.id) throw new Error('thread belongs to a different account')
        } else if (account.provider === 'gmail') {
          if (!a.to?.length || !a.subject) throw new Error('a new email needs `to` and `subject`')
        } else {
          throw new Error(`${account.provider} sends need a thread_id`)
        }
        const item = comms.enqueueOutbox(db, {
          account_id: account.id,
          thread_id: a.thread_id ?? null,
          provider: account.provider,
          to_json: JSON.stringify(account.provider === 'gmail' ? { to: a.to, subject: a.subject } : {}),
          body_text: a.body,
          source: 'agent'
        })
        ctx.onMutate('comms')
        return {
          queued: true,
          outbox_id: item.id,
          note: 'delivers within seconds while the Kairos app is running; otherwise on next app launch'
        }
      }
    }
  ]
}

import { query, type Query } from '@anthropic-ai/claude-agent-sdk'
import { Notification, app } from 'electron'
import type { DbDriver } from '../../core/driver'
import type { AgentTask, AgentTaskDraft, DbEntity } from '../../core/types'
import * as agentTasks from '../../core/repo/agent-tasks'
import { newId, nowIso } from '../../core/ids'
import { DATA_DIR } from '../db'
import { getSettings } from '../settings'
import { logLine } from '../logger'
import { createMainWindow } from '../windows/main-window'
import { buildKairosSdkServer, buildChildEnv, resolveClaudeBinary, DISALLOWED_TOOLS } from './agent'

const TASK_SYSTEM_PROMPT = `You are running as a scheduled background task inside Kairos, Santiago's personal local CRM + task manager + objective tracker.

You were NOT invoked interactively — nobody is watching, and nobody can answer questions. Rules:
- Use your tools over the real data; never guess.
- Do the work the task prompt describes, then produce a single concise final summary of what you found or changed.
- Never ask questions or wait for confirmation. If something is ambiguous, take the safest reasonable interpretation and note the assumption in your summary.
- Never send messages (comms_send) unless the task prompt explicitly says to.`

/**
 * Executes scheduled agent tasks, one at a time (FIFO). Each run gets its own
 * chat session row so the user can open the transcript in Chat and continue
 * the conversation from where the task left off.
 */
export class AgentTaskRunner {
  private queue: string[] = []
  private inFlight = new Set<string>()
  private runningTaskId: string | null = null
  private activeQuery: Query | null = null
  private stopped = new Set<string>()
  private server: ReturnType<typeof buildKairosSdkServer>

  constructor(
    private db: DbDriver,
    private onMutate: (entity: DbEntity) => void,
    /** deep-link a notification click into the renderer (nav:goto) */
    private onNavigate: (view: 'automations', id?: string) => void
  ) {
    this.server = buildKairosSdkServer(db, onMutate)
  }

  /** queue a task for execution; no-op when it is already queued or running */
  enqueue(taskId: string): void {
    if (this.inFlight.has(taskId)) return
    this.inFlight.add(taskId)
    this.queue.push(taskId)
    void this.drain()
  }

  isRunning(taskId: string): boolean {
    return this.runningTaskId === taskId
  }

  /** interrupt the task if running; drop it if still queued */
  stop(taskId: string): void {
    if (this.runningTaskId === taskId && this.activeQuery) {
      this.stopped.add(taskId)
      void this.activeQuery.interrupt()
      return
    }
    const at = this.queue.indexOf(taskId)
    if (at >= 0) {
      this.queue.splice(at, 1)
      this.inFlight.delete(taskId)
    }
  }

  private async drain(): Promise<void> {
    if (this.runningTaskId !== null) return // a run is already active; it re-drains on finish
    const taskId = this.queue.shift()
    if (!taskId) return
    this.runningTaskId = taskId
    try {
      await this.run(taskId)
    } finally {
      this.runningTaskId = null
      this.inFlight.delete(taskId)
      this.stopped.delete(taskId)
      void this.drain()
    }
  }

  private async run(taskId: string): Promise<void> {
    const task = agentTasks.getAgentTask(this.db, taskId)
    if (!task || task.status === 'paused') return

    // consume this occurrence up front so a slow run can't double-fire
    agentTasks.claimForRun(this.db, task.id)

    const settings = getSettings()
    const model = task.model ?? settings.chatModel
    const run = agentTasks.createRun(this.db, task.id, model)
    this.onMutate('agent_tasks')

    if (!resolveClaudeBinary()) {
      agentTasks.finishRun(this.db, run.id, {
        status: 'error',
        error: 'Claude Code binary not found — set its path in Settings'
      })
      this.onMutate('agent_tasks')
      this.notifyFinished(task, false, 'Claude Code binary not found')
      return
    }

    // per-run chat session: the run's transcript, resumable from the Chat view
    const sessionId = newId()
    const ts = nowIso()
    this.db.run(
      'INSERT INTO chat_sessions (id, sdk_session_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      sessionId,
      null,
      `⚙ ${task.name} — ${new Date().toLocaleDateString([], { month: 'short', day: 'numeric' })}`,
      ts,
      ts
    )
    agentTasks.setRunSession(this.db, run.id, sessionId)

    logLine('info', 'task-runner', `run start: ${task.name} (${task.id})`)
    let resultText = ''
    let failed: string | null = null
    try {
      const q = query({
        prompt: task.prompt,
        options: {
          mcpServers: { kairos: this.server.server },
          allowedTools: this.server.allowedTools,
          disallowedTools: DISALLOWED_TOOLS,
          permissionMode: 'default',
          settingSources: [],
          strictMcpConfig: true,
          systemPrompt: TASK_SYSTEM_PROMPT,
          model: model ?? undefined,
          effort: settings.chatEffort ?? undefined,
          maxTurns: task.max_turns ?? 30,
          cwd: DATA_DIR,
          env: buildChildEnv() as Record<string, string>,
          pathToClaudeCodeExecutable: resolveClaudeBinary()
        }
      })
      this.activeQuery = q

      for await (const msg of q) {
        if (msg.type === 'system' && msg.subtype === 'init') {
          this.db.run(
            'UPDATE chat_sessions SET sdk_session_id = ?, updated_at = ? WHERE id = ?',
            msg.session_id,
            nowIso(),
            sessionId
          )
        } else if (msg.type === 'assistant') {
          for (const block of msg.message.content) {
            if (block.type === 'text') {
              resultText = block.text // keep the LAST assistant text = final summary
            } else if (block.type === 'tool_use') {
              agentTasks.appendRunStep(this.db, run.id, block.name.replace('mcp__kairos__', ''))
              this.onMutate('agent_tasks')
            }
          }
        } else if (msg.type === 'result' && msg.subtype !== 'success') {
          failed = `run ended: ${msg.subtype}`
        }
      }
    } catch (err) {
      failed = err instanceof Error ? err.message : String(err)
    } finally {
      this.activeQuery = null
    }

    const wasStopped = this.stopped.has(task.id)
    const status = wasStopped ? 'stopped' : failed ? 'error' : 'success'
    agentTasks.finishRun(this.db, run.id, {
      status,
      result: resultText || null,
      error: failed
    })
    this.onMutate('agent_tasks')
    logLine(
      failed ? 'error' : 'info',
      'task-runner',
      `run ${status}: ${task.name}${failed ? ` — ${failed}` : ''}`
    )

    if (task.notify === 1 && !wasStopped) {
      this.notifyFinished(task, !failed, failed ?? resultText)
    }

    // chaining: a successful run kicks off the linked task (cycle-checked at save time)
    if (!failed && !wasStopped && task.then_task_id) {
      const chained = agentTasks.getAgentTask(this.db, task.then_task_id)
      if (chained && chained.status !== 'paused') this.enqueue(chained.id)
    }
  }

  private notifyFinished(task: AgentTask, ok: boolean, detail: string): void {
    if (!Notification.isSupported()) return
    const n = new Notification({
      title: `${ok ? '✓' : '✗'} ${task.name}`,
      body: detail.trim().slice(0, 300) || (ok ? 'finished' : 'failed')
    })
    n.on('click', () => {
      const win = createMainWindow()
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
      app.focus({ steal: true })
      this.onNavigate('automations', task.id)
    })
    n.show()
  }
}

/**
 * Natural-language → structured task draft, for user review before saving.
 * One-shot model call, no tools — the port of Odysseus's POST /api/tasks/parse.
 */
export async function parseTaskDraft(
  text: string
): Promise<{ ok: true; draft: AgentTaskDraft } | { ok: false; message: string }> {
  if (!resolveClaudeBinary()) {
    return { ok: false, message: 'Claude Code binary not found — set its path in Settings' }
  }
  const now = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  const localNow = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`
  const weekday = now.toLocaleDateString('en-US', { weekday: 'long' })

  const prompt = `Convert this description of a scheduled task into JSON. Current local datetime: ${localNow} (${weekday}).

Description: ${JSON.stringify(text)}

Output ONLY a JSON object, no prose, with exactly these fields:
- "name": short task name (3-6 words)
- "prompt": the instruction the agent will execute each run, written as a direct imperative
- "schedule": one of "once" | "daily" | "weekly" | "monthly"
- "scheduled_time": "HH:MM" 24h local time, or null (only for daily/weekly/monthly)
- "scheduled_day": weekly: weekday number 0=Sunday..6=Saturday; monthly: day of month 1..31; else null
- "scheduled_date": once only: full local ISO datetime like "2026-07-03T09:00"; else null

If the description gives no time, default to "09:00". "Every weekday" is not supported — use daily.`

  const settings = getSettings()
  try {
    const q = query({
      prompt,
      options: {
        permissionMode: 'default',
        settingSources: [],
        strictMcpConfig: true,
        systemPrompt: 'You convert task descriptions to JSON. You output only valid JSON.',
        model: settings.chatModel ?? undefined,
        maxTurns: 1,
        cwd: DATA_DIR,
        env: buildChildEnv() as Record<string, string>,
        pathToClaudeCodeExecutable: resolveClaudeBinary()
      }
    })
    let out = ''
    for await (const msg of q) {
      if (msg.type === 'assistant') {
        for (const block of msg.message.content) {
          if (block.type === 'text') out += block.text
        }
      }
    }
    const jsonMatch = out.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return { ok: false, message: 'could not parse the model output' }
    const raw = JSON.parse(jsonMatch[0]) as Partial<AgentTaskDraft>
    if (!raw.prompt || !raw.schedule) return { ok: false, message: 'draft missing prompt/schedule' }
    return {
      ok: true,
      draft: {
        name: raw.name || text.slice(0, 40),
        prompt: raw.prompt,
        schedule: (['once', 'daily', 'weekly', 'monthly'] as const).includes(
          raw.schedule as 'once'
        )
          ? raw.schedule
          : 'once',
        scheduled_time: raw.scheduled_time ?? null,
        scheduled_day: raw.scheduled_day ?? null,
        scheduled_date: raw.scheduled_date ?? null
      }
    }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}

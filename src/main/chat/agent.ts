import { query, createSdkMcpServer, tool, type Query } from '@anthropic-ai/claude-agent-sdk'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { DbDriver } from '../../core/driver'
import { buildToolDefs } from '../../core/tooldefs'
import { readMemory } from '../../core/memory'
import { newId, nowIso } from '../../core/ids'
import type {
  ChatStreamEvent,
  ChatSessionInfo,
  ChatHistoryMessage,
  ChatDraftInput,
  ChatDraftResult
} from '../../shared/ipc-contract'
import * as comms from '../../core/repo/comms'
import { appendChatMessage, listChatMessages } from '../../core/repo/chat'
import { CHAT_UPLOADS_DIR } from './uploads'
import { getRunBySession, getAgentTask } from '../../core/repo/agent-tasks'
import { DATA_DIR } from '../db'
import { getSettings } from '../settings'
import { emitAppEvent } from '../events'
import { buildChildEnv } from '../child-env'

export { buildChildEnv }

// The chat panel is an optional layer: the app never depends on it.
// Auth rides the user's Claude Code subscription (`claude login`); an
// exported ANTHROPIC_API_KEY would silently switch billing to the API
// account, so it is stripped from the child env.

const SYSTEM_PROMPT = `You are the assistant inside Kairos, Santiago's personal local CRM + task manager + objective tracker (macOS app, local SQLite).

You have tools over his real data: people (with follow-up cadences and interaction logs), tasks/projects, and quarterly objectives with key results. Areas partition everything into 'personal' and 'work'.

Rules:
- Use the tools rather than guessing; check today_agenda or followups_due before making claims about what is due.
- Log interactions and create tasks when asked, then confirm briefly what changed.
- Be concise. This is a dense desktop panel, not a chat website. No filler, no headers unless listing many items.
- When asked to plan (a week, a day), read open tasks, due follow-ups, and objectives first, then propose concrete, small actions.
- You have a persistent memory file (memory_read / memory_save). When Santiago shares something durable — a preference, recurring context, how he likes things done — save it with memory_save (mode append). Keep entries short and factual; rewrite the whole file with mode replace only to prune stale entries. Its current content is included below; you do not need memory_read unless you suspect it changed mid-conversation.`

// Memory is re-read every turn so edits (by the user, the MCP twin, or a
// previous turn) are always reflected.
function buildSystemPrompt(): string {
  const memory = readMemory(DATA_DIR).trim()
  return `${SYSTEM_PROMPT}\n\n## Persistent memory\n${memory || '(empty — nothing saved yet)'}`
}

/** tools column is a JSON string[]; tolerate corruption/legacy shapes */
function safeParseTools(json: string): string[] {
  try {
    const v = JSON.parse(json)
    return Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string') : []
  } catch {
    return []
  }
}

/** run.steps is a JSON [{tool, at}]; pull just the tool names for a transcript */
function parseStepTools(json: string): string[] {
  try {
    const v = JSON.parse(json)
    return Array.isArray(v)
      ? v.map((s) => (s && typeof s.tool === 'string' ? s.tool : null)).filter((t): t is string => !!t)
      : []
  } catch {
    return []
  }
}

type SessionRow = {
  id: string
  sdk_session_id: string | null
  title: string
  created_at: string
  updated_at: string
}

/** The kairos tool server + allowlist, shared by the chat panel and the
 *  scheduled-task runner so both expose the exact same tool surface. */
export function buildKairosSdkServer(
  db: DbDriver,
  onMutate: (entity: import('../../core/types').DbEntity) => void
): { server: ReturnType<typeof createSdkMcpServer>; allowedTools: string[] } {
  // agent-made writes fire automation event triggers just like user actions
  const defs = buildToolDefs(db, { dataDir: DATA_DIR, onMutate, onEvent: emitAppEvent })
  const server = createSdkMcpServer({
    name: 'kairos',
    version: '0.1.0',
    tools: defs.map((d) =>
      tool(d.name, d.description, d.schema, async (args) => {
        try {
          const result = d.handler(args)
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result ?? null, null, 2) }]
          }
        } catch (err) {
          return {
            isError: true,
            content: [
              { type: 'text' as const, text: err instanceof Error ? err.message : String(err) }
            ]
          }
        }
      })
    )
  })
  return { server, allowedTools: defs.map((d) => `mcp__kairos__${d.name}`) }
}

/** built-in tools the agent must never reach from inside the app */
export const DISALLOWED_TOOLS = [
  'Bash',
  'Write',
  'Edit',
  'Read',
  'Glob',
  'Grep',
  'Task',
  'WebSearch',
  'WebFetch',
  'NotebookEdit'
]

// The chat panel alone gets Read back, scoped to staged attachments: without
// a permission prompt handler, any Read outside this pattern is denied.
const CHAT_DISALLOWED = DISALLOWED_TOOLS.filter((t) => t !== 'Read')
const CHAT_READ_SCOPE = `Read(${CHAT_UPLOADS_DIR}/**)`

export class ChatManager {
  private db: DbDriver
  private emit: (event: ChatStreamEvent) => void
  private active = new Map<string, Query>()
  private server: ReturnType<typeof createSdkMcpServer>
  private allowedTools: string[]

  constructor(
    db: DbDriver,
    emit: (event: ChatStreamEvent) => void,
    onMutate: (entity: import('../../core/types').DbEntity) => void
  ) {
    this.db = db
    this.emit = emit

    const { server, allowedTools } = buildKairosSdkServer(db, onMutate)
    this.server = server
    this.allowedTools = allowedTools
  }

  listSessions(): ChatSessionInfo[] {
    return this.db.all<SessionRow>(
      'SELECT * FROM chat_sessions ORDER BY updated_at DESC LIMIT 20'
    )
  }

  /**
   * Replay a session's transcript for the Chat view. Prefers persisted
   * messages; for sessions from before transcripts were stored (or any
   * automation run), reconstructs a minimal transcript from the run row so
   * the session still opens with its prompt, tools, and result.
   */
  getHistory(sessionId: string): ChatHistoryMessage[] {
    const stored = listChatMessages(this.db, sessionId)
    if (stored.length > 0) {
      return stored.map((m) => ({
        role: m.role,
        text: m.text,
        tools: safeParseTools(m.tools)
      }))
    }

    // fallback: rebuild from the owning automation run, if any
    const run = getRunBySession(this.db, sessionId)
    if (!run) return []
    const task = getAgentTask(this.db, run.task_id)
    const out: ChatHistoryMessage[] = []
    if (task?.prompt) out.push({ role: 'user', text: task.prompt, tools: [] })
    const tools = parseStepTools(run.steps)
    if (run.result) out.push({ role: 'assistant', text: run.result, tools })
    else if (tools.length > 0) out.push({ role: 'assistant', text: '', tools })
    if (run.error) out.push({ role: 'error', text: run.error, tools: [] })
    return out
  }

  send(localSessionId: string | null, text: string): { localSessionId: string } {
    const session = this.ensureSession(localSessionId, text)
    void this.runTurn(session, text)
    return { localSessionId: session.id }
  }

  interrupt(localSessionId: string): void {
    void this.active.get(localSessionId)?.interrupt()
  }

  private ensureSession(id: string | null, firstText: string): SessionRow {
    if (id) {
      const row = this.db.get<SessionRow>('SELECT * FROM chat_sessions WHERE id = ?', id)
      if (row) return row
    }
    const ts = nowIso()
    const row: SessionRow = {
      id: newId(),
      sdk_session_id: null,
      title: firstText.slice(0, 60),
      created_at: ts,
      updated_at: ts
    }
    this.db.run(
      'INSERT INTO chat_sessions (id, sdk_session_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      row.id,
      row.sdk_session_id,
      row.title,
      row.created_at,
      row.updated_at
    )
    return row
  }

  /**
   * One-shot reply draft for a comms thread. No session, no tools, maxTurns 1
   * — a single model call. Only ever invoked from the composer's Draft button.
   */
  async draftReply({ threadId, instruction }: ChatDraftInput): Promise<ChatDraftResult> {
    const thread = comms.getThread(this.db, threadId)
    if (!thread) return { ok: false, message: 'unknown thread' }
    const account = comms.getAccount(this.db, thread.account_id)
    if (!account) return { ok: false, message: 'unknown account' }
    if (!resolveClaudeBinary()) {
      return { ok: false, message: 'Claude Code binary not found — set its path in Settings' }
    }

    const messages = comms.listMessages(this.db, threadId).slice(-12)
    if (messages.length === 0) return { ok: false, message: 'nothing to reply to yet' }
    const lastInbound = [...messages].reverse().find((m) => !m.is_me)
    const person = lastInbound?.person_id
      ? this.db.get<{ name: string }>('SELECT name FROM people WHERE id = ?', lastInbound.person_id)
      : undefined

    const transcript = messages
      .map((m) => {
        const who = m.is_me ? 'me' : m.sender_name || m.sender_handle || 'them'
        const body = m.body_text.length > 1500 ? `${m.body_text.slice(0, 1500)}…` : m.body_text
        return `[${who}] (${m.sent_at}): ${body}`
      })
      .join('\n\n')

    const prompt = [
      `Conversation on ${thread.provider} — "${thread.title}":`,
      transcript,
      person ? `The other participant is ${person.name} (a saved contact).` : '',
      `Write only the reply body, as ${account.display_name}. Match the thread's language, tone and register. No subject line, no quoted history, no signature unless the thread uses one, no preamble or explanation — output the reply text and nothing else.`,
      instruction ? `Instruction from the user: ${instruction}` : ''
    ]
      .filter(Boolean)
      .join('\n\n')

    const settings = getSettings()
    try {
      const q = query({
        prompt,
        options: {
          permissionMode: 'default',
          settingSources: [],
          strictMcpConfig: true,
          systemPrompt:
            'You draft replies inside Kairos, a personal messaging app. You return only the message body the user will send — no commentary.',
          model: settings.chatModel ?? undefined,
          effort: settings.chatEffort ?? undefined,
          maxTurns: 1,
          cwd: DATA_DIR,
          env: buildChildEnv() as Record<string, string>,
          pathToClaudeCodeExecutable: resolveClaudeBinary()
        }
      })
      let draft = ''
      let failed: string | null = null
      for await (const msg of q) {
        if (msg.type === 'assistant') {
          for (const block of msg.message.content) {
            if (block.type === 'text') draft += block.text
          }
        } else if (msg.type === 'result' && msg.subtype !== 'success') {
          failed = `draft ended: ${msg.subtype}`
        }
      }
      if (failed) return { ok: false, message: failed }
      if (!draft.trim()) return { ok: false, message: 'the model returned an empty draft' }
      return { ok: true, draft: draft.trim() }
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err)
      const hint = /login|auth|credential|api key|401|403/i.test(raw)
        ? ' — run `claude login` in a terminal, and make sure ANTHROPIC_API_KEY is not exported.'
        : ''
      return { ok: false, message: raw + hint }
    }
  }

  private async runTurn(session: SessionRow, text: string): Promise<void> {
    const sid = session.id
    const settings = getSettings()
    const env = buildChildEnv()

    // persist the user turn so the session can be replayed after reopen
    appendChatMessage(this.db, sid, 'user', text)

    try {
      const q = query({
        prompt: text,
        options: {
          mcpServers: { kairos: this.server },
          allowedTools: [...this.allowedTools, CHAT_READ_SCOPE],
          disallowedTools: CHAT_DISALLOWED,
          permissionMode: 'default',
          // isolate from the user's global Claude config: without these the
          // CLI also loads user-scope MCP servers (including the standalone
          // kairos server) and the model calls the wrong twin
          settingSources: [],
          strictMcpConfig: true,
          systemPrompt: buildSystemPrompt(),
          model: settings.chatModel ?? undefined,
          effort: settings.chatEffort ?? undefined,
          includePartialMessages: true,
          maxTurns: 30,
          cwd: DATA_DIR,
          env: env as Record<string, string>,
          resume: session.sdk_session_id ?? undefined,
          pathToClaudeCodeExecutable: resolveClaudeBinary()
        }
      })
      this.active.set(sid, q)

      for await (const msg of q) {
        if (msg.type === 'system' && msg.subtype === 'init') {
          this.db.run(
            'UPDATE chat_sessions SET sdk_session_id = ?, updated_at = ? WHERE id = ?',
            msg.session_id,
            nowIso(),
            sid
          )
          session.sdk_session_id = msg.session_id
        } else if (msg.type === 'stream_event') {
          const ev = msg.event as {
            type: string
            delta?: { type: string; text?: string }
            content_block?: { type: string; name?: string }
          }
          if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
            this.emit({ localSessionId: sid, kind: 'delta', text: ev.delta.text })
          } else if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use') {
            this.emit({
              localSessionId: sid,
              kind: 'tool',
              name: (ev.content_block.name ?? 'tool').replace('mcp__kairos__', '')
            })
          }
        } else if (msg.type === 'assistant') {
          // the full turn arrives here (text + tool_use blocks); persist it so
          // it can be replayed, then seal the live bubble
          let turnText = ''
          const turnTools: string[] = []
          for (const block of msg.message.content) {
            if (block.type === 'text') turnText += block.text
            else if (block.type === 'tool_use') turnTools.push(block.name.replace('mcp__kairos__', ''))
          }
          if (turnText || turnTools.length > 0) {
            appendChatMessage(this.db, sid, 'assistant', turnText, turnTools)
          }
          this.emit({ localSessionId: sid, kind: 'assistant_done' })
        } else if (msg.type === 'result') {
          if (msg.subtype !== 'success') {
            const message = `run ended: ${msg.subtype}`
            appendChatMessage(this.db, sid, 'error', message)
            this.emit({ localSessionId: sid, kind: 'error', message })
          }
        }
      }
      this.emit({ localSessionId: sid, kind: 'done' })
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err)
      const hint = /login|auth|credential|api key|401|403/i.test(raw)
        ? ' — run `claude login` in a terminal, and make sure ANTHROPIC_API_KEY is not exported.'
        : ''
      appendChatMessage(this.db, sid, 'error', raw + hint)
      this.emit({ localSessionId: sid, kind: 'error', message: raw + hint })
    } finally {
      this.active.delete(sid)
      this.db.run('UPDATE chat_sessions SET updated_at = ? WHERE id = ?', nowIso(), sid)
    }
  }
}


export function resolveClaudeBinary(): string | undefined {
  const candidates = [
    getSettings().claudePath,
    process.env['CLAUDE_CODE_PATH'],
    join(homedir(), '.local/bin/claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude'
  ]
  return candidates.find((p): p is string => Boolean(p && existsSync(p)))
}

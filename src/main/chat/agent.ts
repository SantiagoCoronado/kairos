import { query, createSdkMcpServer, tool, type Query } from '@anthropic-ai/claude-agent-sdk'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { DbDriver } from '../../core/driver'
import { buildToolDefs } from '../../core/tooldefs'
import { readMemory } from '../../core/memory'
import { newId, nowIso } from '../../core/ids'
import type { ChatStreamEvent, ChatSessionInfo } from '../../shared/ipc-contract'
import { DATA_DIR } from '../db'
import { getSettings } from '../settings'

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

type SessionRow = {
  id: string
  sdk_session_id: string | null
  title: string
  created_at: string
  updated_at: string
}

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

    const defs = buildToolDefs(db, { dataDir: DATA_DIR, onMutate })
    this.server = createSdkMcpServer({
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
    this.allowedTools = defs.map((d) => `mcp__kairos__${d.name}`)
  }

  listSessions(): ChatSessionInfo[] {
    return this.db.all<SessionRow>(
      'SELECT * FROM chat_sessions ORDER BY updated_at DESC LIMIT 20'
    )
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

  private async runTurn(session: SessionRow, text: string): Promise<void> {
    const sid = session.id
    const settings = getSettings()
    const env: Record<string, string | undefined> = { ...process.env }
    // subscription auth, never API-key billing
    delete env['ANTHROPIC_API_KEY']
    // GUI apps launched from Finder don't inherit the shell PATH
    env['PATH'] = [env['PATH'], '/opt/homebrew/bin', '/usr/local/bin', join(homedir(), '.local/bin')]
      .filter(Boolean)
      .join(':')

    try {
      const q = query({
        prompt: text,
        options: {
          mcpServers: { kairos: this.server },
          allowedTools: this.allowedTools,
          disallowedTools: [
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
          ],
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
          this.emit({ localSessionId: sid, kind: 'assistant_done' })
        } else if (msg.type === 'result') {
          if (msg.subtype !== 'success') {
            this.emit({
              localSessionId: sid,
              kind: 'error',
              message: `run ended: ${msg.subtype}`
            })
          }
        }
      }
      this.emit({ localSessionId: sid, kind: 'done' })
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err)
      const hint = /login|auth|credential|api key|401|403/i.test(raw)
        ? ' — run `claude login` in a terminal, and make sure ANTHROPIC_API_KEY is not exported.'
        : ''
      this.emit({ localSessionId: sid, kind: 'error', message: raw + hint })
    } finally {
      this.active.delete(sid)
      this.db.run('UPDATE chat_sessions SET updated_at = ? WHERE id = ?', nowIso(), sid)
    }
  }
}

function resolveClaudeBinary(): string | undefined {
  const candidates = [
    getSettings().claudePath,
    process.env['CLAUDE_CODE_PATH'],
    join(homedir(), '.local/bin/claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude'
  ]
  return candidates.find((p): p is string => Boolean(p && existsSync(p)))
}

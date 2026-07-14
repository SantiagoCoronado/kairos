import { query } from '@anthropic-ai/claude-agent-sdk'
import type { DbDriver } from '../../core/driver'
import {
  applySmartIntent,
  fixSpokenDates,
  type SmartCaptureOutcome,
  type SmartIntent
} from '../../core/smart-capture'
import { executeCapture } from '../../core/capture'
import { DATA_DIR } from '../db'
import { logLine } from '../logger'
import { buildChildEnv, resolveClaudeBinary } from './agent'

const KINDS = ['task', 'note', 'event', 'interaction'] as const

/**
 * Spoken capture: one-shot haiku call routes the transcript to a task, note,
 * calendar event, or interaction; the terse-syntax parser is the fallback
 * when the model is unavailable, so plain "buy milk tomorrow" always works.
 */
export async function smartCapture(db: DbDriver, raw: string): Promise<SmartCaptureOutcome> {
  const intent = await parseIntent(raw)
  if (intent) return applySmartIntent(db, fixSpokenDates(raw, intent, new Date()))
  return terseFallback(db, raw)
}

async function parseIntent(raw: string): Promise<SmartIntent | null> {
  if (!resolveClaudeBinary()) return null
  const now = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  const localNow = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`
  const weekday = now.toLocaleDateString('en-US', { weekday: 'long' })
  // spell out the next week so the model never does weekday arithmetic
  const week = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(now)
    d.setDate(d.getDate() + i + 1)
    const name = d.toLocaleDateString('en-US', { weekday: 'long' })
    return `${name}=${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  }).join(', ')

  const prompt = `Route this spoken capture into JSON. Current local datetime: ${localNow} (${weekday}).
Upcoming dates: ${week}.

Transcript: ${JSON.stringify(raw)}

Output ONLY a JSON object with these fields (null when unused):
- "kind": "task" | "note" | "event" | "interaction"
- "title": short cleaned-up title — task/note/event
- "due_date": "YYYY-MM-DD" — task deadline when one is spoken
- "priority": 1 (urgent) .. 4 (someday) — tasks, only when urgency is clearly spoken
- "area": "work" | "personal" — only when clearly stated
- "content": note body — notes only, when the dictation is more than a title
- "start_at": "YYYY-MM-DDTHH:MM" local — events only ("YYYY-MM-DD" if all-day)
- "end_at": "YYYY-MM-DDTHH:MM" — events, when an end/duration is spoken
- "all_day": true — events with a date but no time
- "location": string — events, when a place is spoken
- "person": the person's name — interactions only
- "summary": what happened — interactions only

Routing rules:
- A meeting/appointment/call/reminder at a specific date or time -> "event".
- "note", "write down", "remember", ideas, lists -> "note".
- Already-happened contact with a person (talked to, met, called) -> "interaction".
- Everything else -> "task". A deadline ("by Friday") keeps it a task with due_date.
- When a weekday is spoken, COPY its date from the "Upcoming dates" list verbatim — never compute it yourself.`

  try {
    const q = query({
      prompt,
      options: {
        permissionMode: 'default',
        settingSources: [],
        strictMcpConfig: true,
        systemPrompt: 'You route spoken captures to JSON. You output only valid JSON.',
        model: 'haiku',
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
    if (!jsonMatch) return null
    const parsed = JSON.parse(jsonMatch[0]) as SmartIntent
    if (!KINDS.includes(parsed.kind)) return null
    return parsed
  } catch (err) {
    logLine('warn', 'capture', `smart parse failed, using terse fallback: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

function terseFallback(db: DbDriver, raw: string): SmartCaptureOutcome {
  const result = executeCapture(db, raw)
  if (!result.ok) return { ok: false, message: result.message }
  if (result.kind === 'task')
    return {
      ok: true,
      message: `Task: ${result.task.title}${result.task.due_date ? ` (due ${result.task.due_date})` : ''}`,
      entity: 'tasks',
      appEvent: 'task_created'
    }
  if (result.kind === 'note')
    return { ok: true, message: `Note: ${result.note.title}`, entity: 'notes', appEvent: 'note_created' }
  return {
    ok: true,
    message: `Logged for ${result.person.name}`,
    entity: 'interactions',
    appEvent: 'interaction_logged'
  }
}

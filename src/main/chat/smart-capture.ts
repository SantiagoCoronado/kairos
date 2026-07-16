import { query } from '@anthropic-ai/claude-agent-sdk'
import type { DbDriver } from '../../core/driver'
import type { CaptureContext } from '../../shared/ipc-contract'
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

/** kinds a caller may force — the Tasks/Notes mic buttons always create their
 *  own kind instead of letting the model route */
export type ForcedKind = 'task' | 'note'

/**
 * Spoken capture: one-shot haiku call routes the transcript to a task, note,
 * calendar event, or interaction; the terse-syntax parser is the fallback
 * when the model is unavailable, so plain "buy milk tomorrow" always works.
 * With `kind` the routing is skipped: the model only extracts that kind's
 * fields, and the result is guaranteed to be that kind.
 */
export async function smartCapture(
  db: DbDriver,
  raw: string,
  kind?: ForcedKind
): Promise<SmartCaptureOutcome> {
  const intent = await parseIntent(raw, kind)
  if (intent) return applySmartIntent(db, fixSpokenDates(raw, intent, new Date()))
  return terseFallback(db, raw, kind)
}

/** current datetime + the next week spelled out, so the model never does
 *  weekday arithmetic */
function dateContext(): { localNow: string; weekday: string; week: string } {
  const now = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  const localNow = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`
  const weekday = now.toLocaleDateString('en-US', { weekday: 'long' })
  const week = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(now)
    d.setDate(d.getDate() + i + 1)
    const name = d.toLocaleDateString('en-US', { weekday: 'long' })
    return `${name}=${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  }).join(', ')
  return { localNow, weekday, week }
}

const ALL_FIELDS = `- "kind": "task" | "note" | "event" | "interaction"
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
- "summary": what happened — interactions only`

/** one-shot, tool-less haiku call → parsed JSON object, null when anything
 *  is off (no binary, no JSON, bad kind) so callers can fall back */
async function runHaikuJson(prompt: string): Promise<SmartIntent | null> {
  const bin = resolveClaudeBinary()
  if (!bin) return null
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
      pathToClaudeCodeExecutable: bin
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
  return JSON.parse(jsonMatch[0]) as SmartIntent
}

async function parseIntent(raw: string, kind?: ForcedKind): Promise<SmartIntent | null> {
  if (!resolveClaudeBinary()) return null
  const { localNow, weekday, week } = dateContext()

  const fields =
    kind === 'task'
      ? `- "kind": always "task"
- "title": short cleaned-up task title
- "due_date": "YYYY-MM-DD" — deadline when one is spoken
- "priority": 1 (urgent) .. 4 (someday) — only when urgency is clearly spoken
- "area": "work" | "personal" — only when clearly stated`
      : kind === 'note'
        ? `- "kind": always "note"
- "title": short cleaned-up title
- "content": note body, when the dictation is more than a title`
        : ALL_FIELDS

  const rules = kind
    ? `Rules:
- This capture is ALWAYS a ${kind} — never any other kind.
- When a weekday is spoken, COPY its date from the "Upcoming dates" list verbatim — never compute it yourself.`
    : `Routing rules:
- A meeting/appointment/call/reminder at a specific date or time -> "event".
- "note", "write down", "remember", ideas, lists -> "note".
- Already-happened contact with a person (talked to, met, called) -> "interaction".
- Everything else -> "task". A deadline ("by Friday") keeps it a task with due_date.
- When a weekday is spoken, COPY its date from the "Upcoming dates" list verbatim — never compute it yourself.`

  const prompt = `${kind ? `Extract a ${kind} from this spoken capture as JSON.` : 'Route this spoken capture into JSON.'} Current local datetime: ${localNow} (${weekday}).
Upcoming dates: ${week}.

Transcript: ${JSON.stringify(raw)}

Output ONLY a JSON object with these fields (null when unused):
${fields}

${rules}`

  try {
    const parsed = await runHaikuJson(prompt)
    if (!parsed) return null
    // a forced kind always wins, whatever the model answered
    if (kind) return { ...parsed, kind }
    if (!KINDS.includes(parsed.kind)) return null
    return parsed
  } catch (err) {
    logLine('warn', 'capture', `smart parse failed, using terse fallback: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

/** the model only needs enough of the source to title/date the result */
const CONTEXT_TEXT_CAP = 1500

const CONTEXT_KIND_LABEL: Record<CaptureContext['kind'], string> = {
  comms_thread: 'message thread',
  note: 'note',
  chat_message: 'assistant chat reply',
  calendar_event: 'calendar event'
}

/**
 * ⌘K voice command: execute a spoken instruction, optionally against the
 * entity the user was looking at ("make this email a task I need to do
 * tomorrow"). Same one-shot haiku + applySmartIntent pipeline as smartCapture;
 * without the model the instruction degrades to a plain terse capture.
 */
export async function smartCaptureInstruct(
  db: DbDriver,
  instruction: string,
  context?: CaptureContext
): Promise<SmartCaptureOutcome> {
  const intent = await parseInstruct(instruction, context)
  if (intent) return applySmartIntent(db, fixSpokenDates(instruction, intent, new Date()))
  return terseFallback(db, instruction)
}

async function parseInstruct(
  instruction: string,
  context?: CaptureContext
): Promise<SmartIntent | null> {
  if (!resolveClaudeBinary()) return null
  const { localNow, weekday, week } = dateContext()

  const contextBlock = context
    ? `\nThe user was looking at this ${CONTEXT_KIND_LABEL[context.kind]} while speaking (${JSON.stringify(context.label)}):
"""
${context.text.slice(0, CONTEXT_TEXT_CAP)}
"""
`
    : ''

  const prompt = `Execute this spoken command by producing a JSON action. Current local datetime: ${localNow} (${weekday}).
Upcoming dates: ${week}.

Spoken command: ${JSON.stringify(instruction)}
${contextBlock}
Output ONLY a JSON object with these fields (null when unused):
${ALL_FIELDS}

Rules:
- The command decides the kind: "make/turn this into a task", "remind me", deadlines -> "task"; "note this down" -> "note"; a meeting/appointment at a date or time -> "event"; already-happened contact with a person -> "interaction". Default to "task".
- Use the attached context ONLY when the command refers to it ("this email", "this message", "this note", "this", "esto", …). Then derive the title/content from the context — e.g. an email from Anna about the quarterly report + "task for tomorrow" -> title "Reply to Anna about the quarterly report", due_date tomorrow. A command that stands on its own ignores the context entirely.
- The title states the action to take, not a copy of the source subject.
- When a weekday is spoken, COPY its date from the "Upcoming dates" list verbatim — never compute it yourself.`

  try {
    const parsed = await runHaikuJson(prompt)
    if (!parsed || !KINDS.includes(parsed.kind)) return null
    return parsed
  } catch (err) {
    logLine('warn', 'capture', `instruct parse failed, using terse fallback: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

function terseFallback(db: DbDriver, raw: string, kind?: ForcedKind): SmartCaptureOutcome {
  // forced kinds must stay forced even without the model: create directly
  // (title/date polish is the model's job; the raw text is still captured)
  if (kind === 'task') return applySmartIntent(db, { kind: 'task', title: raw })
  if (kind === 'note') return applySmartIntent(db, { kind: 'note', content: raw })
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

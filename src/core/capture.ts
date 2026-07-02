import type { DbDriver } from './driver'
import type { Area, Task, Interaction, Person } from './types'
import { listPeople } from './repo/people'
import { logInteraction } from './repo/interactions'
import { createTask } from './repo/tasks'
import { localDate } from './ids'

// Quick-capture syntax:
//   buy milk due:fri !1 @personal          -> task
//   p Anna coffee, talked about the reorg  -> interaction with fuzzy person match
//   p "Anna Martinez" quick call           -> quoted multi-word name
// Modifiers: @work/@personal, !1..!4, due:today|tomorrow|mon..sun|YYYY-MM-DD

export type CaptureIntent =
  | { kind: 'task'; title: string; area?: Area; priority?: number; due_date?: string }
  | { kind: 'interaction'; personQuery: string; summary: string }

export type CaptureResult =
  | { ok: true; kind: 'task'; task: Task }
  | { ok: true; kind: 'interaction'; interaction: Interaction; person: Person }
  | { ok: false; message: string }

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']

export function parseDue(token: string, now: Date = new Date()): string | undefined {
  const t = token.toLowerCase()
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t
  if (t === 'today') return localDate(now)
  if (t === 'tomorrow') {
    const d = new Date(now)
    d.setDate(d.getDate() + 1)
    return localDate(d)
  }
  const idx = WEEKDAYS.findIndex((w) => w.startsWith(t))
  if (idx >= 0 && t.length >= 3) {
    const d = new Date(now)
    const delta = (idx - d.getDay() + 7) % 7 || 7 // next occurrence, never today
    d.setDate(d.getDate() + delta)
    return localDate(d)
  }
  return undefined
}

export function parseCapture(raw: string, now: Date = new Date()): CaptureIntent | null {
  const text = raw.trim()
  if (!text) return null

  // interaction form: p <name> <summary>
  const pMatch = text.match(/^p\s+(?:"([^"]+)"|(\S+))\s+(.+)$/s)
  if (pMatch) {
    return {
      kind: 'interaction',
      personQuery: (pMatch[1] ?? pMatch[2]).trim(),
      summary: pMatch[3].trim()
    }
  }

  let area: Area | undefined
  let priority: number | undefined
  let due: string | undefined
  const words: string[] = []

  for (const token of text.split(/\s+/)) {
    if (token === '@work' || token === '@personal') {
      area = token.slice(1) as Area
    } else if (/^![1-4]$/.test(token)) {
      priority = Number(token.slice(1))
    } else if (token.toLowerCase().startsWith('due:')) {
      const parsed = parseDue(token.slice(4), now)
      if (parsed) due = parsed
      else words.push(token)
    } else {
      words.push(token)
    }
  }

  const title = words.join(' ').trim()
  if (!title) return null
  return { kind: 'task', title, area, priority, due_date: due }
}

export function executeCapture(
  db: DbDriver,
  raw: string,
  now: Date = new Date()
): CaptureResult {
  const intent = parseCapture(raw, now)
  if (!intent) return { ok: false, message: 'Nothing to capture' }

  if (intent.kind === 'task') {
    const task = createTask(
      db,
      {
        title: intent.title,
        area: intent.area,
        priority: intent.priority,
        due_date: intent.due_date ?? null
      },
      now
    )
    return { ok: true, kind: 'task', task }
  }

  // interaction: fuzzy person match — exact name/nickname first, then substring
  const candidates = listPeople(db, { search: intent.personQuery })
  const exact = candidates.find(
    (p) =>
      p.name.toLowerCase() === intent.personQuery.toLowerCase() ||
      p.nickname?.toLowerCase() === intent.personQuery.toLowerCase()
  )
  const person = exact ?? candidates[0]
  if (!person) {
    return { ok: false, message: `No person matching "${intent.personQuery}"` }
  }
  const interaction = logInteraction(
    db,
    { person_id: person.id, summary: intent.summary, kind: 'other' },
    now
  )
  return { ok: true, kind: 'interaction', interaction, person }
}

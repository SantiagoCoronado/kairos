import type { DbDriver } from './driver'
import type { AppEventName, DbEntity } from './types'
import { createTask } from './repo/tasks'
import { createNote } from './repo/notes'
import { createEvent } from './repo/calendar'
import { logInteraction } from './repo/interactions'
import { findPerson, parseDue } from './capture'

/** what the one-shot model call returns for a spoken capture — every field
 *  beyond `kind` is optional/nullable because models leave gaps */
export interface SmartIntent {
  kind: 'task' | 'note' | 'event' | 'interaction'
  title?: string | null
  area?: string | null
  priority?: number | null
  due_date?: string | null
  content?: string | null
  start_at?: string | null
  end_at?: string | null
  all_day?: boolean | null
  location?: string | null
  person?: string | null
  summary?: string | null
}

export interface SmartCaptureOutcome {
  ok: boolean
  message: string
  /** set on success so the IPC layer can broadcast/emit */
  entity?: DbEntity
  appEvent?: AppEventName
}

const DATE_RX = /^\d{4}-\d{2}-\d{2}$/
const DATETIME_RX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/
const SPOKEN_DAY_RX =
  /\b(today|tomorrow|sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/

/** Haiku reliably mis-resolves weekday names to dates (off-by-one) even when
 *  handed a date table — when the transcript names a day, recompute the date
 *  deterministically with parseDue and overrule the model. */
export function fixSpokenDates(raw: string, intent: SmartIntent, now: Date): SmartIntent {
  const m = raw.toLowerCase().match(SPOKEN_DAY_RX)
  if (!m) return intent
  const correct = parseDue(m[1], now)
  if (!correct) return intent
  if (intent.kind === 'task' && intent.due_date && intent.due_date !== correct)
    return { ...intent, due_date: correct }
  if (intent.kind === 'event' && intent.start_at && DATETIME_RX.test(intent.start_at)) {
    const [date, time] = intent.start_at.split('T')
    if (date !== correct) {
      const end =
        intent.end_at && DATETIME_RX.test(intent.end_at)
          ? `${correct}T${intent.end_at.split('T')[1]}`
          : intent.end_at
      return { ...intent, start_at: `${correct}T${time}`, end_at: end }
    }
  }
  if (intent.kind === 'event' && intent.start_at && DATE_RX.test(intent.start_at))
    return intent.start_at !== correct ? { ...intent, start_at: correct, end_at: null } : intent
  return intent
}

/** validate a model intent and write it through the normal repos */
export function applySmartIntent(
  db: DbDriver,
  intent: SmartIntent,
  now: Date = new Date()
): SmartCaptureOutcome {
  switch (intent.kind) {
    case 'task': {
      const title = intent.title?.trim()
      if (!title) return { ok: false, message: 'No task title heard' }
      const task = createTask(
        db,
        {
          title,
          area: intent.area === 'work' || intent.area === 'personal' ? intent.area : undefined,
          priority: clampPriority(intent.priority),
          due_date: intent.due_date && DATE_RX.test(intent.due_date) ? intent.due_date : null
        },
        now
      )
      return {
        ok: true,
        message: `Task: ${task.title}${task.due_date ? ` (due ${task.due_date})` : ''}`,
        entity: 'tasks',
        appEvent: 'task_created'
      }
    }

    case 'note': {
      const title = intent.title?.trim() ?? ''
      const content = intent.content?.trim() ?? ''
      if (!title && !content) return { ok: false, message: 'No note content heard' }
      const note = createNote(
        db,
        { title: title || content.slice(0, 60), content: content || undefined },
        now
      )
      return {
        ok: true,
        message: `Note: ${note.title}`,
        entity: 'notes',
        appEvent: 'note_created'
      }
    }

    case 'event': {
      const title = intent.title?.trim()
      const start = intent.start_at?.trim()
      if (!title || !start || !(DATE_RX.test(start) || DATETIME_RX.test(start)))
        return { ok: false, message: 'Event needs a title and a time' }
      const allDay = intent.all_day === true || DATE_RX.test(start)
      let end =
        intent.end_at && (DATE_RX.test(intent.end_at) || DATETIME_RX.test(intent.end_at))
          ? intent.end_at
          : allDay
            ? plusOneDay(start.slice(0, 10)) // all-day ends are exclusive
            : plusOneHour(start)
      if (end <= start) end = allDay ? plusOneDay(start.slice(0, 10)) : plusOneHour(start)
      const event = createEvent(
        db,
        {
          title,
          start_at: start,
          end_at: end,
          all_day: allDay,
          location: intent.location?.trim() || null
        },
        now
      )
      return {
        ok: true,
        message: `Event: ${event.title} (${spokenEventTime(start, allDay)})`,
        entity: 'calendar_events'
      }
    }

    case 'interaction': {
      const personQuery = intent.person?.trim()
      const summary = intent.summary?.trim()
      if (!personQuery || !summary)
        return { ok: false, message: 'Interaction needs a person and a summary' }
      const person = findPerson(db, personQuery)
      if (!person) return { ok: false, message: `No person matching "${personQuery}"` }
      logInteraction(db, { person_id: person.id, summary, kind: 'other' }, now)
      return {
        ok: true,
        message: `Logged for ${person.name}`,
        entity: 'interactions',
        appEvent: 'interaction_logged'
      }
    }

    default:
      return { ok: false, message: 'Could not understand that' }
  }
}

function clampPriority(p: number | null | undefined): number | undefined {
  if (typeof p !== 'number' || !Number.isFinite(p)) return undefined
  return Math.min(4, Math.max(1, Math.round(p)))
}

/** "2026-07-20" → "2026-07-21" */
function plusOneDay(date: string): string {
  const d = new Date(`${date}T12:00:00`)
  d.setDate(d.getDate() + 1)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** "2026-07-15T15:00" → "2026-07-15T16:00", staying in local wall-clock form */
function plusOneHour(startAt: string): string {
  const d = new Date(startAt)
  d.setHours(d.getHours() + 1)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** "Jul 15, 3 PM" (or "Jul 15" for all-day) for the flash message */
function spokenEventTime(startAt: string, allDay: boolean): string {
  const d = new Date(DATE_RX.test(startAt) ? `${startAt}T12:00:00` : startAt)
  const day = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  if (allDay) return day
  const time = d
    .toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    .replace(':00', '')
  return `${day}, ${time}`
}

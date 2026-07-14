import type { TodayPayload } from './types'

/** structurally matches CalendarEvent from the IPC contract — kept local so
 *  core stays independent of shared/ */
export interface BriefingEvent {
  title: string
  start: string
  allDay: boolean
}

const MAX_EVENTS = 5
const MAX_TASKS = 3

/** Today's agenda as a short spoken-English paragraph for TTS (< ~45s read). */
export function composeBriefing(
  agenda: TodayPayload,
  events: BriefingEvent[],
  now: Date = new Date()
): string {
  const parts: string[] = [`${greeting(now)}. It's ${spokenDate(now)}.`]

  if (events.length > 0) {
    const spoken = events.map((e) =>
      e.allDay ? `${e.title}, all day` : `${e.title} at ${spokenTime(e.start)}`
    )
    parts.push(
      events.length === 1
        ? `One event on the calendar: ${spoken[0]}.`
        : `${events.length} events on the calendar: ${spokenList(spoken, MAX_EVENTS)}.`
    )
  }

  const overdue = agenda.overdue_tasks
  if (overdue.length > 0) {
    const titles = spokenList(overdue.map((t) => t.title), MAX_TASKS)
    parts.push(
      overdue.length === 1
        ? `One task is overdue: ${titles}.`
        : `${overdue.length} tasks are overdue: ${titles}.`
    )
  }

  const due = agenda.due_today_tasks
  if (due.length > 0) {
    const titles = spokenList(due.map((t) => t.title), MAX_TASKS)
    parts.push(
      due.length === 1 ? `Due today: ${titles}.` : `${due.length} tasks due today: ${titles}.`
    )
  }

  const followups = agenda.followups
  if (followups.length > 0) {
    const names = spokenList(followups.map((f) => f.name), MAX_TASKS)
    parts.push(
      followups.length === 1
        ? `A follow-up is due for ${names}.`
        : `Follow-ups are due for ${names}.`
    )
  }

  if (overdue.length === 0 && due.length === 0 && followups.length === 0) {
    parts.push('Nothing is due today. Clear runway.')
  } else {
    parts.push("That's your day.")
  }

  return parts.join(' ')
}

function greeting(now: Date): string {
  const h = now.getHours()
  if (h < 12) return 'Good morning'
  if (h < 18) return 'Good afternoon'
  return 'Good evening'
}

/** "Monday, July 14th" — ordinal day so the voice reads it naturally */
function spokenDate(now: Date): string {
  const weekday = now.toLocaleDateString('en-US', { weekday: 'long' })
  const month = now.toLocaleDateString('en-US', { month: 'long' })
  return `${weekday}, ${month} ${ordinal(now.getDate())}`
}

function ordinal(n: number): string {
  const rem10 = n % 10
  const rem100 = n % 100
  if (rem10 === 1 && rem100 !== 11) return `${n}st`
  if (rem10 === 2 && rem100 !== 12) return `${n}nd`
  if (rem10 === 3 && rem100 !== 13) return `${n}rd`
  return `${n}th`
}

/** "9:30 AM", or "2 PM" when on the hour */
function spokenTime(iso: string): string {
  const d = new Date(iso)
  return d
    .toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    .replace(':00', '')
}

/** "A", "A and B", "A, B, and C" — capped, overflow becomes "and N more" */
function spokenList(items: string[], max: number): string {
  const shown = items.slice(0, max)
  if (items.length > max) shown.push(`${items.length - max} more`)
  if (shown.length === 1) return shown[0]
  if (shown.length === 2) return `${shown[0]} and ${shown[1]}`
  return `${shown.slice(0, -1).join(', ')}, and ${shown[shown.length - 1]}`
}

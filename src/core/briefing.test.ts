import { describe, expect, it } from 'vitest'
import { composeBriefing, type BriefingEvent } from './briefing'
import type { FollowupDue, Task, TodayPayload } from './types'

const MONDAY_9AM = new Date('2026-07-13T09:00:00')
const MONDAY_7PM = new Date('2026-07-13T19:00:00')

function agenda(p: Partial<TodayPayload> = {}): TodayPayload {
  return { overdue_tasks: [], due_today_tasks: [], followups: [], objectives: [], ...p }
}

function task(title: string): Task {
  return { title } as Task
}

function followup(name: string): FollowupDue {
  return { name } as FollowupDue
}

function event(title: string, start: string, allDay = false): BriefingEvent {
  return { title, start, allDay }
}

describe('composeBriefing', () => {
  it('empty day: greets, dates, calls the clear runway, and ends with a stoic teaching', () => {
    const text = composeBriefing(agenda(), [], MONDAY_9AM)
    expect(text).toContain('Good morning')
    expect(text).toContain("It's Monday, July 13th.")
    expect(text).toContain('Nothing is due today. Clear runway.')
    expect(text).toMatch(/(Marcus Aurelius|Seneca|Epictetus) reminds you: /)
    expect(text).not.toContain("That's your day")
  })

  it('evening greeting after 6pm', () => {
    expect(composeBriefing(agenda(), [], MONDAY_7PM)).toContain('Good evening')
  })

  it('busy day covers events, overdue, due today, and follow-ups', () => {
    const text = composeBriefing(
      agenda({
        overdue_tasks: [task('Pay rent'), task('Email accountant')],
        due_today_tasks: [task('Ship phase one')],
        followups: [followup('Alice'), followup('Bob')]
      }),
      [
        event('Standup', '2026-07-13T09:30:00'),
        event('Lunch with Sam', '2026-07-13T13:00:00'),
        event('Conference', '', true)
      ],
      MONDAY_9AM
    )
    expect(text).toContain(
      '3 events on the calendar: Standup at 9:30 AM, Lunch with Sam at 1 PM, and Conference, all day.'
    )
    expect(text).toContain('2 tasks are overdue: Pay rent and Email accountant.')
    expect(text).toContain('Due today: Ship phase one.')
    expect(text).toContain('Follow-ups are due for Alice and Bob.')
    expect(text).toContain("That's your day.")
    expect(text).not.toContain('Nothing is due')
  })

  it('singular phrasing for one of each', () => {
    const text = composeBriefing(
      agenda({
        overdue_tasks: [task('Pay rent')],
        followups: [followup('Alice')]
      }),
      [event('Standup', '2026-07-13T09:30:00')],
      MONDAY_9AM
    )
    expect(text).toContain('One event on the calendar: Standup at 9:30 AM.')
    expect(text).toContain('One task is overdue: Pay rent.')
    expect(text).toContain('A follow-up is due for Alice.')
  })

  it('caps long lists with "N more"', () => {
    const text = composeBriefing(
      agenda({ overdue_tasks: ['A', 'B', 'C', 'D', 'E', 'F'].map(task) }),
      [],
      MONDAY_9AM
    )
    expect(text).toContain('6 tasks are overdue: A, B, C, and 3 more.')
  })

  it('drops :00 from on-the-hour times', () => {
    const text = composeBriefing(agenda(), [event('Lunch', '2026-07-13T13:00:00')], MONDAY_9AM)
    expect(text).toContain('Lunch at 1 PM.')
  })
})

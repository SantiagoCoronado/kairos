import type { CalendarCalendar, CalendarEventRecord } from '../../../../core/types'

/** Google Calendar event palette, keyed by colorId '1'..'11' — storing the id
 *  keeps sync lossless in both directions. Local events use the same ids. */
export const EVENT_COLORS: { id: string; name: string; hex: string }[] = [
  { id: '1', name: 'Lavender', hex: '#7986cb' },
  { id: '2', name: 'Sage', hex: '#33b679' },
  { id: '3', name: 'Grape', hex: '#8e24aa' },
  { id: '4', name: 'Flamingo', hex: '#e67c73' },
  { id: '5', name: 'Banana', hex: '#f6bf26' },
  { id: '6', name: 'Tangerine', hex: '#f4511e' },
  { id: '7', name: 'Peacock', hex: '#039be5' },
  { id: '8', name: 'Graphite', hex: '#616161' },
  { id: '9', name: 'Blueberry', hex: '#3f51b5' },
  { id: '10', name: 'Basil', hex: '#0b8043' },
  { id: '11', name: 'Tomato', hex: '#d50000' }
]

const BY_ID = new Map(EVENT_COLORS.map((c) => [c.id, c.hex]))

export const DEFAULT_EVENT_HEX = '#039be5'

/** event colorId → hex, falling back to the calendar's Google color, then default */
export function eventHex(
  event: Pick<CalendarEventRecord, 'color' | 'calendar_id'>,
  calendars: Map<string, CalendarCalendar>
): string {
  if (event.color) {
    const hex = BY_ID.get(event.color)
    if (hex) return hex
  }
  return calendars.get(event.calendar_id)?.color ?? DEFAULT_EVENT_HEX
}

export function calendarHex(c: CalendarCalendar): string {
  return c.color ?? DEFAULT_EVENT_HEX
}

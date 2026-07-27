// Minimal iCalendar (RFC 5545) VEVENT reader for calendar-invite emails.
// Deliberately small, mirroring markdown-lite: covers what Google/Outlook
// invites actually contain (METHOD, DTSTART/DTEND with TZID/VALUE=DATE/Z,
// SUMMARY, LOCATION, DESCRIPTION, ORGANIZER, ATTENDEE, UID). Pure data out,
// no deps, so it unit-tests in vitest and runs in main or renderer.

import type { CalendarAttendee } from './types'

export interface IcsEvent {
  uid: string | null
  /** VCALENDAR METHOD — REQUEST (invite), CANCEL, REPLY … */
  method: string | null
  summary: string
  description: string | null
  location: string | null
  organizer: CalendarAttendee | null
  attendees: CalendarAttendee[]
  /** UTC ISO, or YYYY-MM-DD when all_day */
  start_at: string | null
  end_at: string | null
  all_day: boolean
  conferencing_url: string | null
}

/** split "NAME;P=1;Q="a:b":value" at the first ':' outside double quotes */
function splitProp(line: string): [string, string] | null {
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') quoted = !quoted
    else if (line[i] === ':' && !quoted) return [line.slice(0, i), line.slice(i + 1)]
  }
  return null
}

/** split on ';' outside double quotes — CN="Rios; Anna" is one param */
function splitParams(head: string): string[] {
  const segs: string[] = []
  let start = 0
  let quoted = false
  for (let i = 0; i < head.length; i++) {
    if (head[i] === '"') quoted = !quoted
    else if (head[i] === ';' && !quoted) {
      segs.push(head.slice(start, i))
      start = i + 1
    }
  }
  segs.push(head.slice(start))
  return segs
}

function parseParams(head: string): { name: string; params: Record<string, string> } {
  const segs = splitParams(head)
  const params: Record<string, string> = {}
  for (const seg of segs.slice(1)) {
    const eq = seg.indexOf('=')
    if (eq < 0) continue
    params[seg.slice(0, eq).toUpperCase()] = seg.slice(eq + 1).replace(/^"|"$/g, '')
  }
  return { name: segs[0].toUpperCase(), params }
}

/** single pass so an escaped backslash never re-parses ('\\n' → '\' + 'n') */
const unescapeText = (v: string): string =>
  v.replace(/\\(n|N|[\\;,])/g, (_, c: string) => (c === 'n' || c === 'N' ? '\n' : c))

/** wall-clock offset of an IANA zone at a given UTC instant */
function tzOffsetMs(tz: string, utcMs: number): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  })
  const p: Record<string, string> = {}
  for (const part of dtf.formatToParts(new Date(utcMs))) p[part.type] = part.value
  const asUtc = Date.UTC(
    Number(p['year']),
    Number(p['month']) - 1,
    Number(p['day']),
    p['hour'] === '24' ? 0 : Number(p['hour']),
    Number(p['minute']),
    Number(p['second'])
  )
  return asUtc - utcMs
}

/** "20260728T133000" in tz → UTC ISO; non-IANA TZIDs fall back to local time */
function zonedToUtcIso(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  s: number,
  tz: string | null
): string {
  if (tz) {
    try {
      const guess = Date.UTC(y, mo - 1, d, h, mi, s)
      const off = tzOffsetMs(tz, guess)
      const off2 = tzOffsetMs(tz, guess - off) // re-check across DST boundaries
      return new Date(guess - off2).toISOString()
    } catch {
      // Outlook-style non-IANA TZID ("Central Standard Time") — treat as local
    }
  }
  return new Date(y, mo - 1, d, h, mi, s).toISOString()
}

/** DTSTART/DTEND value → { iso, allDay } */
function parseDt(value: string, params: Record<string, string>): { iso: string; allDay: boolean } | null {
  const date = /^(\d{4})(\d{2})(\d{2})$/.exec(value)
  if (params['VALUE'] === 'DATE' || date) {
    const m = date ?? /^(\d{4})(\d{2})(\d{2})/.exec(value)
    if (!m) return null
    return { iso: `${m[1]}-${m[2]}-${m[3]}`, allDay: true }
  }
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(value)
  if (!m) return null
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number)
  if (m[7] === 'Z') return { iso: new Date(Date.UTC(y, mo - 1, d, h, mi, s)).toISOString(), allDay: false }
  return { iso: zonedToUtcIso(y, mo, d, h, mi, s, params['TZID'] ?? null), allDay: false }
}

function parsePerson(value: string, params: Record<string, string>): CalendarAttendee | null {
  const email = value.replace(/^mailto:/i, '').trim().toLowerCase()
  if (!email) return null
  const out: CalendarAttendee = { email }
  if (params['CN'] && params['CN'] !== email) out.displayName = params['CN']
  const rsvp = params['PARTSTAT']
  if (rsvp === 'ACCEPTED') out.responseStatus = 'accepted'
  else if (rsvp === 'DECLINED') out.responseStatus = 'declined'
  else if (rsvp === 'TENTATIVE') out.responseStatus = 'tentative'
  else if (rsvp === 'NEEDS-ACTION') out.responseStatus = 'needsAction'
  return out
}

const CONF_URL_RE =
  /https?:\/\/(?:[\w.-]*\.)?(?:meet\.google\.com|zoom\.us|teams\.microsoft\.com|whereby\.com|webex\.com)\/[^\s<>"]*/i

export function parseIcs(text: string): IcsEvent[] {
  // unfold continuation lines (CRLF followed by a space or tab)
  const lines = text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n')
  const events: IcsEvent[] = []
  let method: string | null = null
  let cur: IcsEvent | null = null
  let depth = 0 // skip nested components (VALARM) inside a VEVENT

  for (const line of lines) {
    const prop = splitProp(line)
    if (!prop) continue
    const { name, params } = parseParams(prop[0])
    const value = prop[1].trim()

    if (name === 'BEGIN') {
      if (value.toUpperCase() === 'VEVENT' && !cur) {
        cur = {
          uid: null,
          method,
          summary: '',
          description: null,
          location: null,
          organizer: null,
          attendees: [],
          start_at: null,
          end_at: null,
          all_day: false,
          conferencing_url: null
        }
      } else if (cur) depth++
      continue
    }
    if (name === 'END') {
      if (cur && depth > 0) depth--
      else if (cur && value.toUpperCase() === 'VEVENT') {
        if (cur.start_at && !cur.end_at) {
          // invites without DTEND/DURATION: all-day spans one day, timed one hour
          cur.end_at = cur.all_day
            ? new Date(Date.parse(cur.start_at) + 86_400_000).toISOString().slice(0, 10)
            : new Date(Date.parse(cur.start_at) + 3_600_000).toISOString()
        }
        events.push(cur)
        cur = null
      }
      continue
    }
    if (!cur) {
      if (name === 'METHOD') method = value.toUpperCase()
      continue
    }
    if (depth > 0) continue

    switch (name) {
      case 'UID':
        cur.uid = value
        break
      case 'SUMMARY':
        cur.summary = unescapeText(value)
        break
      case 'DESCRIPTION':
        cur.description = unescapeText(value)
        break
      case 'LOCATION':
        cur.location = unescapeText(value)
        break
      case 'ORGANIZER':
        cur.organizer = parsePerson(value, params)
        if (cur.organizer) cur.organizer.organizer = true
        break
      case 'ATTENDEE': {
        const a = parsePerson(value, params)
        if (a) cur.attendees.push(a)
        break
      }
      case 'DTSTART': {
        const dt = parseDt(value, params)
        if (dt) {
          cur.start_at = dt.iso
          cur.all_day = dt.allDay
        }
        break
      }
      case 'DTEND': {
        const dt = parseDt(value, params)
        if (dt) cur.end_at = dt.iso
        break
      }
      case 'X-GOOGLE-CONFERENCE':
        cur.conferencing_url = value
        break
    }
  }

  // fall back to a meeting URL found in description/location
  for (const ev of events) {
    if (!ev.conferencing_url) {
      const hit =
        CONF_URL_RE.exec(ev.location ?? '')?.[0] ?? CONF_URL_RE.exec(ev.description ?? '')?.[0]
      if (hit) ev.conferencing_url = hit
    }
  }
  return events
}

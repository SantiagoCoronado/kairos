import { describe, it, expect } from 'vitest'
import { parseIcs } from './ics'

const GOOGLE_INVITE = [
  'BEGIN:VCALENDAR',
  'PRODID:-//Google Inc//Google Calendar 70.9054//EN',
  'VERSION:2.0',
  'CALSCALE:GREGORIAN',
  'METHOD:REQUEST',
  'BEGIN:VEVENT',
  'DTSTART:20260728T183000Z',
  'DTEND:20260728T184500Z',
  'DTSTAMP:20260727T154800Z',
  'ORGANIZER;CN=Alexander Mischi:mailto:alexander@stacksync.com',
  'UID:abc123def456@google.com',
  'ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=',
  ' TRUE;CN=s.coronado.sroka@gmail.com;X-NUM-GUESTS=0:mailto:s.coronado.sroka@g',
  ' mail.com',
  'DESCRIPTION:Join: https://meet.google.com/kuu-nvfq-rua\\nBooked by Santiago',
  'LOCATION:',
  'SEQUENCE:0',
  'STATUS:CONFIRMED',
  'SUMMARY:Stacksync - Initial Screen (Santiago Coronado Sroka)',
  'TRANSP:OPAQUE',
  'BEGIN:VALARM',
  'ACTION:DISPLAY',
  'DESCRIPTION:This is an event reminder',
  'TRIGGER:-P0DT0H30M0S',
  'END:VALARM',
  'END:VEVENT',
  'END:VCALENDAR'
].join('\r\n')

describe('parseIcs', () => {
  it('parses a Google Calendar invite', () => {
    const [ev] = parseIcs(GOOGLE_INVITE)
    expect(ev).toMatchObject({
      uid: 'abc123def456@google.com',
      method: 'REQUEST',
      summary: 'Stacksync - Initial Screen (Santiago Coronado Sroka)',
      start_at: '2026-07-28T18:30:00.000Z',
      end_at: '2026-07-28T18:45:00.000Z',
      all_day: false,
      conferencing_url: 'https://meet.google.com/kuu-nvfq-rua'
    })
    expect(ev.organizer).toEqual({
      email: 'alexander@stacksync.com',
      displayName: 'Alexander Mischi',
      organizer: true
    })
    // folded ATTENDEE line reassembles, VALARM's DESCRIPTION does not leak
    expect(ev.attendees).toEqual([
      { email: 's.coronado.sroka@gmail.com', responseStatus: 'needsAction' }
    ])
    expect(ev.description).toContain('Booked by Santiago')
  })

  it('converts TZID datetimes to UTC', () => {
    const [ev] = parseIcs(
      [
        'BEGIN:VCALENDAR',
        'BEGIN:VEVENT',
        'DTSTART;TZID=America/Mexico_City:20260728T133000',
        'DTEND;TZID=America/Mexico_City:20260728T134500',
        'SUMMARY:Tz test',
        'END:VEVENT',
        'END:VCALENDAR'
      ].join('\r\n')
    )
    // Mexico City is UTC-6 (no DST since 2022)
    expect(ev.start_at).toBe('2026-07-28T19:30:00.000Z')
    expect(ev.end_at).toBe('2026-07-28T19:45:00.000Z')
  })

  it('parses all-day events as date-only values', () => {
    const [ev] = parseIcs(
      [
        'BEGIN:VCALENDAR',
        'BEGIN:VEVENT',
        'DTSTART;VALUE=DATE:20260801',
        'DTEND;VALUE=DATE:20260802',
        'SUMMARY:All day',
        'END:VEVENT',
        'END:VCALENDAR'
      ].join('\r\n')
    )
    expect(ev).toMatchObject({ start_at: '2026-08-01', end_at: '2026-08-02', all_day: true })
  })

  it('defaults a missing DTEND to one hour and survives quoted params', () => {
    const [ev] = parseIcs(
      [
        'BEGIN:VCALENDAR',
        'BEGIN:VEVENT',
        'DTSTART:20260728T100000Z',
        'ORGANIZER;CN="Rios, Anna":mailto:anna@example.com',
        'SUMMARY:No end',
        'END:VEVENT',
        'END:VCALENDAR'
      ].join('\r\n')
    )
    expect(ev.end_at).toBe('2026-07-28T11:00:00.000Z')
    expect(ev.organizer?.displayName).toBe('Rios, Anna')
  })

  it('returns an empty list for non-calendar text', () => {
    expect(parseIcs('hello world')).toEqual([])
  })
})

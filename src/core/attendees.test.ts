import { describe, it, expect } from 'vitest'
import type { CalendarAttendee } from './types'
import { applyRsvp, selfAttendee } from './attendees'

const guests = (): CalendarAttendee[] => [
  { email: 'boss@example.com', organizer: true, responseStatus: 'accepted' },
  { email: 'peer@example.com', responseStatus: 'tentative' },
  { email: 'me@gmail.com', self: true, responseStatus: 'needsAction' }
]

describe('selfAttendee', () => {
  it('prefers the self flag, falls back to a case-insensitive email match', () => {
    expect(selfAttendee(guests(), 'me@gmail.com')?.self).toBe(true)
    const noFlag = guests().map(({ self: _self, ...a }) => a)
    expect(selfAttendee(noFlag, 'me@gmail.com')?.email).toBe('me@gmail.com')
    expect(selfAttendee([{ email: 'Me@Gmail.com' }], 'me@gmail.com')?.email).toBe('Me@Gmail.com')
    expect(selfAttendee(noFlag, 'stranger@example.com')).toBeUndefined()
  })
})

describe('applyRsvp', () => {
  it('changes only the self entry and carries everyone else through', () => {
    const next = applyRsvp(guests(), 'me@gmail.com', 'accepted')!
    expect(next.find((a) => a.self)!.responseStatus).toBe('accepted')
    expect(next.find((a) => a.organizer)!.responseStatus).toBe('accepted')
    expect(next.find((a) => a.email === 'peer@example.com')!.responseStatus).toBe('tentative')
  })

  it('round-trips wire fields — including ones beyond the type', () => {
    // the typed extras (resource, optional, comment, additionalGuests) plus a
    // genuinely untyped one: the pass-through contract is "whatever Google
    // sent survives", not "the fields we happened to type survive"
    const wire = [
      { email: 'room-4@resource.calendar.google.com', resource: true, responseStatus: 'accepted' },
      { email: 'peer@example.com', optional: true, comment: 'maybe late' },
      { email: 'me@gmail.com', self: true, responseStatus: 'needsAction', additionalGuests: 2, id: 'att-9' }
    ] as CalendarAttendee[]
    const next = applyRsvp(wire, 'me@gmail.com', 'accepted')!
    expect(next[0]).toBe(wire[0]) // non-self entries pass through by REFERENCE
    expect(next[1]).toBe(wire[1])
    const self = next[2] as CalendarAttendee & { id?: string }
    expect(self.responseStatus).toBe('accepted')
    expect(self.additionalGuests).toBe(2)
    expect(self.id).toBe('att-9') // the spread keeps untyped fields too
  })

  it('falls back to email match and reports strangers', () => {
    const noFlag = guests().map(({ self: _self, ...a }) => a)
    const next = applyRsvp(noFlag, 'me@gmail.com', 'declined')!
    expect(next.find((a) => a.email === 'me@gmail.com')!.responseStatus).toBe('declined')
    expect(applyRsvp(noFlag, 'stranger@example.com', 'declined')).toBeUndefined()
  })
})

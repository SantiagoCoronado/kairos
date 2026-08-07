// Pure attendee-list helpers — the "who is us / answer as us" rules shared by
// invite detection (repo/pending.ts SQL mirrors selfAttendee), the RSVP write
// path (gcal/manager.ts), and the EventEditor's response row. Deliberately
// persistence-free: the renderer imports this without touching the repo layer.
import type { CalendarAttendee, RsvpResponse } from './types'

/** The attendee entry that is us on this copy of the event: Google stamps
 *  `self` on the calendar-owner's entry; the email match is the fallback for
 *  feeds that omit the flag. `accountEmail` must be pre-lowercased — it is
 *  calendar_accounts.external_id, lowercased by contract at connect. */
export function selfAttendee(
  attendees: CalendarAttendee[],
  accountEmail: string
): CalendarAttendee | undefined {
  return attendees.find((a) => a.self || a.email?.toLowerCase() === accountEmail)
}

/**
 * Attendee list with the self entry's responseStatus replaced — the body of an
 * RSVP patch. Google replaces the whole attendees array on patch, so everyone
 * else must be carried through unchanged or their RSVPs reset to needsAction.
 * Returns undefined when no self entry exists (we are not invited).
 *
 * Entries deliberately pass through whole (others by reference, self by
 * spread): attendee objects carry fields beyond the common five — optional,
 * resource, comment, additionalGuests — and rebuilding entries field-by-field
 * would silently strip those flags from every guest on each RSVP. Do not
 * "tidy" this into a reconstruction.
 */
export function applyRsvp(
  attendees: CalendarAttendee[],
  accountEmail: string,
  response: RsvpResponse
): CalendarAttendee[] | undefined {
  const self = selfAttendee(attendees, accountEmail)
  if (!self) return undefined
  return attendees.map((a) => (a === self ? { ...a, responseStatus: response } : a))
}

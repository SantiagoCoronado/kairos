import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { DbDriver } from './driver'
import { openNodeSqliteDb } from './drivers/node-sqlite'
import { migrate } from './migrations'
import * as cal from './repo/calendar'

const T0 = new Date('2026-07-01T12:00:00Z')

let db: DbDriver

beforeEach(() => {
  db = openNodeSqliteDb(':memory:')
  migrate(db)
})

afterEach(() => db.close())

function googleCalendar(): { accountId: string; calendarId: string } {
  const account = cal.upsertCalendarAccount(db, {
    external_id: 'me@gmail.com',
    display_name: 'me@gmail.com'
  })
  const calendar = cal.upsertCalendarFromGoogle(db, account.id, {
    google_calendar_id: 'me@gmail.com',
    summary: 'Personal',
    color: '#9fe1e7',
    is_primary: true,
    is_writable: true
  })
  return { accountId: account.id, calendarId: calendar.id }
}

describe('calendars', () => {
  it('seeds the local pseudo-calendar', () => {
    const local = cal.getCalendar(db, cal.LOCAL_CALENDAR_ID)
    expect(local).toBeDefined()
    expect(local!.account_id).toBeNull()
    expect(local!.is_writable).toBe(1)
  })

  it('upsert from google updates in place on re-sync', () => {
    const { accountId, calendarId } = googleCalendar()
    const again = cal.upsertCalendarFromGoogle(db, accountId, {
      google_calendar_id: 'me@gmail.com',
      summary: 'Renamed',
      color: null,
      is_primary: true,
      is_writable: false
    })
    expect(again.id).toBe(calendarId)
    expect(again.summary).toBe('Renamed')
    expect(again.is_writable).toBe(0)
  })

  it('drops calendars missing from the calendarList (events cascade)', () => {
    const { accountId, calendarId } = googleCalendar()
    cal.createEvent(db, {
      calendar_id: calendarId,
      title: 'x',
      start_at: '2026-07-02T10:00:00Z',
      end_at: '2026-07-02T11:00:00Z'
    })
    const removed = cal.deleteCalendarsNotIn(db, accountId, ['other@group.calendar.google.com'])
    expect(removed).toBe(1)
    expect(cal.getCalendar(db, calendarId)).toBeUndefined()
    expect(cal.listEventsInRange(db, '2026-07-01', '2026-07-08')).toHaveLength(0)
  })

  it('deleting an account cascades calendars and events', () => {
    const { accountId, calendarId } = googleCalendar()
    cal.createEvent(db, {
      calendar_id: calendarId,
      title: 'x',
      start_at: '2026-07-02T10:00:00Z',
      end_at: '2026-07-02T11:00:00Z'
    })
    cal.deleteCalendarAccount(db, accountId)
    expect(cal.getCalendar(db, calendarId)).toBeUndefined()
    expect(cal.listCalendars(db).map((c) => c.id)).toEqual([cal.LOCAL_CALENDAR_ID])
  })
})

describe('event CRUD + dirty flags', () => {
  it('local events are born synced (nothing to push)', () => {
    const e = cal.createEvent(
      db,
      { title: 'Dentist', start_at: '2026-07-02T10:00:00Z', end_at: '2026-07-02T11:00:00Z' },
      T0
    )
    expect(e.calendar_id).toBe('local')
    expect(e.sync_status).toBe('synced')
  })

  it('google-calendar events are born pending_create', () => {
    const { calendarId } = googleCalendar()
    const e = cal.createEvent(db, {
      calendar_id: calendarId,
      title: 'Standup',
      start_at: '2026-07-02T10:00:00Z',
      end_at: '2026-07-02T10:15:00Z'
    })
    expect(e.sync_status).toBe('pending_create')
  })

  it('rejects zero/negative duration', () => {
    expect(() =>
      cal.createEvent(db, { title: 'x', start_at: '2026-07-02T10:00:00Z', end_at: '2026-07-02T10:00:00Z' })
    ).toThrow(/end must be after start/)
  })

  it('update escalates synced → pending_update, leaves pending_create alone', () => {
    const { calendarId } = googleCalendar()
    const e = cal.createEvent(db, {
      calendar_id: calendarId,
      title: 'x',
      start_at: '2026-07-02T10:00:00Z',
      end_at: '2026-07-02T11:00:00Z'
    })
    const stillCreate = cal.updateEvent(db, e.id, { title: 'y' })
    expect(stillCreate.sync_status).toBe('pending_create')

    cal.markEventSynced(db, e.id, { google_event_id: 'g1', etag: 'e1' })
    const dirty = cal.updateEvent(db, e.id, { start_at: '2026-07-02T12:00:00Z', end_at: '2026-07-02T13:00:00Z' })
    expect(dirty.sync_status).toBe('pending_update')
    expect(dirty.start_at).toBe('2026-07-02T12:00:00Z')
  })

  it('local event updates stay synced', () => {
    const e = cal.createEvent(db, { title: 'x', start_at: '2026-07-02T10:00:00Z', end_at: '2026-07-02T11:00:00Z' })
    const u = cal.updateEvent(db, e.id, { color: '5', attendees: [{ email: 'a@b.c' }] })
    expect(u.sync_status).toBe('synced')
    expect(u.color).toBe('5')
    expect(u.attendees).toEqual([{ email: 'a@b.c' }])
  })

  it('delete of a never-pushed event is immediate; pushed events queue pending_delete', () => {
    const { calendarId } = googleCalendar()
    const fresh = cal.createEvent(db, {
      calendar_id: calendarId,
      title: 'fresh',
      start_at: '2026-07-02T10:00:00Z',
      end_at: '2026-07-02T11:00:00Z'
    })
    cal.deleteEvent(db, fresh.id)
    expect(cal.getEvent(db, fresh.id)).toBeUndefined()

    const pushed = cal.createEvent(db, {
      calendar_id: calendarId,
      title: 'pushed',
      start_at: '2026-07-02T10:00:00Z',
      end_at: '2026-07-02T11:00:00Z'
    })
    cal.markEventSynced(db, pushed.id, { google_event_id: 'g2', etag: 'e2' })
    cal.deleteEvent(db, pushed.id)
    expect(cal.getEvent(db, pushed.id)!.sync_status).toBe('pending_delete')
    // queued deletes vanish from range queries immediately
    expect(cal.listEventsInRange(db, '2026-07-01', '2026-07-08').map((e) => e.id)).not.toContain(pushed.id)
  })

  it('moving a synced google event between calendars is blocked; unsynced moves flip the dirty flag', () => {
    const { calendarId } = googleCalendar()
    const localEvent = cal.createEvent(db, {
      title: 'x',
      start_at: '2026-07-02T10:00:00Z',
      end_at: '2026-07-02T11:00:00Z'
    })
    const moved = cal.updateEvent(db, localEvent.id, { calendar_id: calendarId })
    expect(moved.sync_status).toBe('pending_create')

    cal.markEventSynced(db, moved.id, { google_event_id: 'g3', etag: 'e3' })
    expect(() => cal.updateEvent(db, moved.id, { calendar_id: 'local' })).toThrow(/cannot be moved/)
  })
})

describe('recurring instances are read-only', () => {
  it('blocks update and delete', () => {
    const { calendarId } = googleCalendar()
    cal.applyRemoteEvent(db, calendarId, {
      google_event_id: 'rec_20260702',
      etag: 'e1',
      recurring_event_id: 'rec',
      title: 'Weekly standup',
      description: null,
      location: null,
      start_at: '2026-07-02T09:00:00Z',
      end_at: '2026-07-02T09:15:00Z',
      all_day: false,
      timezone: 'America/Mexico_City',
      color: null,
      attendees: [],
      conferencing_url: null,
      status: 'confirmed'
    })
    const [instance] = cal.listEventsInRange(db, '2026-07-01', '2026-07-08')
    expect(instance.recurring_event_id).toBe('rec')
    expect(() => cal.updateEvent(db, instance.id, { title: 'nope' })).toThrow(/read-only/)
    expect(() => cal.deleteEvent(db, instance.id)).toThrow(/read-only/)
  })
})

describe('range queries', () => {
  it('finds overlapping timed events and respects visibility', () => {
    const { calendarId } = googleCalendar()
    cal.createEvent(db, {
      calendar_id: calendarId,
      title: 'in range',
      start_at: '2026-07-02T10:00:00Z',
      end_at: '2026-07-02T11:00:00Z'
    })
    cal.createEvent(db, {
      calendar_id: calendarId,
      title: 'before',
      start_at: '2026-06-20T10:00:00Z',
      end_at: '2026-06-20T11:00:00Z'
    })
    const hits = cal.listEventsInRange(db, '2026-07-01T00:00:00Z', '2026-07-08T00:00:00Z')
    expect(hits.map((e) => e.title)).toEqual(['in range'])

    cal.setCalendarVisible(db, calendarId, false)
    expect(cal.listEventsInRange(db, '2026-07-01T00:00:00Z', '2026-07-08T00:00:00Z')).toHaveLength(0)
  })

  it('spanning events overlap the window from either side', () => {
    cal.createEvent(db, {
      title: 'offsite',
      start_at: '2026-06-30T22:00:00Z',
      end_at: '2026-07-04T10:00:00Z'
    })
    expect(cal.listEventsInRange(db, '2026-07-01T00:00:00Z', '2026-07-02T00:00:00Z')).toHaveLength(1)
  })

  it('all-day exclusive end: event does NOT appear on its end date', () => {
    cal.createEvent(db, {
      title: 'conference',
      all_day: true,
      start_at: '2026-07-02',
      end_at: '2026-07-04' // covers Jul 2 + Jul 3 only
    })
    const jul3 = cal.listEventsInRange(db, '2026-07-03T00:00:00Z', '2026-07-04T00:00:00Z')
    expect(jul3).toHaveLength(1)
    const jul4 = cal.listEventsInRange(db, '2026-07-04T00:00:00Z', '2026-07-05T00:00:00Z')
    expect(jul4).toHaveLength(0)
  })

  it('all-day events sort before timed events', () => {
    cal.createEvent(db, {
      title: 'timed',
      start_at: '2026-07-02T01:00:00Z',
      end_at: '2026-07-02T02:00:00Z'
    })
    cal.createEvent(db, { title: 'allday', all_day: true, start_at: '2026-07-02', end_at: '2026-07-03' })
    const hits = cal.listEventsInRange(db, '2026-07-02T00:00:00Z', '2026-07-03T00:00:00Z')
    expect(hits.map((e) => e.title)).toEqual(['allday', 'timed'])
  })
})

describe('attendee suggestions', () => {
  it('surfaces distinct emails from past event attendees, filtered by query', () => {
    cal.createEvent(db, {
      title: 'a',
      start_at: '2026-07-02T10:00:00Z',
      end_at: '2026-07-02T11:00:00Z',
      attendees: [
        { email: 'Ana@Example.com', displayName: 'Ana Ríos' },
        { email: 'bob@example.com' }
      ]
    })
    cal.createEvent(db, {
      title: 'b',
      start_at: '2026-07-03T10:00:00Z',
      end_at: '2026-07-03T11:00:00Z',
      attendees: [{ email: 'ana@example.com', displayName: 'Ana Ríos' }]
    })
    const hits = cal.suggestAttendees(db, 'ana')
    expect(hits).toEqual([{ email: 'ana@example.com', name: 'Ana Ríos' }])
    expect(cal.suggestAttendees(db, 'example')).toHaveLength(2)
    expect(cal.suggestAttendees(db, 'zzz')).toHaveLength(0)
  })
})

describe('remote apply + full-sync reconciliation', () => {
  const remote = (over: Partial<cal.RemoteEvent> = {}): cal.RemoteEvent => ({
    google_event_id: 'g1',
    etag: 'e1',
    recurring_event_id: null,
    title: 'Remote',
    description: null,
    location: null,
    start_at: '2026-07-02T10:00:00Z',
    end_at: '2026-07-02T11:00:00Z',
    all_day: false,
    timezone: null,
    color: null,
    attendees: [],
    conferencing_url: null,
    status: 'confirmed',
    ...over
  })

  it('inserts then updates by (calendar, google id)', () => {
    const { calendarId } = googleCalendar()
    cal.applyRemoteEvent(db, calendarId, remote())
    cal.applyRemoteEvent(db, calendarId, remote({ etag: 'e2', title: 'Renamed' }))
    const hits = cal.listEventsInRange(db, '2026-07-01', '2026-07-08')
    expect(hits).toHaveLength(1)
    expect(hits[0].title).toBe('Renamed')
    expect(hits[0].etag).toBe('e2')
  })

  it('remote cancellation deletes the local row', () => {
    const { calendarId } = googleCalendar()
    cal.applyRemoteEvent(db, calendarId, remote())
    cal.applyRemoteEvent(db, calendarId, remote({ status: 'cancelled' }))
    expect(cal.listEventsInRange(db, '2026-07-01', '2026-07-08')).toHaveLength(0)
  })

  it('an unchanged remote copy does not revert queued local edits', () => {
    const { calendarId } = googleCalendar()
    cal.applyRemoteEvent(db, calendarId, remote())
    const [e] = cal.listEventsInRange(db, '2026-07-01', '2026-07-08')
    cal.updateEvent(db, e.id, { title: 'Edited offline' })

    // full resync re-delivers the same etag — local edit must survive
    cal.applyRemoteEvent(db, calendarId, remote())
    expect(cal.getEvent(db, e.id)!.title).toBe('Edited offline')
    expect(cal.getEvent(db, e.id)!.sync_status).toBe('pending_update')
  })

  it('a genuinely newer remote wins over local dirty state', () => {
    const { calendarId } = googleCalendar()
    cal.applyRemoteEvent(db, calendarId, remote())
    const [e] = cal.listEventsInRange(db, '2026-07-01', '2026-07-08')
    cal.updateEvent(db, e.id, { title: 'Local edit' })

    cal.applyRemoteEvent(db, calendarId, remote({ etag: 'e2', title: 'Remote edit' }))
    const after = cal.getEvent(db, e.id)!
    expect(after.title).toBe('Remote edit')
    expect(after.sync_status).toBe('synced')
  })

  it('full-sync reconciliation drops synced rows missing from the feed, keeps dirty rows', () => {
    const { calendarId } = googleCalendar()
    cal.applyRemoteEvent(db, calendarId, remote({ google_event_id: 'keep' }))
    cal.applyRemoteEvent(db, calendarId, remote({ google_event_id: 'gone' }))
    const dirty = cal.createEvent(db, {
      calendar_id: calendarId,
      title: 'queued create',
      start_at: '2026-07-02T12:00:00Z',
      end_at: '2026-07-02T13:00:00Z'
    })

    const removed = cal.deleteEventsMissingFromFullSync(
      db,
      calendarId,
      ['keep'],
      '2026-01-01T00:00:00Z',
      '2027-01-01T00:00:00Z'
    )
    expect(removed).toBe(1)
    const ids = cal.listEventsInRange(db, '2026-07-01', '2026-07-08').map((e) => e.title)
    expect(ids).toContain('Remote')
    expect(ids).toContain('queued create')
    expect(cal.getEvent(db, dirty.id)).toBeDefined()
  })

  it('listDirtyEvents returns the account push work list oldest-first', () => {
    const { accountId, calendarId } = googleCalendar()
    cal.createEvent(
      db,
      {
        calendar_id: calendarId,
        title: 'first',
        start_at: '2026-07-02T10:00:00Z',
        end_at: '2026-07-02T11:00:00Z'
      },
      new Date('2026-07-01T10:00:00Z')
    )
    cal.createEvent(
      db,
      {
        calendar_id: calendarId,
        title: 'second',
        start_at: '2026-07-03T10:00:00Z',
        end_at: '2026-07-03T11:00:00Z'
      },
      new Date('2026-07-01T11:00:00Z')
    )
    cal.createEvent(db, { title: 'local, never dirty', start_at: '2026-07-02T10:00:00Z', end_at: '2026-07-02T11:00:00Z' })
    expect(cal.listDirtyEvents(db, accountId).map((e) => e.title)).toEqual(['first', 'second'])
  })
})

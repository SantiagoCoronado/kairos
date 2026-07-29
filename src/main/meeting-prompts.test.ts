import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { DbDriver } from '../core/driver'
import { openNodeSqliteDb } from '../core/drivers/node-sqlite'
import { migrate } from '../core/migrations'
import * as calendar from '../core/repo/calendar'
import * as meetingsRepo from '../core/repo/meetings'
import type { MeetingEvent } from '../shared/ipc-contract'
import {
  findPromptable,
  MeetingPromptWatcher,
  PROMPT_GRACE_MS,
  PROMPT_LEAD_MS,
  type PromptCandidate,
  type PromptedEvent
} from './meeting-prompts'

const NOW = new Date('2026-07-29T15:00:00Z')
const atOffset = (ms: number): string => new Date(NOW.getTime() + ms).toISOString()

function candidate(over: Partial<PromptCandidate> = {}): PromptCandidate {
  return {
    id: 'ev1',
    title: 'Weekly sync',
    start_at: NOW.toISOString(),
    all_day: 0,
    conferencing_url: 'https://meet.google.com/abc',
    ...over
  }
}

const NO_STATE = {
  now: NOW,
  alreadyPrompted: new Set<string>(),
  recordingActive: false,
  hasMeeting: () => false
}

describe('findPromptable', () => {
  it('returns an in-window event with a conferencing URL', () => {
    expect(findPromptable([candidate()], NO_STATE)).toHaveLength(1)
  })

  it('accepts the full window: lead edge and grace edge', () => {
    const early = candidate({ start_at: atOffset(PROMPT_LEAD_MS) })
    const late = candidate({ start_at: atOffset(-PROMPT_GRACE_MS) })
    expect(findPromptable([early, late], NO_STATE)).toHaveLength(2)
  })

  it('skips events without a URL, all-day events, and out-of-window starts', () => {
    const rejects = [
      candidate({ conferencing_url: null }),
      candidate({ conferencing_url: '' }),
      candidate({ all_day: 1 }),
      candidate({ start_at: atOffset(PROMPT_LEAD_MS + 1000) }), // too early to nag
      candidate({ start_at: atOffset(-PROMPT_GRACE_MS - 1000) }) // call long started
    ]
    expect(findPromptable(rejects, NO_STATE)).toEqual([])
  })

  it('skips already-prompted events and events that already have a meeting', () => {
    expect(
      findPromptable([candidate()], { ...NO_STATE, alreadyPrompted: new Set(['ev1']) })
    ).toEqual([])
    expect(
      findPromptable([candidate()], { ...NO_STATE, hasMeeting: (id) => id === 'ev1' })
    ).toEqual([])
  })

  it('prompts nothing while a recording is active', () => {
    expect(findPromptable([candidate()], { ...NO_STATE, recordingActive: true })).toEqual([])
  })
})

describe('MeetingPromptWatcher', () => {
  let db: DbDriver
  let now: Date
  let enabled: boolean
  let recording: boolean
  let emitted: MeetingEvent[]
  let notified: PromptedEvent[]
  let watcher: MeetingPromptWatcher

  beforeEach(() => {
    db = openNodeSqliteDb(':memory:')
    migrate(db)
    now = new Date(NOW)
    enabled = true
    recording = false
    emitted = []
    notified = []
    watcher = new MeetingPromptWatcher(
      {
        db,
        enabled: () => enabled,
        recordingActive: () => recording,
        emit: (ev) => emitted.push(ev),
        notify: (p) => notified.push(p)
      },
      () => now
    )
  })

  afterEach(() => db.close())

  function seedEvent(over: Partial<Parameters<typeof calendar.createEvent>[1]> = {}): string {
    return calendar.createEvent(
      db,
      {
        title: 'Design review',
        start_at: NOW.toISOString(),
        end_at: atOffset(30 * 60_000),
        conferencing_url: 'https://zoom.us/j/123',
        ...over
      },
      new Date(NOW.getTime() - 86_400_000)
    ).id
  }

  it('emits once per due event (toast payload + notification), never re-emits', () => {
    const id = seedEvent()
    watcher.tick()
    expect(emitted).toEqual([
      { kind: 'record-prompt', eventId: id, title: 'Design review', startAt: NOW.toISOString() }
    ])
    expect(notified).toHaveLength(1)

    now = new Date(NOW.getTime() + 30_000) // next scheduler tick
    watcher.tick()
    expect(emitted).toHaveLength(1)
    expect(notified).toHaveLength(1)
  })

  it('stays silent when the setting is off', () => {
    seedEvent()
    enabled = false
    watcher.tick()
    expect(emitted).toEqual([])
  })

  it('ignores events without a URL and cancelled events', () => {
    seedEvent({ conferencing_url: null })
    const cancelled = seedEvent()
    calendar.deleteEvent(db, cancelled)
    watcher.tick()
    expect(emitted).toEqual([])
  })

  it('skips an event that already has a meeting row', () => {
    const id = seedEvent()
    meetingsRepo.createMeeting(db, { calendar_event_id: id }, NOW)
    watcher.tick()
    expect(emitted).toEqual([])
  })

  it('holds while recording, then prompts once the recorder frees up in-window', () => {
    seedEvent()
    recording = true
    watcher.tick()
    expect(emitted).toEqual([])

    recording = false
    now = new Date(NOW.getTime() + 60_000) // still inside the grace window
    watcher.tick()
    expect(emitted).toHaveLength(1)
  })

  it('reprompt (notification click) re-emits while the event is still actionable', () => {
    const id = seedEvent()
    watcher.tick()
    expect(emitted).toHaveLength(1)

    // toast expired, user clicks the notification 3 min into the call
    now = new Date(NOW.getTime() + 3 * 60_000)
    watcher.reprompt({ eventId: id, title: 'Design review', startAt: NOW.toISOString() })
    expect(emitted).toHaveLength(2)
    expect(notified).toHaveLength(1) // no second notification — user is already looking
  })

  it('reprompt refuses when out of window, recording, disabled, or already recorded', () => {
    const id = seedEvent()
    const prompt = { eventId: id, title: 'Design review', startAt: NOW.toISOString() }
    watcher.tick()
    emitted = []

    now = new Date(NOW.getTime() + PROMPT_GRACE_MS + 1000)
    watcher.reprompt(prompt)

    now = new Date(NOW)
    recording = true
    watcher.reprompt(prompt)
    recording = false

    enabled = false
    watcher.reprompt(prompt)
    enabled = true

    meetingsRepo.createMeeting(db, { calendar_event_id: id }, NOW)
    watcher.reprompt(prompt)

    expect(emitted).toEqual([])
  })

  it('prunes prompted entries after their window passes', () => {
    seedEvent()
    watcher.tick()
    expect(watcher.promptedSize).toBe(1)

    now = new Date(NOW.getTime() + PROMPT_GRACE_MS + 60_000)
    watcher.tick()
    expect(watcher.promptedSize).toBe(0)
    expect(emitted).toHaveLength(1) // out of window now — pruning can't re-prompt
  })
})

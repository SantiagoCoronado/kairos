import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { DbDriver } from './driver'
import { openNodeSqliteDb } from './drivers/node-sqlite'
import { migrate } from './migrations'
import * as meetingsRepo from './repo/meetings'
import * as peopleRepo from './repo/people'
import * as tasksRepo from './repo/tasks'
import {
  applySummaryFanOut,
  buildSummaryPrompt,
  parseSummaryResponse,
  undoFanOutTasks,
  MAX_TRANSCRIPT_CHARS,
  type ParsedSummary
} from './meeting-summary'

const base = {
  transcriptText: 'Me: lets ship friday\nThem: I will review tomorrow',
  title: 'Standup with Ana',
  attendees: [
    { email: 'me@x.com', self: true },
    { email: 'ana@x.com', displayName: 'Ana Torres' }
  ],
  durationSeconds: 1800,
  knownPeople: ['Ana Torres', 'Bob Chen']
}

describe('buildSummaryPrompt', () => {
  it('carries transcript, attendees, duration and people hints', () => {
    const p = buildSummaryPrompt(base)
    expect(p).toContain('lets ship friday')
    expect(p).toContain('Ana Torres')
    expect(p).toContain('(30 min)')
    expect(p).toContain('Bob Chen')
    expect(p).toContain('"Standup with Ana"')
  })

  it('infers 1:1 vs group phrasing from attendee count', () => {
    expect(buildSummaryPrompt(base)).toContain('this is a 1:1')
    const group = {
      ...base,
      attendees: [...base.attendees, { email: 'c@x.com' }, { email: 'd@x.com' }]
    }
    expect(buildSummaryPrompt(group)).toContain('group meeting')
  })

  it('truncates giant transcripts with a marker', () => {
    const p = buildSummaryPrompt({
      ...base,
      transcriptText: 'x'.repeat(MAX_TRANSCRIPT_CHARS + 500)
    })
    expect(p).toContain('[transcript truncated]')
    expect(p.length).toBeLessThan(MAX_TRANSCRIPT_CHARS + 3000)
  })
})

describe('parseSummaryResponse', () => {
  it('parses a well-formed response', () => {
    const out = parseSummaryResponse(`Here you go:
{"summary_md": "- discussed the ship date", "decisions": ["ship friday"],
 "action_items": [{"text": "review the PR", "person": "Ana Torres"}, {"text": "write notes", "person": null}],
 "participants": ["Me", "Ana"]}`)
    expect(out).toEqual({
      summary_md: '- discussed the ship date',
      decisions: ['ship friday'],
      action_items: [
        { text: 'review the PR', person: 'Ana Torres' },
        { text: 'write notes', person: null }
      ],
      participants: ['Me', 'Ana']
    })
  })

  it('tolerates missing arrays and junk entries', () => {
    const out = parseSummaryResponse('{"summary_md": "ok", "action_items": [{"text": ""}, null, {"text": "real"}]}')
    expect(out!.decisions).toEqual([])
    expect(out!.action_items).toEqual([{ text: 'real', person: null }])
  })

  it('rejects output without a usable summary', () => {
    expect(parseSummaryResponse('no json here')).toBeNull()
    expect(parseSummaryResponse('{"summary_md": ""}')).toBeNull()
    expect(parseSummaryResponse('{"summary_md": 42}')).toBeNull()
  })
})

describe('applySummaryFanOut', () => {
  const T0 = new Date('2026-07-28T12:00:00Z')
  let db: DbDriver

  const PARSED: ParsedSummary = {
    summary_md: 'Shipping Friday. Ana reviews the PR first.',
    decisions: ['ship friday'],
    action_items: [
      { text: 'Review the pull request', person: 'Ana Torres' },
      { text: 'Prepare release notes', person: null },
      { text: 'Ping the vendor', person: 'Zed Unknown' }
    ],
    participants: ['Me', 'Ana']
  }

  beforeEach(() => {
    db = openNodeSqliteDb(':memory:')
    migrate(db)
  })

  afterEach(() => db.close())

  it('first run creates linked tasks, logs interactions, persists the summary', () => {
    const ana = peopleRepo.upsertPerson(db, { name: 'Ana Torres', email: 'ana@x.com' }, T0)
    const m = meetingsRepo.createMeeting(db, { title: 'Standup' }, T0)

    const res = applySummaryFanOut(
      db,
      m.id,
      PARSED,
      {
        model: 'sonnet',
        attendees: [
          { email: 'me@x.com', self: true },
          { email: 'ana@x.com', displayName: 'Ana Torres' },
          { email: 'stranger@x.com' } // no matching person — skipped
        ]
      },
      T0
    )

    expect(res.taskIds).toHaveLength(3)
    const created = res.taskIds.map((id) => tasksRepo.getTask(db, id)!)
    expect(created.every((t) => t.meeting_id === m.id)).toBe(true)
    expect(created.find((t) => t.title === 'Review the pull request')!.person_id).toBe(ana.id)
    expect(created.find((t) => t.title === 'Prepare release notes')!.person_id).toBeNull()
    expect(created.find((t) => t.title === 'Ping the vendor')!.person_id).toBeNull() // unknown name

    expect(res.interactionCount).toBe(1) // self + stranger skipped
    const detail = peopleRepo.getPersonDetail(db, ana.id)!
    expect(detail.interactions[0].kind).toBe('meeting')
    expect(detail.interactions[0].summary).toContain('Standup')

    expect(res.meeting.summary_md).toContain('Shipping Friday')
    expect(res.meeting.summarized_at).toBe(T0.toISOString())
    expect(res.meeting.summary.action_items.map((a) => a.task_id)).toEqual(res.taskIds)
  })

  it('re-run updates the text only and PRESERVES existing task links', () => {
    peopleRepo.upsertPerson(db, { name: 'Ana Torres', email: 'ana@x.com' }, T0)
    const m = meetingsRepo.createMeeting(db, { title: 'Standup' }, T0)
    const attendees = [{ email: 'ana@x.com' }]
    const first = applySummaryFanOut(db, m.id, PARSED, { model: 'sonnet', attendees }, T0)

    const rerun = applySummaryFanOut(
      db,
      m.id,
      {
        ...PARSED,
        summary_md: 'Revised summary.',
        action_items: [
          { text: 'Review the pull request', person: 'Ana Torres' }, // same text — link survives
          { text: 'Completely new wording here', person: null } // reworded — no link
        ]
      },
      { model: 'sonnet', attendees },
      new Date(T0.getTime() + 60_000)
    )

    expect(rerun.taskIds).toEqual([])
    expect(rerun.interactionCount).toBe(0)
    expect(rerun.meeting.summary_md).toBe('Revised summary.')
    expect(tasksRepo.listTasks(db, {})).toHaveLength(3) // no duplicates
    // the SummaryModal's live task state depends on this surviving:
    const reviewItem = rerun.meeting.summary.action_items.find(
      (a) => a.text === 'Review the pull request'
    )!
    expect(reviewItem.task_id).toBe(first.taskIds[0])
    expect(
      rerun.meeting.summary.action_items.find((a) => a.text === 'Completely new wording here')!
        .task_id
    ).toBeNull()
  })

  it('never matches by loose substring: "Ana" stays clear of "Diana"', () => {
    peopleRepo.upsertPerson(db, { name: 'Diana Prince', email: 'd@x.com' }, T0)
    const m = meetingsRepo.createMeeting(db, {}, T0)
    const res = applySummaryFanOut(
      db,
      m.id,
      { ...PARSED, action_items: [{ text: 'Follow up', person: 'Ana' }] },
      { model: 'sonnet', attendees: [] },
      T0
    )
    expect(tasksRepo.getTask(db, res.taskIds[0])!.person_id).toBeNull()
  })

  it('matches first names as whole words: "Ana" → Ana Torres when unique', () => {
    const ana = peopleRepo.upsertPerson(db, { name: 'Ana Torres', email: 'a@x.com' }, T0)
    peopleRepo.upsertPerson(db, { name: 'Diana Prince', email: 'd@x.com' }, T0)
    const m = meetingsRepo.createMeeting(db, {}, T0)
    const res = applySummaryFanOut(
      db,
      m.id,
      { ...PARSED, action_items: [{ text: 'Follow up', person: 'Ana' }] },
      { model: 'sonnet', attendees: [] },
      T0
    )
    expect(tasksRepo.getTask(db, res.taskIds[0])!.person_id).toBe(ana.id)
  })

  it('dedupes attendees resolving to the same person', () => {
    peopleRepo.upsertPerson(db, { name: 'Ana Torres', email: 'ana@x.com' }, T0)
    const m = meetingsRepo.createMeeting(db, {}, T0)
    const res = applySummaryFanOut(
      db,
      m.id,
      { ...PARSED, action_items: [] },
      {
        model: 'sonnet',
        attendees: [{ email: 'ana@x.com' }, { email: 'ANA@X.COM', displayName: 'Ana (alt)' }]
      },
      T0
    )
    expect(res.interactionCount).toBe(1)
  })

  it('undoFanOutTasks deletes the tasks and clears their summary links', () => {
    peopleRepo.upsertPerson(db, { name: 'Ana Torres', email: 'ana@x.com' }, T0)
    const m = meetingsRepo.createMeeting(db, { title: 'Standup' }, T0)
    const res = applySummaryFanOut(db, m.id, PARSED, { model: 'sonnet', attendees: [] }, T0)

    undoFanOutTasks(db, m.id, res.taskIds)

    for (const id of res.taskIds) expect(tasksRepo.getTask(db, id)).toBeUndefined()
    const after = meetingsRepo.getMeeting(db, m.id)!
    expect(after.summary.action_items.every((a) => a.task_id === null)).toBe(true)
    expect(after.summary_md).toContain('Shipping Friday') // summary itself intact
  })

  it('ambiguous owner names stay unmatched instead of guessing', () => {
    peopleRepo.upsertPerson(db, { name: 'Ana Torres', email: 'a1@x.com' }, T0)
    peopleRepo.upsertPerson(db, { name: 'Ana Ruiz', email: 'a2@x.com' }, T0)
    const m = meetingsRepo.createMeeting(db, {}, T0)
    const res = applySummaryFanOut(
      db,
      m.id,
      { ...PARSED, action_items: [{ text: 'Follow up', person: 'Ana' }] },
      { model: 'sonnet', attendees: [] },
      T0
    )
    expect(tasksRepo.getTask(db, res.taskIds[0])!.person_id).toBeNull()
  })
})

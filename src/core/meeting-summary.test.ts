import { describe, it, expect } from 'vitest'
import {
  buildSummaryPrompt,
  parseSummaryResponse,
  MAX_TRANSCRIPT_CHARS
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

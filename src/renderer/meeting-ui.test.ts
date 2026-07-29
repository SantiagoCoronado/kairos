import { describe, it, expect } from 'vitest'
import {
  meetingAffordance,
  fmtMeetingDuration,
  fmtElapsed,
  recordPromptToast
} from './src/lib/meeting-ui'
import type { Meeting } from '../core/types'

const meeting = (status: Meeting['status']): Meeting =>
  ({ status }) as Meeting

describe('meetingAffordance', () => {
  it('maps meeting state to the offered control', () => {
    expect(meetingAffordance(null)).toBe('record')
    expect(meetingAffordance(undefined)).toBe('record')
    expect(meetingAffordance(meeting('recording'))).toBe('recording')
    expect(meetingAffordance(meeting('processing'))).toBe('processing')
    expect(meetingAffordance(meeting('ready'))).toBe('view')
    expect(meetingAffordance(meeting('error'))).toBe('error')
  })
})

describe('fmtMeetingDuration', () => {
  it('formats compactly across magnitudes', () => {
    expect(fmtMeetingDuration(null)).toBe('')
    expect(fmtMeetingDuration(34)).toBe('34s')
    expect(fmtMeetingDuration(60)).toBe('1m')
    expect(fmtMeetingDuration(18 * 60 + 20)).toBe('18m')
    expect(fmtMeetingDuration(3900)).toBe('1h 05m')
  })
})

describe('fmtElapsed', () => {
  it('renders a live clock, hours only when needed', () => {
    expect(fmtElapsed(0)).toBe('0:00')
    expect(fmtElapsed(7_000)).toBe('0:07')
    expect(fmtElapsed(62_000)).toBe('1:02')
    expect(fmtElapsed(3_725_000)).toBe('1:02:05')
    expect(fmtElapsed(-50)).toBe('0:00')
  })
})

describe('recordPromptToast', () => {
  const startAt = '2026-07-29T15:00:00Z'
  const at = (offsetMs: number): Date => new Date(Date.parse(startAt) + offsetMs)

  it('names the meeting and reads "Starting now" around the start time', () => {
    expect(recordPromptToast({ title: 'Weekly sync', startAt }, at(0))).toEqual({
      text: 'Record “Weekly sync”?',
      detail: 'Starting now'
    })
    // the one-tick lead prompt is still "now", not "-1 min ago"
    expect(recordPromptToast({ title: 'Weekly sync', startAt }, at(-60_000)).detail).toBe(
      'Starting now'
    )
  })

  it('falls back for untitled events and reports lateness in minutes', () => {
    expect(recordPromptToast({ title: '  ', startAt }, at(3 * 60_000))).toEqual({
      text: 'Record this meeting?',
      detail: 'Started 3 min ago'
    })
  })

  it('floors lateness: 31s in is still "now", 90s is 1 min', () => {
    expect(recordPromptToast({ title: 'x', startAt }, at(31_000)).detail).toBe('Starting now')
    expect(recordPromptToast({ title: 'x', startAt }, at(90_000)).detail).toBe('Started 1 min ago')
  })
})

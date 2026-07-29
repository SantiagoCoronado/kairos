import { describe, it, expect } from 'vitest'
import { meetingAffordance, fmtMeetingDuration, fmtElapsed } from './src/lib/meeting-ui'
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

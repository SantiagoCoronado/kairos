// Pure UI selectors for meeting capture — kept out of components so the
// state → affordance mapping is unit-testable (this repo has no DOM tests).

import type { Meeting } from '../../../core/types'

export type MeetingAffordance = 'record' | 'recording' | 'processing' | 'view' | 'error'

/** what the meeting block should offer for a given (latest) meeting row */
export function meetingAffordance(meeting: Meeting | null | undefined): MeetingAffordance {
  if (!meeting) return 'record'
  switch (meeting.status) {
    case 'recording':
      return 'recording'
    case 'processing':
      return 'processing'
    case 'error':
      return 'error'
    case 'ready':
      return 'view'
  }
}

/** compact duration for meeting rows: 34s, 18m, 1h 05m */
export function fmtMeetingDuration(seconds: number | null | undefined): string {
  if (seconds == null || seconds < 0) return ''
  if (seconds < 60) return `${Math.round(seconds)}s`
  const mins = Math.round(seconds / 60)
  if (mins < 60) return `${mins}m`
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return `${h}h ${String(m).padStart(2, '0')}m`
}

/** live elapsed clock for the recording chip: m:ss, h:mm:ss past the hour */
export function fmtElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const s = total % 60
  const m = Math.floor(total / 60) % 60
  const h = Math.floor(total / 3600)
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`
}

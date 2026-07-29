// Two-channel transcript assembly. The mic and system channels are
// transcribed separately (never mixed) and merged here by timestamp —
// speaker attribution without any diarization model: mic = Me, system =
// Them. Pure; no runtime imports.

import type { TranscriptSegment } from './types'

type Untagged = Omit<TranscriptSegment, 'channel'>

/** interleave the two channels' segments in spoken order */
export function mergeChannelSegments(me: Untagged[], them: Untagged[]): TranscriptSegment[] {
  const tagged: TranscriptSegment[] = [
    ...me.map((s) => ({ ...s, channel: 'me' as const })),
    ...them.map((s) => ({ ...s, channel: 'them' as const }))
  ]
  return tagged.sort(
    (a, b) => a.t0 - b.t0 || a.t1 - b.t1 || (a.channel === b.channel ? 0 : a.channel === 'me' ? -1 : 1)
  )
}

/** plain-text rendering for search/export: consecutive same-speaker
 *  segments collapse into one "Me:"/"Them:" paragraph */
export function transcriptText(segments: TranscriptSegment[]): string {
  const parts: string[] = []
  let channel: TranscriptSegment['channel'] | null = null
  let run: string[] = []
  const flush = (): void => {
    if (run.length) parts.push(`${channel === 'me' ? 'Me' : 'Them'}: ${run.join(' ')}`)
    run = []
  }
  for (const s of segments) {
    if (s.channel !== channel) {
      flush()
      channel = s.channel
    }
    run.push(s.text)
  }
  flush()
  return parts.join('\n')
}

// Two-channel transcript assembly. The mic and system channels are
// transcribed separately (never mixed) and merged here by timestamp —
// speaker attribution without any diarization model: mic = Me, system =
// Them. Pure; no runtime imports.

import type { TranscriptSegment } from './types'

type Untagged = Omit<TranscriptSegment, 'channel'>

/** interleave the two channels' segments in spoken order */
export function mergeChannelSegments(me: Untagged[], them: Untagged[]): TranscriptSegment[] {
  const tagged: TranscriptSegment[] = [
    ...dropMicBleed(me, them).map((s) => ({ ...s, channel: 'me' as const })),
    ...them.map((s) => ({ ...s, channel: 'them' as const }))
  ]
  return tagged.sort(
    (a, b) => a.t0 - b.t0 || a.t1 - b.t1 || (a.channel === b.channel ? 0 : a.channel === 'me' ? -1 : 1)
  )
}

// Speaker bleed: without headphones the mic hears the laptop speakers, so
// the other side's words get transcribed twice — once clean on the system
// channel and once as an echo on the mic, attributed to Me. The system
// channel is the authoritative Them source (it can't hear the user), so a
// mic segment whose words also appear on the system channel in the same
// time window is the echo and is dropped. Whisper segments the two
// channels differently, so a mic segment is compared against every
// overlapping system segment concatenated: a bleed echo that straddles two
// system segments still matches, while the user's own words in between
// ("Hola, muy bien, ¿y tú?") stay because they never appear over there.
/** whisper's timestamps for the same sound differ per channel by this much */
const BLEED_WINDOW_S = 1.5
/** shorter mic segments ("sí", "ok") are too often a genuine echo of
 *  agreement to call bleed on text alone */
const BLEED_MIN_WORDS = 3
/** fraction of the mic segment's words found in order on the system side */
const BLEED_MATCH_RATIO = 0.8
/** an echo's words sit contiguously on the system side, so the match is
 *  bounded to a span not much longer than the mic segment — otherwise a
 *  3-word "sí, claro, perfecto" is found scattered across any long Them
 *  monologue of common words. 1.5× leaves room for words whisper split
 *  across two system segments ("pesos mex" / "icanos") */
const BLEED_SPAN_FACTOR = 1.5

export function dropMicBleed(me: Untagged[], them: Untagged[]): Untagged[] {
  if (them.length === 0) return me
  const themWords = them.map((s) => ({ ...s, words: normalizeWords(s.text) }))
  return me.filter((seg) => {
    const words = normalizeWords(seg.text)
    if (words.length < BLEED_MIN_WORDS) return true
    // an echo starts while Them is still talking (a few hundred ms after
    // the system segment does), so the trailing edge gets no tolerance:
    // a reply that repeats Them's words right after they finish is the
    // user's own
    const overlapping = themWords
      .filter((t) => t.t0 < seg.t1 + BLEED_WINDOW_S && t.t1 > seg.t0)
      .flatMap((t) => t.words)
    if (overlapping.length === 0) return true
    const span = Math.ceil(words.length * BLEED_SPAN_FACTOR)
    let best = 0
    for (let i = 0; i + Math.min(span, overlapping.length) <= overlapping.length; i++) {
      best = Math.max(best, orderedOverlap(words, overlapping.slice(i, i + span)))
      if (best === words.length) break
    }
    return best / words.length < BLEED_MATCH_RATIO
  })
}

/** lower-case, diacritic- and punctuation-insensitive word tokens, so
 *  "Cómo estás?" and "como estas" compare equal across the two whisper
 *  passes */
function normalizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ')
    .filter(Boolean)
}

/** length of the longest common subsequence — how many of `a`'s words
 *  appear in `b` in the same order */
function orderedOverlap(a: string[], b: string[]): number {
  let prev = new Array<number>(b.length + 1).fill(0)
  for (const wa of a) {
    const cur = new Array<number>(b.length + 1).fill(0)
    for (let j = 0; j < b.length; j++) {
      cur[j + 1] = wa === b[j] ? prev[j] + 1 : Math.max(prev[j + 1], cur[j])
    }
    prev = cur
  }
  return prev[b.length]
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

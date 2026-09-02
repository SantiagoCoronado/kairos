import { describe, it, expect } from 'vitest'
import { dropMicBleed, mergeChannelSegments, transcriptText } from './transcript'

describe('mergeChannelSegments', () => {
  it('interleaves channels in spoken order with attribution', () => {
    const merged = mergeChannelSegments(
      [
        { t0: 0, t1: 2, text: 'hey there' },
        { t0: 6, t1: 8, text: 'sounds good' }
      ],
      [{ t0: 2.5, t1: 5.5, text: 'hi, quick question' }]
    )
    expect(merged.map((s) => `${s.channel}:${s.text}`)).toEqual([
      'me:hey there',
      'them:hi, quick question',
      'me:sounds good'
    ])
  })

  it('breaks exact ties deterministically (me first)', () => {
    const merged = mergeChannelSegments(
      [{ t0: 0, t1: 1, text: 'a' }],
      [{ t0: 0, t1: 1, text: 'b' }]
    )
    expect(merged.map((s) => s.channel)).toEqual(['me', 'them'])
  })

  it('handles one-sided meetings', () => {
    expect(mergeChannelSegments([], [{ t0: 0, t1: 1, text: 'x' }])).toHaveLength(1)
    expect(mergeChannelSegments([], [])).toEqual([])
  })
})

describe('dropMicBleed', () => {
  // no headphones: the mic hears the speakers, so Them's words show up on
  // the mic channel too, a few hundred ms late
  it('drops mic segments that echo an overlapping system segment', () => {
    const them = [{ t0: 161.9, t1: 163.3, text: 'Hola Santiago, ¿cómo estás?' }]
    const me = [
      { t0: 162.1, t1: 163.3, text: 'Hola Santiago, ¿cómo estás?' },
      { t0: 163.3, t1: 164.4, text: 'Hola, muy bien, ¿y tú?' }
    ]
    expect(dropMicBleed(me, them).map((s) => s.text)).toEqual(['Hola, muy bien, ¿y tú?'])
  })

  it('ignores punctuation, case and accents between the two whisper passes', () => {
    const them = [{ t0: 0, t1: 2, text: 'como estas, todo bien' }]
    const me = [{ t0: 0.2, t1: 2.1, text: '¿Cómo estás? Todo bien.' }]
    expect(dropMicBleed(me, them)).toEqual([])
  })

  it('matches an echo that straddles two system segments', () => {
    const them = [
      { t0: 878.0, t1: 884.3, text: 'Pues depende mucho, pero me lo puedes decir en pesos mex' },
      { t0: 884.3, t1: 885.8, text: 'icanos o en dólares.' }
    ]
    const me = [
      { t0: 881.3, t1: 885.5, text: 'me lo puedes decir en pesos mexicanos o en dólares' }
    ]
    // "mexicanos" is split across the two system segments, so 1 of 9 words
    // misses — still well over the match ratio
    expect(dropMicBleed(me, them)).toEqual([])
  })

  it('keeps the same words said at a different time', () => {
    const them = [{ t0: 0, t1: 2, text: 'nos vemos el viernes entonces' }]
    const me = [{ t0: 10, t1: 12, text: 'nos vemos el viernes entonces' }]
    expect(dropMicBleed(me, them)).toHaveLength(1)
  })

  it('keeps a short interjection whose words are scattered across a long Them segment', () => {
    // review finding: every word of "sí, claro, perfecto" appears in order
    // somewhere in the monologue, but an echo would be contiguous
    const them = [
      {
        t0: 0,
        t1: 20,
        text: 'sí, bueno, lo que pasa es que claro, la idea es tener algo perfecto para el lunes y después vemos'
      }
    ]
    const me = [{ t0: 5, t1: 6.2, text: 'sí, claro, perfecto' }]
    expect(dropMicBleed(me, them)).toHaveLength(1)
  })

  it('keeps a reply that repeats Them right after they finish', () => {
    // review finding: an echo starts while Them is still talking; a mic
    // segment that begins after the system segment ended is the user
    const them = [{ t0: 0, t1: 3.0, text: '¿nos vemos el viernes?' }]
    const me = [{ t0: 3.2, t1: 4.5, text: 'nos vemos el viernes' }]
    expect(dropMicBleed(me, them)).toHaveLength(1)
  })

  it('still drops an echo whose mic timestamps start before the system copy', () => {
    // whisper's per-channel timestamps can put the mic copy a few seconds
    // early (seen at 878.0 vs 881.3 in the Primero AI call)
    const them = [{ t0: 881.3, t1: 884.5, text: 'Pues depende mucho, pero me lo puedes decir en pesos mex' }]
    const me = [{ t0: 878.0, t1: 884.3, text: 'Pues depende mucho, pero me lo puedes decir en pesos mex' }]
    expect(dropMicBleed(me, them)).toEqual([])
  })

  it('keeps short interjections and genuinely different overlapping speech', () => {
    const them = [{ t0: 0, t1: 3, text: 'sí, claro, y luego mandamos la propuesta' }]
    const me = [
      { t0: 0.5, t1: 1, text: 'sí, claro' },
      { t0: 1, t1: 3, text: 'perfecto, yo la reviso el lunes' }
    ]
    expect(dropMicBleed(me, them)).toHaveLength(2)
  })

  it('is a no-op without a system channel', () => {
    const me = [{ t0: 0, t1: 1, text: 'talking to myself here' }]
    expect(dropMicBleed(me, [])).toBe(me)
  })

  it('is applied by mergeChannelSegments', () => {
    const merged = mergeChannelSegments(
      [{ t0: 0.2, t1: 2, text: 'hi, quick question for you' }],
      [{ t0: 0, t1: 2, text: 'hi, quick question for you' }]
    )
    expect(merged.map((s) => s.channel)).toEqual(['them'])
  })
})

describe('transcriptText', () => {
  it('collapses consecutive same-speaker segments into paragraphs', () => {
    const text = transcriptText([
      { t0: 0, t1: 1, channel: 'me', text: 'so' },
      { t0: 1, t1: 2, channel: 'me', text: 'about the plan' },
      { t0: 2, t1: 4, channel: 'them', text: 'yes?' },
      { t0: 4, t1: 5, channel: 'me', text: 'shipping friday' }
    ])
    expect(text).toBe('Me: so about the plan\nThem: yes?\nMe: shipping friday')
  })

  it('is empty for no segments', () => {
    expect(transcriptText([])).toBe('')
  })
})

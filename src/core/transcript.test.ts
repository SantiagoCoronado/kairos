import { describe, it, expect } from 'vitest'
import { mergeChannelSegments, transcriptText } from './transcript'

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

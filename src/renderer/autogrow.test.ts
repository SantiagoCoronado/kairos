import { describe, expect, it } from 'vitest'
import { autoGrowHeight, composerCap, COMPOSER_CAP_FRACTION } from './src/lib/autogrow'

const FLOOR = 56 // two rows of 13px text plus padding and borders

describe('composerCap', () => {
  it('takes its share of the pane', () => {
    expect(composerCap(1000, FLOOR)).toBe(Math.floor(1000 * COMPOSER_CAP_FRACTION))
  })

  it('never drops under the min-rows floor in a tiny pane', () => {
    expect(composerCap(80, FLOOR)).toBe(FLOOR)
  })

  it('rounds down so the box never overshoots the share by a fraction', () => {
    expect(composerCap(333, FLOOR)).toBe(149)
  })
})

describe('autoGrowHeight', () => {
  const cap = 300

  it('sits at the floor while the text is shorter than the min rows', () => {
    expect(autoGrowHeight(20, FLOOR, cap)).toEqual({ height: FLOOR, overflow: false })
  })

  it('follows the content between floor and cap without scrolling', () => {
    expect(autoGrowHeight(180, FLOOR, cap)).toEqual({ height: 180, overflow: false })
  })

  it('stops at the cap and scrolls inside past it', () => {
    expect(autoGrowHeight(900, FLOOR, cap)).toEqual({ height: cap, overflow: true })
  })

  it('exactly at the cap still fits without a scrollbar', () => {
    expect(autoGrowHeight(cap, FLOOR, cap)).toEqual({ height: cap, overflow: false })
  })

  it('a cap squeezed to the floor keeps the min rows and scrolls', () => {
    expect(autoGrowHeight(180, FLOOR, FLOOR)).toEqual({ height: FLOOR, overflow: true })
  })
})

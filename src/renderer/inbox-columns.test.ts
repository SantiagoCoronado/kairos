import { describe, expect, it } from 'vitest'
import { fitMax, PANE_MIN } from './src/lib/inbox-columns'

const RAIL = { def: 176, min: 140, max: 280 }
const LIST = { def: 320, min: 240, max: 480 }

describe('fitMax', () => {
  it('keeps the static max until the shell has been measured', () => {
    expect(fitMax(0, 176, LIST)).toBe(480)
  })

  it('leaves the pane its floor once the shell is known', () => {
    expect(fitMax(800, 176, LIST)).toBe(800 - 176 - PANE_MIN)
  })

  it('never exceeds the static max in a wide shell', () => {
    expect(fitMax(2000, 176, LIST)).toBe(480)
  })

  it('stops at the column min instead of going negative', () => {
    expect(fitMax(500, 176, LIST)).toBe(240)
  })

  it('the rail only yields once the list at its min would not fit the pane', () => {
    // list at min + pane floor = 600; anything above leaves the rail alone
    expect(fitMax(600 + 200, LIST.min, RAIL)).toBe(200)
    expect(fitMax(600 + 300, LIST.min, RAIL)).toBe(280)
    expect(fitMax(600 + 100, LIST.min, RAIL)).toBe(140)
  })
})

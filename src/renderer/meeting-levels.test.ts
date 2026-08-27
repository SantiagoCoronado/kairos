import { describe, it, expect, afterEach, vi } from 'vitest'

vi.mock('./src/lib/api', () => ({
  api: { invoke: vi.fn(), on: vi.fn(() => () => {}), pathForFile: vi.fn() }
}))

import {
  levelFromFrames,
  envelope,
  noteFrames,
  resetLevels,
  getLevels
} from './src/lib/meeting-levels'

afterEach(() => resetLevels())

describe('levelFromFrames', () => {
  it('maps silence to empty and full scale to full', () => {
    expect(levelFromFrames(new Float32Array(0))).toBe(0)
    expect(levelFromFrames(new Float32Array(128))).toBe(0)
    expect(levelFromFrames(new Float32Array(128).fill(1))).toBe(1)
    expect(levelFromFrames(new Float32Array(128).fill(-1))).toBe(1)
  })

  it('is a dB scale over a -60 dB floor: -20 dBFS sits two thirds up', () => {
    expect(levelFromFrames(new Float32Array(128).fill(0.1))).toBeCloseTo(2 / 3, 5)
    // below the floor clamps to empty rather than going negative
    expect(levelFromFrames(new Float32Array(128).fill(0.0001))).toBe(0)
  })
})

describe('envelope', () => {
  it('attacks instantly and releases gradually', () => {
    expect(envelope(0.2, 0.9)).toBe(0.9)
    const fell = envelope(0.9, 0)
    expect(fell).toBeGreaterThan(0)
    expect(fell).toBeLessThan(0.9)
    // a quieter but non-silent block never pulls below itself
    expect(envelope(0.9, 0.85)).toBe(0.85)
  })
})

describe('level store', () => {
  it('tracks each channel independently', () => {
    noteFrames('mic', new Float32Array(128).fill(1))
    expect(getLevels()).toEqual({ mic: 1, system: 0 })
    noteFrames('system', new Float32Array(128).fill(0.1))
    expect(getLevels().system).toBeCloseTo(2 / 3, 5)
    expect(getLevels().mic).toBe(1)
    // silence after speech releases rather than snapping to zero
    noteFrames('mic', new Float32Array(128))
    expect(getLevels().mic).toBeCloseTo(0.9, 5)
  })

  it('resetLevels flattens both meters in place — a held reference stays live', () => {
    const held = getLevels()
    noteFrames('mic', new Float32Array(128).fill(1))
    noteFrames('system', new Float32Array(128).fill(1))
    resetLevels()
    expect(held).toEqual({ mic: 0, system: 0 })
    noteFrames('mic', new Float32Array(128).fill(1))
    expect(held.mic).toBe(1)
    expect(getLevels()).toBe(held)
  })
})

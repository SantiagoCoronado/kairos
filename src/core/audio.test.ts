import { describe, it, expect } from 'vitest'
import { floatTo16BitPcm, wavHeader, WAV_HEADER_BYTES } from './audio'

describe('floatTo16BitPcm', () => {
  it('quantizes and clamps to int16 range', () => {
    const out = floatTo16BitPcm(new Float32Array([0, 1, -1, 2, -2, 0.5]))
    expect(out[0]).toBe(0)
    expect(out[1]).toBe(0x7fff) // +1 → max
    expect(out[2]).toBe(-0x8000) // -1 → min
    expect(out[3]).toBe(0x7fff) // clamp above
    expect(out[4]).toBe(-0x8000) // clamp below
    expect(out[5]).toBe(Math.round(0.5 * 0x7fff))
  })
})

describe('wavHeader', () => {
  it('is byte-exact for 16kHz mono 16-bit', () => {
    const h = wavHeader(320000, 16000) // 10s of 16k mono int16
    expect(h.length).toBe(WAV_HEADER_BYTES)
    const view = new DataView(h.buffer)
    const ascii = (off: number, len: number): string =>
      String.fromCharCode(...h.slice(off, off + len))
    expect(ascii(0, 4)).toBe('RIFF')
    expect(view.getUint32(4, true)).toBe(36 + 320000)
    expect(ascii(8, 4)).toBe('WAVE')
    expect(ascii(12, 4)).toBe('fmt ')
    expect(view.getUint32(16, true)).toBe(16)
    expect(view.getUint16(20, true)).toBe(1) // PCM
    expect(view.getUint16(22, true)).toBe(1) // mono
    expect(view.getUint32(24, true)).toBe(16000)
    expect(view.getUint32(28, true)).toBe(32000) // byte rate
    expect(view.getUint16(32, true)).toBe(2) // block align
    expect(view.getUint16(34, true)).toBe(16)
    expect(ascii(36, 4)).toBe('data')
    expect(view.getUint32(40, true)).toBe(320000)
  })
})

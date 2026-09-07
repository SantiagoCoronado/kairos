import { describe, it, expect } from 'vitest'
import { capFileNameBytes } from './fs-names'

describe('capFileNameBytes', () => {
  it('passes short names through untouched', () => {
    expect(capFileNameBytes('photo.jpeg')).toBe('photo.jpeg')
  })

  it('caps at the byte budget and keeps the extension', () => {
    const out = capFileNameBytes('x'.repeat(300) + '.pdf', 50)
    expect(out.endsWith('.pdf')).toBe(true)
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(50)
  })

  it('never splits a multi-byte code point', () => {
    const out = capFileNameBytes('日'.repeat(100) + '.png', 32)
    expect(out.endsWith('.png')).toBe(true)
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(32)
    expect(out.includes('�')).toBe(false)
    expect([...out.slice(0, -4)].every((c) => c === '日')).toBe(true)
  })

  it('an absurdly long extension is treated as part of the stem', () => {
    const out = capFileNameBytes('a.' + 'e'.repeat(40), 20)
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(20)
  })
})

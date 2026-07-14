import { describe, expect, it } from 'vitest'
import { stoicForDate } from './stoic'

describe('stoicForDate', () => {
  it('is deterministic for a given day', () => {
    const a = stoicForDate(new Date('2026-07-14T08:00:00'))
    const b = stoicForDate(new Date('2026-07-14T23:59:00'))
    expect(a).toEqual(b)
  })

  it('rotates to a different teaching the next day', () => {
    const today = stoicForDate(new Date('2026-07-14T12:00:00'))
    const tomorrow = stoicForDate(new Date('2026-07-15T12:00:00'))
    expect(today).not.toEqual(tomorrow)
  })

  it('returns a well-formed teaching for every day of a leap year', () => {
    for (let i = 0; i < 366; i++) {
      const d = new Date(2028, 0, 1 + i)
      const t = stoicForDate(d)
      expect(t.text.length).toBeGreaterThan(10)
      expect(['Marcus Aurelius', 'Seneca', 'Epictetus']).toContain(t.author)
    }
  })
})

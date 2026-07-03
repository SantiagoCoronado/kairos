import { describe, it, expect } from 'vitest'
import { layoutDayEvents } from './calendar-layout'

interface Ev {
  id: string
  s: number
  e: number
}

const ev = (id: string, s: number, e: number): Ev => ({ id, s, e })
const layout = (items: Ev[]): Record<string, { col: number; cols: number }> => {
  const out: Record<string, { col: number; cols: number }> = {}
  for (const r of layoutDayEvents(items, (t) => t.s, (t) => t.e)) {
    out[r.item.id] = { col: r.col, cols: r.cols }
  }
  return out
}

describe('layoutDayEvents', () => {
  it('non-overlapping events each get full width', () => {
    const r = layout([ev('a', 0, 60), ev('b', 60, 120), ev('c', 200, 260)])
    expect(r.a).toEqual({ col: 0, cols: 1 })
    expect(r.b).toEqual({ col: 0, cols: 1 })
    expect(r.c).toEqual({ col: 0, cols: 1 })
  })

  it('two overlapping events split into two columns', () => {
    const r = layout([ev('a', 0, 120), ev('b', 60, 180)])
    expect(r.a).toEqual({ col: 0, cols: 2 })
    expect(r.b).toEqual({ col: 1, cols: 2 })
  })

  it('a column frees up once its event ends (chain within a cluster)', () => {
    // a 0-120, b 60-180 overlap; c 130-200 fits back into column 0 but the
    // cluster is still open (b runs to 180), so all three share cols=2
    const r = layout([ev('a', 0, 120), ev('b', 60, 180), ev('c', 130, 200)])
    expect(r.a.col).toBe(0)
    expect(r.b.col).toBe(1)
    expect(r.c.col).toBe(0)
    expect(r.a.cols).toBe(2)
    expect(r.c.cols).toBe(2)
  })

  it('triple overlap makes three columns', () => {
    const r = layout([ev('a', 0, 180), ev('b', 30, 180), ev('c', 60, 180)])
    expect([r.a.col, r.b.col, r.c.col].sort()).toEqual([0, 1, 2])
    expect(r.a.cols).toBe(3)
  })

  it('clusters are independent: widths reset after a gap', () => {
    const r = layout([ev('a', 0, 60), ev('b', 30, 90), ev('c', 300, 360)])
    expect(r.a.cols).toBe(2)
    expect(r.b.cols).toBe(2)
    expect(r.c).toEqual({ col: 0, cols: 1 })
  })

  it('input order does not matter', () => {
    const r1 = layout([ev('a', 0, 120), ev('b', 60, 180)])
    const r2 = layout([ev('b', 60, 180), ev('a', 0, 120)])
    expect(r1).toEqual(r2)
  })

  it('handles empty input', () => {
    expect(layoutDayEvents([], () => 0, () => 0)).toEqual([])
  })
})

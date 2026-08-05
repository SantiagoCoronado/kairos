import { describe, it, expect } from 'vitest'
import { deliveredMap, sendUnits, pendingUnits } from './outbox-units'

const row = (over: { body_text?: string; to_json?: string; delivered_json?: string | null }) => ({
  body_text: 'hola',
  to_json: '{}',
  delivered_json: null,
  ...over
})

describe('sendUnits', () => {
  it('text-only row is a single text unit', () => {
    expect(sendUnits(row({}))).toEqual([{ key: 'text', kind: 'text' }])
  })

  it('whitespace-only body contributes no text unit', () => {
    expect(sendUnits(row({ body_text: '  \n ' }))).toEqual([])
  })

  it('text first, then one unit per attachment in to_json order', () => {
    expect(
      sendUnits(row({ to_json: JSON.stringify({ jid: 'x', attachments: ['a1', 'a2'] }) }))
    ).toEqual([
      { key: 'text', kind: 'text' },
      { key: 'att:0', kind: 'att', index: 0 },
      { key: 'att:1', kind: 'att', index: 1 }
    ])
  })

  it('attachments-only row has no text unit', () => {
    expect(
      sendUnits(row({ body_text: '', to_json: JSON.stringify({ attachments: ['a1'] }) }))
    ).toEqual([{ key: 'att:0', kind: 'att', index: 0 }])
  })

  it('corrupt to_json and non-array attachments degrade to no att units', () => {
    expect(sendUnits(row({ to_json: 'not json {' }))).toEqual([{ key: 'text', kind: 'text' }])
    expect(sendUnits(row({ to_json: JSON.stringify({ attachments: 'a1' }) }))).toEqual([
      { key: 'text', kind: 'text' }
    ])
  })
})

describe('deliveredMap', () => {
  it('NULL and corrupt JSON count as nothing delivered', () => {
    expect(deliveredMap(row({}))).toEqual({})
    expect(deliveredMap(row({ delivered_json: 'not json {' }))).toEqual({})
    expect(deliveredMap(row({ delivered_json: '[1,2]' }))).toEqual({})
    expect(deliveredMap(row({ delivered_json: '"text"' }))).toEqual({})
  })

  it('keeps string values and drops anything else', () => {
    expect(
      deliveredMap(row({ delivered_json: JSON.stringify({ text: 'id1', 'att:0': 7, x: null }) }))
    ).toEqual({ text: 'id1' })
  })
})

describe('pendingUnits', () => {
  const both = row({ to_json: JSON.stringify({ attachments: ['a1', 'a2'] }) })

  it('nothing delivered → everything pending, in order', () => {
    expect(pendingUnits(both).map((u) => u.key)).toEqual(['text', 'att:0', 'att:1'])
  })

  it('delivered units are skipped, order preserved', () => {
    expect(
      pendingUnits({ ...both, delivered_json: JSON.stringify({ text: 'id1', 'att:0': 'id2' }) }).map(
        (u) => u.key
      )
    ).toEqual(['att:1'])
  })

  it('fully delivered → empty', () => {
    expect(
      pendingUnits({
        ...both,
        delivered_json: JSON.stringify({ text: 'i1', 'att:0': 'i2', 'att:1': 'i3' })
      })
    ).toEqual([])
  })

  it('corrupt delivered_json resends everything (duplicate beats lost)', () => {
    expect(pendingUnits({ ...both, delivered_json: '{broken' })).toHaveLength(3)
  })
})

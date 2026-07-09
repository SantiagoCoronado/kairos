import { describe, it, expect } from 'vitest'
import {
  buildLabelPrompt,
  parseLabelResponse,
  heuristicLabels,
  labelIdsFromRawJson,
  type LabelCandidate
} from './labels'

const candidates: LabelCandidate[] = [
  { id: 't1', sender: 'Anna <anna@x.com>', subject: 'Lunch?', snippet: 'are you free' },
  { id: 't2', sender: 'Bank <no-reply@bank.com>', subject: 'Statement', snippet: 'your statement' }
]

describe('heuristicLabels', () => {
  it('classifies gmail categories without a model', () => {
    expect(heuristicLabels(['CATEGORY_PROMOTIONS'], 'Big sale', '50% off')).toEqual(['promo'])
    expect(heuristicLabels(['CATEGORY_SOCIAL'], 'New follower', '')).toEqual(['other'])
    expect(heuristicLabels(['CATEGORY_FORUMS'], 'Digest', '')).toEqual(['newsletter'])
  })

  it('keyword rules outrank gmail categories', () => {
    expect(heuristicLabels(['CATEGORY_PROMOTIONS'], 'Your receipt from Apple', '')).toEqual(['finance'])
    expect(heuristicLabels([], 'Flight itinerary MEX-SFO', '')).toEqual(['travel'])
    expect(heuristicLabels(['CATEGORY_UPDATES'], 'Factura electrónica', 'recibo adjunto')).toEqual(['finance'])
  })

  it('returns null for ambiguous mail (goes to the model)', () => {
    expect(heuristicLabels(['CATEGORY_PERSONAL'], 'Lunch?', 'are you free')).toBeNull()
    expect(heuristicLabels([], 'Quick question', 'about the project')).toBeNull()
    expect(heuristicLabels(['CATEGORY_UPDATES'], 'Your order shipped', '')).toBeNull()
  })
})

describe('labelIdsFromRawJson', () => {
  it('extracts labelIds and tolerates junk', () => {
    expect(labelIdsFromRawJson(JSON.stringify({ labelIds: ['INBOX', 'CATEGORY_PROMOTIONS'] }))).toEqual([
      'INBOX',
      'CATEGORY_PROMOTIONS'
    ])
    expect(labelIdsFromRawJson(null)).toEqual([])
    expect(labelIdsFromRawJson('not json')).toEqual([])
    expect(labelIdsFromRawJson(JSON.stringify({ key: {} }))).toEqual([])
  })
})

describe('parseLabelResponse', () => {
  it('maps numbered entries back to thread ids', () => {
    const out = parseLabelResponse('{"1":["personal"],"2":["finance"]}', candidates)
    expect(out.get('t1')).toEqual(['personal'])
    expect(out.get('t2')).toEqual(['finance'])
  })

  it('tolerates code fences and prose around the JSON', () => {
    const out = parseLabelResponse('Sure!\n```json\n{"1":["personal"]}\n```', candidates)
    expect(out.get('t1')).toEqual(['personal'])
    expect(out.has('t2')).toBe(false)
  })

  it('drops unknown labels, caps at 2, falls back to other', () => {
    const out = parseLabelResponse(
      '{"1":["spam-eggs","Personal","finance","travel"],"2":["banana"]}',
      candidates
    )
    expect(out.get('t1')).toEqual(['personal', 'finance'])
    expect(out.get('t2')).toEqual(['other']) // nothing valid → never re-queued
  })

  it('returns empty on garbage', () => {
    expect(parseLabelResponse('no json here', candidates).size).toBe(0)
    expect(parseLabelResponse('{broken', candidates).size).toBe(0)
  })
})

describe('buildLabelPrompt', () => {
  it('numbers candidates and demands bare JSON', () => {
    const p = buildLabelPrompt(candidates)
    expect(p).toContain('1. from: Anna <anna@x.com> | subject: Lunch?')
    expect(p).toContain('2. from: Bank <no-reply@bank.com>')
    expect(p).toContain('Return ONLY a JSON object')
  })
})

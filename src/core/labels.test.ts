import { describe, it, expect } from 'vitest'
import {
  buildLabelPrompt,
  parseLabelResponse,
  heuristicLabels,
  labelIdsFromRawJson,
  buildMessageTriagePrompt,
  parseTriageResponse,
  heuristicMessageTriage,
  splitTriageBudget,
  type LabelCandidate,
  type MessageTriageCandidate
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

const triageCandidates: MessageTriageCandidate[] = [
  { id: 'w1', sender: 'Mamá', messages: ['¿Puedes llamarme? Es sobre el doctor'] },
  { id: 'w2', sender: 'Leo', messages: ['jajaja', 'mira este meme'] }
]

describe('heuristicMessageTriage', () => {
  it('drops pure acknowledgment/emoji chatter without a model call', () => {
    expect(heuristicMessageTriage(['ok'])).toBe('routine')
    expect(heuristicMessageTriage(['jajaja', '👍', 'gracias!'])).toBe('routine')
    expect(heuristicMessageTriage(['ok 👍'])).toBe('routine')
    expect(heuristicMessageTriage(['gracias!! 🙏🙏'])).toBe('routine')
    expect(heuristicMessageTriage(['🎉🎉', '  '])).toBe('routine')
    expect(heuristicMessageTriage([])).toBe('routine')
  })

  it('defers anything substantive to the classifier', () => {
    expect(heuristicMessageTriage(['¿puedes mandarme el reporte hoy?'])).toBeNull()
    expect(heuristicMessageTriage(['ok', 'nos vemos a las 7 entonces?'])).toBeNull()
    expect(heuristicMessageTriage(['check out https://x.com/thing'])).toBeNull()
  })

  it('drops laughs, reactions and greetings across languages', () => {
    expect(heuristicMessageTriage(['hahaha'])).toBe('routine')
    expect(heuristicMessageTriage(['jsjs'])).toBeNull() // not in the list — model decides
    expect(heuristicMessageTriage(['looool 😂'])).toBe('routine')
    expect(heuristicMessageTriage(['Awww 😝'])).toBe('routine')
    expect(heuristicMessageTriage(['wow!!'])).toBe('routine')
    expect(heuristicMessageTriage(['buenas'])).toBe('routine')
    expect(heuristicMessageTriage(['buenos días'])).toBe('routine')
    expect(heuristicMessageTriage(['adiós!'])).toBe('routine')
    // reaction word + substance is NOT routine — every() must fail
    expect(heuristicMessageTriage(['wow', 'te marco en 5 para lo del banco'])).toBeNull()
    expect(heuristicMessageTriage(['Awww. Cute as always😝'])).toBeNull()
  })
})

describe('splitTriageBudget', () => {
  const items = ['a', 'b', 'c', 'd']

  it('sends what the budget affords, defers the overflow', () => {
    expect(splitTriageBudget(items, 2)).toEqual({ toModel: ['a', 'b'], deferred: ['c', 'd'] })
    expect(splitTriageBudget(items, 4)).toEqual({ toModel: items, deferred: [] })
    expect(splitTriageBudget(items, 99)).toEqual({ toModel: items, deferred: [] })
  })

  it('exhausted (or negative) budget defers everything — never notifies unfiltered', () => {
    expect(splitTriageBudget(items, 0)).toEqual({ toModel: [], deferred: items })
    expect(splitTriageBudget(items, -3)).toEqual({ toModel: [], deferred: items })
  })
})

describe('buildMessageTriagePrompt', () => {
  it('numbers conversations, quotes messages, truncates long bodies', () => {
    const long = 'x'.repeat(300)
    const p = buildMessageTriagePrompt([{ id: 'a', sender: 'Bo', messages: [long] }, ...triageCandidates])
    expect(p).toContain('1. from: Bo')
    expect(p).toContain(`> ${'x'.repeat(200)}`)
    expect(p).not.toContain('x'.repeat(201))
    expect(p).toContain('2. from: Mamá')
    expect(p).toContain('> ¿Puedes llamarme?')
    expect(p).toContain('Return ONLY a JSON object')
  })
})

describe('parseTriageResponse', () => {
  it('maps verdicts back by position, tolerating fences and prose', () => {
    const out = parseTriageResponse(
      'Sure!\n```json\n{"1":"important","2":"routine"}\n```',
      triageCandidates
    )
    expect(out.get('w1')).toBe('important')
    expect(out.get('w2')).toBe('routine')
  })

  it('leaves skipped or invalid entries absent (retry, not misfire)', () => {
    const out = parseTriageResponse('{"1":"IMPORTANT","2":"maybe"}', triageCandidates)
    expect(out.get('w1')).toBe('important')
    expect(out.has('w2')).toBe(false)
    expect(parseTriageResponse('no json here', triageCandidates).size).toBe(0)
  })
})

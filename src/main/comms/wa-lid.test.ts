import { describe, it, expect } from 'vitest'
import { LidBook } from './wa-lid'

const LID = '213365519610111@lid'
const PN = '5215534002774@s.whatsapp.net'

describe('LidBook', () => {
  it('learns a pairing in either order and resolves the lid to the phone jid', () => {
    const book = new LidBook()
    expect(book.learn(LID, PN)).toBe('new')
    expect(book.canonical(LID)).toBe(PN)
    expect(book.canonical(PN)).toBe(PN)
    const reversed = new LidBook()
    reversed.learn(PN, LID)
    expect(reversed.pnFor(LID)).toBe(PN)
  })

  it('tolerates device suffixes — the mapping store answers with `<pn>:0@s.whatsapp.net`', () => {
    const book = new LidBook()
    book.learn('213365519610111:4@lid', '5215534002774:0@s.whatsapp.net')
    expect(book.canonical(LID)).toBe(PN)
    expect(book.canonical('213365519610111:7@lid')).toBe(PN)
  })

  it('ignores pairs that are not one lid and one phone jid', () => {
    const book = new LidBook()
    expect(book.learn(LID, undefined)).toBe(false)
    expect(book.learn(LID, '120363401548388910@g.us')).toBe(false)
    expect(book.learn(PN, '5215519544781@s.whatsapp.net')).toBe(false)
    expect(book.learn('1@hosted.lid', PN)).toBe(false)
    expect(book.canonical(LID)).toBe(LID)
  })

  it('reports a re-learned identical pair as nothing new', () => {
    const book = new LidBook()
    book.learn(LID, PN)
    expect(book.learn(LID, PN)).toBe(false)
  })

  it('flags a lid moving to another phone and drops the stale reverse entry', () => {
    const book = new LidBook()
    book.learn(LID, PN)
    expect(book.learn(LID, '5215519544781@s.whatsapp.net')).toBe('remap')
    expect(book.canonical(LID)).toBe('5215519544781@s.whatsapp.net')
    expect(book.aliases(PN)).toEqual([PN])
  })

  it('lists aliases canonical-first from either side', () => {
    const book = new LidBook()
    book.learn(LID, PN)
    expect(book.aliases(LID)).toEqual([PN, LID])
    expect(book.aliases(PN)).toEqual([PN, LID])
    expect(book.aliases('999@lid')).toEqual(['999@lid'])
  })

  it('unresolved() picks out only the lids it cannot map', () => {
    const book = new LidBook()
    book.learn(LID, PN)
    expect(book.unresolved([LID, '42331348689117@lid', PN, '42331348689117@lid'])).toEqual([
      '42331348689117@lid'
    ])
  })
})

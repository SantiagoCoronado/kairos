import { describe, expect, it } from 'vitest'
import { buildForwardBody, looksLikeEmail } from './forward'

describe('buildForwardBody', () => {
  it('email style carries the classic header block', () => {
    const body = buildForwardBody({
      senderName: 'Alejandro Cordoba',
      sentAtLabel: 'Jul 27, 10:24 AM',
      text: 'Voy 5 min',
      style: 'email'
    })
    expect(body).toBe(
      '---------- Forwarded message ----------\n' +
        'From: Alejandro Cordoba\n' +
        'Date: Jul 27, 10:24 AM\n' +
        '\n' +
        'Voy 5 min'
    )
  })

  it('chat style is a one-line prefix', () => {
    const body = buildForwardBody({
      senderName: 'Alejandro Cordoba',
      sentAtLabel: 'Jul 27, 10:24 AM',
      text: 'Voy 5 min',
      style: 'chat'
    })
    expect(body).toBe('Forwarded from Alejandro Cordoba:\nVoy 5 min')
  })

  it('a comment sits above the quoted content', () => {
    const body = buildForwardBody({
      senderName: 'AC',
      sentAtLabel: 'today',
      text: 'hola',
      comment: '  mira esto  ',
      style: 'chat'
    })
    expect(body).toBe('mira esto\n\nForwarded from AC:\nhola')
  })

  it('a whitespace-only comment is dropped', () => {
    const body = buildForwardBody({
      senderName: 'AC',
      sentAtLabel: 'today',
      text: 'hola',
      comment: '   ',
      style: 'chat'
    })
    expect(body).toBe('Forwarded from AC:\nhola')
  })

  it('empty original text falls back to a placeholder', () => {
    const body = buildForwardBody({
      senderName: 'AC',
      sentAtLabel: 'today',
      text: '  ',
      style: 'email'
    })
    expect(body).toContain('(no text)')
  })
})

describe('looksLikeEmail', () => {
  it('accepts a plain address (trimmed)', () => {
    expect(looksLikeEmail(' user@example.com ')).toBe(true)
  })
  it('rejects missing domain dot, spaces, and double @', () => {
    expect(looksLikeEmail('user@localhost')).toBe(false)
    expect(looksLikeEmail('user name@example.com')).toBe(false)
    expect(looksLikeEmail('a@b@example.com')).toBe(false)
    expect(looksLikeEmail('not an email')).toBe(false)
  })
})

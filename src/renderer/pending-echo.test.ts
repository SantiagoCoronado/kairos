import { describe, it, expect } from 'vitest'
import { pendingEchoLanded } from './src/lib/pending-echo'

const me = (body: string): { is_me: number; body_text: string | null } => ({
  is_me: 1,
  body_text: body
})

describe('pendingEchoLanded', () => {
  it('matches a verbatim echo', () => {
    expect(pendingEchoLanded('hola Mario', [me('hola Mario')])).toBe(true)
  })

  it('survives CRLF endings and soft wrapping from Gmail re-encoding', () => {
    const sent = 'line one\nline two which is fairly long'
    expect(pendingEchoLanded(sent, [me('line one\r\nline two which is\r\nfairly long')])).toBe(
      true
    )
  })

  it('matches by prefix when ingestion appends quoted history', () => {
    expect(
      pendingEchoLanded('thanks, see you then', [
        me('thanks, see you then\n\nOn Mon, Jul 27, Mario wrote:\n> cual es la direccion')
      ])
    ).toBe(true)
  })

  it('does not match different text, incoming messages, or null bodies', () => {
    expect(pendingEchoLanded('hola', [me('adios')])).toBe(false)
    expect(pendingEchoLanded('hola', [{ is_me: 0, body_text: 'hola' }])).toBe(false)
    expect(pendingEchoLanded('hola', [{ is_me: 1, body_text: null }])).toBe(false)
  })

  it('never matches on an empty pending text', () => {
    expect(pendingEchoLanded('   ', [me('anything')])).toBe(false)
  })
})

import { describe, expect, it } from 'vitest'
import { buildMime, sanitizeFilename, toBase64Url } from './mime'

const base = {
  from: 'me@example.com',
  to: ['you@example.com'],
  subject: 'Hola',
  bodyText: 'hola mundo'
}

const png = Buffer.from('fakepngbytes').toString('base64')

describe('buildMime', () => {
  it('plain message stays single-part', () => {
    const raw = buildMime(base)
    expect(raw).toContain('Content-Type: text/plain; charset=UTF-8')
    expect(raw).not.toContain('multipart')
  })

  it('html body becomes multipart/alternative', () => {
    const raw = buildMime({ ...base, bodyHtml: '<b>hola</b>' })
    expect(raw).toContain('multipart/alternative')
    expect(raw).not.toContain('multipart/mixed')
  })

  it('attachments wrap everything in multipart/mixed', () => {
    const raw = buildMime({
      ...base,
      bodyHtml: '<b>hola</b>',
      attachments: [{ filename: 'voice.ogg', mimeType: 'audio/ogg', contentBase64: png }]
    })
    // mixed on the outside, alternative nested inside it
    const mixedIdx = raw.indexOf('multipart/mixed')
    const altIdx = raw.indexOf('multipart/alternative')
    expect(mixedIdx).toBeGreaterThan(-1)
    expect(altIdx).toBeGreaterThan(mixedIdx)
    expect(raw).toContain('Content-Disposition: attachment; filename="voice.ogg"')
    expect(raw).toContain('Content-Type: audio/ogg; name="voice.ogg"')
    expect(raw).toContain(png)
  })

  it('attachment content is 76-col wrapped', () => {
    const long = Buffer.alloc(200, 7).toString('base64')
    const raw = buildMime({
      ...base,
      attachments: [{ filename: 'a.bin', mimeType: 'application/octet-stream', contentBase64: long }]
    })
    const contentLines = raw.split('\r\n').filter((l) => l.length > 0 && !l.includes(':'))
    for (const line of contentLines) expect(line.length).toBeLessThanOrEqual(76)
  })

  it('missing mime type falls back to octet-stream', () => {
    const raw = buildMime({
      ...base,
      attachments: [{ filename: 'x', mimeType: '', contentBase64: png }]
    })
    expect(raw).toContain('Content-Type: application/octet-stream; name="x"')
  })
})

describe('sanitizeFilename', () => {
  it('strips quotes and CRLF that could break out of the header value', () => {
    expect(sanitizeFilename('a"b\r\nc.pdf')).toBe('a_b__c.pdf')
  })
  it('empty name falls back', () => {
    expect(sanitizeFilename('  ')).toBe('attachment')
  })
})

describe('toBase64Url', () => {
  it('is url-safe without padding', () => {
    const enc = toBase64Url('subj>ects?')
    expect(enc).not.toMatch(/[+/=]/)
  })
})

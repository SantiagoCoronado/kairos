import { describe, expect, it } from 'vitest'
import { buildMime, sanitizeFilename, sanitizeMimeType, toBase64Url } from './mime'

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

  it('a CRLF-bearing remote mime type cannot smuggle headers', () => {
    const raw = buildMime({
      ...base,
      attachments: [
        {
          filename: 'a.ogg',
          mimeType: 'audio/ogg\r\nX-Injected: evil',
          contentBase64: png
        }
      ]
    })
    expect(raw).not.toContain('X-Injected')
    expect(raw).toContain('Content-Type: application/octet-stream; name="a.ogg"')
  })

  it('non-ascii filenames get RFC 2231 filename* plus an ascii fallback', () => {
    const raw = buildMime({
      ...base,
      attachments: [{ filename: 'canción.mp3', mimeType: 'audio/mpeg', contentBase64: png }]
    })
    expect(raw).toContain('filename="canci_n.mp3"')
    expect(raw).toContain("filename*=UTF-8''canci%C3%B3n.mp3")
    expect(raw).not.toMatch(/name="[^"]*canción/)
  })

  it('ascii filenames skip the filename* parameter', () => {
    const raw = buildMime({
      ...base,
      attachments: [{ filename: 'plain.pdf', mimeType: 'application/pdf', contentBase64: png }]
    })
    expect(raw).toContain('filename="plain.pdf"')
    expect(raw).not.toContain('filename*=')
  })
})

describe('sanitizeMimeType', () => {
  it('strips parameters and keeps a valid type', () => {
    expect(sanitizeMimeType('audio/ogg; codecs=opus')).toBe('audio/ogg')
  })
  it('rejects malformed values', () => {
    expect(sanitizeMimeType('audio/ogg\r\nX-Evil: 1')).toBe('application/octet-stream')
    expect(sanitizeMimeType('not a mime')).toBe('application/octet-stream')
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

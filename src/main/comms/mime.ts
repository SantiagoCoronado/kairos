// Minimal RFC 2822 builder for Gmail sends. Deliberately tiny: UTF-8 only,
// base64 bodies, RFC 2047-encoded subject. With bodyHtml the message becomes
// multipart/alternative (plain + html) so paragraphs survive rich clients.
// With attachments everything is wrapped in a multipart/mixed envelope.

import { randomBytes } from 'node:crypto'

export interface MimeAttachment {
  filename: string
  mimeType: string
  /** raw bytes, already base64-encoded (NOT base64url) */
  contentBase64: string
}

export interface MimeInput {
  from: string
  to: string[]
  cc?: string[]
  subject: string
  bodyText: string
  /** optional HTML alternative; omit for a plain text/plain message */
  bodyHtml?: string
  /** Message-ID header value of the message being replied to */
  inReplyTo?: string | null
  /** files to attach — turns the message into multipart/mixed */
  attachments?: MimeAttachment[]
}

/** Escape + autolink + preserve line breaks — an HTML rendering of plain text. */
export function textToHtml(text: string): string {
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  const linked = escaped.replace(/https?:\/\/[^\s<>"']+/g, (url) => `<a href="${url}">${url}</a>`)
  return `<div dir="auto">${linked.replace(/\n/g, '<br>\n')}</div>`
}

const needsEncoding = (s: string): boolean => /[^\x20-\x7e]/.test(s)

/** RFC 2047 encoded-word for non-ASCII header values. */
const encodeHeader = (s: string): string =>
  needsEncoding(s) ? `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=` : s

const wrap76 = (b64: string): string => b64.replace(/(.{76})/g, '$1\r\n')

export function buildMime(input: MimeInput): string {
  const head = [
    `From: ${input.from}`,
    `To: ${input.to.join(', ')}`,
    ...(input.cc?.length ? [`Cc: ${input.cc.join(', ')}`] : []),
    `Subject: ${encodeHeader(input.subject)}`,
    ...(input.inReplyTo ? [`In-Reply-To: ${input.inReplyTo}`, `References: ${input.inReplyTo}`] : []),
    'MIME-Version: 1.0'
  ]
  const b64 = (s: string): string => wrap76(Buffer.from(s, 'utf8').toString('base64'))

  /** the text/plain (or alternative) body as header+content lines, sans the
   *  top-level headers — reused verbatim inside a mixed envelope */
  const bodyPart = (): string[] => {
    if (!input.bodyHtml) {
      return [
        'Content-Type: text/plain; charset=UTF-8',
        'Content-Transfer-Encoding: base64',
        '',
        b64(input.bodyText)
      ]
    }
    const alt = `kairos_alt_${randomBytes(12).toString('hex')}`
    return [
      `Content-Type: multipart/alternative; boundary="${alt}"`,
      '',
      `--${alt}`,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      b64(input.bodyText),
      `--${alt}`,
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      b64(input.bodyHtml),
      `--${alt}--`
    ]
  }

  if (!input.attachments?.length) {
    return [...head, ...bodyPart()].join('\r\n')
  }

  const mixed = `kairos_mix_${randomBytes(12).toString('hex')}`
  return [
    ...head,
    `Content-Type: multipart/mixed; boundary="${mixed}"`,
    '',
    `--${mixed}`,
    ...bodyPart(),
    ...input.attachments.flatMap((a) => {
      const clean = sanitizeFilename(a.filename)
      // RFC 2047 inside filename="…" is nonstandard; the conformant form is
      // an RFC 2231 filename* parameter with an ASCII-degraded fallback for
      // clients that don't decode it
      const ascii = clean.replace(/[^\x20-\x7e]/g, '_')
      const ext = ascii === clean ? '' : `; filename*=UTF-8''${encodeRFC2231(clean)}`
      return [
        `--${mixed}`,
        `Content-Type: ${sanitizeMimeType(a.mimeType)}; name="${ascii}"`,
        `Content-Disposition: attachment; filename="${ascii}"${ext}`,
        'Content-Transfer-Encoding: base64',
        '',
        wrap76(a.contentBase64)
      ]
    }),
    `--${mixed}--`
  ].join('\r\n')
}

/** header-safe filename: no quotes/CRLF that could break out of the value */
export function sanitizeFilename(name: string): string {
  const cleaned = name.replace(/[\r\n"\\]/g, '_').trim()
  return cleaned || 'attachment'
}

/** RFC 2231 extended-value encoding for filename* — percent-encode, plus
 *  the chars encodeURIComponent leaves that 2231 forbids in a value. */
const encodeRFC2231 = (s: string): string =>
  encodeURIComponent(s).replace(/['*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)

/** Header-safe media type: strip parameters, validate bare type/subtype.
 *  The value is remote-controlled (a WhatsApp sender's protobuf, a Gmail
 *  part) — it must not be able to smuggle CRLF into the part headers. */
export function sanitizeMimeType(mime: string): string {
  const bare = mime.split(';')[0].trim()
  return /^[\w.+-]+\/[\w.+-]+$/.test(bare) ? bare : 'application/octet-stream'
}

/** Gmail's messages.send wants base64url of the raw RFC 2822 message. */
export function toBase64Url(raw: string): string {
  return Buffer.from(raw, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

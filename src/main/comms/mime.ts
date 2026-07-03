// Minimal RFC 2822 builder for Gmail sends. Deliberately tiny: UTF-8 only,
// base64 bodies, RFC 2047-encoded subject. With bodyHtml the message becomes
// multipart/alternative (plain + html) so paragraphs survive rich clients.

import { randomBytes } from 'node:crypto'

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

  if (!input.bodyHtml) {
    return [
      ...head,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      b64(input.bodyText)
    ].join('\r\n')
  }

  const boundary = `kairos_${randomBytes(12).toString('hex')}`
  return [
    ...head,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64(input.bodyText),
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64(input.bodyHtml),
    `--${boundary}--`
  ].join('\r\n')
}

/** Gmail's messages.send wants base64url of the raw RFC 2822 message. */
export function toBase64Url(raw: string): string {
  return Buffer.from(raw, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

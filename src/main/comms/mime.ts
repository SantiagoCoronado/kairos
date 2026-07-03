// Minimal RFC 2822 builder for plain-text Gmail sends. Deliberately tiny:
// text/plain UTF-8 only, base64 body, RFC 2047-encoded subject.

export interface MimeInput {
  from: string
  to: string[]
  cc?: string[]
  subject: string
  bodyText: string
  /** Message-ID header value of the message being replied to */
  inReplyTo?: string | null
}

const needsEncoding = (s: string): boolean => /[^\x20-\x7e]/.test(s)

/** RFC 2047 encoded-word for non-ASCII header values. */
const encodeHeader = (s: string): string =>
  needsEncoding(s) ? `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=` : s

const wrap76 = (b64: string): string => b64.replace(/(.{76})/g, '$1\r\n')

export function buildMime(input: MimeInput): string {
  const lines = [
    `From: ${input.from}`,
    `To: ${input.to.join(', ')}`,
    ...(input.cc?.length ? [`Cc: ${input.cc.join(', ')}`] : []),
    `Subject: ${encodeHeader(input.subject)}`,
    ...(input.inReplyTo ? [`In-Reply-To: ${input.inReplyTo}`, `References: ${input.inReplyTo}`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(Buffer.from(input.bodyText, 'utf8').toString('base64'))
  ]
  return lines.join('\r\n')
}

/** Gmail's messages.send wants base64url of the raw RFC 2822 message. */
export function toBase64Url(raw: string): string {
  return Buffer.from(raw, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

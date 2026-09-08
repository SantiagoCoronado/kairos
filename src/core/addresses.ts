// RFC-5322-ish recipient parsing, just enough to answer "is this mail only to
// me?" — the gmail mail-to-self check. Deliberately conservative: anything it
// can't parse comes back as a non-empty unknown token, so the answer is "no".

/** Every address in a To/Cc header, lowercased. Splits on commas outside
 *  quotes and angle brackets, so `"Coronado, Santiago" <s@x>` stays one. */
export function recipientEmails(header: string): string[] {
  const parts: string[] = []
  let cur = ''
  let quoted = false
  let angle = 0
  for (const ch of header) {
    if (ch === '"') quoted = !quoted
    else if (!quoted && ch === '<') angle++
    else if (!quoted && ch === '>') angle = Math.max(0, angle - 1)
    if (ch === ',' && !quoted && angle === 0) {
      parts.push(cur)
      cur = ''
    } else {
      cur += ch
    }
  }
  parts.push(cur)
  return parts
    .map((p) => {
      const m = p.match(/<([^>]*)>/)
      return (m ? m[1] : p).trim().toLowerCase()
    })
    .filter((e) => e.length > 0)
}

/** True only when every To and Cc recipient is `self` and there is at least
 *  one. A list address anywhere on the line, or an unparsable header, is not
 *  mail to yourself. */
export function isMailToSelf(headers: { to?: string; cc?: string } | undefined, self: string): boolean {
  if (!headers) return false
  const me = self.trim().toLowerCase()
  const to = recipientEmails(headers.to ?? '')
  const cc = recipientEmails(headers.cc ?? '')
  return to.length > 0 && [...to, ...cc].every((e) => e === me)
}

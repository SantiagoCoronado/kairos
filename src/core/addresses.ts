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
      // a bare address may itself be quoted: "me@x.com"
      return (m ? m[1] : p).trim().replace(/^"+|"+$/g, '').trim().toLowerCase()
    })
    .filter((e) => e.length > 0)
}

/** True only when every To and Cc recipient is one of YOUR addresses and
 *  there is at least one. `selves` is the account's primary address plus the
 *  message's own From (a send-as alias mailing itself). A list address
 *  anywhere on the line, or an unparsable header, is not mail to yourself. */
export function isMailToSelf(
  headers: { to?: string; cc?: string } | undefined,
  selves: readonly string[]
): boolean {
  if (!headers) return false
  const mine = new Set(selves.map((a) => a.trim().toLowerCase()).filter((a) => a.length > 0))
  if (mine.size === 0) return false
  const to = recipientEmails(headers.to ?? '')
  const cc = recipientEmails(headers.cc ?? '')
  return to.length > 0 && [...to, ...cc].every((e) => mine.has(e))
}

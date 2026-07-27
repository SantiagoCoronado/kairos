/** Whether the provider's echo of a queued reply has landed in the thread.
 *  Slack/WhatsApp upsert the outgoing body verbatim, but Gmail re-encodes
 *  outgoing MIME server-side and can hand the text/plain part back with CRLF
 *  endings or soft wrapping — so compare with all whitespace collapsed, and
 *  by prefix (mail ingestion may append quoting under the sent body). */

const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim()

export function pendingEchoLanded(
  pendingText: string,
  messages: readonly { is_me: number; body_text: string | null }[]
): boolean {
  const want = collapse(pendingText)
  if (!want) return false
  return messages.some((m) => m.is_me === 1 && collapse(m.body_text ?? '').startsWith(want))
}

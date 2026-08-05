// Forwarded-message body construction — kept out of the renderer so the
// format is unit-testable (this repo has no DOM tests).

export interface ForwardInput {
  /** display name of the original sender ('me' for own messages) */
  senderName: string
  /** preformatted timestamp label — callers own locale/timezone concerns */
  sentAtLabel: string
  /** original subject, when the source is an email thread */
  subjectLabel?: string
  /** original message text */
  text: string
  /** optional note the forwarder typed above the quoted content */
  comment?: string
  /** email gets the classic header block; chats get a one-line prefix */
  style: 'email' | 'chat'
}

export function buildForwardBody(input: ForwardInput): string {
  const comment = input.comment?.trim()
  const text = input.text.trim()
  // empty text happens when only attachments travel (voice note, bare
  // photo) — the header/prefix still says where the media came from
  const quoted =
    input.style === 'email'
      ? [
          '---------- Forwarded message ----------',
          `From: ${input.senderName}`,
          `Date: ${input.sentAtLabel}`,
          ...(input.subjectLabel ? [`Subject: ${input.subjectLabel}`] : []),
          ...(text ? ['', text] : [])
        ].join('\n')
      : text
        ? `Forwarded from ${input.senderName}:\n${text}`
        : `Forwarded from ${input.senderName}`
  return comment ? `${comment}\n\n${quoted}` : quoted
}

/** Loose but practical: one @, no spaces, a dot in the domain. */
export function looksLikeEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim())
}

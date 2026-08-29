/** What the message pane last scrolled for — enough to tell a real change
 *  from a refetch that returns the same messages under a new array identity. */
export type ThreadScrollKey = {
  threadId: string
  /** id of the newest message, '' for an empty thread */
  newestId: string
  /** optimistic echoes queued below the messages */
  pendingCount: number
}

export type ThreadScrollTarget = 'latest-start' | 'bottom'

/**
 * Where the pane should scroll after a render, or null to leave the reader
 * alone. Mark-read and every background sync broadcast db:changed, which
 * refetches the thread — scrolling on each of those yanked a half-read email
 * to its bottom.
 *
 * - opening a thread: email lands on the start of the newest message (the
 *   top, for the usual single-message thread); chat lands on the bottom
 * - a new message or a queued send: bottom, whatever the provider
 * - anything else (same newest id, same pending count): stay put
 */
export function threadScrollTarget(
  prev: ThreadScrollKey | null,
  next: ThreadScrollKey,
  provider: string
): ThreadScrollTarget | null {
  if (!prev || prev.threadId !== next.threadId) {
    return provider === 'gmail' ? 'latest-start' : 'bottom'
  }
  if (next.pendingCount > prev.pendingCount) return 'bottom'
  if (next.newestId !== prev.newestId) return 'bottom'
  return null
}

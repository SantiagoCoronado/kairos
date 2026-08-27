/** Which IpcApi channels a remote (phone/browser) client may invoke. Pure
 *  so the boundary is unit-testable without standing up the server.
 *
 *  capture:* window management is never remotely useful — except
 *  capture:submit / capture:smart, plain DB writes that the phone's voice
 *  capture rides. terminal:* is a shell on this machine — refused unless
 *  the user explicitly opts in (Settings → remote access → allow terminal).
 *  meetings mutations stay local-only: the Mac owns the live capture rig,
 *  and a remote client must never start/stop/pause/feed/delete a recording
 *  it can't see — nor trigger paid model calls (summarize). Reads
 *  (list/get/active/audioData) and the scoped undo remain available. */
const ALWAYS_DENIED = [
  /^capture:(?!submit$|smart$)/,
  /^meetings:(start|stop|pause|resume|chunk|delete|summarize)$/
]
const TERMINAL = /^terminal:/

export function isDeniedChannel(channel: string, opts: { remoteTerminal: boolean }): boolean {
  if (ALWAYS_DENIED.some((rx) => rx.test(channel))) return true
  if (TERMINAL.test(channel) && !opts.remoteTerminal) return true
  return false
}

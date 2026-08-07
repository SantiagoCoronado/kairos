// Notification deep links, delivered reliably (issue #99).
//
// A notification click may CONSTRUCT the main window, and a synchronous
// webContents.send right after construction is lost: nothing buffers it, and
// deferring to did-finish-load is the same race with a shorter window —
// React's mount trails the load event (empirically: listeners attached at
// parse, in a microtask, or in the load handler catch the send; rAF,
// setTimeout(0), and everything later do not — React commits on the wrong
// side of that line, and no main-side timer reliably lands on the right one).
//
// So delivery is a handshake: main STASHES the link and sends it
// opportunistically; the renderer CLAIMS on mount. An already-open window
// navigates on the send and its ack-claim clears the stash; a cold window
// misses the send and its mount-claim retrieves the link. The claim channel
// is Electron-only by construction (registered on ipcMain directly, never on
// the remote dispatch) — a notification click on the Mac is desktop intent,
// and must not move a connected phone's view.
import type { BrowserWindow } from 'electron'
import type { IpcEvents, NavView } from '../shared/ipc-contract'

export interface DeepLink {
  view: NavView
  id?: string
}

/** A stashed link older than this is stale — the mount it was waiting for
 *  never came (window construction + React mount is 1–3s; 60s absorbs a
 *  pathological cold start without letting an unclaimed link from earlier
 *  hijack an unrelated launch). */
const CLAIM_TTL_MS = 60_000

let pending: { link: DeepLink; at: number } | null = null

/** Deliver a notification deep link: stash for the mount-claim handshake,
 *  then send opportunistically — delivered-or-lost, the stash is the truth. */
export function deliverDeepLink(win: BrowserWindow, link: DeepLink, now = Date.now()): void {
  pending = { link, at: now }
  const payload: IpcEvents['nav:goto'] = { view: link.view, id: link.id }
  win.webContents.send('nav:goto', payload)
}

/** One-shot: the link is consumed by whoever claims it first (the mounted
 *  renderer's nav:goto ack, or a cold window's mount-claim). */
export function claimDeepLink(now = Date.now()): DeepLink | null {
  if (!pending) return null
  const { link, at } = pending
  pending = null
  return now - at <= CLAIM_TTL_MS ? link : null
}

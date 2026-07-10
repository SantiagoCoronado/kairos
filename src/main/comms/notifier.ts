// Native notifications for new inbound messages. Two entry points:
//   noteInbound(provider)  — a sync/socket batch just stored new unread rows
//   noteLabeled(threadIds) — the labeler just classified email threads
// Mode (Settings → notifyInbox):
//   'off'       — never
//   'important' — DMs on arrival + emails when labeled action-needed (the
//                 labeler runs async, so email pings arrive ~seconds later)
//   'all'       — every thread with new inbound mail/messages
// Always suppressed while an app window is focused (the list + badge are
// already in view), and only for messages newer than RECENT_WINDOW_MS so a
// first sync/backfill can never turn into a notification storm.
import { Notification, BrowserWindow, app } from 'electron'
import type { DbDriver } from '../../core/driver'
import type { NavView } from '../../shared/ipc-contract'
import type { CommsProvider, CommsThreadListItem } from '../../core/comms-types'
import * as repo from '../../core/repo/comms'
import { createMainWindow } from '../windows/main-window'
import { getSettings } from '../settings'
import { logLine } from '../logger'

const RECENT_WINDOW_MS = 30 * 60_000
const NOTIFIED_CAP = 500

export class CommsNotifier {
  /** threadId → last_message_at already notified; a newer message re-arms */
  private notified = new Map<string, string>()

  constructor(
    private db: DbDriver,
    /** deep-link a notification click into the renderer (nav:goto) */
    private onNavigate: (view: NavView, id?: string) => void
  ) {}

  /** A batch of new inbound rows landed for `provider`. */
  noteInbound(provider: CommsProvider): void {
    const mode = getSettings().notifyInbox
    if (mode === 'off') return
    // important-mode email waits for the labeler's verdict instead
    if (mode === 'important' && provider === 'gmail') return
    this.scan((t) => t.provider === provider && (mode === 'all' || t.kind === 'dm'))
  }

  /** The labeler just wrote labels for these threads. */
  noteLabeled(threadIds: string[]): void {
    if (getSettings().notifyInbox !== 'important') return
    const ids = new Set(threadIds)
    this.scan((t) => ids.has(t.id) && t.labels.split(',').includes('action-needed'))
  }

  private scan(eligible: (t: CommsThreadListItem) => boolean): void {
    if (!Notification.isSupported()) return
    // focused window = the user is already looking at the app
    if (BrowserWindow.getFocusedWindow()) return
    const cutoff = new Date(Date.now() - RECENT_WINDOW_MS).toISOString()
    for (const t of repo.listThreads(this.db, { unreadOnly: true, limit: 30 })) {
      if (!t.last_message_at || t.last_message_at < cutoff) continue // backlog, not news
      if (!eligible(t)) continue
      const seen = this.notified.get(t.id)
      if (seen && seen >= t.last_message_at) continue
      this.notified.set(t.id, t.last_message_at)
      if (this.notified.size > NOTIFIED_CAP) {
        const oldest = this.notified.keys().next().value
        if (oldest !== undefined) this.notified.delete(oldest)
      }
      this.show(t)
    }
  }

  private show(t: CommsThreadListItem): void {
    const title = t.person_name || t.title || 'New message'
    const n = new Notification({ title, body: t.snippet || '(no preview)', silent: false })
    n.on('click', () => {
      const win = createMainWindow()
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
      app.focus({ steal: true })
      this.onNavigate('inbox', t.id)
    })
    n.show()
    logLine('info', 'comms', `notified ${t.provider}/${t.kind}: "${title}"`)
  }
}

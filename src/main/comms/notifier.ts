// Native notifications for new inbound messages. Two entry points:
//   noteInbound(provider)  — a sync/socket batch just stored new unread rows
//   noteLabeled(threadIds) — the labeler just classified email threads
// Mode (Settings → notifyInbox):
//   'off'       — never
//   'important' — slack DMs on arrival; email when labeled action-needed;
//                 whatsapp when the message triage flags it (both classifier
//                 paths run async, so those pings arrive ~seconds later)
//   'all'       — every thread with new inbound mail/messages
// Guardrails: suppressed while an app window is focused; only messages newer
// than RECENT_WINDOW_MS (a first sync/backfill can't storm); at most
// MAX_PER_BATCH individual banners per event, the rest coalesce into one.
import { Notification, BrowserWindow, app } from 'electron'
import type { DbDriver } from '../../core/driver'
import type { NavView } from '../../shared/ipc-contract'
import type { CommsProvider, CommsThreadListItem } from '../../core/comms-types'
import * as repo from '../../core/repo/comms'
import { createMainWindow } from '../windows/main-window'
import { getSettings } from '../settings'
import { sendPushAll } from '../remote/push'
import { logLine } from '../logger'

/** exported for the labeler: in notification-only mode it classifies just
 *  the mail fresh enough to still produce a banner */
export const RECENT_WINDOW_MS = 30 * 60_000
const NOTIFIED_CAP = 500
const MAX_PER_BATCH = 3

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
    // important mode: email waits for the labeler's action-needed verdict,
    // whatsapp for the message triage — both ping via their own callbacks
    if (mode === 'important' && (provider === 'gmail' || provider === 'whatsapp')) return
    // provider filter in SQL — an unfiltered top-N recency scan could get
    // starved by 30 busier threads from other providers
    const threads = repo.listThreads(this.db, { unreadOnly: true, provider, limit: 30 })
    this.deliver(threads.filter((t) => mode === 'all' || t.kind === 'dm'))
  }

  /** The labeler just wrote labels for these threads. */
  noteLabeled(threadIds: string[]): void {
    if (getSettings().notifyInbox !== 'important') return
    // we know the exact ids — look them up directly instead of scanning
    const threads = threadIds
      .map((id) => repo.getThreadListItem(this.db, id))
      .filter(
        (t): t is CommsThreadListItem =>
          t !== null &&
          t.unread_count > 0 &&
          t.is_archived === 0 &&
          t.sync_enabled === 1 &&
          t.labels.split(',').includes('action-needed')
      )
    this.deliver(threads)
  }

  /** The triage's daily model budget ran out with fresh threads unchecked —
   *  one quiet digest instead of notifying every thread unfiltered. */
  noteTriageDeferred(count: number): void {
    if (getSettings().notifyInbox !== 'important') return
    if (!Notification.isSupported()) return
    if (BrowserWindow.getFocusedWindow()) return
    this.notify(
      'WhatsApp triage paused',
      `Daily triage budget used — ${count} recent thread${count > 1 ? 's' : ''} not checked for urgency.`
    )
    logLine('info', 'comms', `triage-deferred digest sent (${count} threads)`)
  }

  /** The whatsapp triage flagged these threads as notification-worthy. */
  noteImportant(threadIds: string[]): void {
    if (getSettings().notifyInbox !== 'important') return
    const threads = threadIds
      .map((id) => repo.getThreadListItem(this.db, id))
      .filter(
        (t): t is CommsThreadListItem =>
          t !== null && t.unread_count > 0 && t.is_archived === 0 && t.sync_enabled === 1
      )
    this.deliver(threads)
  }

  private deliver(candidates: CommsThreadListItem[]): void {
    if (!Notification.isSupported()) return
    // focused window = the user is already looking at the app
    if (BrowserWindow.getFocusedWindow()) return
    const cutoff = new Date(Date.now() - RECENT_WINDOW_MS).toISOString()
    const fresh: CommsThreadListItem[] = []
    for (const t of candidates) {
      if (!t.last_message_at || t.last_message_at < cutoff) continue // backlog, not news
      const seen = this.notified.get(t.id)
      if (seen && seen >= t.last_message_at) continue
      // delete-then-set keeps Map iteration order = least-recently-touched,
      // so the cap evicts genuinely stale entries (true LRU)
      this.notified.delete(t.id)
      this.notified.set(t.id, t.last_message_at)
      if (this.notified.size > NOTIFIED_CAP) {
        const oldest = this.notified.keys().next().value
        if (oldest !== undefined) this.notified.delete(oldest)
      }
      fresh.push(t)
    }
    for (const t of fresh.slice(0, MAX_PER_BATCH)) this.show(t)
    // a labeler sweep can classify a batch of recent mail at once — coalesce
    // the overflow instead of firing a banner per thread
    const extra = fresh.length - MAX_PER_BATCH
    if (extra > 0) {
      this.notify('Inbox', `…and ${extra} more important message${extra > 1 ? 's' : ''}`)
      logLine('info', 'comms', `notification overflow coalesced: ${extra}`)
    }
  }

  private show(t: CommsThreadListItem): void {
    const title = t.person_name || t.title || 'New message'
    this.notify(title, t.snippet || '(no preview)', t.id)
    logLine('info', 'comms', `notified ${t.provider}/${t.kind}: "${title}"`)
  }

  private notify(title: string, body: string, threadId?: string): void {
    // second output: web push to any subscribed phone. Same trigger as the
    // banner (window unfocused ≈ away from the desk), no-op with no devices.
    sendPushAll({ title, body, threadId })
    const n = new Notification({ title, body, silent: false })
    n.on('click', () => {
      const win = createMainWindow()
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
      app.focus({ steal: true })
      this.onNavigate('inbox', threadId)
    })
    n.show()
  }
}

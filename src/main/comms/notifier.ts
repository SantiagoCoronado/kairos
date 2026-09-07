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
// Freshness and the banner body come from the thread's newest INBOUND
// message (gmail: newest UNREAD one — mail to yourself arrives unread there),
// never last_message_at/snippet — those follow your own reply from the phone
// too, which used to re-arm a banner quoting you to yourself.
import { Notification, BrowserWindow } from 'electron'
import type { DbDriver } from '../../core/driver'
import type { NavView } from '../../shared/ipc-contract'
import type { CommsProvider, CommsThreadListItem } from '../../core/comms-types'
import * as repo from '../../core/repo/comms'
import { getSettings } from '../settings'
import { sendPushAll } from '../remote/push'
import { logLine } from '../logger'

/** exported for the labeler: in notification-only mode it classifies just
 *  the mail fresh enough to still produce a banner */
export const RECENT_WINDOW_MS = 30 * 60_000
const NOTIFIED_CAP = 500
const MAX_PER_BATCH = 3

export class CommsNotifier {
  /** threadId → sent_at of the inbound message already notified; a newer one re-arms */
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
    const fresh: { thread: CommsThreadListItem; body: string }[] = []
    for (const t of candidates) {
      // gmail: UNREAD is authoritative and mail-to-self arrives unread, so the
      // subject is the newest unread message; elsewhere it's the newest one
      // someone else sent — your own reply from the phone is never news
      const subject =
        t.provider === 'gmail'
          ? repo.latestUnreadMessage(this.db, t.id)
          : repo.latestInboundMessage(this.db, t.id)
      if (!subject || subject.sent_at < cutoff) continue // backlog or self-only, not news
      const seen = this.notified.get(t.id)
      if (seen && seen >= subject.sent_at) continue
      // delete-then-set keeps Map iteration order = least-recently-touched,
      // so the cap evicts genuinely stale entries (true LRU)
      this.notified.delete(t.id)
      this.notified.set(t.id, subject.sent_at)
      if (this.notified.size > NOTIFIED_CAP) {
        const oldest = this.notified.keys().next().value
        if (oldest !== undefined) this.notified.delete(oldest)
      }
      fresh.push({ thread: t, body: subject.body_text.replace(/\s+/g, ' ').trim().slice(0, 120) })
    }
    for (const f of fresh.slice(0, MAX_PER_BATCH)) this.show(f.thread, f.body)
    // a labeler sweep can classify a batch of recent mail at once — coalesce
    // the overflow instead of firing a banner per thread
    const extra = fresh.length - MAX_PER_BATCH
    if (extra > 0) {
      this.notify('Inbox', `…and ${extra} more important message${extra > 1 ? 's' : ''}`)
      logLine('info', 'comms', `notification overflow coalesced: ${extra}`)
    }
  }

  private show(t: CommsThreadListItem, body: string): void {
    const title = t.person_name || t.title || 'New message'
    this.notify(title, body || '(no preview)', t.id)
    logLine('info', 'comms', `notified ${t.provider}/${t.kind}: "${title}"`)
  }

  private notify(title: string, body: string, threadId?: string): void {
    // second output: web push to any subscribed phone. Same trigger as the
    // banner (window unfocused ≈ away from the desk), no-op with no devices.
    sendPushAll({ title, body, threadId })
    const n = new Notification({ title, body, silent: false })
    n.on('click', () => this.onNavigate('inbox', threadId))
    n.show()
  }
}

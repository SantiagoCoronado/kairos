// CommsSyncManager — the one long-lived comms service in the Electron main
// process. Owns the per-account sync loops (Gmail/Slack polling, WhatsApp
// sockets) and the outbox drain. All sends — composer, agent, MCP — go
// through comms_outbox; the drain is the single delivery path.
import type { DbDriver } from '../../core/driver'
import type { CommsAccount } from '../../core/comms-types'
import type { CommsEvent, CommsSendInput, CommsSendResult } from '../../shared/ipc-contract'
import * as repo from '../../core/repo/comms'
import {
  connectGmail,
  syncGmailAccount,
  sendGmail,
  modifyGmailThread,
  modifyGmailMessage,
  trashGmailThread,
  GmailAuthError
} from './gmail'
import { connectSlack, syncSlackAccount, sendSlack, SlackAuthError } from './slack'
import { WhatsAppConnection, deleteWaAuthState } from './whatsapp'
import { loadMacContacts } from '../contacts'
import { logLine } from '../logger'

const GMAIL_INTERVAL_MS = 60_000
const SLACK_INTERVAL_MS = 90_000
const DRAIN_INTERVAL_MS = 3_000
const MAX_BACKOFF_MS = 5 * 60_000
const CHANGED_DEBOUNCE_MS = 500

export class CommsSyncManager {
  private timers = new Map<string, NodeJS.Timeout>()
  private failures = new Map<string, number>()
  private syncing = new Set<string>()
  private wa = new Map<string, WhatsAppConnection>()
  private drainTimer: NodeJS.Timeout | null = null
  private draining = false
  private contactsTimer: NodeJS.Timeout | null = null
  private changedTimer: NodeJS.Timeout | null = null
  private stopped = false

  constructor(
    private db: DbDriver,
    private emit: (e: CommsEvent) => void,
    private onDbChanged: () => void,
    /** fired once per sync batch that stored ≥1 new inbound unread message */
    private onInbound?: (provider: CommsAccount['provider']) => void
  ) {}

  start(): void {
    repo.requeueStuckSending(this.db)
    for (const account of repo.listAccounts(this.db)) {
      if (account.status === 'disabled' || account.status === 'needs_auth') continue
      this.startAccount(account)
    }
    this.drainTimer = setInterval(() => void this.drainOutbox(), DRAIN_INTERVAL_MS)
    // name WhatsApp chats from the macOS address book — at startup and then
    // periodically, since history chunks keep creating threads after boot
    void this.applyContactNames()
    this.contactsTimer = setInterval(() => void this.applyContactNames(), 5 * 60_000)
  }

  /** Sweep macOS Contacts names over placeholder WhatsApp threads/senders. */
  private async applyContactNames(): Promise<void> {
    const res = await loadMacContacts()
    if ('error' in res) return // no permission / helper missing: quietly skip
    const started = Date.now()
    let changed = false
    for (const account of repo.listAccounts(this.db)) {
      if (account.provider !== 'whatsapp') continue
      if (repo.applyContactNames(this.db, account.id, res.contacts)) changed = true
    }
    const ms = Date.now() - started
    if (ms > 200) logLine('warn', 'comms', `contacts sweep took ${ms}ms (${res.contacts.length} contacts)`)
    if (changed) this.notifyChanged()
    // second pass over the wire: resolve address-book phones to @lid chats
    for (const conn of this.wa.values()) {
      void conn.resolveContacts(res.contacts).catch(() => {})
    }
  }

  stop(): void {
    this.stopped = true
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
    if (this.drainTimer) clearInterval(this.drainTimer)
    if (this.contactsTimer) clearInterval(this.contactsTimer)
    if (this.changedTimer) clearTimeout(this.changedTimer)
    for (const conn of this.wa.values()) conn.stop()
    this.wa.clear()
  }

  private notifyChanged(): void {
    if (this.changedTimer) return
    this.changedTimer = setTimeout(() => {
      this.changedTimer = null
      this.onDbChanged()
    }, CHANGED_DEBOUNCE_MS)
  }

  // ---------- sync loops ----------

  private startAccount(account: CommsAccount): void {
    if (account.provider === 'whatsapp') {
      this.startWhatsApp(account.id)
    } else {
      this.scheduleSync(account.id, 0)
    }
  }

  private scheduleSync(accountId: string, delayMs: number): void {
    if (this.stopped) return
    const existing = this.timers.get(accountId)
    if (existing) clearTimeout(existing)
    this.timers.set(
      accountId,
      setTimeout(() => void this.runSync(accountId), delayMs)
    )
  }

  private async runSync(accountId: string): Promise<void> {
    if (this.stopped || this.syncing.has(accountId)) return
    const account = repo.getAccount(this.db, accountId)
    if (!account || account.provider === 'whatsapp') return
    if (account.status === 'disabled' || account.status === 'needs_auth') return

    const interval = account.provider === 'gmail' ? GMAIL_INTERVAL_MS : SLACK_INTERVAL_MS
    this.syncing.add(accountId)
    this.emit({ kind: 'sync', accountId, status: 'syncing' })
    const syncStartedAt = new Date().toISOString()
    try {
      const added =
        account.provider === 'gmail'
          ? await syncGmailAccount(this.db, account)
          : await syncSlackAccount(this.db, account)
      if (account.status === 'error') repo.setAccountStatus(this.db, accountId, 'connected')
      this.failures.delete(accountId)
      this.emit({ kind: 'sync', accountId, status: 'idle' })
      if (added > 0) this.notifyChanged()
      // `added` conflates outbound copies and gmail label changes — count the
      // actual new inbound unread rows for the automation trigger signal
      if (added > 0 && this.onInbound && repo.countNewInbound(this.db, accountId, syncStartedAt) > 0) {
        this.onInbound(account.provider)
      }
      this.scheduleSync(accountId, interval)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (err instanceof GmailAuthError || err instanceof SlackAuthError) {
        repo.setAccountStatus(this.db, accountId, 'needs_auth', message)
        this.emit({ kind: 'sync', accountId, status: 'needs_auth', message })
        this.notifyChanged()
        return // loop stops until the user reconnects
      }
      const fails = (this.failures.get(accountId) ?? 0) + 1
      this.failures.set(accountId, fails)
      repo.setAccountStatus(this.db, accountId, 'error', message)
      this.emit({ kind: 'sync', accountId, status: 'error', message })
      this.notifyChanged()
      this.scheduleSync(accountId, Math.min(interval * 2 ** fails, MAX_BACKOFF_MS))
    } finally {
      this.syncing.delete(accountId)
    }
  }

  syncNow(accountId?: string): void {
    void this.applyContactNames()
    const accounts = accountId
      ? [repo.getAccount(this.db, accountId)].filter(Boolean)
      : repo.listAccounts(this.db)
    for (const account of accounts as CommsAccount[]) {
      if (account.provider === 'whatsapp') continue // event-driven, nothing to poll
      if (account.status === 'disabled' || account.status === 'needs_auth') continue
      this.scheduleSync(account.id, 0)
    }
  }

  // ---------- read / archive ----------

  private onGmailModifyError(accountId: string, action: string, err: unknown): string {
    const message = err instanceof Error ? err.message : String(err)
    if (err instanceof GmailAuthError) {
      repo.setAccountStatus(this.db, accountId, 'needs_auth', message)
      this.emit({ kind: 'sync', accountId, status: 'needs_auth', message })
      this.notifyChanged()
    } else {
      logLine('warn', 'comms', `gmail ${action} failed: ${message}`)
    }
    return message
  }

  /** Mark read locally right away; propagate to Gmail in the background. */
  markRead(threadId: string): void {
    const thread = repo.getThread(this.db, threadId)
    if (!thread) return
    repo.markThreadRead(this.db, threadId)
    this.notifyChanged()
    if (thread.provider !== 'gmail') return
    const account = repo.getAccount(this.db, thread.account_id)
    if (!account || account.status !== 'connected') return
    void modifyGmailThread(this.db, account, thread.external_id, { removeLabelIds: ['UNREAD'] }).catch(
      (err) => this.onGmailModifyError(account.id, 'mark-read', err)
    )
  }

  /** Mark unread locally right away; re-add UNREAD in Gmail in the background. */
  markUnread(threadId: string): void {
    const thread = repo.getThread(this.db, threadId)
    if (!thread) return
    const externalId = repo.markThreadUnread(this.db, threadId)
    this.notifyChanged()
    if (!externalId || thread.provider !== 'gmail') return
    const account = repo.getAccount(this.db, thread.account_id)
    if (!account || account.status !== 'connected') return
    void modifyGmailMessage(this.db, account, externalId, { addLabelIds: ['UNREAD'] }).catch(
      (err) => this.onGmailModifyError(account.id, 'mark-unread', err)
    )
  }

  /** Archive/unarchive. Gmail archives remotely first; other providers are local-only. */
  async setThreadArchived(
    threadId: string,
    archived: boolean
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    const thread = repo.getThread(this.db, threadId)
    if (!thread) return { ok: false, message: 'unknown thread' }
    if (thread.provider === 'gmail') {
      const account = repo.getAccount(this.db, thread.account_id)
      if (!account) return { ok: false, message: 'unknown account' }
      try {
        await modifyGmailThread(this.db, account, thread.external_id, {
          [archived ? 'removeLabelIds' : 'addLabelIds']: ['INBOX']
        })
      } catch (err) {
        return { ok: false, message: this.onGmailModifyError(account.id, 'archive', err) }
      }
    }
    repo.setThreadArchived(this.db, threadId, archived)
    this.notifyChanged()
    return { ok: true }
  }

  /** Email-only delete: trash the thread in Gmail, then drop it locally. */
  async deleteThread(threadId: string): Promise<{ ok: true } | { ok: false; message: string }> {
    const thread = repo.getThread(this.db, threadId)
    if (!thread) return { ok: false, message: 'unknown thread' }
    if (thread.provider !== 'gmail') return { ok: false, message: 'only emails can be deleted' }
    const account = repo.getAccount(this.db, thread.account_id)
    if (!account) return { ok: false, message: 'unknown account' }
    try {
      await trashGmailThread(this.db, account, thread.external_id)
    } catch (err) {
      return { ok: false, message: this.onGmailModifyError(account.id, 'trash', err) }
    }
    repo.deleteThread(this.db, threadId)
    this.notifyChanged()
    return { ok: true }
  }

  // ---------- connect / disconnect ----------

  async connectGmail(): Promise<CommsAccount> {
    const account = await connectGmail(this.db)
    this.emit({ kind: 'sync', accountId: account.id, status: 'connected' })
    this.notifyChanged()
    this.scheduleSync(account.id, 0)
    return account
  }

  async connectSlack(): Promise<CommsAccount> {
    const account = await connectSlack(this.db)
    this.emit({ kind: 'sync', accountId: account.id, status: 'connected' })
    this.notifyChanged()
    this.scheduleSync(account.id, 0)
    return account
  }

  /** Provisions the account and starts the QR flow; pairing completes via comms:event. */
  connectWhatsApp(): CommsAccount {
    // reuse an existing linking/relink-needed account instead of stacking new ones
    const existing = repo
      .listAccounts(this.db)
      .find((a) => a.provider === 'whatsapp' && a.status === 'needs_auth')
    const account =
      existing ??
      repo.upsertAccount(this.db, {
        provider: 'whatsapp',
        external_id: `pending:${Date.now()}`,
        display_name: 'WhatsApp (linking…)',
        status: 'needs_auth'
      })
    // a fresh QR pairing needs clean session state
    this.wa.get(account.id)?.stop()
    this.wa.delete(account.id)
    deleteWaAuthState(account.id)
    this.startWhatsApp(account.id)
    this.notifyChanged()
    return account
  }

  private startWhatsApp(accountId: string): void {
    if (this.wa.has(accountId)) return
    const conn = new WhatsAppConnection(this.db, accountId, {
      emit: (e) => this.emit(e),
      onChanged: () => this.notifyChanged(),
      onInbound: () => this.onInbound?.('whatsapp')
    })
    this.wa.set(accountId, conn)
    void conn.start().catch((err) => {
      repo.setAccountStatus(this.db, accountId, 'error', err instanceof Error ? err.message : String(err))
      this.emit({ kind: 'sync', accountId, status: 'error', message: String(err) })
      this.wa.delete(accountId)
    })
  }

  disconnect(accountId: string): void {
    const timer = this.timers.get(accountId)
    if (timer) clearTimeout(timer)
    this.timers.delete(accountId)
    const conn = this.wa.get(accountId)
    if (conn) {
      conn.stop()
      this.wa.delete(accountId)
      deleteWaAuthState(accountId)
    }
    repo.deleteAccount(this.db, accountId)
    this.notifyChanged()
  }

  // ---------- sends ----------

  /** Composer path: enqueue + dispatch immediately for synchronous feedback. */
  async sendNow(input: CommsSendInput): Promise<CommsSendResult> {
    const account = repo.getAccount(this.db, input.accountId)
    if (!account) return { ok: false, message: 'unknown account' }
    if (account.provider === 'gmail' && !input.threadId && (!input.to?.length || !input.subject)) {
      return { ok: false, message: 'a new email needs recipients and a subject' }
    }
    if (account.provider !== 'gmail' && !input.threadId) {
      return { ok: false, message: 'pick a conversation to send into' }
    }
    const item = repo.enqueueOutbox(this.db, {
      account_id: account.id,
      thread_id: input.threadId ?? null,
      provider: account.provider,
      to_json: JSON.stringify(
        account.provider === 'gmail' ? { to: input.to, subject: input.subject } : {}
      ),
      body_text: input.body,
      source: 'app'
    })
    const [claimed] = repo.claimQueued(this.db, 1)
    // the 3 s drain may already have grabbed it; either way it gets delivered
    if (claimed && claimed.id === item.id) {
      const err = await this.dispatch(claimed.id)
      if (err) return { ok: false, message: err }
    }
    return { ok: true, outboxId: item.id }
  }

  private async drainOutbox(): Promise<void> {
    if (this.draining || this.stopped) return
    this.draining = true
    try {
      for (const item of repo.claimQueued(this.db)) {
        await this.dispatch(item.id)
      }
    } finally {
      this.draining = false
    }
  }

  /** Deliver one claimed outbox item. Returns an error message, or null on success. */
  private async dispatch(outboxId: string): Promise<string | null> {
    const item = repo.getOutboxItem(this.db, outboxId)
    if (!item) return 'outbox item vanished'
    const account = repo.getAccount(this.db, item.account_id)
    if (!account) {
      repo.finishOutbox(this.db, item.id, { ok: false, error: 'account was disconnected' })
      return 'account was disconnected'
    }
    try {
      let externalId: string
      if (account.provider === 'gmail') {
        externalId = await sendGmail(this.db, account, item)
      } else if (account.provider === 'slack') {
        externalId = await sendSlack(this.db, account, item)
      } else {
        const conn = this.wa.get(account.id)
        if (!conn) throw new Error('WhatsApp is not connected')
        externalId = await conn.send(item)
      }
      repo.finishOutbox(this.db, item.id, { ok: true, external_id: externalId })
      this.notifyChanged()
      return null
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      repo.finishOutbox(this.db, item.id, { ok: false, error: message })
      this.notifyChanged()
      return message
    }
  }
}

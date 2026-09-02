// WhatsApp provider via Baileys — an UNOFFICIAL WebSocket bridge (same
// protocol as WhatsApp Web, linked by QR). This violates WhatsApp's ToS and
// carries a small account-ban risk; the user opted in knowingly.
import { join } from 'node:path'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import {
  makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  proto,
  DisconnectReason,
  Browsers,
  type AnyMessageContent,
  type WASocket,
  type WAMessage,
  type WAMessageKey
} from 'baileys'
import { toDataURL } from 'qrcode'
import type { DbDriver } from '../../core/driver'
import type { OutboundAttachment, OutboxItem } from '../../core/comms-types'
import type { CommsEvent } from '../../shared/ipc-contract'
import * as repo from '../../core/repo/comms'
import { deliveredMap, pendingUnits, sendUnits } from '../../core/outbox-units'
import { DATA_DIR } from '../db'
import { logLine } from '../logger'
import { LidBook, isGroupJid, isLidJid, isPnJid, jidUser } from './wa-lid'

const WA_DIR = join(DATA_DIR, 'wa')

export const waAuthDir = (accountId: string): string => join(WA_DIR, accountId)

// Baileys wants a pino-ish logger; keep it silent.
interface SilentLogger {
  level: string
  child: (o?: object) => SilentLogger
  trace: (...a: unknown[]) => void
  debug: (...a: unknown[]) => void
  info: (...a: unknown[]) => void
  warn: (...a: unknown[]) => void
  error: (...a: unknown[]) => void
}
const silentLogger: SilentLogger = {
  level: 'silent',
  child: () => silentLogger,
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {}
}

// @lid is WhatsApp's privacy-preserving chat id — most modern DMs use it
// instead of the phone-number jid, so it MUST be accepted as a chat.
const isChatJid = (jid: string | null | undefined): jid is string =>
  Boolean(jid && (isPnJid(jid) || isGroupJid(jid) || isLidJid(jid)))

function extractText(msg: WAMessage): { text: string; hasAttachment: boolean } {
  const m = msg.message
  if (!m) return { text: '', hasAttachment: false }
  if (m.conversation) return { text: m.conversation, hasAttachment: false }
  if (m.extendedTextMessage?.text) return { text: m.extendedTextMessage.text, hasAttachment: false }
  if (m.imageMessage) return { text: m.imageMessage.caption || '[image]', hasAttachment: true }
  if (m.videoMessage) return { text: m.videoMessage.caption || '[video]', hasAttachment: true }
  if (m.audioMessage) return { text: '[voice message]', hasAttachment: true }
  if (m.documentMessage) return { text: `[file] ${m.documentMessage.fileName ?? ''}`.trim(), hasAttachment: true }
  if (m.stickerMessage) return { text: '[sticker]', hasAttachment: true }
  if (m.locationMessage) return { text: '[location]', hasAttachment: false }
  if (m.contactMessage) return { text: '[contact card]', hasAttachment: false }
  return { text: '', hasAttachment: false }
}

/** proto int64s arrive as Long instances — collapse to a plain number */
const toNum = (v: unknown): number | null => {
  if (typeof v === 'number') return v
  if (v && typeof v === 'object' && 'toNumber' in v) return (v as { toNumber: () => number }).toNumber()
  return v == null ? null : Number(v)
}

/** Attachment metadata for a media message, or null for text/protocol messages. */
function mediaMeta(msg: WAMessage): { filename: string; mime_type: string; size_bytes: number | null } | null {
  const m = msg.message
  if (!m) return null
  const doc = m.documentMessage
  const media = doc ?? m.imageMessage ?? m.videoMessage ?? m.audioMessage ?? m.stickerMessage
  if (!media) return null
  const mime = media.mimetype ?? ''
  const ext = mime.split('/')[1]?.split(';')[0] || 'bin'
  const filename =
    doc?.fileName ||
    (m.imageMessage ? `photo.${ext}` : m.videoMessage ? `video.${ext}` : m.audioMessage ? `audio.${ext}` : m.stickerMessage ? `sticker.${ext}` : `file.${ext}`)
  return { filename, mime_type: mime, size_bytes: toNum(media.fileLength) }
}

interface WaOpts {
  emit: (e: CommsEvent) => void
  onChanged: () => void
  /** fired once per live-message batch that stored ≥1 new inbound message */
  onInbound?: () => void
}

/** watchdog sweep cadence, and how long a connect attempt may stay pending */
const WATCHDOG_MS = 60_000
const CONNECT_GRACE_MS = 90_000

export class WhatsAppConnection {
  private sock: WASocket | null = null
  private stopped = false
  /** set while the Mac is asleep — see pause()/resume() */
  private paused = false
  /** true between connection.update open and close — the socket's own view */
  private open = false
  private reconnectTimer: NodeJS.Timeout | null = null
  private reconnectDelay = 2_000
  private watchdog: NodeJS.Timeout | null = null
  private lastAttemptAt = 0
  /** jid → chat/contact display name, fed by history + contact events */
  private names = new Map<string, string>()
  /** jids whose name came from a message pushName — contact-store names win */
  private pushNamed = new Set<string>()
  /** set by ingest() when a pushName taught us a new chat name — the batch
   *  handler then sweeps placeholder threads (cleared by applyNames) */
  private namesLearned = false
  /** names already swept into the DB, so applyNames stays incremental */
  private appliedNames = new Map<string, string>()
  /** address-book phones already looked up via onWhatsApp this session */
  private queriedPhones = new Set<string>()
  /** lid ↔ phone jid pairings — the thread key is the phone jid once known */
  private lids = new LidBook()
  /** lids already folded (or found to have no thread) — one fold per lid per session */
  private absorbed = new Set<string>()
  /** lids already asked of the mapping store this socket — a miss is a file read each time */
  private tried = new Set<string>()

  constructor(
    private db: DbDriver,
    private accountId: string,
    private opts: WaOpts
  ) {}

  private tag(): string {
    return `wa ${this.accountId.slice(0, 8)}`
  }

  /**
   * Connect (or reconnect). Never leaves the connection silently dead: a
   * failed attempt logs and schedules a retry, and the watchdog recycles
   * sockets that die without ever emitting a close event.
   */
  async start(): Promise<void> {
    if (this.stopped || this.paused) return
    this.lastAttemptAt = Date.now()
    if (!this.watchdog) this.watchdog = setInterval(() => this.checkAlive(), WATCHDOG_MS)
    try {
      await this.connect()
    } catch (err) {
      logLine(
        'warn',
        'comms',
        `${this.tag()} connect failed: ${err instanceof Error ? err.message : String(err)}`
      )
      this.scheduleReconnect('connect failed')
    }
  }

  private scheduleReconnect(reason: string): void {
    if (this.stopped || this.paused || this.reconnectTimer) return
    const delay = this.reconnectDelay
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 60_000)
    logLine('info', 'comms', `${this.tag()} reconnecting in ${Math.round(delay / 1000)}s (${reason})`)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.start()
    }, delay)
  }

  /** Recycle a socket that died without a close event (or never came up). */
  private checkAlive(): void {
    if (this.stopped || this.paused || this.reconnectTimer) return
    if (this.open && this.sock?.ws.isOpen) return
    if (Date.now() - this.lastAttemptAt < CONNECT_GRACE_MS) return // still connecting
    logLine(
      'warn',
      'comms',
      `${this.tag()} watchdog: socket dead (open=${this.open}, ws=${
        this.sock ? (this.sock.ws.isOpen ? 'open' : 'closed') : 'none'
      }) — recycling`
    )
    this.sock?.end(undefined)
    this.sock = null
    this.open = false
    void this.start()
  }

  private async connect(): Promise<void> {
    const dir = waAuthDir(this.accountId)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const { state, saveCreds } = await useMultiFileAuthState(dir)
    const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }))
    this.tried.clear() // the store may have learned pairings since the last socket

    const sock = makeWASocket({
      version,
      auth: state,
      logger: silentLogger as never,
      markOnlineOnConnect: false,
      // history is only pushed at pairing time — ask for all of it then
      syncFullHistory: true,
      // Baileys defaults to Browsers.ubuntu(...), which mislabels every
      // linked-device sync notification on the phone as "Ubuntu" even though
      // this runs on macOS
      browser: Browsers.macOS('Kairos')
    })
    this.sock = sock

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('connection.update', (update) => {
      void (async () => {
        if (update.qr) {
          // a QR while the account believes it's connected means the stored
          // session no longer authenticates — without this the QR goes to a
          // closed Settings modal and the account looks fine while dead
          const account = repo.getAccount(this.db, this.accountId)
          if (account?.status === 'connected') {
            logLine('warn', 'comms', `${this.tag()} session invalid — QR re-link required`)
            repo.setAccountStatus(this.db, this.accountId, 'needs_auth', 're-link required — Settings → Connections → + WhatsApp')
            this.opts.emit({ kind: 'sync', accountId: this.accountId, status: 'needs_auth', message: 're-link required' })
            this.opts.onChanged()
            this.stop() // no point looping QR sockets nobody is watching
            return
          }
          const qrDataUrl = await toDataURL(update.qr, { margin: 1, width: 320 })
          this.opts.emit({ kind: 'wa_qr', accountId: this.accountId, qrDataUrl })
        }
        if (update.connection === 'open') {
          this.open = true
          this.reconnectDelay = 2_000
          const jid = sock.user?.id ?? ''
          const phone = jidUser(jid)
          logLine('info', 'comms', `${this.tag()} connected as +${phone}`)
          repo.updateAccountIdentity(this.db, this.accountId, jid || this.accountId, `+${phone}`)
          this.opts.emit({ kind: 'sync', accountId: this.accountId, status: 'connected' })
          this.opts.onChanged()
          // chats keyed by a lid whose phone jid is now known fold into the
          // phone thread — heals splits left by earlier sessions
          await this.reconcileLidThreads()
          // group subjects never arrive with messages — fetch them all once
          try {
            const groups = await sock.groupFetchAllParticipating()
            for (const [gid, meta] of Object.entries(groups)) {
              if (meta.subject) this.applyGroupSubject(gid, meta.subject)
            }
            this.applyNames()
          } catch {
            // non-fatal: groups stay titled by chat-name events
          }
        }
        if (update.connection === 'close') {
          this.open = false
          const err = update.lastDisconnect?.error as
            | (Error & { output?: { statusCode?: number } })
            | undefined
          const statusCode = err?.output?.statusCode
          logLine(
            'info',
            'comms',
            `${this.tag()} closed (code ${statusCode ?? '?'}: ${err?.message ?? 'unknown'})`
          )
          if (statusCode === DisconnectReason.loggedOut) {
            logLine('warn', 'comms', `${this.tag()} logged out from phone — re-link required`)
            repo.setAccountStatus(this.db, this.accountId, 'needs_auth', 'logged out from phone')
            this.opts.emit({ kind: 'sync', accountId: this.accountId, status: 'needs_auth' })
            this.opts.onChanged()
            // stop for real, like the invalid-session QR branch above: nothing
            // reconnects until a re-link, and a half-alive connection would
            // keep willReconnect() true — making the outbox drain defer this
            // account's rows forever instead of failing them honestly
            this.stop()
            return
          }
          this.scheduleReconnect(`close ${statusCode ?? '?'}`)
        }
      })()
    })

    sock.ev.on('contacts.upsert', (contacts) => {
      for (const c of contacts) this.addContact(c)
      this.applyNames()
    })
    sock.ev.on('contacts.update', (contacts) => {
      for (const c of contacts) this.addContact(c as Parameters<WhatsAppConnection['addContact']>[0])
      this.applyNames()
    })

    sock.ev.on('messaging-history.set', ({ chats, contacts, messages, lidPnMappings }) => {
      void this.guard('history', async () => {
        if (this.stopped) return
        for (const m of lidPnMappings ?? []) this.learnPair(m.lid, m.pn)
        for (const c of contacts ?? []) this.addContact(c)
        for (const c of chats ?? []) {
          if (!c.id) continue
          if (c.name) this.names.set(c.id, c.name)
          // history chats carry both ids of a DM peer
          this.learnPair(c.id, c.lidJid)
          this.learnPair(c.id, c.pnJid)
          this.learnPair(c.lidJid, c.pnJid)
        }
        await this.resolveLids((messages ?? []).map((m) => m.key))
        // history arrives already-read
        for (const msg of messages ?? []) this.ingest(msg, true)
        // lid chats this chunk created before a later chunk taught the phone
        await this.reconcileLidThreads()
        // names and messages come in separate chunks, in either order — retitle
        // whatever placeholder threads the name book can now resolve
        this.applyNames()
        this.opts.onChanged()
      })
    })

    sock.ev.on('messages.upsert', ({ messages, type }) => {
      void this.guard('messages', async () => {
        if (this.stopped) return
        // inbound keys carry the phone jid next to the lid; outbound ones may
        // not — ask the mapping store before a lid picks the thread
        await this.resolveLids(messages.map((m) => m.key))
        let any = false
        let inbound = false
        for (const msg of messages) {
          if (this.ingest(msg, type !== 'notify')) {
            any = true
            if (type === 'notify' && !msg.key.fromMe) inbound = true
          }
        }
        // a pushName may have just named a chat that already exists as a
        // placeholder thread — sweep so the list fixes itself immediately
        if (this.namesLearned) this.applyNames()
        if (any) this.opts.onChanged()
        if (inbound) this.opts.onInbound?.()
      })
    })

    // groups created or renamed after connect: subjects arrive out-of-band
    sock.ev.on('groups.upsert', (metas) => {
      for (const g of metas) this.applyGroupSubject(g.id, g.subject)
    })
    sock.ev.on('groups.update', (updates) => {
      for (const g of updates) this.applyGroupSubject(g.id, g.subject)
    })

    // a pairing Baileys learns live (envelope alt jids, USync) — the trigger
    // for folding a lid thread the connect sweep could not resolve
    sock.ev.on('lid-mapping.update', (m) => {
      if (this.learnPair(m.lid, m.pn)) void this.guard('lid-mapping', () => this.reconcileLidThreads())
    })

    // read state mirrored from the phone via app-state sync: reading a chat
    // there emits unreadCount 0, marking it unread emits -1 (baileys
    // chat-utils); positive counts are increments our own ingest already tracks
    sock.ev.on('chats.update', (updates) => {
      let changed = false
      for (const c of updates) {
        if (!c.id) continue
        if (c.name) this.names.set(c.id, c.name)
        if (typeof c.unreadCount !== 'number') continue
        const thread = repo.getThreadByExternal(this.db, this.accountId, this.lids.canonical(c.id))
        if (!thread) continue
        if (c.unreadCount === 0 && thread.unread_count > 0) {
          repo.markThreadRead(this.db, thread.id)
          changed = true
        } else if (c.unreadCount === -1 && thread.unread_count === 0) {
          repo.markThreadUnread(this.db, thread.id)
          changed = true
        }
      }
      if (changed) this.opts.onChanged()
    })
  }

  /** Contact records carry the lid AND the phone jid — key the name under every form. */
  private addContact(c: {
    id?: string
    lid?: string
    phoneNumber?: string
    name?: string
    notify?: string
    verifiedName?: string
  }): void {
    for (const [a, b] of [
      [c.id, c.lid],
      [c.id, c.phoneNumber],
      [c.lid, c.phoneNumber]
    ]) {
      this.learnPair(a, b)
    }
    const name = c.name || c.notify || c.verifiedName
    if (!name) return
    for (const j of [c.id, c.lid, c.phoneNumber]) {
      if (j) {
        this.names.set(j, name)
        this.pushNamed.delete(j) // contact-store name outranks a pushName
      }
    }
  }

  /** A name known under any jid of the account — canonical first. */
  private nameFor(jid: string): string | undefined {
    for (const alias of this.lids.aliases(jid)) {
      const name = this.names.get(alias)
      if (name) return name
    }
    return undefined
  }

  /** Event handlers are async now (mapping lookups) — never let one reject unseen. */
  private guard(what: string, fn: () => Promise<void>): Promise<void> {
    return fn().catch((err) => {
      logLine('warn', 'comms', `${this.tag()} ${what} handler failed: ${err instanceof Error ? err.message : String(err)}`)
    })
  }

  /**
   * Every pairing goes through here. A new one rewrites the lid-digit sender
   * handles already stored (group participants included — they never get a
   * thread of their own) and un-memoizes the names so applyNames() re-applies
   * them under the phone handle. A lid moving to another phone is logged:
   * numbers get recycled, and a wrong pair would fold the wrong threads.
   */
  private learnPair(a?: string | null, b?: string | null): boolean {
    const learned = this.lids.learn(a, b)
    if (!learned) return false
    const lid = isLidJid(a ?? '') ? String(a) : String(b)
    const pn = this.lids.pnFor(lid)!
    if (learned === 'remap') logLine('warn', 'comms', `${this.tag()} lid ${lid} now maps to ${pn}`)
    for (const j of [lid, pn]) this.appliedNames.delete(j)
    try {
      repo.replaceSenderHandle(this.db, this.accountId, 'whatsapp', jidUser(lid), jidUser(pn))
    } catch (err) {
      logLine('warn', 'comms', `${this.tag()} handle rewrite failed for ${lid}: ${err instanceof Error ? err.message : String(err)}`)
    }
    return true
  }

  /**
   * Learn every lid/phone pairing the keys disclose (inbound live messages
   * carry remoteJidAlt / participantAlt), then ask Baileys' persisted
   * mapping store about the lids still unknown. A local file read, no network.
   */
  private async resolveLids(keys: WAMessageKey[]): Promise<void> {
    const want = new Set<string>()
    for (const k of keys) {
      for (const [jid, alt] of [
        [k.remoteJid, k.remoteJidAlt],
        [k.participant, k.participantAlt]
      ]) {
        if (!jid) continue
        if (alt) this.learnPair(jid, alt)
        else if (isLidJid(jid)) want.add(jid)
      }
    }
    await this.lookupLids([...want])
  }

  /** Ask the store once per lid per socket — a miss is one file read, and the
   *  same unmapped lid would otherwise be re-read on every batch. */
  private async lookupLids(lids: string[]): Promise<boolean> {
    const sock = this.sock
    const ask = this.lids.unresolved(lids).filter((l) => !this.tried.has(l))
    if (ask.length === 0 || !sock) return false
    for (const l of ask) this.tried.add(l)
    let learned = false
    try {
      const pairs = await sock.signalRepository.lidMapping.getPNsForLIDs(ask)
      for (const p of pairs ?? []) if (this.learnPair(p.lid, p.pn)) learned = true
    } catch (err) {
      logLine('warn', 'comms', `${this.tag()} lid lookup failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    return learned
  }

  /**
   * A thread keyed by `lidJid` becomes part of the `pnJid` thread — merged
   * into it when one exists, re-keyed in place otherwise — in one transaction
   * (repo.foldLidThread). Once a pairing is known upsertThread only ever sees
   * the phone jid, so a lid is looked at once per session either way. Never
   * throws: a failed fold must not take the rest of an ingest batch with it.
   */
  private absorbLidThread(lidJid: string, pnJid: string): boolean {
    if (this.absorbed.has(lidJid)) return false
    this.absorbed.add(lidJid)
    try {
      const r = repo.foldLidThread(this.db, this.accountId, lidJid, pnJid, this.nameFor(pnJid))
      if (r.action === 'none') return false
      logLine(
        'info',
        'comms',
        `${this.tag()} ${r.action} lid chat ${lidJid} → ${pnJid} (${r.messages} messages, ${r.handles} handles)`
      )
      return true
    } catch (err) {
      this.absorbed.delete(lidJid) // retry on the next message / sweep
      logLine('warn', 'comms', `${this.tag()} fold ${lidJid} → ${pnJid} failed: ${err instanceof Error ? err.message : String(err)}`)
      return false
    }
  }

  /**
   * Fold every lid-keyed thread whose phone jid the mapping store knows, and
   * rewrite lid-digit sender handles whose pairing it knows (group-only
   * participants have handles but no thread). Runs at connect, after each
   * history chunk, and whenever a pairing is learned out-of-band.
   */
  private async reconcileLidThreads(): Promise<void> {
    if (this.stopped) return
    const lidThreads = repo
      .listAccountThreads(this.db, this.accountId)
      .filter((t) => isLidJid(t.external_id) && !this.absorbed.has(t.external_id))
    // handles that key a phone thread or are a paired phone are numbers, not
    // lids — never fabricate `<phone>@lid` from them (see listInboundSenderHandles)
    const handleLids = repo
      .listInboundSenderHandles(this.db, this.accountId)
      .filter((h) => !this.lids.isKnownPn(h))
      .map((h) => `${h}@lid`)
    await this.lookupLids([...lidThreads.map((t) => t.external_id), ...handleLids])
    let changed = false
    for (const t of lidThreads) {
      const pn = this.lids.pnFor(t.external_id)
      if (pn && this.absorbLidThread(t.external_id, pn)) changed = true
    }
    if (changed) {
      this.applyNames()
      this.opts.onChanged()
    }
  }

  /** Group subjects arrive out-of-band; a rename must overwrite the old real title too. */
  private applyGroupSubject(gid?: string | null, subject?: string | null): void {
    if (!gid || !subject) return
    this.names.set(gid, subject)
    const thread = repo.getThreadByExternal(this.db, this.accountId, gid)
    if (thread && thread.title !== subject) {
      repo.setThreadTitle(this.db, thread.id, subject)
      this.opts.onChanged()
    }
  }

  private static isPlaceholder(title: string): boolean {
    return repo.isPlaceholderTitle(title)
  }

  /** Retitle placeholder threads and fix placeholder sender names from the name book. */
  private applyNames(): void {
    this.namesLearned = false
    if (this.names.size === 0) return
    const started = Date.now()
    let changed = false
    this.db.transaction(() => {
      for (const thread of repo.listAccountThreads(this.db, this.accountId)) {
        if (!WhatsAppConnection.isPlaceholder(thread.title)) continue
        const name = this.nameFor(thread.external_id)
        if (name) {
          repo.setThreadTitle(this.db, thread.id, name)
          changed = true
        }
      }
      for (const [jid, name] of this.names) {
        if (isGroupJid(jid) || this.appliedNames.get(jid) === name) continue
        this.appliedNames.set(jid, name)
        // messages carry the phone handle once the lid is known, the lid before
        for (const alias of this.lids.aliases(jid)) {
          if (repo.updateSenderNames(this.db, this.accountId, jidUser(alias), name) > 0) changed = true
        }
      }
    })
    const ms = Date.now() - started
    if (ms > 200) logLine('warn', 'comms', `wa applyNames swept ${this.names.size} names in ${ms}ms`)
    if (changed) this.opts.onChanged()
  }

  /** returns true if the message was new */
  private ingest(msg: WAMessage, asRead: boolean): boolean {
    const rawChat = msg.key.remoteJid
    if (!isChatJid(rawChat)) return false // status broadcasts, newsletters, …
    const { text, hasAttachment } = extractText(msg)
    if (!text && !hasAttachment) return false // protocol/reaction/poll noise

    // one chat, one thread: a lid resolves to its phone jid when known, and a
    // thread an earlier session keyed by the lid folds into the phone thread
    const chatJid = this.lids.canonical(rawChat)
    if (chatJid !== rawChat) this.absorbLidThread(rawChat, chatJid)
    const isGroup = isGroupJid(chatJid)
    const isMe = Boolean(msg.key.fromMe)
    const senderJid = isGroup ? this.lids.canonical(msg.key.participant ?? '') : chatJid
    // DMs: an inbound pushName is the chat's name when nothing better is
    // known. Feeding it into the name book (not just this message's title)
    // is what keeps outbound messages from re-computing 'WhatsApp chat' and
    // lets applyNames() fix an already-placeholder thread.
    if (!isGroup && !isMe && msg.pushName) {
      const known = this.nameFor(chatJid)
      if (!known || (this.pushNamed.has(chatJid) && known !== msg.pushName)) {
        this.names.set(chatJid, msg.pushName)
        this.pushNamed.add(chatJid)
        this.namesLearned = true
      }
    }
    // lid jids are opaque ids, not phone numbers — never render them as "+…"
    const jidLabel = (jid: string): string =>
      isLidJid(jid) || isGroupJid(jid) ? 'WhatsApp chat' : `+${jidUser(jid)}`
    const title =
      this.nameFor(chatJid) ||
      (isGroup ? 'Group' : msg.pushName && !isMe ? msg.pushName : '') ||
      jidLabel(chatJid)

    const thread = repo.upsertThread(this.db, {
      account_id: this.accountId,
      provider: 'whatsapp',
      external_id: chatJid,
      kind: isGroup ? 'group' : 'dm',
      title
    })
    const ts = Number(msg.messageTimestamp ?? 0) * 1000
    const externalId = msg.key.id ?? `${chatJid}:${ts}`
    // media messages keep their full content node (proto → base64-safe JSON)
    // so downloadMediaMessage() can fetch the bytes later; text messages only
    // need the key, and only inbound (read receipts)
    const meta = hasAttachment ? mediaMeta(msg) : null
    const media = meta && msg.message ? proto.Message.fromObject(msg.message).toJSON() : undefined
    const rawJson =
      media || !isMe ? JSON.stringify({ key: msg.key, ...(media ? { media } : {}) }) : undefined
    const added = repo.upsertMessage(this.db, {
      thread_id: thread.id,
      account_id: this.accountId,
      provider: 'whatsapp',
      external_id: externalId,
      sender_name: isMe ? 'me' : msg.pushName || this.nameFor(senderJid) || jidLabel(senderJid),
      sender_handle: jidUser(senderJid),
      is_me: isMe,
      sent_at: new Date(ts || Date.now()).toISOString(),
      body_text: text,
      has_attachments: hasAttachment,
      is_read: asRead,
      // the full key (incl. group participant jid) is what readMessages()
      // needs to send a read receipt for this message later
      raw_json: rawJson
    })
    if (added && meta) {
      const row = repo.getMessageByExternal(this.db, this.accountId, externalId)
      if (row) repo.addAttachments(this.db, row.id, [{ ...meta, external_ref: externalId }])
    }
    return added
  }

  /** Fetch a media message's bytes via its stored proto node. */
  async downloadMedia(rawJson: string | null): Promise<Buffer> {
    if (!this.sock || this.stopped) throw new Error('WhatsApp is not connected')
    if (!rawJson) throw new Error('message was synced before attachment support')
    const parsed = JSON.parse(rawJson) as { key?: WAMessageKey; media?: Record<string, unknown> }
    if (!parsed.key || !parsed.media) throw new Error('message was synced before attachment support')
    const wamsg = {
      key: parsed.key,
      message: proto.Message.fromObject(parsed.media)
    } as WAMessage
    return (await downloadMediaMessage(
      wamsg,
      'buffer',
      {},
      // expired CDN urls get refreshed through the live socket
      { logger: silentLogger as never, reuploadRequest: this.sock.updateMediaMessage }
    )) as Buffer
  }

  /**
   * Send read receipts to the phone for a thread's still-unread inbound
   * messages. Must run BEFORE the local mark-read flips is_read (the unread
   * rows ARE the receipt list). Fire-and-forget: a receipt failure never
   * blocks the local state change.
   */
  sendReadReceipts(threadId: string): void {
    if (!this.sock || this.stopped) return
    const keys: WAMessageKey[] = []
    for (const m of repo.unreadInboundMessages(this.db, threadId)) {
      if (!m.raw_json) continue // rows ingested before receipt support
      try {
        const { key } = JSON.parse(m.raw_json) as { key?: WAMessageKey }
        if (key?.remoteJid && key.id) keys.push(key)
      } catch {
        // corrupt raw_json: skip this message
      }
    }
    if (keys.length === 0) return
    void this.sock.readMessages(keys).catch((err) => {
      logLine('warn', 'comms', `wa read receipts failed: ${err instanceof Error ? err.message : String(err)}`)
    })
  }

  /**
   * Bridge the macOS address book into @lid chats: WhatsApp's USync lookup
   * (the same one the official client uses to find contacts) maps a phone
   * number to its account — including the lid — so lid-keyed threads can be
   * named even though they never expose a phone number themselves.
   */
  async resolveContacts(contacts: { name: string; phones: string[] }[]): Promise<void> {
    if (!this.sock || this.stopped) return
    // only worth network roundtrips while unnamed lid chats exist
    const hasPlaceholderLid = repo
      .listAccountThreads(this.db, this.accountId)
      .some((t) => isLidJid(t.external_id) && repo.isPlaceholderTitle(t.title))
    if (!hasPlaceholderLid) return

    const byCanonical = new Map<string, string>()
    const pending: string[] = []
    for (const c of contacts) {
      for (const p of c.phones) {
        const digits = p.replace(/\D/g, '')
        if (digits.length < 8 || this.queriedPhones.has(digits)) continue
        this.queriedPhones.add(digits)
        byCanonical.set(repo.canonicalPhoneDigits(digits), c.name)
        pending.push(digits)
      }
    }
    if (pending.length === 0) return

    const CHUNK = 50
    let learned = false
    for (let i = 0; i < pending.length && !this.stopped; i += CHUNK) {
      const chunk = pending.slice(i, i + CHUNK)
      try {
        const results = (await this.sock.onWhatsApp(...chunk.map((d) => `+${d}`))) ?? []
        for (const r of results) {
          if (!r.exists || !r.jid) continue
          const canon = repo.canonicalPhoneDigits(jidUser(String(r.jid)))
          const name =
            byCanonical.get(canon) ??
            [...byCanonical].find(([d]) => d.endsWith(canon) || canon.endsWith(d))?.[1]
          if (!name) continue
          this.names.set(String(r.jid), name)
          const lid = (r as { lid?: string }).lid
          if (lid) {
            const lidJid = lid.includes('@') ? String(lid) : `${lid}@lid`
            this.names.set(lidJid, name)
            this.learnPair(lidJid, String(r.jid))
          }
          learned = true
        }
      } catch {
        break // USync rejected (rate limit?) — retry next sweep for the rest
      }
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    if (!learned) return
    // USync is the one source that can pair a lid the local store could not —
    // fold now rather than at the next reconnect
    await this.reconcileLidThreads()
    this.applyNames()
  }

  /** The outbox drain should hold this account's rows for a later tick: the
   *  socket is down but this connection is still trying (startup handshake,
   *  watchdog recycle, sleep-pause). Dispatching now would terminally fail a
   *  row — possibly one mid-resume with delivered units — that would deliver
   *  seconds later. False once stop() ran: nothing will reconnect, so a
   *  dispatch should fail honestly instead of queueing forever. */
  willReconnect(): boolean {
    return !this.stopped && !(this.open && this.sock?.ws.isOpen === true)
  }

  async send(item: OutboxItem, attachments: OutboundAttachment[] = []): Promise<string> {
    if (!this.sock) throw new Error('WhatsApp is not connected')
    const to = JSON.parse(item.to_json) as { jid?: string }
    let jid = to.jid
    if (!jid && item.thread_id) jid = repo.getThread(this.db, item.thread_id)?.external_id
    if (!jid) throw new Error('no WhatsApp chat to send to')
    // Capture socket + destination for the whole batch: the sock field is
    // nulled mid-flight by the watchdog recycle / stop() / sleep-pause, and
    // a multi-second media upload must not straddle a reconnect onto a null
    // read (const copies also keep TS narrowing across the closure).
    const sock = this.sock
    const dest = jid
    const units = sendUnits(item)
    if (units.length === 0) throw new Error('nothing to send')
    // Resume, don't restart: skip units a previous attempt already delivered
    // (crash requeue, manual retry) — delivered_json is the ledger, written
    // after every provider accept below.
    const done = deliveredMap(item)
    const pending = pendingUnits(item)
    // Read every file BEFORE the first send — an unreadable file must fail
    // the item while nothing has shipped yet, not midway through. The list
    // holds only still-pending attachments (delivered ones were skipped at
    // resolve), keyed by their to_json position.
    const files = new Map(
      attachments.map((f) => [f.index, { ...f, bytes: readFileSync(f.path) }])
    )
    // text first, then each file as its own message (matching how phones
    // forward media)
    let lastId = ''
    let sentNow = 0
    const sendOne = async (
      unitKey: string,
      content: AnyMessageContent,
      what: string
    ): Promise<void> => {
      let sent: Awaited<ReturnType<typeof sock.sendMessage>>
      try {
        sent = await sock.sendMessage(dest, content)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        // a multi-message send has no transaction: say what already shipped
        // and that a retry of THIS row picks up where it left off
        const deliveredCount = Object.keys(done).length
        throw new Error(
          deliveredCount > 0
            ? `${what} failed — ${deliveredCount} of ${units.length} messages already delivered; Retry sends only what's left: ${msg}`
            : `${what} failed: ${msg}`
        )
      }
      lastId = sent?.key.id ?? lastId
      sentNow++
      done[unitKey] = sent?.key.id ?? ''
      // The message IS delivered from here on — the ledger write lives
      // outside the provider try/catch so a bookkeeping failure can't
      // report an accepted message as a send failure (a retry would then
      // duplicate it). Swallowed: a missing entry costs at worst the same
      // one-unit re-send as the documented crash window.
      try {
        repo.recordOutboxDelivery(this.db, item.id, unitKey, sent?.key.id ?? '')
      } catch (err) {
        logLine(
          'warn',
          'comms',
          `${this.tag()} outbox ledger write failed for ${item.id}/${unitKey}: ${
            err instanceof Error ? err.message : String(err)
          }`
        )
      }
    }
    for (const unit of pending) {
      if (unit.kind === 'text') {
        await sendOne(unit.key, { text: item.body_text }, 'text')
        continue
      }
      const f = files.get(unit.index)
      if (!f) throw new Error('a forwarded attachment no longer exists')
      // ptt only for the ogg container WhatsApp records itself — opus in
      // WebM (or any other audio) plays as a regular audio message
      const content: AnyMessageContent = f.mimeType.startsWith('audio/')
        ? { audio: f.bytes, mimetype: f.mimeType, ptt: /audio\/ogg/i.test(f.mimeType) }
        : f.mimeType.startsWith('image/')
          ? { image: f.bytes, mimetype: f.mimeType }
          : f.mimeType.startsWith('video/')
            ? { video: f.bytes, mimetype: f.mimeType }
            : { document: f.bytes, mimetype: f.mimeType, fileName: f.filename }
      await sendOne(unit.key, content, `"${f.filename}"`)
    }
    // everything was already delivered by a prior attempt (crash after the
    // last accept, before the row went 'sent') — report the last known id,
    // skipping units whose provider id never came back
    if (sentNow === 0) {
      const ids = Object.values(done).filter((id) => id !== '')
      return ids[ids.length - 1] ?? ''
    }
    // our own copy comes back through messages.upsert (fromMe) and is ingested there
    return lastId
  }

  stop(): void {
    this.stopped = true
    this.open = false
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.watchdog) {
      clearInterval(this.watchdog)
      this.watchdog = null
    }
    this.sock?.end(undefined)
    this.sock = null
  }

  /**
   * Called on system sleep: drop the socket and suppress reconnect attempts
   * until resume(). Without this, Power Nap-style partial wake-ups keep
   * reconnecting the socket while the lid is closed, and each reconnect
   * triggers a fresh "synced with [device]" push on the phone.
   */
  pause(): void {
    if (this.paused || this.stopped) return
    logLine('info', 'comms', `${this.tag()} paused (system sleep)`)
    this.paused = true
    this.open = false
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.sock?.end(undefined)
    this.sock = null
  }

  /** Called on system wake: reconnect if the socket was paused for sleep. */
  resume(): void {
    if (!this.paused) return
    logLine('info', 'comms', `${this.tag()} resumed (system wake)`)
    this.paused = false
    if (!this.stopped) void this.start()
  }
}

/** Remove the on-disk session (pairing) state for an account. */
export function deleteWaAuthState(accountId: string): void {
  rmSync(waAuthDir(accountId), { recursive: true, force: true })
}


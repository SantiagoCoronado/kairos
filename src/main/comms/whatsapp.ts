// WhatsApp provider via Baileys — an UNOFFICIAL WebSocket bridge (same
// protocol as WhatsApp Web, linked by QR). This violates WhatsApp's ToS and
// carries a small account-ban risk; the user opted in knowingly.
import { join } from 'node:path'
import { mkdirSync, rmSync } from 'node:fs'
import {
  makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  proto,
  DisconnectReason,
  Browsers,
  type WASocket,
  type WAMessage,
  type WAMessageKey
} from 'baileys'
import { toDataURL } from 'qrcode'
import type { DbDriver } from '../../core/driver'
import type { OutboxItem } from '../../core/comms-types'
import type { CommsEvent } from '../../shared/ipc-contract'
import * as repo from '../../core/repo/comms'
import { DATA_DIR } from '../db'
import { logLine } from '../logger'

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

const jidUser = (jid: string): string => jid.split('@')[0].split(':')[0]
const isGroupJid = (jid: string): boolean => jid.endsWith('@g.us')
// @lid is WhatsApp's privacy-preserving chat id — most modern DMs use it
// instead of the phone-number jid, so it MUST be accepted as a chat.
const isChatJid = (jid: string | null | undefined): jid is string =>
  Boolean(
    jid && (jid.endsWith('@s.whatsapp.net') || jid.endsWith('@g.us') || jid.endsWith('@lid'))
  )
const isLidJid = (jid: string): boolean => jid.endsWith('@lid')

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

export class WhatsAppConnection {
  private sock: WASocket | null = null
  private stopped = false
  /** set while the Mac is asleep — see pause()/resume() */
  private paused = false
  private reconnectTimer: NodeJS.Timeout | null = null
  private reconnectDelay = 2_000
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

  constructor(
    private db: DbDriver,
    private accountId: string,
    private opts: WaOpts
  ) {}

  async start(): Promise<void> {
    if (this.stopped) return
    const dir = waAuthDir(this.accountId)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const { state, saveCreds } = await useMultiFileAuthState(dir)
    const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }))

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
          const qrDataUrl = await toDataURL(update.qr, { margin: 1, width: 320 })
          this.opts.emit({ kind: 'wa_qr', accountId: this.accountId, qrDataUrl })
        }
        if (update.connection === 'open') {
          this.reconnectDelay = 2_000
          const jid = sock.user?.id ?? ''
          const phone = jidUser(jid)
          repo.updateAccountIdentity(this.db, this.accountId, jid || this.accountId, `+${phone}`)
          this.opts.emit({ kind: 'sync', accountId: this.accountId, status: 'connected' })
          this.opts.onChanged()
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
          const statusCode = (update.lastDisconnect?.error as { output?: { statusCode?: number } })
            ?.output?.statusCode
          if (statusCode === DisconnectReason.loggedOut) {
            repo.setAccountStatus(this.db, this.accountId, 'needs_auth', 'logged out from phone')
            this.opts.emit({ kind: 'sync', accountId: this.accountId, status: 'needs_auth' })
            this.opts.onChanged()
            return
          }
          if (this.stopped || this.paused) return
          this.reconnectTimer = setTimeout(() => void this.start(), this.reconnectDelay)
          this.reconnectDelay = Math.min(this.reconnectDelay * 2, 60_000)
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

    sock.ev.on('messaging-history.set', ({ chats, contacts, messages }) => {
      for (const c of contacts ?? []) this.addContact(c)
      for (const c of chats ?? []) {
        if (c.id && c.name) this.names.set(c.id, c.name)
      }
      // history arrives already-read
      for (const msg of messages ?? []) this.ingest(msg, true)
      // names and messages come in separate chunks, in either order — retitle
      // whatever placeholder threads the name book can now resolve
      this.applyNames()
      this.opts.onChanged()
    })

    sock.ev.on('messages.upsert', ({ messages, type }) => {
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

    // groups created or renamed after connect: subjects arrive out-of-band
    sock.ev.on('groups.upsert', (metas) => {
      for (const g of metas) this.applyGroupSubject(g.id, g.subject)
    })
    sock.ev.on('groups.update', (updates) => {
      for (const g of updates) this.applyGroupSubject(g.id, g.subject)
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
        const thread = repo.getThreadByExternal(this.db, this.accountId, c.id)
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
  private addContact(c: { id?: string; lid?: string; jid?: string; name?: string; notify?: string; verifiedName?: string }): void {
    const name = c.name || c.notify || c.verifiedName
    if (!name) return
    for (const j of [c.id, c.lid, c.jid]) {
      if (j) {
        this.names.set(j, name)
        this.pushNamed.delete(j) // contact-store name outranks a pushName
      }
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
        const name = this.names.get(thread.external_id)
        if (name) {
          repo.setThreadTitle(this.db, thread.id, name)
          changed = true
        }
      }
      for (const [jid, name] of this.names) {
        if (isGroupJid(jid) || this.appliedNames.get(jid) === name) continue
        this.appliedNames.set(jid, name)
        if (repo.updateSenderNames(this.db, this.accountId, jidUser(jid), name) > 0) changed = true
      }
    })
    const ms = Date.now() - started
    if (ms > 200) logLine('warn', 'comms', `wa applyNames swept ${this.names.size} names in ${ms}ms`)
    if (changed) this.opts.onChanged()
  }

  /** returns true if the message was new */
  private ingest(msg: WAMessage, asRead: boolean): boolean {
    const chatJid = msg.key.remoteJid
    if (!isChatJid(chatJid)) return false // status broadcasts, newsletters, …
    const { text, hasAttachment } = extractText(msg)
    if (!text && !hasAttachment) return false // protocol/reaction/poll noise

    const isGroup = isGroupJid(chatJid)
    const isMe = Boolean(msg.key.fromMe)
    const senderJid = isGroup ? (msg.key.participant ?? '') : chatJid
    // DMs: an inbound pushName is the chat's name when nothing better is
    // known. Feeding it into the name book (not just this message's title)
    // is what keeps outbound messages from re-computing 'WhatsApp chat' and
    // lets applyNames() fix an already-placeholder thread.
    if (!isGroup && !isMe && msg.pushName) {
      const known = this.names.get(chatJid)
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
      this.names.get(chatJid) ||
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
      sender_name: isMe ? 'me' : msg.pushName || this.names.get(senderJid) || jidLabel(senderJid),
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
          if (lid) this.names.set(lid.includes('@') ? String(lid) : `${lid}@lid`, name)
          learned = true
        }
      } catch {
        break // USync rejected (rate limit?) — retry next sweep for the rest
      }
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    if (learned) this.applyNames()
  }

  async send(item: OutboxItem): Promise<string> {
    if (!this.sock) throw new Error('WhatsApp is not connected')
    const to = JSON.parse(item.to_json) as { jid?: string }
    let jid = to.jid
    if (!jid && item.thread_id) jid = repo.getThread(this.db, item.thread_id)?.external_id
    if (!jid) throw new Error('no WhatsApp chat to send to')
    const sent = await this.sock.sendMessage(jid, { text: item.body_text })
    // our own copy comes back through messages.upsert (fromMe) and is ingested there
    return sent?.key.id ?? ''
  }

  stop(): void {
    this.stopped = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
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
    this.paused = true
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
    this.paused = false
    if (!this.stopped) void this.start()
  }
}

/** Remove the on-disk session (pairing) state for an account. */
export function deleteWaAuthState(accountId: string): void {
  rmSync(waAuthDir(accountId), { recursive: true, force: true })
}


import type { DbDriver, SqlValue } from '../driver'
import type {
  CommsAccount,
  CommsAccountStatus,
  CommsMessage,
  CommsThread,
  AccountUpsert,
  ThreadUpsert,
  MessageUpsert,
  MessageSearchHit,
  OutboxEnqueue,
  OutboxItem,
  ThreadFilter,
  CommsProvider
} from '../comms-types'
import { newId, nowIso } from '../ids'

// ---------- accounts ----------

export function listAccounts(db: DbDriver): CommsAccount[] {
  return db.all<CommsAccount>('SELECT * FROM comms_accounts ORDER BY created_at')
}

export function getAccount(db: DbDriver, id: string): CommsAccount | undefined {
  return db.get<CommsAccount>('SELECT * FROM comms_accounts WHERE id = ?', id)
}

export function upsertAccount(db: DbDriver, input: AccountUpsert, now: Date = new Date()): CommsAccount {
  const ts = nowIso(now)
  const existing = db.get<CommsAccount>(
    'SELECT * FROM comms_accounts WHERE provider = ? AND external_id = ?',
    input.provider,
    input.external_id
  )
  if (existing) {
    db.run(
      `UPDATE comms_accounts SET display_name = ?, status = ?, error = NULL, updated_at = ? WHERE id = ?`,
      input.display_name,
      input.status ?? 'connected',
      ts,
      existing.id
    )
    return getAccount(db, existing.id)!
  }
  const id = newId()
  db.run(
    `INSERT INTO comms_accounts (id, provider, external_id, display_name, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    id,
    input.provider,
    input.external_id,
    input.display_name,
    input.status ?? 'connected',
    ts,
    ts
  )
  return getAccount(db, id)!
}

export function setAccountStatus(
  db: DbDriver,
  id: string,
  status: CommsAccountStatus,
  error: string | null = null,
  now: Date = new Date()
): void {
  db.run(
    'UPDATE comms_accounts SET status = ?, error = ?, updated_at = ? WHERE id = ?',
    status,
    error,
    nowIso(now),
    id
  )
}

/** Shallow-merge a patch into the account's sync_state JSON. */
export function patchSyncState(
  db: DbDriver,
  id: string,
  patch: Record<string, unknown>,
  now: Date = new Date()
): void {
  const account = getAccount(db, id)
  if (!account) return
  let state: Record<string, unknown> = {}
  try {
    state = JSON.parse(account.sync_state) as Record<string, unknown>
  } catch {
    // corrupted state: start fresh
  }
  db.run(
    'UPDATE comms_accounts SET sync_state = ?, last_sync_at = ?, updated_at = ? WHERE id = ?',
    JSON.stringify({ ...state, ...patch }),
    nowIso(now),
    nowIso(now),
    id
  )
}

/** Finalize a provisional account once the provider reveals its identity (WhatsApp post-QR). */
export function updateAccountIdentity(
  db: DbDriver,
  id: string,
  externalId: string,
  displayName: string,
  now: Date = new Date()
): void {
  db.run(
    `UPDATE comms_accounts SET external_id = ?, display_name = ?, status = 'connected', error = NULL, updated_at = ? WHERE id = ?`,
    externalId,
    displayName,
    nowIso(now),
    id
  )
}

export function deleteAccount(db: DbDriver, id: string): void {
  db.run('DELETE FROM comms_accounts WHERE id = ?', id)
}

// ---------- credentials (opaque ciphertext; encryption lives in Electron main) ----------

export function setCredentialCipher(db: DbDriver, accountId: string, cipher: string): void {
  db.run(
    `INSERT INTO comms_credentials (account_id, cipher) VALUES (?, ?)
     ON CONFLICT(account_id) DO UPDATE SET cipher = excluded.cipher`,
    accountId,
    cipher
  )
}

export function getCredentialCipher(db: DbDriver, accountId: string): string | undefined {
  return db.get<{ cipher: string }>(
    'SELECT cipher FROM comms_credentials WHERE account_id = ?',
    accountId
  )?.cipher
}

// ---------- threads ----------

export function getThread(db: DbDriver, id: string): CommsThread | undefined {
  return db.get<CommsThread>('SELECT * FROM comms_threads WHERE id = ?', id)
}

export function getThreadByExternal(
  db: DbDriver,
  accountId: string,
  externalId: string
): CommsThread | undefined {
  return db.get<CommsThread>(
    'SELECT * FROM comms_threads WHERE account_id = ? AND external_id = ?',
    accountId,
    externalId
  )
}

export function upsertThread(db: DbDriver, input: ThreadUpsert, now: Date = new Date()): CommsThread {
  const ts = nowIso(now)
  const existing = getThreadByExternal(db, input.account_id, input.external_id)
  if (existing) {
    if (input.title !== undefined && input.title !== '' && input.title !== existing.title) {
      db.run('UPDATE comms_threads SET title = ?, updated_at = ? WHERE id = ?', input.title, ts, existing.id)
      return getThread(db, existing.id)!
    }
    return existing
  }
  const id = newId()
  db.run(
    `INSERT INTO comms_threads (id, account_id, provider, external_id, kind, title, sync_enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    input.account_id,
    input.provider,
    input.external_id,
    input.kind,
    input.title ?? '',
    input.sync_enabled ?? 1,
    ts,
    ts
  )
  return getThread(db, id)!
}

export function listThreads(db: DbDriver, f: ThreadFilter = {}): CommsThread[] {
  const where: string[] = ['t.last_message_at IS NOT NULL']
  const params: SqlValue[] = []
  if (!f.includeDisabled) where.push('t.sync_enabled = 1')
  if (f.accountId) {
    where.push('t.account_id = ?')
    params.push(f.accountId)
  }
  if (f.provider) {
    where.push('t.provider = ?')
    params.push(f.provider)
  }
  if (f.unreadOnly) where.push('t.unread_count > 0')
  if (f.search) {
    where.push('(t.title LIKE ? OR t.snippet LIKE ?)')
    const q = `%${f.search}%`
    params.push(q, q)
  }
  params.push(f.limit ?? 200)
  return db.all<CommsThread>(
    `SELECT t.* FROM comms_threads t WHERE ${where.join(' AND ')}
     ORDER BY t.last_message_at DESC LIMIT ?`,
    ...params
  )
}

/** All threads for an account regardless of activity — for sync loops and channel opt-in UI. */
export function listAccountThreads(db: DbDriver, accountId: string): CommsThread[] {
  return db.all<CommsThread>(
    'SELECT * FROM comms_threads WHERE account_id = ? ORDER BY title COLLATE NOCASE',
    accountId
  )
}

export function setThreadSyncEnabled(db: DbDriver, threadId: string, enabled: boolean, now: Date = new Date()): void {
  db.run(
    'UPDATE comms_threads SET sync_enabled = ?, updated_at = ? WHERE id = ?',
    enabled ? 1 : 0,
    nowIso(now),
    threadId
  )
}

export function setThreadTitle(db: DbDriver, threadId: string, title: string, now: Date = new Date()): void {
  db.run('UPDATE comms_threads SET title = ?, updated_at = ? WHERE id = ?', title, nowIso(now), threadId)
}

/** Fix placeholder sender names once a real contact name is learned. Returns rows changed. */
export function updateSenderNames(db: DbDriver, accountId: string, handle: string, name: string): number {
  return db.run(
    `UPDATE comms_messages SET sender_name = ?
     WHERE account_id = ? AND sender_handle = ? AND is_me = 0
       AND (sender_name = '' OR sender_name = 'WhatsApp chat' OR sender_name LIKE '+%')`,
    name,
    accountId,
    handle
  ).changes
}

export function isPlaceholderTitle(title: string): boolean {
  return title === '' || title === 'Group' || title === 'WhatsApp chat' || /^\+\d+$/.test(title)
}

/**
 * WhatsApp ids keep legacy mobile tokens some countries have since dropped
 * from dialing: Mexico's '1' after +52, Argentina's '9' after +54. Contacts
 * apps store the modern form, so both sides normalize to it before matching.
 */
export function canonicalPhoneDigits(digits: string): string {
  if (/^521\d{10}$/.test(digits)) return `52${digits.slice(3)}`
  if (/^549\d{10}$/.test(digits)) return `54${digits.slice(3)}`
  return digits
}

/**
 * Name WhatsApp threads/senders from an address book. Matches by canonical
 * phone-digit suffix (≥7 digits, tolerant of country-code differences).
 * Covers phone-number jids; @lid chats expose no number and stay untouched.
 * Returns true if anything changed.
 */
export function applyContactNames(
  db: DbDriver,
  accountId: string,
  contacts: { name: string; phones: string[] }[],
  now: Date = new Date()
): boolean {
  const byTail = new Map<string, { digits: string; name: string }[]>()
  for (const c of contacts) {
    for (const p of c.phones) {
      const d = canonicalPhoneDigits(p.replace(/\D/g, ''))
      if (d.length < 7) continue
      const tail = d.slice(-7)
      const bucket = byTail.get(tail)
      if (bucket) bucket.push({ digits: d, name: c.name })
      else byTail.set(tail, [{ digits: d, name: c.name }])
    }
  }
  if (byTail.size === 0) return false
  const lookup = (rawDigits: string): string | undefined => {
    const digits = canonicalPhoneDigits(rawDigits)
    if (digits.length < 7) return undefined
    return byTail
      .get(digits.slice(-7))
      ?.find((c) => c.digits.endsWith(digits) || digits.endsWith(c.digits))?.name
  }

  let changed = false
  db.transaction(() => {
    for (const thread of listAccountThreads(db, accountId)) {
      if (!thread.external_id.endsWith('@s.whatsapp.net')) continue
      if (!isPlaceholderTitle(thread.title)) continue
      const jidDigits = thread.external_id.split('@')[0].split(':')[0]
      const name = lookup(jidDigits)
      if (name) {
        setThreadTitle(db, thread.id, name, now)
        changed = true
      }
    }
    for (const handle of listPlaceholderSenderHandles(db, accountId)) {
      const name = lookup(handle.replace(/\D/g, ''))
      if (name && updateSenderNames(db, accountId, handle, name) > 0) changed = true
    }
  })
  return changed
}

/** Distinct inbound sender handles whose display name is still a placeholder. */
export function listPlaceholderSenderHandles(db: DbDriver, accountId: string): string[] {
  return db
    .all<{ sender_handle: string }>(
      `SELECT DISTINCT sender_handle FROM comms_messages
       WHERE account_id = ? AND is_me = 0 AND sender_handle != ''
         AND (sender_name = '' OR sender_name = 'WhatsApp chat' OR sender_name LIKE '+%')`,
      accountId
    )
    .map((r) => r.sender_handle)
}

export function setThreadCursor(db: DbDriver, threadId: string, cursor: string, now: Date = new Date()): void {
  db.run(
    'UPDATE comms_threads SET sync_cursor = ?, updated_at = ? WHERE id = ?',
    cursor,
    nowIso(now),
    threadId
  )
}

export function markThreadRead(db: DbDriver, threadId: string, now: Date = new Date()): void {
  db.transaction(() => {
    db.run('UPDATE comms_messages SET is_read = 1 WHERE thread_id = ?', threadId)
    db.run('UPDATE comms_threads SET unread_count = 0, updated_at = ? WHERE id = ?', nowIso(now), threadId)
  })
}

export function unreadTotal(db: DbDriver): number {
  return (
    db.get<{ n: number }>(
      'SELECT COALESCE(SUM(unread_count), 0) AS n FROM comms_threads WHERE sync_enabled = 1'
    )?.n ?? 0
  )
}

// ---------- person resolution ----------

const digits = (s: string): string => s.replace(/\D/g, '')

/**
 * Resolve a sender handle to a person id: explicit identity link first, then
 * people.email (gmail) or people.phone digit-suffix match (whatsapp). On a
 * people-table match the identity row is written so future lookups are one query.
 */
export function resolvePersonForHandle(
  db: DbDriver,
  provider: CommsProvider,
  handle: string,
  now: Date = new Date()
): string | null {
  if (!handle) return null
  const linked = db.get<{ person_id: string }>(
    'SELECT person_id FROM comms_identities WHERE provider = ? AND handle = ?',
    provider,
    handle
  )
  if (linked) return linked.person_id

  let personId: string | null = null
  if (provider === 'gmail') {
    personId =
      db.get<{ id: string }>(
        'SELECT id FROM people WHERE archived_at IS NULL AND lower(email) = lower(?)',
        handle
      )?.id ?? null
  } else if (provider === 'whatsapp') {
    const h = digits(handle)
    if (h.length >= 7) {
      const candidates = db.all<{ id: string; phone: string }>(
        'SELECT id, phone FROM people WHERE archived_at IS NULL AND phone IS NOT NULL'
      )
      for (const c of candidates) {
        const p = digits(c.phone)
        if (p.length >= 7 && (p.endsWith(h) || h.endsWith(p))) {
          personId = c.id
          break
        }
      }
    }
  }
  // slack: manual linking only in v1 (user ids aren't in the people table)

  // Plain insert, no transaction: this runs inside upsertMessage's transaction
  // and the driver's transactions don't nest. No backfill needed — earlier
  // messages with this handle would have auto-resolved the same way.
  if (personId) {
    db.run(
      `INSERT INTO comms_identities (id, person_id, provider, handle, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(provider, handle) DO UPDATE SET person_id = excluded.person_id`,
      newId(),
      personId,
      provider,
      handle,
      nowIso(now)
    )
  }
  return personId
}

/** Insert/replace an identity link and backfill person_id on existing messages. */
export function linkHandleToPerson(
  db: DbDriver,
  provider: CommsProvider,
  handle: string,
  personId: string,
  now: Date = new Date()
): void {
  db.transaction(() => {
    db.run(
      `INSERT INTO comms_identities (id, person_id, provider, handle, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(provider, handle) DO UPDATE SET person_id = excluded.person_id`,
      newId(),
      personId,
      provider,
      handle,
      nowIso(now)
    )
    db.run(
      'UPDATE comms_messages SET person_id = ? WHERE provider = ? AND sender_handle = ?',
      personId,
      provider,
      handle
    )
  })
}

// ---------- messages ----------

const SNIPPET_LEN = 120

/**
 * Idempotent message insert (UNIQUE(account_id, external_id) — re-syncs are
 * no-ops). Resolves the sender to a person and bumps the thread's
 * last_message_at / snippet / unread_count. Returns true if inserted.
 */
export function upsertMessage(db: DbDriver, input: MessageUpsert, now: Date = new Date()): boolean {
  return db.transaction(() => {
    const handle = (input.sender_handle ?? '').trim().toLowerCase()
    const personId = input.is_me ? null : resolvePersonForHandle(db, input.provider, handle, now)
    const res = db.run(
      `INSERT INTO comms_messages
         (id, thread_id, account_id, provider, external_id, sender_name, sender_handle,
          is_me, person_id, sent_at, body_text, has_attachments, is_read, raw_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(account_id, external_id) DO NOTHING`,
      newId(),
      input.thread_id,
      input.account_id,
      input.provider,
      input.external_id,
      input.sender_name ?? '',
      handle,
      input.is_me ? 1 : 0,
      personId,
      input.sent_at,
      input.body_text ?? '',
      input.has_attachments ? 1 : 0,
      input.is_me || input.is_read ? 1 : 0,
      input.raw_json ?? null,
      nowIso(now)
    )
    if (res.changes === 0) return false

    const thread = getThread(db, input.thread_id)
    if (thread && (!thread.last_message_at || input.sent_at >= thread.last_message_at)) {
      const snippet = (input.body_text ?? '').replace(/\s+/g, ' ').trim().slice(0, SNIPPET_LEN)
      db.run(
        'UPDATE comms_threads SET last_message_at = ?, snippet = ?, updated_at = ? WHERE id = ?',
        input.sent_at,
        snippet,
        nowIso(now),
        input.thread_id
      )
    }
    if (!input.is_me && !input.is_read) {
      db.run('UPDATE comms_threads SET unread_count = unread_count + 1 WHERE id = ?', input.thread_id)
    }
    return true
  })
}

export function listMessages(db: DbDriver, threadId: string, limit = 200): CommsMessage[] {
  // newest N, presented oldest-first
  return db
    .all<CommsMessage>(
      'SELECT * FROM comms_messages WHERE thread_id = ? ORDER BY sent_at DESC LIMIT ?',
      threadId,
      limit
    )
    .reverse()
}

export function searchMessages(
  db: DbDriver,
  query: string,
  opts: { provider?: CommsProvider; personId?: string; limit?: number } = {}
): MessageSearchHit[] {
  const where: string[] = ['(m.body_text LIKE ? OR m.sender_name LIKE ? OR t.title LIKE ?)']
  const q = `%${query}%`
  const params: SqlValue[] = [q, q, q]
  if (opts.provider) {
    where.push('m.provider = ?')
    params.push(opts.provider)
  }
  if (opts.personId) {
    where.push('m.person_id = ?')
    params.push(opts.personId)
  }
  params.push(opts.limit ?? 20)
  return db.all<MessageSearchHit>(
    `SELECT m.*, t.title AS thread_title, a.display_name AS account_display_name
     FROM comms_messages m
     JOIN comms_threads t ON t.id = m.thread_id
     JOIN comms_accounts a ON a.id = m.account_id
     WHERE ${where.join(' AND ')}
     ORDER BY m.sent_at DESC LIMIT ?`,
    ...params
  )
}

// ---------- outbox ----------

export function enqueueOutbox(db: DbDriver, input: OutboxEnqueue, now: Date = new Date()): OutboxItem {
  const id = newId()
  db.run(
    `INSERT INTO comms_outbox (id, account_id, thread_id, provider, to_json, body_text, in_reply_to, source, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    input.account_id,
    input.thread_id ?? null,
    input.provider,
    input.to_json,
    input.body_text,
    input.in_reply_to ?? null,
    input.source ?? 'app',
    nowIso(now)
  )
  return getOutboxItem(db, id)!
}

export function getOutboxItem(db: DbDriver, id: string): OutboxItem | undefined {
  return db.get<OutboxItem>('SELECT * FROM comms_outbox WHERE id = ?', id)
}

/**
 * Atomically claim up to `limit` queued items (status flips to 'sending'
 * inside one transaction, so a concurrent drainer can't double-send).
 */
export function claimQueued(db: DbDriver, limit = 10): OutboxItem[] {
  return db.transaction(() => {
    const items = db.all<OutboxItem>(
      "SELECT * FROM comms_outbox WHERE status = 'queued' ORDER BY created_at LIMIT ?",
      limit
    )
    for (const item of items) {
      db.run("UPDATE comms_outbox SET status = 'sending' WHERE id = ?", item.id)
    }
    return items.map((i) => ({ ...i, status: 'sending' as const }))
  })
}

export function finishOutbox(
  db: DbDriver,
  id: string,
  result: { ok: true; external_id?: string } | { ok: false; error: string },
  now: Date = new Date()
): void {
  if (result.ok) {
    db.run(
      "UPDATE comms_outbox SET status = 'sent', external_id = ?, error = NULL, sent_at = ? WHERE id = ?",
      result.external_id ?? null,
      nowIso(now),
      id
    )
  } else {
    db.run("UPDATE comms_outbox SET status = 'failed', error = ? WHERE id = ?", result.error, id)
  }
}

/** Requeue items stuck in 'sending' (e.g. app was killed mid-send) — call on startup. */
export function requeueStuckSending(db: DbDriver): number {
  return db.run("UPDATE comms_outbox SET status = 'queued' WHERE status = 'sending'").changes
}

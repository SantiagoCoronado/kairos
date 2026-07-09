import type { DbDriver, SqlValue } from '../driver'
import type {
  CommsAccount,
  CommsAccountStatus,
  CommsMessage,
  CommsThread,
  CommsThreadListItem,
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
  return db.all<CommsAccount>('SELECT * FROM comms_accounts ORDER BY sort_order, created_at')
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
    `INSERT INTO comms_accounts (id, provider, external_id, display_name, status, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM comms_accounts), ?, ?)`,
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

/** Reorder an account before `beforeId` (null = end). Renumbers the whole table. */
export function moveAccountBefore(
  db: DbDriver,
  id: string,
  beforeId: string | null,
  now: Date = new Date()
): void {
  db.transaction(() => {
    const rows = db.all<{ id: string }>('SELECT id FROM comms_accounts ORDER BY sort_order, id')
    if (!rows.some((r) => r.id === id)) throw new Error(`account not found: ${id}`)
    const ids = rows.map((r) => r.id).filter((x) => x !== id)
    const at = beforeId === null ? ids.length : ids.indexOf(beforeId)
    if (at < 0) throw new Error(`account not found: ${beforeId}`)
    ids.splice(at, 0, id)
    ids.forEach((aid, i) => db.run('UPDATE comms_accounts SET sort_order = ? WHERE id = ?', i + 1, aid))
    db.run('UPDATE comms_accounts SET updated_at = ? WHERE id = ?', nowIso(now), id)
  })
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
    if (
      input.title !== undefined &&
      input.title !== '' &&
      input.title !== existing.title &&
      // a placeholder never displaces a real name: an outbound WhatsApp
      // message can only compute 'WhatsApp chat', and without this guard it
      // clobbers a title learned from an inbound message's pushName
      !(isPlaceholderTitle(input.title) && !isPlaceholderTitle(existing.title))
    ) {
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

export function listThreads(db: DbDriver, f: ThreadFilter = {}): CommsThreadListItem[] {
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
  const box = f.box ?? 'inbox'
  if (box !== 'all') where.push(`t.is_archived = ${box === 'archived' ? 1 : 0}`)
  if (f.unreadOnly) where.push('t.unread_count > 0')
  if (f.search) {
    where.push('(t.title LIKE ? OR t.snippet LIKE ?)')
    const q = `%${f.search}%`
    params.push(q, q)
  }
  params.push(f.limit ?? 200)
  // person join: the linked person of the latest inbound message; the
  // correlated subquery runs only over the returned rows via idx_comms_messages_thread
  return db.all<CommsThreadListItem>(
    `SELECT t.*, p.id AS person_id, p.name AS person_name
     FROM comms_threads t
     LEFT JOIN people p ON p.id = (
       SELECT m.person_id FROM comms_messages m
       WHERE m.thread_id = t.id AND m.is_me = 0 AND m.person_id IS NOT NULL
       ORDER BY m.sent_at DESC LIMIT 1
     )
     WHERE ${where.join(' AND ')}
     ORDER BY t.pinned DESC, t.last_message_at DESC LIMIT ?`,
    ...params
  )
}

/** Pin/unpin: pinned threads float to the top of the list. Local-only. */
export function setThreadPinned(db: DbDriver, threadId: string, pinned: boolean, now: Date = new Date()): void {
  db.run(
    'UPDATE comms_threads SET pinned = ?, updated_at = ? WHERE id = ?',
    pinned ? 1 : 0,
    nowIso(now),
    threadId
  )
}

/** One thread as a list row (person join included) — for opening search hits
 *  whose thread isn't in the current list. */
export function getThreadListItem(db: DbDriver, threadId: string): CommsThreadListItem | null {
  return (
    db.get<CommsThreadListItem>(
      `SELECT t.*, p.id AS person_id, p.name AS person_name
       FROM comms_threads t
       LEFT JOIN people p ON p.id = (
         SELECT m.person_id FROM comms_messages m
         WHERE m.thread_id = t.id AND m.is_me = 0 AND m.person_id IS NOT NULL
         ORDER BY m.sent_at DESC LIMIT 1
       )
       WHERE t.id = ?`,
      threadId
    ) ?? null
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

/** Bulk channel opt-in/out — the "enable all" path in the channel picker. */
export function setThreadsSyncEnabled(
  db: DbDriver,
  threadIds: string[],
  enabled: boolean,
  now: Date = new Date()
): void {
  for (const id of threadIds) setThreadSyncEnabled(db, id, enabled, now)
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

/** The inbound messages still unread in a thread — the WhatsApp read-receipt list. */
export function unreadInboundMessages(db: DbDriver, threadId: string): CommsMessage[] {
  return db.all<CommsMessage>(
    'SELECT * FROM comms_messages WHERE thread_id = ? AND is_me = 0 AND is_read = 0 ORDER BY sent_at',
    threadId
  )
}

/** Archive/unarchive a thread; gmail messages mirror the flag so local state matches the remote modify. */
export function setThreadArchived(
  db: DbDriver,
  threadId: string,
  archived: boolean,
  now: Date = new Date()
): void {
  db.transaction(() => {
    db.run(
      'UPDATE comms_threads SET is_archived = ?, updated_at = ? WHERE id = ?',
      archived ? 1 : 0,
      nowIso(now),
      threadId
    )
    db.run(
      "UPDATE comms_messages SET is_inbox = ? WHERE thread_id = ? AND provider = 'gmail'",
      archived ? 0 : 1,
      threadId
    )
  })
}

/**
 * Apply a Gmail history label event to one message by (account_id, external_id).
 * Returns the affected thread id, or null when the message predates the
 * backfill window (skip — nothing to update).
 */
export function applyGmailLabelEvent(
  db: DbDriver,
  accountId: string,
  messageExternalId: string,
  patch: { read?: boolean; inbox?: boolean }
): string | null {
  const row = db.get<{ id: string; thread_id: string }>(
    'SELECT id, thread_id FROM comms_messages WHERE account_id = ? AND external_id = ?',
    accountId,
    messageExternalId
  )
  if (!row) return null
  const sets: string[] = []
  const params: SqlValue[] = []
  if (patch.read !== undefined) {
    sets.push('is_read = ?')
    params.push(patch.read ? 1 : 0)
  }
  if (patch.inbox !== undefined) {
    sets.push('is_inbox = ?')
    params.push(patch.inbox ? 1 : 0)
  }
  if (sets.length === 0) return null
  db.run(`UPDATE comms_messages SET ${sets.join(', ')} WHERE id = ?`, ...params, row.id)
  return row.thread_id
}

/**
 * Mark a thread unread again: flag its newest inbound message so the thread
 * resurfaces with unread_count 1 (not the whole history). Returns that
 * message's external id (for the remote label add), or null if none exists.
 */
export function markThreadUnread(db: DbDriver, threadId: string, now: Date = new Date()): string | null {
  const msg = db.get<{ id: string; external_id: string }>(
    'SELECT id, external_id FROM comms_messages WHERE thread_id = ? AND is_me = 0 ORDER BY sent_at DESC LIMIT 1',
    threadId
  )
  if (!msg) return null
  db.transaction(() => {
    db.run('UPDATE comms_messages SET is_read = 0 WHERE id = ?', msg.id)
    db.run(
      `UPDATE comms_threads SET
         unread_count = (SELECT COUNT(*) FROM comms_messages WHERE thread_id = ? AND is_read = 0 AND is_me = 0),
         updated_at = ?
       WHERE id = ?`,
      threadId,
      nowIso(now),
      threadId
    )
  })
  return msg.external_id
}

/** Remove a thread locally (messages cascade via FK). */
export function deleteThread(db: DbDriver, threadId: string): void {
  db.run('DELETE FROM comms_threads WHERE id = ?', threadId)
}

/**
 * Fill body_html on an already-synced message that predates HTML capture —
 * re-syncs skip existing rows, so this is the only path that upgrades them.
 * Never overwrites an existing body_html. Returns true if a row changed.
 */
export function fillMessageHtml(
  db: DbDriver,
  accountId: string,
  externalId: string,
  html: string
): boolean {
  return (
    db.run(
      'UPDATE comms_messages SET body_html = ? WHERE account_id = ? AND external_id = ? AND body_html IS NULL',
      html,
      accountId,
      externalId
    ).changes > 0
  )
}

/** Recount a thread's unread_count and (gmail) is_archived from its messages. */
export function recomputeThreadState(db: DbDriver, threadId: string, now: Date = new Date()): void {
  db.transaction(() => {
    db.run(
      `UPDATE comms_threads SET
         unread_count = (SELECT COUNT(*) FROM comms_messages WHERE thread_id = ? AND is_read = 0 AND is_me = 0),
         updated_at = ?
       WHERE id = ?`,
      threadId,
      nowIso(now),
      threadId
    )
    db.run(
      `UPDATE comms_threads SET is_archived = NOT EXISTS (
         SELECT 1 FROM comms_messages WHERE thread_id = ? AND is_inbox = 1
       ) WHERE id = ? AND provider = 'gmail'`,
      threadId,
      threadId
    )
  })
}

export function unreadTotal(db: DbDriver): number {
  return (
    db.get<{ n: number }>(
      'SELECT COALESCE(SUM(unread_count), 0) AS n FROM comms_threads WHERE sync_enabled = 1 AND is_archived = 0'
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
          is_me, person_id, sent_at, body_text, body_html, has_attachments, is_read, is_inbox, raw_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      input.body_html ?? null,
      input.has_attachments ? 1 : 0,
      input.is_me || input.is_read ? 1 : 0,
      input.is_inbox === false ? 0 : 1,
      input.raw_json ?? null,
      nowIso(now)
    )
    if (res.changes === 0) return false

    // new inbox mail resurfaces an archived thread (matches Gmail semantics)
    if (input.is_inbox !== false) {
      db.run('UPDATE comms_threads SET is_archived = 0 WHERE id = ? AND is_archived = 1', input.thread_id)
    }

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

/** inbound unread messages stored since `sinceIso` — the "new mail arrived"
 *  signal for automation event triggers (created_at is stamped at insert).
 *  Requires a recent sent_at too: backfill sweeps ingest months-old unread
 *  mail whose created_at is now, and those must not fire "email received". */
export function countNewInbound(db: DbDriver, accountId: string, sinceIso: string): number {
  const recentIso = new Date(Date.parse(sinceIso) - 24 * 60 * 60 * 1000).toISOString()
  const row = db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM comms_messages
     WHERE account_id = ? AND is_me = 0 AND is_read = 0 AND created_at >= ? AND sent_at >= ?`,
    accountId,
    sinceIso,
    recentIso
  )
  return row?.n ?? 0
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
  opts: { accountId?: string; provider?: CommsProvider; personId?: string; limit?: number } = {}
): MessageSearchHit[] {
  const where: string[] = ['(m.body_text LIKE ? OR m.sender_name LIKE ? OR t.title LIKE ?)']
  const q = `%${query}%`
  const params: SqlValue[] = [q, q, q]
  if (opts.accountId) {
    where.push('m.account_id = ?')
    params.push(opts.accountId)
  }
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

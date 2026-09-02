import type { DbDriver, SqlValue } from '../driver'
import type {
  CommsAccount,
  CommsAccountStatus,
  CommsAttachment,
  CommsIdentity,
  CommsMessage,
  CommsThread,
  CommsThreadListItem,
  AccountUpsert,
  AttachmentUpsert,
  ThreadUpsert,
  MessageUpsert,
  MessageSearchHit,
  OutboxEnqueue,
  OutboxItem,
  ThreadFilter,
  CommsProvider
} from '../comms-types'
import { newId, nowIso } from '../ids'
import { deliveredMap } from '../outbox-units'

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
  if (f.label) {
    // exact token match on the comma-joined list — no substring collisions
    where.push("(',' || t.labels || ',') LIKE ?")
    params.push(`%,${f.label},%`)
  }
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
     LEFT JOIN people p ON p.archived_at IS NULL AND p.id = (
       SELECT m.person_id FROM comms_messages m
       WHERE m.thread_id = t.id AND m.is_me = 0 AND m.person_id IS NOT NULL
       ORDER BY m.sent_at DESC LIMIT 1
     )
     WHERE ${where.join(' AND ')}
     ORDER BY t.pinned DESC, t.last_message_at DESC LIMIT ?`,
    ...params
  )
}

/** Overwrite a thread's labels (auto-classifier and manual menu alike). */
export function setThreadLabels(
  db: DbDriver,
  threadId: string,
  labels: string[],
  now: Date = new Date()
): void {
  db.run(
    'UPDATE comms_threads SET labels = ?, updated_at = ? WHERE id = ?',
    labels.join(','),
    nowIso(now),
    threadId
  )
}

/** Distinct labels present on any thread — the filter row's chip list. */
export function listThreadLabels(db: DbDriver): string[] {
  const rows = db.all<{ labels: string }>(
    "SELECT DISTINCT labels FROM comms_threads WHERE labels != ''"
  )
  const set = new Set<string>()
  for (const r of rows) for (const l of r.labels.split(',')) if (l) set.add(l)
  return [...set].sort()
}

/** Unclassified inbox email threads newer than `sinceIso`, newest first — the
 *  labeler's work queue. `sender` is the latest inbound sender and
 *  `newest_raw` its raw_json (gmail labelIds for the zero-token heuristics). */
export function listUnlabeledEmailThreads(
  db: DbDriver,
  sinceIso: string,
  limit: number
): (CommsThread & { sender: string; newest_raw: string | null })[] {
  return db.all<CommsThread & { sender: string; newest_raw: string | null }>(
    `SELECT t.*, COALESCE((
       SELECT m.sender_name || ' <' || m.sender_handle || '>'
       FROM comms_messages m WHERE m.thread_id = t.id AND m.is_me = 0
       ORDER BY m.sent_at DESC LIMIT 1
     ), '') AS sender,
     (
       SELECT m.raw_json FROM comms_messages m WHERE m.thread_id = t.id
       ORDER BY m.sent_at DESC LIMIT 1
     ) AS newest_raw
     FROM comms_threads t
     WHERE t.provider = 'gmail' AND t.labels = '' AND t.is_archived = 0
       AND t.sync_enabled = 1 AND t.last_message_at >= ?
     ORDER BY t.last_message_at DESC LIMIT ?`,
    sinceIso,
    limit
  )
}

/** WhatsApp DM threads with fresh unread messages the notification triage
 *  hasn't evaluated yet (last_message_at past the notify_eval_at watermark). */
export function listWhatsappTriageCandidates(
  db: DbDriver,
  sinceIso: string,
  limit: number
): (CommsThread & { sender: string })[] {
  return db.all<CommsThread & { sender: string }>(
    `SELECT t.*, COALESCE((
       SELECT COALESCE(NULLIF(m.sender_name, ''), m.sender_handle)
       FROM comms_messages m WHERE m.thread_id = t.id AND m.is_me = 0
       ORDER BY m.sent_at DESC LIMIT 1
     ), t.title) AS sender
     FROM comms_threads t
     WHERE t.provider = 'whatsapp' AND t.kind = 'dm' AND t.unread_count > 0
       AND t.is_archived = 0 AND t.sync_enabled = 1
       AND t.last_message_at >= ?
       AND (t.notify_eval_at IS NULL OR t.last_message_at > t.notify_eval_at)
     ORDER BY t.last_message_at DESC LIMIT ?`,
    sinceIso,
    limit
  )
}

/** Stamp the triage watermark. No updated_at bump — bookkeeping, not content. */
export function setThreadNotifyEval(db: DbDriver, threadId: string, evalAt: string): void {
  db.run('UPDATE comms_threads SET notify_eval_at = ? WHERE id = ?', evalAt, threadId)
}

/** Recent inbound plain-text bodies for triage context, oldest first. */
export function recentInboundBodies(db: DbDriver, threadId: string, limit: number): string[] {
  return db
    .all<{ body_text: string }>(
      `SELECT body_text FROM comms_messages
       WHERE thread_id = ? AND is_me = 0
       ORDER BY sent_at DESC LIMIT ?`,
      threadId,
      limit
    )
    .map((r) => r.body_text)
    .reverse()
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
       LEFT JOIN people p ON p.archived_at IS NULL AND p.id = (
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
 * resurfaces with unread_count 1 (not the whole history). A thread with no
 * inbound messages at all (self-sent automation mail, note-to-self chats)
 * falls back to its newest message — the toggle must still work there.
 * Returns the flagged message's external id (for the remote label add), or
 * null if the thread has no messages.
 */
export function markThreadUnread(db: DbDriver, threadId: string, now: Date = new Date()): string | null {
  const msg =
    db.get<{ id: string; external_id: string }>(
      'SELECT id, external_id FROM comms_messages WHERE thread_id = ? AND is_me = 0 ORDER BY sent_at DESC LIMIT 1',
      threadId
    ) ??
    db.get<{ id: string; external_id: string }>(
      'SELECT id, external_id FROM comms_messages WHERE thread_id = ? ORDER BY sent_at DESC LIMIT 1',
      threadId
    )
  if (!msg) return null
  db.transaction(() => {
    db.run('UPDATE comms_messages SET is_read = 0 WHERE id = ?', msg.id)
    db.run(
      `UPDATE comms_threads SET
         unread_count = (SELECT COUNT(*) FROM comms_messages
                         WHERE thread_id = ? AND is_read = 0 AND (is_me = 0 OR id = ?)),
         updated_at = ?
       WHERE id = ?`,
      threadId,
      msg.id,
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

/** Re-key a thread (WhatsApp: a lid-keyed chat learns its phone jid). */
export function setThreadExternalId(
  db: DbDriver,
  threadId: string,
  externalId: string,
  now: Date = new Date()
): void {
  db.run(
    'UPDATE comms_threads SET external_id = ?, updated_at = ? WHERE id = ?',
    externalId,
    nowIso(now),
    threadId
  )
}

/**
 * Fold `fromId` into `intoId` — the same WhatsApp chat keyed two ways (phone
 * jid vs lid). Messages and queued sends move over; local flags survive
 * (pinned if either was, archived only if both were, labels unioned); a real
 * title beats a placeholder; snippet / last_message_at come from the newest
 * message the survivor now holds; unread counts add; a pending-inbox
 * dismissal/snooze on the absorbed thread carries over when the survivor has
 * none. The absorbed thread is deleted. Returns the message count moved.
 */
export function mergeThreads(db: DbDriver, fromId: string, intoId: string, now: Date = new Date()): number {
  if (fromId === intoId) return 0
  return db.transaction(() => {
    const from = getThread(db, fromId)
    const into = getThread(db, intoId)
    if (!from || !into) return 0
    const moved = db.run('UPDATE comms_messages SET thread_id = ? WHERE thread_id = ?', intoId, fromId).changes
    db.run('UPDATE comms_outbox SET thread_id = ? WHERE thread_id = ?', intoId, fromId)
    db.run(
      `UPDATE pending_overlay SET item_key = ? WHERE item_key = ?
         AND NOT EXISTS (SELECT 1 FROM pending_overlay WHERE item_key = ?)`,
      `thread:${intoId}`,
      `thread:${fromId}`,
      `thread:${intoId}`
    )
    db.run('DELETE FROM pending_overlay WHERE item_key = ?', `thread:${fromId}`)
    const labels = new Set<string>()
    for (const l of `${into.labels},${from.labels}`.split(',')) if (l) labels.add(l)
    const title = isPlaceholderTitle(into.title) && !isPlaceholderTitle(from.title) ? from.title : into.title
    // ids are ULIDs: the tiebreak on same-second messages is insertion order
    const newest = db.get<{ sent_at: string; body_text: string }>(
      'SELECT sent_at, body_text FROM comms_messages WHERE thread_id = ? ORDER BY sent_at DESC, id DESC LIMIT 1',
      intoId
    )
    db.run(
      `UPDATE comms_threads SET
         title = ?, labels = ?, pinned = ?, is_archived = ?,
         unread_count = ?, last_message_at = ?, snippet = ?,
         notify_eval_at = ?, updated_at = ?
       WHERE id = ?`,
      title,
      [...labels].join(','),
      into.pinned || from.pinned ? 1 : 0,
      into.is_archived && from.is_archived ? 1 : 0,
      into.unread_count + from.unread_count,
      newest?.sent_at ?? into.last_message_at ?? from.last_message_at,
      newest ? newest.body_text.replace(/\s+/g, ' ').trim().slice(0, SNIPPET_LEN) : into.snippet,
      [into.notify_eval_at, from.notify_eval_at].filter(Boolean).sort().pop() ?? null,
      nowIso(now),
      intoId
    )
    db.run('DELETE FROM comms_threads WHERE id = ?', fromId)
    return moved
  })
}

export interface FoldResult {
  action: 'merged' | 'rekeyed' | 'none'
  /** the surviving thread (undefined for 'none') */
  threadId?: string
  /** messages that changed thread ('merged') or key ('rekeyed') */
  messages: number
  /** inbound rows whose sender handle moved to the phone digits */
  handles: number
}

/**
 * A WhatsApp thread keyed by `lidJid` becomes the `pnJid` thread, atomically:
 * merged into an existing phone thread, or re-keyed in place (id, pins and
 * labels survive). Inbound sender handles switch to the phone digits so the
 * rows link to People. A placeholder title becomes `title` when given, else
 * the number — a lid could only ever be titled 'WhatsApp chat'.
 */
export function foldLidThread(
  db: DbDriver,
  accountId: string,
  lidJid: string,
  pnJid: string,
  title?: string,
  now: Date = new Date()
): FoldResult {
  return db.transaction(() => {
    const lidThread = getThreadByExternal(db, accountId, lidJid)
    if (!lidThread) return { action: 'none', messages: 0, handles: 0 }
    const pnThread = getThreadByExternal(db, accountId, pnJid)
    let action: FoldResult['action']
    let messages: number
    if (pnThread) {
      action = 'merged'
      messages = mergeThreads(db, lidThread.id, pnThread.id, now)
    } else {
      action = 'rekeyed'
      setThreadExternalId(db, lidThread.id, pnJid, now)
      messages = db.get<{ n: number }>('SELECT COUNT(*) n FROM comms_messages WHERE thread_id = ?', lidThread.id)!.n
    }
    const lidUser = lidJid.split('@')[0]
    const pnUser = pnJid.split('@')[0]
    const handles = replaceSenderHandle(db, accountId, 'whatsapp', lidUser, pnUser, now)
    const survivor = getThreadByExternal(db, accountId, pnJid)!
    if (isPlaceholderTitle(survivor.title)) setThreadTitle(db, survivor.id, title || `+${pnUser}`, now)
    return { action, threadId: survivor.id, messages, handles }
  })
}

/**
 * Inbound sender handles that may still be lid digits — the lid→phone handle
 * sweep's candidates. A handle that keys a phone-jid thread of the account is
 * a phone number and is left out: asking the store about `<phone>@lid` is a
 * miss today, but a collision with a real lid would rewrite genuine phone
 * handles onto another number, account-wide.
 */
export function listInboundSenderHandles(db: DbDriver, accountId: string): string[] {
  return db
    .all<{ sender_handle: string }>(
      `SELECT DISTINCT m.sender_handle FROM comms_messages m
       WHERE m.account_id = ? AND m.is_me = 0 AND m.sender_handle != ''
         AND NOT EXISTS (SELECT 1 FROM comms_threads t
                         WHERE t.account_id = m.account_id
                           AND t.external_id = m.sender_handle || '@s.whatsapp.net')`,
      accountId
    )
    .map((r) => r.sender_handle)
}

/**
 * Re-key an account's inbound messages from one sender handle to another
 * (WhatsApp: lid digits → phone digits) and link them to whoever the new
 * handle resolves to. Returns rows changed.
 */
export function replaceSenderHandle(
  db: DbDriver,
  accountId: string,
  provider: CommsProvider,
  from: string,
  to: string,
  now: Date = new Date()
): number {
  if (!from || !to || from === to) return 0
  return db.transaction(() => {
    const personId = resolvePersonForHandle(db, provider, to, now)
    return db.run(
      `UPDATE comms_messages SET sender_handle = ?, person_id = COALESCE(person_id, ?)
       WHERE account_id = ? AND sender_handle = ? AND is_me = 0`,
      to,
      personId,
      accountId,
      from
    ).changes
  })
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

/** Recount a thread's unread_count and (gmail) is_archived from its messages.
 *  Gmail-only caller: is_read mirrors the UNREAD label there, which gmail
 *  applies to self-sent mail too — so unlike the other providers' counts,
 *  this one must NOT filter on is_me, or a mark-unread on a self-sent thread
 *  gets wiped by the label-history recompute on the next sync tick. */
export function recomputeThreadState(db: DbDriver, threadId: string, now: Date = new Date()): void {
  db.transaction(() => {
    db.run(
      `UPDATE comms_threads SET
         unread_count = (SELECT COUNT(*) FROM comms_messages WHERE thread_id = ? AND is_read = 0),
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

/** Remove an identity link and clear person_id on its messages (inverse of linkHandleToPerson). */
export function unlinkHandle(db: DbDriver, provider: CommsProvider, handle: string): void {
  db.transaction(() => {
    db.run('DELETE FROM comms_identities WHERE provider = ? AND handle = ?', provider, handle)
    db.run(
      'UPDATE comms_messages SET person_id = NULL WHERE provider = ? AND sender_handle = ?',
      provider,
      handle
    )
  })
}

/** Every linked handle for a person — the detail view's "linked accounts" list. */
export function listIdentitiesForPerson(db: DbDriver, personId: string): CommsIdentity[] {
  return db.all<CommsIdentity>(
    'SELECT * FROM comms_identities WHERE person_id = ? ORDER BY provider, handle',
    personId
  )
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
    // gmail: UNREAD is authoritative for self-sent mail too (mail to yourself
    // arrives unread) — count it, so the badge matches gmail and survives the
    // recompute. Other providers never treat own outbound as unread.
    if (!input.is_read && (!input.is_me || input.provider === 'gmail')) {
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

// ---------- attachments ----------

export function getMessage(db: DbDriver, id: string): CommsMessage | undefined {
  return db.get<CommsMessage>('SELECT * FROM comms_messages WHERE id = ?', id)
}

export function getMessageByExternal(
  db: DbDriver,
  accountId: string,
  externalId: string
): CommsMessage | undefined {
  return db.get<CommsMessage>(
    'SELECT * FROM comms_messages WHERE account_id = ? AND external_id = ?',
    accountId,
    externalId
  )
}

/** Record a message's attachments. INSERT OR IGNORE on (message_id,
 *  external_ref) keeps backfill re-ingests idempotent. */
export function addAttachments(
  db: DbDriver,
  messageId: string,
  attachments: AttachmentUpsert[],
  now: Date = new Date()
): void {
  for (const a of attachments) {
    db.run(
      `INSERT OR IGNORE INTO comms_attachments (id, message_id, filename, mime_type, size_bytes, external_ref, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      newId(),
      messageId,
      a.filename ?? '',
      a.mime_type ?? '',
      a.size_bytes ?? null,
      a.external_ref,
      nowIso(now)
    )
  }
}

export function getAttachment(db: DbDriver, id: string): CommsAttachment | undefined {
  return db.get<CommsAttachment>('SELECT * FROM comms_attachments WHERE id = ?', id)
}

/** All attachments across a thread — one query for the whole message pane. */
export function listThreadAttachments(db: DbDriver, threadId: string): CommsAttachment[] {
  return db.all<CommsAttachment>(
    `SELECT a.* FROM comms_attachments a
     JOIN comms_messages m ON m.id = a.message_id
     WHERE m.thread_id = ? ORDER BY m.sent_at, a.created_at`,
    threadId
  )
}

export function setAttachmentLocalPath(db: DbDriver, id: string, localPath: string): void {
  db.run('UPDATE comms_attachments SET local_path = ? WHERE id = ?', localPath, id)
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

/**
 * Atomically claim ONE specific queued item (sendNow's own enqueue). Returns
 * false when the drain already grabbed it — never touches other items, so a
 * queued agent message can't be stranded in 'sending' by a user send.
 */
export function claimOutboxItem(db: DbDriver, id: string): boolean {
  return (
    db.run("UPDATE comms_outbox SET status = 'sending' WHERE id = ? AND status = 'queued'", id)
      .changes > 0
  )
}

/**
 * Persist one delivered unit the moment the provider accepts it, so a crash
 * requeue or a manual retry resumes at the first undelivered unit instead of
 * resending the whole batch. Read-modify-write inside a transaction (there is
 * a single drainer today, but be safe).
 *
 * Residual window, by design: a crash between the provider accepting a unit
 * and this write committing re-sends that ONE unit on resume. Shrinking it to
 * zero needs provider-side idempotency keys WhatsApp doesn't offer.
 */
export function recordOutboxDelivery(
  db: DbDriver,
  id: string,
  unitKey: string,
  externalId: string
): void {
  db.transaction(() => {
    const row = db.get<{ delivered_json: string | null }>(
      'SELECT delivered_json FROM comms_outbox WHERE id = ?',
      id
    )
    if (!row) return
    const map = deliveredMap(row)
    map[unitKey] = externalId
    db.run('UPDATE comms_outbox SET delivered_json = ? WHERE id = ?', JSON.stringify(map), id)
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

/** Requeue items stuck in 'sending' (e.g. app was killed mid-send) — call on
 *  startup. delivered_json survives the flip, so dispatch resumes at the
 *  first undelivered unit rather than resending the whole batch. */
export function requeueStuckSending(db: DbDriver): number {
  return db.run("UPDATE comms_outbox SET status = 'queued' WHERE status = 'sending'").changes
}

/** Give a claimed item back to the queue untouched — drain deferral, e.g.
 *  the provider socket is mid-reconnect. Not a failure: error and
 *  delivered_json stay as they were. */
export function unclaimOutbox(db: DbDriver, id: string): void {
  db.run("UPDATE comms_outbox SET status = 'queued' WHERE id = ? AND status = 'sending'", id)
}

/** Flip one failed row back to queued for a user-driven retry — same row, so
 *  delivered_json keeps already-shipped units out of the re-send. Returns
 *  false when the row isn't in 'failed' (unknown, in flight, or already sent). */
export function requeueFailed(db: DbDriver, id: string): boolean {
  return (
    db.run(
      "UPDATE comms_outbox SET status = 'queued', error = NULL WHERE id = ? AND status = 'failed'",
      id
    ).changes > 0
  )
}

/** Failed sends plus rows stuck in queued/sending past a grace window (the
 *  drain loop normally empties within seconds; restart requeues sending →
 *  queued) — the Pending inbox's outbox source. Thread title joined for a
 *  human destination on slack/whatsapp, where to_json carries none. */
export function listOutboxPending(
  db: DbDriver,
  now: Date = new Date(),
  stuckAfterMs = 10 * 60_000
): (OutboxItem & { thread_title: string | null })[] {
  const cutoff = new Date(now.getTime() - stuckAfterMs).toISOString()
  return db.all<OutboxItem & { thread_title: string | null }>(
    `SELECT o.*, t.title AS thread_title FROM comms_outbox o
     LEFT JOIN comms_threads t ON t.id = o.thread_id
     WHERE o.status = 'failed' OR (o.status IN ('queued','sending') AND o.created_at < ?)
     ORDER BY o.created_at DESC`,
    cutoff
  )
}

/** Drop an unsent outbox row for good (Pending's Discard). Sent rows are
 *  history, not pending work — refuse to delete them. */
export function deleteOutboxItem(db: DbDriver, id: string): boolean {
  return db.run("DELETE FROM comms_outbox WHERE id = ? AND status != 'sent'", id).changes > 0
}

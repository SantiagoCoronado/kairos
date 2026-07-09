// Communications module row types + input shapes. Shared by the Electron
// app, the MCP server, and the agent tools. Pure types, no runtime imports.

export type CommsProvider = 'gmail' | 'slack' | 'whatsapp'
export type CommsAccountStatus = 'connected' | 'needs_auth' | 'error' | 'disabled'
export type CommsThreadKind = 'email' | 'dm' | 'group' | 'channel'
export type OutboxStatus = 'queued' | 'sending' | 'sent' | 'failed'

export interface CommsAccount {
  id: string
  provider: CommsProvider
  /** gmail address | slack team_id:user_id | whatsapp jid */
  external_id: string
  display_name: string
  status: CommsAccountStatus
  error: string | null
  /** JSON: gmail {historyId}, slack {channelsFetchedAt}, whatsapp {} */
  sync_state: string
  last_sync_at: string | null
  sort_order: number
  created_at: string
  updated_at: string
}

export interface CommsThread {
  id: string
  account_id: string
  provider: CommsProvider
  /** gmail threadId | slack channel id | whatsapp chat jid */
  external_id: string
  kind: CommsThreadKind
  title: string
  snippet: string
  last_message_at: string | null
  unread_count: number
  /** slack channels default off (opt-in); everything else on */
  sync_enabled: number
  /** slack: latest fetched ts */
  sync_cursor: string | null
  /** gmail: no message carries INBOX; slack/whatsapp: local-only flag */
  is_archived: number
  /** pinned threads float to the top of the list (local-only) */
  pinned: number
  /** comma-joined labels from core/labels.ts taxonomy; '' = not classified yet */
  labels: string
  created_at: string
  updated_at: string
}

/** Thread list row: thread + the linked person of its latest inbound sender. */
export interface CommsThreadListItem extends CommsThread {
  person_id: string | null
  person_name: string | null
}

export interface CommsMessage {
  id: string
  thread_id: string
  account_id: string
  provider: CommsProvider
  /** gmail message id | slack ts | whatsapp key.id */
  external_id: string
  sender_name: string
  /** normalized: lowercased email | slack user id | E.164-ish phone */
  sender_handle: string
  is_me: number
  person_id: string | null
  sent_at: string
  body_text: string
  /** gmail: raw text/html part when present */
  body_html: string | null
  has_attachments: number
  is_read: number
  /** gmail: message carries the INBOX label; others always 1 */
  is_inbox: number
  raw_json: string | null
  created_at: string
}

export interface CommsAttachment {
  id: string
  message_id: string
  filename: string
  mime_type: string
  size_bytes: number | null
  /** gmail: part attachmentId; whatsapp: the message external id (bytes come from raw_json) */
  external_ref: string
  /** download cache — set once the file is on disk */
  local_path: string | null
  created_at: string
}

export interface AttachmentUpsert {
  filename?: string
  mime_type?: string
  size_bytes?: number | null
  external_ref: string
}

export interface OutboxItem {
  id: string
  account_id: string
  thread_id: string | null
  provider: CommsProvider
  /** JSON: {to:[…],subject?} | {channel} | {jid} */
  to_json: string
  body_text: string
  /** gmail Message-ID header for In-Reply-To/References */
  in_reply_to: string | null
  status: OutboxStatus
  error: string | null
  source: 'app' | 'agent'
  /** provider id of the sent message */
  external_id: string | null
  created_at: string
  sent_at: string | null
}

// ---------- input shapes ----------

export interface ThreadFilter {
  accountId?: string
  provider?: CommsProvider
  unreadOnly?: boolean
  search?: string
  /** archive bucket to show (default 'inbox') */
  box?: 'inbox' | 'archived' | 'all'
  /** exact-match one label from the taxonomy */
  label?: string
  /** include threads with sync disabled (default false) */
  includeDisabled?: boolean
  limit?: number
}

export interface AccountUpsert {
  provider: CommsProvider
  external_id: string
  display_name: string
  status?: CommsAccountStatus
}

export interface ThreadUpsert {
  account_id: string
  provider: CommsProvider
  external_id: string
  kind: CommsThreadKind
  title?: string
  sync_enabled?: number
}

export interface MessageUpsert {
  thread_id: string
  account_id: string
  provider: CommsProvider
  external_id: string
  sender_name?: string
  sender_handle?: string
  is_me?: boolean
  sent_at: string
  body_text?: string
  body_html?: string | null
  has_attachments?: boolean
  is_read?: boolean
  /** gmail: message carries INBOX (default true) */
  is_inbox?: boolean
  raw_json?: string | null
}

export interface OutboxEnqueue {
  account_id: string
  thread_id?: string | null
  provider: CommsProvider
  to_json: string
  body_text: string
  in_reply_to?: string | null
  source?: 'app' | 'agent'
}

export interface MessageSearchHit extends CommsMessage {
  thread_title: string
  account_display_name: string
}

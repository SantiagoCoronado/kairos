// Gmail provider: raw fetch against the Gmail REST API (no googleapis).
// OAuth is the installed-app loopback flow with the user's own client id/secret.
import type { DbDriver } from '../../core/driver'
import type { CommsAccount, OutboxItem } from '../../core/comms-types'
import * as repo from '../../core/repo/comms'
import { getSettings } from '../settings'
import { runLoopbackFlow } from './oauth'
import { saveTokens, loadTokens } from './credentials'
import { buildMime, toBase64Url } from './mime'

const API = 'https://gmail.googleapis.com/gmail/v1/users/me'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const SCOPES = 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send openid email'
const BACKFILL_QUERY = 'newer_than:30d -in:spam -in:trash'
const BACKFILL_CAP = 500
const FETCH_CONCURRENCY = 4

interface GmailTokens {
  access_token: string
  refresh_token: string
  /** epoch ms */
  expires_at: number
  /** the OAuth client that issued the refresh token — refreshes must use this
   *  exact client, even if Settings later holds a different one (tokens older
   *  than this field fall back to Settings) */
  client_id?: string
  client_secret?: string
}

/** thrown when the account needs the user to re-run the consent flow */
export class GmailAuthError extends Error {}

interface GmailHeader {
  name: string
  value: string
}
interface GmailPart {
  mimeType?: string
  filename?: string
  body?: { data?: string; attachmentId?: string }
  parts?: GmailPart[]
}
interface GmailMessage {
  id: string
  threadId: string
  labelIds?: string[]
  internalDate?: string
  payload?: GmailPart & { headers?: GmailHeader[] }
}

// ---------- OAuth ----------

function requireClient(): { clientId: string; clientSecret: string } {
  const s = getSettings()
  if (!s.googleClientId || !s.googleClientSecret) {
    throw new Error('Google OAuth client not configured — paste a client ID and secret in Settings → Connections.')
  }
  return { clientId: s.googleClientId, clientSecret: s.googleClientSecret }
}

async function exchangeToken(body: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString()
  })
  const json = (await res.json()) as Record<string, unknown>
  if (!res.ok) {
    const code = String(json['error'] ?? res.status)
    if (code === 'invalid_grant') throw new GmailAuthError('Google refresh token revoked or expired')
    if (code === 'unauthorized_client' || code === 'invalid_client' || code === 'deleted_client')
      throw new GmailAuthError(
        'OAuth client mismatch — this account was connected with different Google credentials. Reconnect it.'
      )
    throw new Error(`Google token endpoint error: ${code}`)
  }
  return json
}

export async function connectGmail(db: DbDriver): Promise<CommsAccount> {
  const { clientId, clientSecret } = requireClient()
  const flow = await runLoopbackFlow({
    usePkce: true,
    buildAuthUrl: ({ redirectUri, state, codeChallenge }) => {
      const p = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: SCOPES,
        state,
        code_challenge: codeChallenge!,
        code_challenge_method: 'S256',
        access_type: 'offline',
        // consent forces a refresh_token on re-adds; select_account enables multi-account
        prompt: 'consent select_account'
      })
      return `https://accounts.google.com/o/oauth2/v2/auth?${p}`
    }
  })

  const tok = await exchangeToken({
    client_id: clientId,
    client_secret: clientSecret,
    code: flow.code,
    code_verifier: flow.codeVerifier!,
    grant_type: 'authorization_code',
    redirect_uri: flow.redirectUri
  })
  if (!tok['refresh_token']) throw new Error('Google did not return a refresh token — remove the app from your Google account permissions and retry')

  const tokens: GmailTokens = {
    access_token: String(tok['access_token']),
    refresh_token: String(tok['refresh_token']),
    expires_at: Date.now() + Number(tok['expires_in'] ?? 3600) * 1000,
    client_id: clientId,
    client_secret: clientSecret
  }

  const profileRes = await fetch(`${API}/profile`, {
    headers: { Authorization: `Bearer ${tokens.access_token}` }
  })
  if (!profileRes.ok) throw new Error(`could not read Gmail profile (${profileRes.status})`)
  const profile = (await profileRes.json()) as { emailAddress: string; historyId: string }

  const account = repo.upsertAccount(db, {
    provider: 'gmail',
    external_id: profile.emailAddress.toLowerCase(),
    display_name: profile.emailAddress
  })
  saveTokens(db, account.id, tokens)
  // record the history cursor BEFORE backfill so nothing between now and the
  // first incremental sync can fall in a gap
  repo.patchSyncState(db, account.id, { historyId: profile.historyId })
  return account
}

// ---------- authenticated fetch ----------

async function ensureAccessToken(db: DbDriver, account: CommsAccount): Promise<GmailTokens> {
  const tokens = loadTokens<GmailTokens>(db, account.id)
  if (!tokens) throw new GmailAuthError('no stored credentials')
  if (Date.now() < tokens.expires_at - 60_000) return tokens

  // refresh with the client that issued the token, not whatever is currently
  // in Settings — swapping Settings credentials must not break other accounts
  let clientId = tokens.client_id
  let clientSecret = tokens.client_secret
  if (!clientId || !clientSecret) ({ clientId, clientSecret } = requireClient())
  const tok = await exchangeToken({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: tokens.refresh_token,
    grant_type: 'refresh_token'
  })
  const next: GmailTokens = {
    access_token: String(tok['access_token']),
    refresh_token: tokens.refresh_token,
    expires_at: Date.now() + Number(tok['expires_in'] ?? 3600) * 1000,
    client_id: clientId,
    client_secret: clientSecret
  }
  saveTokens(db, account.id, next)
  return next
}

async function gmailFetch(
  db: DbDriver,
  account: CommsAccount,
  path: string,
  init?: RequestInit
): Promise<Record<string, unknown>> {
  let tokens = await ensureAccessToken(db, account)
  let res = await fetch(`${API}${path}`, {
    ...init,
    headers: { ...init?.headers, Authorization: `Bearer ${tokens.access_token}` }
  })
  if (res.status === 401) {
    // token revoked server-side before its expiry — force one refresh and retry
    tokens = { ...tokens, expires_at: 0 }
    saveTokens(db, account.id, tokens)
    tokens = await ensureAccessToken(db, account)
    res = await fetch(`${API}${path}`, {
      ...init,
      headers: { ...init?.headers, Authorization: `Bearer ${tokens.access_token}` }
    })
  }
  if (res.status === 404) throw new GmailNotFound(path)
  if (!res.ok) throw new Error(`Gmail API ${path} → ${res.status}`)
  return (await res.json()) as Record<string, unknown>
}

export class GmailNotFound extends Error {}

// ---------- message parsing ----------

const header = (msg: GmailMessage, name: string): string =>
  msg.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? ''

/** "Anna Ríos <anna@example.com>" → { name: 'Anna Ríos', email: 'anna@example.com' } */
function parseAddress(raw: string): { name: string; email: string } {
  const m = raw.match(/^\s*(?:"?([^"<]*)"?\s*)?<([^>]+)>\s*$/)
  if (m) return { name: (m[1] ?? '').trim(), email: m[2].trim().toLowerCase() }
  return { name: '', email: raw.trim().toLowerCase() }
}

const decodeB64Url = (data: string): string =>
  Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')

const stripHtml = (html: string): string =>
  html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

function findPart(part: GmailPart | undefined, mime: string): GmailPart | undefined {
  if (!part) return undefined
  if (part.mimeType === mime && part.body?.data) return part
  for (const child of part.parts ?? []) {
    const hit = findPart(child, mime)
    if (hit) return hit
  }
  return undefined
}

function hasAttachment(part: GmailPart | undefined): boolean {
  if (!part) return false
  if (part.filename && part.body?.attachmentId) return true
  return (part.parts ?? []).some(hasAttachment)
}

function extractBody(msg: GmailMessage): string {
  const plain = findPart(msg.payload, 'text/plain')
  if (plain?.body?.data) return decodeB64Url(plain.body.data)
  const html = findPart(msg.payload, 'text/html')
  if (html?.body?.data) return stripHtml(decodeB64Url(html.body.data))
  return ''
}

const stripReplyPrefix = (subject: string): string =>
  subject.replace(/^\s*((re|fwd?|aw|sv)\s*(\[\d+\])?\s*:\s*)+/i, '').trim()

/** Ingest one full-format Gmail message; returns true if it was new. */
export function ingestGmailMessage(db: DbDriver, account: CommsAccount, msg: GmailMessage): boolean {
  const from = parseAddress(header(msg, 'From'))
  const isMe = from.email === account.external_id
  const subject = header(msg, 'Subject')
  const thread = repo.upsertThread(db, {
    account_id: account.id,
    provider: 'gmail',
    external_id: msg.threadId,
    kind: 'email',
    title: stripReplyPrefix(subject) || '(no subject)'
  })
  return repo.upsertMessage(db, {
    thread_id: thread.id,
    account_id: account.id,
    provider: 'gmail',
    external_id: msg.id,
    sender_name: from.name || from.email,
    sender_handle: from.email,
    is_me: isMe,
    sent_at: new Date(Number(msg.internalDate ?? Date.now())).toISOString(),
    body_text: extractBody(msg).slice(0, 100_000),
    has_attachments: hasAttachment(msg.payload),
    is_read: !(msg.labelIds ?? []).includes('UNREAD'),
    raw_json: JSON.stringify({
      headers: {
        from: header(msg, 'From'),
        to: header(msg, 'To'),
        cc: header(msg, 'Cc'),
        reply_to: header(msg, 'Reply-To'),
        message_id: header(msg, 'Message-ID'),
        subject
      },
      labelIds: msg.labelIds ?? []
    })
  })
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++
        results[i] = await fn(items[i])
      }
    })
  )
  return results
}

async function fetchAndIngest(db: DbDriver, account: CommsAccount, ids: string[]): Promise<number> {
  let added = 0
  await mapLimit(ids, FETCH_CONCURRENCY, async (id) => {
    try {
      const msg = (await gmailFetch(db, account, `/messages/${id}?format=full`)) as unknown as GmailMessage
      if (ingestGmailMessage(db, account, msg)) added++
    } catch (err) {
      if (err instanceof GmailNotFound) return // message deleted between list and get
      throw err
    }
  })
  return added
}

// ---------- sync ----------

async function backfill(db: DbDriver, account: CommsAccount): Promise<number> {
  const ids: string[] = []
  let pageToken: string | undefined
  while (ids.length < BACKFILL_CAP) {
    const p = new URLSearchParams({ q: BACKFILL_QUERY, maxResults: '100' })
    if (pageToken) p.set('pageToken', pageToken)
    const page = await gmailFetch(db, account, `/messages?${p}`)
    for (const m of (page['messages'] as { id: string }[] | undefined) ?? []) ids.push(m.id)
    pageToken = page['nextPageToken'] as string | undefined
    if (!pageToken) break
  }
  return fetchAndIngest(db, account, ids.slice(0, BACKFILL_CAP))
}

async function incremental(db: DbDriver, account: CommsAccount, historyId: string): Promise<number> {
  const ids = new Set<string>()
  let latest = historyId
  let pageToken: string | undefined
  do {
    const p = new URLSearchParams({ startHistoryId: historyId, historyTypes: 'messageAdded' })
    if (pageToken) p.set('pageToken', pageToken)
    const page = await gmailFetch(db, account, `/history?${p}`)
    for (const h of (page['history'] as
      | { messagesAdded?: { message: { id: string } }[] }[]
      | undefined) ?? []) {
      for (const ma of h.messagesAdded ?? []) ids.add(ma.message.id)
    }
    latest = String(page['historyId'] ?? latest)
    pageToken = page['nextPageToken'] as string | undefined
  } while (pageToken)

  const added = await fetchAndIngest(db, account, [...ids])
  repo.patchSyncState(db, account.id, { historyId: latest })
  return added
}

/** One sync pass. Returns the number of newly ingested messages. */
export async function syncGmailAccount(db: DbDriver, account: CommsAccount): Promise<number> {
  let state: { historyId?: string; backfilled?: boolean } = {}
  try {
    state = JSON.parse(account.sync_state) as typeof state
  } catch {
    // corrupted sync_state: treat as fresh
  }

  if (!state.backfilled) {
    const added = await backfill(db, account)
    repo.patchSyncState(db, account.id, { backfilled: true })
    return added
  }

  if (!state.historyId) {
    // shouldn't happen (connect stores it), but recover via profile
    const profile = await gmailFetch(db, account, '/profile')
    repo.patchSyncState(db, account.id, { historyId: String(profile['historyId']) })
    return 0
  }

  try {
    return await incremental(db, account, state.historyId)
  } catch (err) {
    if (err instanceof GmailNotFound) {
      // history expired (404) — reset the cursor and re-backfill; inserts are idempotent
      const profile = await gmailFetch(db, account, '/profile')
      repo.patchSyncState(db, account.id, { historyId: String(profile['historyId']) })
      return backfill(db, account)
    }
    throw err
  }
}

// ---------- send ----------

interface GmailToJson {
  to?: string[]
  cc?: string[]
  subject?: string
}

/**
 * Send an outbox item. For replies (thread_id set) the recipients/subject are
 * derived from the newest inbound message when not given explicitly.
 */
export async function sendGmail(db: DbDriver, account: CommsAccount, item: OutboxItem): Promise<string> {
  const to = JSON.parse(item.to_json) as GmailToJson
  let recipients = to.to ?? []
  let subject = to.subject ?? ''
  let inReplyTo = item.in_reply_to
  let threadExternalId: string | undefined

  if (item.thread_id) {
    const thread = repo.getThread(db, item.thread_id)
    if (thread) {
      threadExternalId = thread.external_id
      const messages = repo.listMessages(db, thread.id)
      const lastInbound = [...messages].reverse().find((m) => !m.is_me)
      const last = lastInbound ?? messages[messages.length - 1]
      if (last?.raw_json) {
        try {
          const raw = JSON.parse(last.raw_json) as { headers?: Record<string, string> }
          if (!recipients.length) {
            const replyTo = raw.headers?.['reply_to'] || raw.headers?.['from'] || ''
            if (replyTo) recipients = [replyTo]
          }
          if (!inReplyTo) inReplyTo = raw.headers?.['message_id'] || null
          if (!subject) {
            const orig = raw.headers?.['subject'] ?? thread.title
            subject = /^\s*re\s*:/i.test(orig) ? orig : `Re: ${orig}`
          }
        } catch {
          // raw_json unparsable: fall through to validation below
        }
      }
      if (!subject) subject = `Re: ${thread.title}`
    }
  }

  if (!recipients.length) throw new Error('no recipients')
  if (!subject) throw new Error('no subject')

  const raw = buildMime({
    from: account.external_id,
    to: recipients,
    cc: to.cc,
    subject,
    bodyText: item.body_text,
    inReplyTo
  })
  const body: Record<string, string> = { raw: toBase64Url(raw) }
  if (threadExternalId) body['threadId'] = threadExternalId

  const sent = await gmailFetch(db, account, '/messages/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  const sentId = String(sent['id'])

  // ingest our own copy right away so the thread updates without waiting a poll
  try {
    const full = (await gmailFetch(db, account, `/messages/${sentId}?format=full`)) as unknown as GmailMessage
    ingestGmailMessage(db, account, full)
  } catch {
    // non-fatal: the next incremental sync will pick it up
  }
  return sentId
}

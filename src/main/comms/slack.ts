// Slack provider: raw fetch against the Slack Web API with a user token
// (xoxp) from the user's own Slack app, so Kairos reads and sends as them.
import type { DbDriver } from '../../core/driver'
import type { CommsAccount, CommsThread, OutboxItem } from '../../core/comms-types'
import * as repo from '../../core/repo/comms'
import { getSettings } from '../settings'
import { runLoopbackFlow } from './oauth'
import { saveTokens, loadTokens } from './credentials'

// Must be registered verbatim as a redirect URL in the user's Slack app.
export const SLACK_REDIRECT_PORT = 43117

const USER_SCOPES = [
  'channels:history',
  'groups:history',
  'im:history',
  'mpim:history',
  'channels:read',
  'groups:read',
  'im:read',
  'mpim:read',
  'users:read',
  'chat:write'
].join(',')

/** refresh the conversations list this often (per account) */
const CHANNEL_LIST_INTERVAL_MS = 15 * 60 * 1000
const HISTORY_PAGE_LIMIT = 200

interface SlackTokens {
  access_token: string
  team_id: string
  user_id: string
}

export class SlackAuthError extends Error {}

// ---------- Web API ----------

async function slackApi(
  token: string,
  method: string,
  params: Record<string, string> = {}
): Promise<Record<string, unknown>> {
  for (;;) {
    const res = await fetch(`https://slack.com/api/${method}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams(params).toString()
    })
    if (res.status === 429) {
      const wait = Number(res.headers.get('Retry-After') ?? 5)
      await new Promise((r) => setTimeout(r, Math.min(wait, 60) * 1000))
      continue
    }
    const json = (await res.json()) as Record<string, unknown>
    if (!json['ok']) {
      const err = String(json['error'] ?? 'unknown')
      if (err === 'invalid_auth' || err === 'token_revoked' || err === 'account_inactive') {
        throw new SlackAuthError(err)
      }
      throw new Error(`Slack ${method} → ${err}`)
    }
    return json
  }
}

// ---------- OAuth ----------

export async function connectSlack(db: DbDriver): Promise<CommsAccount> {
  const s = getSettings()
  if (!s.slackClientId || !s.slackClientSecret) {
    throw new Error(
      'Slack OAuth client not configured — paste a client ID and secret in Settings → Connections.'
    )
  }
  const clientId = s.slackClientId
  const clientSecret = s.slackClientSecret

  const flow = await runLoopbackFlow({
    fixedPort: SLACK_REDIRECT_PORT,
    buildAuthUrl: ({ redirectUri, state }) => {
      const p = new URLSearchParams({
        client_id: clientId,
        user_scope: USER_SCOPES,
        redirect_uri: redirectUri,
        state
      })
      return `https://slack.com/oauth/v2/authorize?${p}`
    }
  })

  const res = await fetch('https://slack.com/api/oauth.v2.access', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code: flow.code,
      redirect_uri: flow.redirectUri
    }).toString()
  })
  const json = (await res.json()) as {
    ok: boolean
    error?: string
    team?: { id: string; name: string }
    authed_user?: { id: string; access_token?: string }
  }
  if (!json.ok || !json.authed_user?.access_token) {
    throw new Error(`Slack OAuth failed: ${json.error ?? 'no user token returned'}`)
  }

  const tokens: SlackTokens = {
    access_token: json.authed_user.access_token,
    team_id: json.team?.id ?? '?',
    user_id: json.authed_user.id
  }
  const account = repo.upsertAccount(db, {
    provider: 'slack',
    external_id: `${tokens.team_id}:${tokens.user_id}`,
    display_name: json.team?.name ?? 'Slack'
  })
  saveTokens(db, account.id, tokens)
  return account
}

// ---------- sync ----------

interface SlackConversation {
  id: string
  is_im?: boolean
  is_mpim?: boolean
  is_archived?: boolean
  name?: string
  user?: string // im peer
}

function requireTokens(db: DbDriver, account: CommsAccount): SlackTokens {
  const tokens = loadTokens<SlackTokens>(db, account.id)
  if (!tokens) throw new SlackAuthError('no stored credentials')
  return tokens
}

/** users.info cache: user id → display name (per process lifetime) */
const userNames = new Map<string, string>()

async function userName(token: string, userId: string): Promise<string> {
  if (!userId) return ''
  const cached = userNames.get(userId)
  if (cached) return cached
  try {
    const res = await slackApi(token, 'users.info', { user: userId })
    const u = res['user'] as { real_name?: string; name?: string } | undefined
    const name = u?.real_name || u?.name || userId
    userNames.set(userId, name)
    return name
  } catch {
    return userId
  }
}

async function refreshConversations(
  db: DbDriver,
  account: CommsAccount,
  tokens: SlackTokens
): Promise<void> {
  let cursor: string | undefined
  do {
    const params: Record<string, string> = {
      types: 'im,mpim,private_channel,public_channel',
      exclude_archived: 'true',
      limit: '200'
    }
    if (cursor) params['cursor'] = cursor
    const res = await slackApi(tokens.access_token, 'users.conversations', params)
    for (const c of (res['channels'] as SlackConversation[] | undefined) ?? []) {
      const isDm = Boolean(c.is_im)
      const isGroupDm = Boolean(c.is_mpim)
      const title = isDm ? await userName(tokens.access_token, c.user ?? '') : (c.name ?? c.id)
      repo.upsertThread(db, {
        account_id: account.id,
        provider: 'slack',
        external_id: c.id,
        kind: isDm ? 'dm' : isGroupDm ? 'group' : 'channel',
        title,
        // channels are opt-in (volume + rate limits); DMs/group DMs sync by default
        sync_enabled: isDm || isGroupDm ? 1 : 0
      })
    }
    cursor = (res['response_metadata'] as { next_cursor?: string } | undefined)?.next_cursor || undefined
  } while (cursor)
  repo.patchSyncState(db, account.id, { channelsFetchedAt: Date.now() })
}

/** Channel-picker "refresh": re-list conversations now, skipping the 15 min cache. */
export async function refreshSlackChannels(db: DbDriver, account: CommsAccount): Promise<void> {
  const tokens = requireTokens(db, account)
  await refreshConversations(db, account, tokens)
}

async function syncThreadHistory(
  db: DbDriver,
  account: CommsAccount,
  tokens: SlackTokens,
  thread: CommsThread
): Promise<number> {
  const params: Record<string, string> = { channel: thread.external_id, limit: String(HISTORY_PAGE_LIMIT) }
  if (thread.sync_cursor) params['oldest'] = thread.sync_cursor
  const res = await slackApi(tokens.access_token, 'conversations.history', params)
  const messages = ((res['messages'] as Record<string, unknown>[] | undefined) ?? [])
    // plain user messages only; skip joins/leaves/bots without text
    .filter((m) => typeof m['ts'] === 'string' && (m['text'] || m['files']))

  let added = 0
  let maxTs = thread.sync_cursor ?? '0'
  for (const m of messages.reverse()) {
    const ts = String(m['ts'])
    const userId = String(m['user'] ?? m['bot_id'] ?? '')
    const isMe = userId === tokens.user_id
    const inserted = repo.upsertMessage(db, {
      thread_id: thread.id,
      account_id: account.id,
      provider: 'slack',
      external_id: ts,
      sender_name: await userName(tokens.access_token, userId),
      sender_handle: userId,
      is_me: isMe,
      sent_at: new Date(Number(ts.split('.')[0]) * 1000).toISOString(),
      body_text: String(m['text'] ?? ''),
      has_attachments: Boolean((m['files'] as unknown[] | undefined)?.length),
      // first fetch of a thread seeds as read; only messages after the cursor count as unread
      is_read: !thread.sync_cursor,
      raw_json: null
    })
    if (inserted) added++
    if (ts > maxTs) maxTs = ts
  }
  if (maxTs !== (thread.sync_cursor ?? '0')) repo.setThreadCursor(db, thread.id, maxTs)
  return added
}

/** One sync pass. Returns the number of newly ingested messages. */
export async function syncSlackAccount(db: DbDriver, account: CommsAccount): Promise<number> {
  const tokens = requireTokens(db, account)
  let state: { channelsFetchedAt?: number } = {}
  try {
    state = JSON.parse(account.sync_state) as typeof state
  } catch {
    // corrupted sync_state: refresh everything
  }
  if (!state.channelsFetchedAt || Date.now() - state.channelsFetchedAt > CHANNEL_LIST_INTERVAL_MS) {
    await refreshConversations(db, account, tokens)
  }

  // Per-thread fault isolation: one unreadable conversation must not kill the
  // account's sync (Slack Connect DMs/shared channels list fine but their
  // history is unreadable with a user token → channel_not_found).
  let added = 0
  const failures: string[] = []
  for (const thread of repo.listAccountThreads(db, account.id)) {
    if (!thread.sync_enabled) continue
    try {
      added += await syncThreadHistory(db, account, tokens, thread)
    } catch (err) {
      if (err instanceof SlackAuthError) throw err
      const msg = err instanceof Error ? err.message : String(err)
      if (/channel_not_found|is_archived|not_in_channel/.test(msg)) {
        repo.setThreadSyncEnabled(db, thread.id, false) // permanently inaccessible; stop trying
      } else {
        failures.push(`${thread.title || thread.external_id}: ${msg}`)
      }
    }
  }
  if (failures.length > 0) {
    throw new Error(`${failures.length} conversation(s) failed to sync — ${failures[0]}`)
  }
  return added
}

// ---------- send ----------

export async function sendSlack(db: DbDriver, account: CommsAccount, item: OutboxItem): Promise<string> {
  const tokens = requireTokens(db, account)
  const to = JSON.parse(item.to_json) as { channel?: string }
  let channel = to.channel
  if (!channel && item.thread_id) channel = repo.getThread(db, item.thread_id)?.external_id
  if (!channel) throw new Error('no Slack channel to send to')

  const res = await slackApi(tokens.access_token, 'chat.postMessage', {
    channel,
    text: item.body_text
  })
  const ts = String(res['ts'])

  if (item.thread_id) {
    repo.upsertMessage(db, {
      thread_id: item.thread_id,
      account_id: account.id,
      provider: 'slack',
      external_id: ts,
      sender_name: 'me',
      sender_handle: tokens.user_id,
      is_me: true,
      sent_at: new Date(Number(ts.split('.')[0]) * 1000).toISOString(),
      body_text: item.body_text
    })
    const thread = repo.getThread(db, item.thread_id)
    if (thread && (!thread.sync_cursor || ts > thread.sync_cursor)) {
      repo.setThreadCursor(db, item.thread_id, ts)
    }
  }
  return ts
}

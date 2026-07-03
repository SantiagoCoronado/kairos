// Google Calendar provider: raw fetch against the Calendar REST API (no
// googleapis), mirroring the Gmail integration in src/main/comms/gmail.ts.
// OAuth is the installed-app loopback flow with the user's own client id/secret.
import type { DbDriver } from '../../core/driver'
import type { CalendarAccount, CalendarAttendee, CalendarEventRecord } from '../../core/types'
import * as repo from '../../core/repo/calendar'
import type { RemoteEvent } from '../../core/repo/calendar'
import { getSettings } from '../settings'
import { runLoopbackFlow } from '../comms/oauth'
import { saveTokens, loadTokens } from '../comms/credentials'

const API = 'https://www.googleapis.com/calendar/v3'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const SCOPES = 'https://www.googleapis.com/auth/calendar openid email'

/** thrown when the account needs the user to re-run the consent flow */
export class GcalAuthError extends Error {}
export class GcalNotFound extends Error {}
/** 410 — the events syncToken expired; caller clears it and full-resyncs */
export class GcalGone extends Error {}
/** 409/412 — etag mismatch on push; caller re-fetches, remote wins */
export class GcalConflict extends Error {}

interface GcalTokens {
  access_token: string
  refresh_token: string
  /** epoch ms */
  expires_at: number
  /** the OAuth client that issued the refresh token (see gmail.ts) */
  client_id?: string
  client_secret?: string
}

// ---------- Google wire shapes ----------

export interface GoogleCalendarListEntry {
  id: string
  summary?: string
  summaryOverride?: string
  backgroundColor?: string
  primary?: boolean
  accessRole?: 'owner' | 'writer' | 'reader' | 'freeBusyReader'
  deleted?: boolean
}

interface GoogleEventTime {
  date?: string
  dateTime?: string
  timeZone?: string
}

export interface GoogleEvent {
  id: string
  etag?: string
  status?: 'confirmed' | 'tentative' | 'cancelled'
  summary?: string
  description?: string
  location?: string
  colorId?: string
  start?: GoogleEventTime
  end?: GoogleEventTime
  recurringEventId?: string
  attendees?: CalendarAttendee[]
  hangoutLink?: string
  conferenceData?: {
    entryPoints?: { entryPointType?: string; uri?: string }[]
    createRequest?: { status?: { statusCode?: string } }
  }
}

// ---------- OAuth ----------

function requireClient(): { clientId: string; clientSecret: string } {
  const s = getSettings()
  if (!s.googleClientId || !s.googleClientSecret) {
    throw new Error(
      'Google OAuth client not configured — paste a client ID and secret in Settings → Connections.'
    )
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
    if (code === 'invalid_grant') throw new GcalAuthError('Google refresh token revoked or expired')
    if (code === 'unauthorized_client' || code === 'invalid_client' || code === 'deleted_client')
      throw new GcalAuthError(
        'OAuth client mismatch — this account was connected with different Google credentials. Reconnect it.'
      )
    throw new Error(`Google token endpoint error: ${code}`)
  }
  return json
}

export async function connectGcal(db: DbDriver): Promise<CalendarAccount> {
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
  if (!tok['refresh_token'])
    throw new Error(
      'Google did not return a refresh token — remove the app from your Google account permissions and retry'
    )

  const tokens: GcalTokens = {
    access_token: String(tok['access_token']),
    refresh_token: String(tok['refresh_token']),
    expires_at: Date.now() + Number(tok['expires_in'] ?? 3600) * 1000,
    client_id: clientId,
    client_secret: clientSecret
  }

  const infoRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { Authorization: `Bearer ${tokens.access_token}` }
  })
  if (!infoRes.ok) throw new Error(`could not read Google profile (${infoRes.status})`)
  const info = (await infoRes.json()) as { email?: string }
  if (!info.email) throw new Error('Google profile did not include an email')

  const account = repo.upsertCalendarAccount(db, {
    external_id: info.email.toLowerCase(),
    display_name: info.email
  })
  saveTokens(db, account.id, tokens, 'calendar')
  return account
}

// ---------- authenticated fetch ----------

async function ensureAccessToken(db: DbDriver, account: CalendarAccount): Promise<GcalTokens> {
  const tokens = loadTokens<GcalTokens>(db, account.id, 'calendar')
  if (!tokens) throw new GcalAuthError('no stored credentials')
  if (Date.now() < tokens.expires_at - 60_000) return tokens

  let clientId = tokens.client_id
  let clientSecret = tokens.client_secret
  if (!clientId || !clientSecret) ({ clientId, clientSecret } = requireClient())
  const tok = await exchangeToken({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: tokens.refresh_token,
    grant_type: 'refresh_token'
  })
  const next: GcalTokens = {
    access_token: String(tok['access_token']),
    refresh_token: tokens.refresh_token,
    expires_at: Date.now() + Number(tok['expires_in'] ?? 3600) * 1000,
    client_id: clientId,
    client_secret: clientSecret
  }
  saveTokens(db, account.id, next, 'calendar')
  return next
}

async function gcalFetch(
  db: DbDriver,
  account: CalendarAccount,
  path: string,
  init?: RequestInit & { extraHeaders?: Record<string, string> }
): Promise<Record<string, unknown> | null> {
  let tokens = await ensureAccessToken(db, account)
  const doFetch = (t: GcalTokens): Promise<Response> =>
    fetch(`${API}${path}`, {
      ...init,
      headers: {
        ...init?.headers,
        ...init?.extraHeaders,
        Authorization: `Bearer ${t.access_token}`
      }
    })
  let res = await doFetch(tokens)
  if (res.status === 401) {
    tokens = { ...tokens, expires_at: 0 }
    saveTokens(db, account.id, tokens, 'calendar')
    tokens = await ensureAccessToken(db, account)
    res = await doFetch(tokens)
  }
  if (res.status === 404) throw new GcalNotFound(path)
  if (res.status === 410) throw new GcalGone(path)
  if (res.status === 409 || res.status === 412) throw new GcalConflict(path)
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    if (res.status === 403 && /insufficient|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(body)) {
      throw new GcalAuthError('Calendar permissions missing — reconnect this Google account')
    }
    throw new Error(`Google Calendar API ${path.split('?')[0]} → ${res.status}`)
  }
  if (res.status === 204) return null
  return (await res.json()) as Record<string, unknown>
}

// ---------- calendarList ----------

export async function listCalendarList(
  db: DbDriver,
  account: CalendarAccount
): Promise<GoogleCalendarListEntry[]> {
  const items: GoogleCalendarListEntry[] = []
  let pageToken: string | undefined
  do {
    const p = new URLSearchParams({ maxResults: '250', showDeleted: 'false' })
    if (pageToken) p.set('pageToken', pageToken)
    const page = (await gcalFetch(db, account, `/users/me/calendarList?${p}`))!
    for (const item of (page['items'] as GoogleCalendarListEntry[] | undefined) ?? []) {
      if (!item.deleted) items.push(item)
    }
    pageToken = page['nextPageToken'] as string | undefined
  } while (pageToken)
  return items
}

// ---------- events ----------

export interface EventsPage {
  items: GoogleEvent[]
  nextPageToken?: string
  nextSyncToken?: string
}

export async function listEventsPage(
  db: DbDriver,
  account: CalendarAccount,
  googleCalendarId: string,
  params: { syncToken?: string; timeMin?: string; timeMax?: string; pageToken?: string }
): Promise<EventsPage> {
  // incremental requests must repeat the original params (singleEvents) but
  // carry ONLY syncToken — mixing in timeMin/timeMax is a 400
  const p = new URLSearchParams({ singleEvents: 'true', maxResults: '250' })
  if (params.syncToken) {
    p.set('syncToken', params.syncToken)
  } else {
    if (params.timeMin) p.set('timeMin', params.timeMin)
    if (params.timeMax) p.set('timeMax', params.timeMax)
  }
  if (params.pageToken) p.set('pageToken', params.pageToken)
  const page = (await gcalFetch(
    db,
    account,
    `/calendars/${encodeURIComponent(googleCalendarId)}/events?${p}`
  ))!
  return {
    items: ((page['items'] as GoogleEvent[] | undefined) ?? []).filter((e) => e.id),
    nextPageToken: page['nextPageToken'] as string | undefined,
    nextSyncToken: page['nextSyncToken'] as string | undefined
  }
}

export async function getEventRemote(
  db: DbDriver,
  account: CalendarAccount,
  googleCalendarId: string,
  eventId: string
): Promise<GoogleEvent> {
  return (await gcalFetch(
    db,
    account,
    `/calendars/${encodeURIComponent(googleCalendarId)}/events/${encodeURIComponent(eventId)}`
  )) as unknown as GoogleEvent
}

export async function insertEvent(
  db: DbDriver,
  account: CalendarAccount,
  googleCalendarId: string,
  body: Record<string, unknown>,
  opts: { sendUpdates?: boolean } = {}
): Promise<GoogleEvent> {
  const p = new URLSearchParams({ sendUpdates: opts.sendUpdates ? 'all' : 'none' })
  return (await gcalFetch(db, account, `/calendars/${encodeURIComponent(googleCalendarId)}/events?${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })) as unknown as GoogleEvent
}

export async function patchEvent(
  db: DbDriver,
  account: CalendarAccount,
  googleCalendarId: string,
  eventId: string,
  body: Record<string, unknown>,
  opts: { etag?: string | null; sendUpdates?: boolean; conferenceDataVersion?: number } = {}
): Promise<GoogleEvent> {
  const p = new URLSearchParams({ sendUpdates: opts.sendUpdates ? 'all' : 'none' })
  if (opts.conferenceDataVersion !== undefined)
    p.set('conferenceDataVersion', String(opts.conferenceDataVersion))
  return (await gcalFetch(
    db,
    account,
    `/calendars/${encodeURIComponent(googleCalendarId)}/events/${encodeURIComponent(eventId)}?${p}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      extraHeaders: opts.etag ? { 'If-Match': opts.etag } : undefined,
      body: JSON.stringify(body)
    }
  )) as unknown as GoogleEvent
}

export async function deleteEventRemote(
  db: DbDriver,
  account: CalendarAccount,
  googleCalendarId: string,
  eventId: string,
  opts: { sendUpdates?: boolean } = {}
): Promise<void> {
  const p = new URLSearchParams({ sendUpdates: opts.sendUpdates ? 'all' : 'none' })
  await gcalFetch(
    db,
    account,
    `/calendars/${encodeURIComponent(googleCalendarId)}/events/${encodeURIComponent(eventId)}?${p}`,
    { method: 'DELETE' }
  )
}

// ---------- mapping ----------

function timeToStored(t: GoogleEventTime | undefined): { value: string; allDay: boolean } {
  if (t?.date) return { value: t.date, allDay: true }
  if (t?.dateTime) return { value: new Date(t.dateTime).toISOString(), allDay: false }
  return { value: '', allDay: false }
}

export function meetLinkOf(ev: GoogleEvent): string | null {
  const video = ev.conferenceData?.entryPoints?.find((e) => e.entryPointType === 'video' && e.uri)
  return video?.uri ?? ev.hangoutLink ?? null
}

/** Google event → the repo's provider-agnostic RemoteEvent shape. */
export function googleEventToRemote(ev: GoogleEvent): RemoteEvent {
  const start = timeToStored(ev.start)
  const end = timeToStored(ev.end)
  return {
    google_event_id: ev.id,
    etag: ev.etag ?? null,
    recurring_event_id: ev.recurringEventId ?? null,
    title: ev.summary ?? '',
    description: ev.description ?? null,
    location: ev.location ?? null,
    start_at: start.value,
    end_at: end.value,
    all_day: start.allDay,
    timezone: ev.start?.timeZone ?? null,
    color: ev.colorId ?? null,
    attendees: (ev.attendees ?? []).map((a) => ({
      email: a.email,
      displayName: a.displayName,
      responseStatus: a.responseStatus,
      organizer: a.organizer,
      self: a.self
    })),
    conferencing_url: meetLinkOf(ev),
    status: ev.status ?? 'confirmed'
  }
}

/** local row → Google insert/patch body (recurrence is never authored here) */
export function rowToGoogleBody(row: CalendarEventRecord): Record<string, unknown> {
  return {
    summary: row.title,
    description: row.description,
    location: row.location,
    colorId: row.color,
    start: row.all_day
      ? { date: row.start_at, dateTime: null }
      : { dateTime: row.start_at, timeZone: row.timezone ?? undefined, date: null },
    end: row.all_day
      ? { date: row.end_at, dateTime: null }
      : { dateTime: row.end_at, timeZone: row.timezone ?? undefined, date: null },
    // keep responseStatus for attendees we already know — a patch replaces
    // the whole list and omitting it would reset RSVPs to needsAction
    attendees: row.attendees.map((a) => ({
      email: a.email,
      displayName: a.displayName,
      ...(a.responseStatus ? { responseStatus: a.responseStatus } : {})
    }))
  }
}

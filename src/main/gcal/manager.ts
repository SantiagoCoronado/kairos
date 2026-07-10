// CalendarSyncManager — long-lived Google Calendar sync service in the
// Electron main process, modeled on CommsSyncManager. Two loops per account:
// a pull (calendarList + per-calendar events, incremental via syncToken) and
// a fast push drain that sends dirty local rows (pending_create/update/delete)
// to Google. Conflict policy: last-write-wins, remote preferred — pushes carry
// If-Match etags and a 412 re-fetches the remote copy over the local edit.
import type { DbDriver } from '../../core/driver'
import type { CalendarAccount, CalendarCalendar, CalendarEventRecord, DbEntity } from '../../core/types'
import type { CalendarSyncEvent } from '../../shared/ipc-contract'
import * as repo from '../../core/repo/calendar'
import { newId } from '../../core/ids'
import {
  connectGcal,
  deleteEventRemote,
  getEventRemote,
  googleEventToRemote,
  insertEvent,
  listCalendarList,
  listEventsPage,
  meetLinkOf,
  patchEvent,
  rowToGoogleBody,
  GcalAuthError,
  GcalConflict,
  GcalGone,
  GcalNotFound
} from './api'
import { logLine } from '../logger'

const PULL_INTERVAL_MS = 60_000
const DRAIN_INTERVAL_MS = 15_000
const POKE_DEBOUNCE_MS = 500
/** opportunistic pulls (focus, view open, wake) skip if a pull ran this recently */
const POKE_PULL_MIN_GAP_MS = 20_000
const MAX_BACKOFF_MS = 10 * 60_000
// initial full sync window: 6 months back, 18 months forward
const WINDOW_PAST_MS = 182 * 86_400_000
const WINDOW_FUTURE_MS = 548 * 86_400_000

export class CalendarSyncManager {
  private pullTimer: NodeJS.Timeout | null = null
  private drainTimer: NodeJS.Timeout | null = null
  private pokeTimer: NodeJS.Timeout | null = null
  private pulling = new Set<string>()
  private draining = false
  /** serializes every Google push — concurrent triggers (drain timer, poke,
   *  addMeet) queue behind each other instead of racing. Two pushes for the
   *  same pending_create row would each insert a fresh Google event. */
  private pushQueue: Promise<unknown> = Promise.resolve()
  private failures = new Map<string, number>()
  private skipUntil = new Map<string, number>()
  private lastPullAt = 0
  private stopped = false

  constructor(
    private db: DbDriver,
    private emit: (e: CalendarSyncEvent) => void,
    private onDbChanged: (entity: DbEntity) => void
  ) {}

  start(): void {
    setTimeout(() => void this.pullAll(), 3_000)
    this.pullTimer = setInterval(() => void this.pullAll(), PULL_INTERVAL_MS)
    this.drainTimer = setInterval(() => void this.drainAll(), DRAIN_INTERVAL_MS)
  }

  stop(): void {
    this.stopped = true
    if (this.pullTimer) clearInterval(this.pullTimer)
    if (this.drainTimer) clearInterval(this.drainTimer)
    if (this.pokeTimer) clearTimeout(this.pokeTimer)
  }

  /** called after local mutations so pushes go out in ~0.5s, not 15s */
  pokePush(): void {
    if (this.stopped || this.pokeTimer) return
    this.pokeTimer = setTimeout(() => {
      this.pokeTimer = null
      void this.drainAll()
    }, POKE_DEBOUNCE_MS)
  }

  /** opportunistic remote check — window focus, calendar view open, wake from
   *  sleep. Incremental syncToken pulls are one tiny request per calendar, so
   *  this can fire liberally; a min-gap throttle stops focus-toggle storms. */
  pokePull(): void {
    if (this.stopped) return
    if (Date.now() - this.lastPullAt < POKE_PULL_MIN_GAP_MS) return
    void this.pullAll()
  }

  async connectGoogle(): Promise<CalendarAccount> {
    const account = await connectGcal(this.db)
    this.failures.delete(account.id)
    this.skipUntil.delete(account.id)
    this.emit({ kind: 'sync', accountId: account.id, status: 'connected' })
    this.onDbChanged('calendar_accounts')
    // first pull in the background so connect returns as soon as auth lands
    void this.pullAccount(account.id)
    return account
  }

  disconnect(accountId: string): void {
    repo.deleteCalendarAccount(this.db, accountId)
    this.failures.delete(accountId)
    this.skipUntil.delete(accountId)
    this.onDbChanged('calendar_accounts')
    this.onDbChanged('calendars')
    this.onDbChanged('calendar_events')
  }

  syncNow(accountId?: string): void {
    if (accountId) {
      this.skipUntil.delete(accountId)
      void this.pullAccount(accountId)
    } else {
      for (const a of repo.listCalendarAccounts(this.db)) {
        this.skipUntil.delete(a.id)
        void this.pullAccount(a.id)
      }
    }
    void this.drainAll()
  }

  // ---------- pull ----------

  private async pullAll(): Promise<void> {
    if (this.stopped) return
    this.lastPullAt = Date.now()
    for (const account of repo.listCalendarAccounts(this.db)) {
      if (account.status === 'disabled' || account.status === 'needs_auth') continue
      if ((this.skipUntil.get(account.id) ?? 0) > Date.now()) continue
      await this.pullAccount(account.id)
    }
  }

  private async pullAccount(accountId: string): Promise<void> {
    if (this.stopped || this.pulling.has(accountId)) return
    const account = repo.getCalendarAccount(this.db, accountId)
    if (!account) return
    this.pulling.add(accountId)
    this.emit({ kind: 'sync', accountId, status: 'syncing' })
    try {
      // refresh the calendar list first — new/renamed/removed calendars
      const remote = await listCalendarList(this.db, account)
      for (const item of remote) {
        repo.upsertCalendarFromGoogle(this.db, account.id, {
          google_calendar_id: item.id,
          summary: item.summaryOverride ?? item.summary ?? item.id,
          color: item.backgroundColor ?? null,
          is_primary: Boolean(item.primary),
          is_writable: item.accessRole === 'owner' || item.accessRole === 'writer'
        })
      }
      repo.deleteCalendarsNotIn(this.db, account.id, remote.map((r) => r.id))
      this.onDbChanged('calendars')

      let changed = false
      for (const cal of repo.listAccountCalendars(this.db, account.id)) {
        if (!cal.is_visible) continue
        if (await this.syncCalendarEvents(account, cal)) changed = true
      }

      repo.touchCalendarAccountSync(this.db, account.id)
      if (account.status !== 'connected') repo.setCalendarAccountStatus(this.db, account.id, 'connected')
      this.failures.delete(accountId)
      this.emit({ kind: 'sync', accountId, status: 'idle' })
      if (changed) this.onDbChanged('calendar_events')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (err instanceof GcalAuthError) {
        repo.setCalendarAccountStatus(this.db, accountId, 'needs_auth', message)
        this.emit({ kind: 'sync', accountId, status: 'needs_auth', message })
        this.onDbChanged('calendar_accounts')
      } else {
        const fails = (this.failures.get(accountId) ?? 0) + 1
        this.failures.set(accountId, fails)
        this.skipUntil.set(
          accountId,
          Date.now() + Math.min(PULL_INTERVAL_MS * 2 ** fails, MAX_BACKOFF_MS)
        )
        repo.setCalendarAccountStatus(this.db, accountId, 'error', message)
        this.emit({ kind: 'sync', accountId, status: 'error', message })
        this.onDbChanged('calendar_accounts')
        logLine('warn', 'gcal', `pull failed for ${accountId}: ${message}`)
      }
    } finally {
      this.pulling.delete(accountId)
    }
  }

  /** one calendar's events: incremental via syncToken, else windowed full sync */
  private async syncCalendarEvents(
    account: CalendarAccount,
    cal: CalendarCalendar
  ): Promise<boolean> {
    const gid = cal.google_calendar_id!
    let changed = false

    if (cal.sync_token) {
      try {
        let pageToken: string | undefined
        let syncToken: string | undefined
        do {
          const page = await listEventsPage(this.db, account, gid, {
            syncToken: cal.sync_token,
            pageToken
          })
          for (const ev of page.items) {
            repo.applyRemoteEvent(this.db, cal.id, googleEventToRemote(ev))
            changed = true
          }
          pageToken = page.nextPageToken
          syncToken = page.nextSyncToken ?? syncToken
        } while (pageToken)
        if (syncToken) repo.setCalendarSyncToken(this.db, cal.id, syncToken)
        return changed
      } catch (err) {
        if (!(err instanceof GcalGone)) throw err
        // syncToken expired — fall through to a full resync
        repo.setCalendarSyncToken(this.db, cal.id, null)
        logLine('info', 'gcal', `syncToken expired for ${cal.summary}, full resync`)
      }
    }

    const windowStart = new Date(Date.now() - WINDOW_PAST_MS).toISOString()
    const windowEnd = new Date(Date.now() + WINDOW_FUTURE_MS).toISOString()
    const seen: string[] = []
    let pageToken: string | undefined
    let syncToken: string | undefined
    do {
      const page = await listEventsPage(this.db, account, gid, {
        timeMin: windowStart,
        timeMax: windowEnd,
        pageToken
      })
      for (const ev of page.items) {
        seen.push(ev.id)
        repo.applyRemoteEvent(this.db, cal.id, googleEventToRemote(ev))
      }
      pageToken = page.nextPageToken
      syncToken = page.nextSyncToken ?? syncToken
    } while (pageToken)
    repo.deleteEventsMissingFromFullSync(this.db, cal.id, seen, windowStart, windowEnd)
    if (syncToken) repo.setCalendarSyncToken(this.db, cal.id, syncToken)
    return true
  }

  // ---------- push ----------

  private enqueuePush<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.pushQueue.then(fn)
    this.pushQueue = run.catch(() => undefined)
    return run
  }

  private async drainAll(): Promise<void> {
    if (this.stopped || this.draining) return
    this.draining = true
    try {
      await this.enqueuePush(async () => {
        for (const account of repo.listCalendarAccounts(this.db)) {
          if (account.status === 'disabled' || account.status === 'needs_auth') continue
          await this.drainAccount(account)
        }
      })
    } finally {
      this.draining = false
    }
  }

  private async drainAccount(account: CalendarAccount): Promise<void> {
    const dirty = repo.listDirtyEvents(this.db, account.id)
    if (dirty.length === 0) return
    let changed = false
    for (const stale of dirty) {
      // re-read: queued push work (addMeet) may have synced or deleted the
      // row since the dirty list was built
      const event = repo.getEvent(this.db, stale.id)
      if (!event || event.sync_status === 'synced') continue
      try {
        if (await this.pushEvent(account, event)) changed = true
      } catch (err) {
        if (err instanceof GcalAuthError) {
          repo.setCalendarAccountStatus(this.db, account.id, 'needs_auth', err.message)
          this.emit({ kind: 'sync', accountId: account.id, status: 'needs_auth', message: err.message })
          this.onDbChanged('calendar_accounts')
          return
        }
        // leave the row dirty; the next drain retries
        logLine('warn', 'gcal', `push failed for event ${event.id}: ${err instanceof Error ? err.message : err}`)
      }
    }
    if (changed) this.onDbChanged('calendar_events')
  }

  /** returns true if the local row changed */
  private async pushEvent(account: CalendarAccount, event: CalendarEventRecord): Promise<boolean> {
    const cal = repo.getCalendar(this.db, event.calendar_id)
    if (!cal?.google_calendar_id) return false
    const gid = cal.google_calendar_id
    const notify = event.attendees.length > 0

    if (event.sync_status === 'pending_delete') {
      try {
        await deleteEventRemote(this.db, account, gid, event.google_event_id!, { sendUpdates: notify })
      } catch (err) {
        if (!(err instanceof GcalNotFound) && !(err instanceof GcalGone)) throw err
      }
      repo.hardDeleteEvent(this.db, event.id)
      return true
    }

    // a pending_create row that somehow already carries a remote id (e.g. a
    // push raced this one) must be patched, not inserted again — a second
    // insert makes a duplicate Google event
    if (event.sync_status === 'pending_create' && !event.google_event_id) {
      const created = await insertEvent(this.db, account, gid, rowToGoogleBody(event), {
        sendUpdates: notify
      })
      repo.markEventSynced(this.db, event.id, {
        google_event_id: created.id,
        etag: created.etag ?? null
      })
      return true
    }

    // pending_update (or pending_create with a remote id)
    try {
      const patched = await patchEvent(this.db, account, gid, event.google_event_id!, rowToGoogleBody(event), {
        etag: event.etag,
        sendUpdates: notify
      })
      repo.markEventSynced(this.db, event.id, {
        google_event_id: patched.id,
        etag: patched.etag ?? null
      })
      return true
    } catch (err) {
      if (err instanceof GcalConflict) {
        // remote changed since our last pull — remote wins
        const remote = await getEventRemote(this.db, account, gid, event.google_event_id!)
        repo.markEventSynced(this.db, event.id, {
          google_event_id: event.google_event_id!,
          etag: null
        })
        repo.applyRemoteEvent(this.db, cal.id, googleEventToRemote(remote))
        return true
      }
      if (err instanceof GcalNotFound || err instanceof GcalGone) {
        // deleted remotely while we edited — remote wins here too
        repo.hardDeleteEvent(this.db, event.id)
        return true
      }
      throw err
    }
  }

  // ---------- Google Meet ----------

  async addMeet(eventId: string): Promise<CalendarEventRecord> {
    let event = repo.getEvent(this.db, eventId)
    if (!event) throw new Error('event not found')
    const cal = repo.getCalendar(this.db, event.calendar_id)
    if (!cal?.account_id || !cal.google_calendar_id)
      throw new Error('Google Meet links need an event on a Google calendar')
    if (!cal.is_writable) throw new Error('this calendar is read-only')
    const account = repo.getCalendarAccount(this.db, cal.account_id)
    if (!account) throw new Error('calendar account missing')

    // the event must exist remotely before it can carry conference data.
    // Push through the shared queue — Meet-on-create fires right after the
    // create poked a drain, and an unserialized second push would insert a
    // duplicate Google event. Re-read inside the queue slot: by the time we
    // run, that drain may already have pushed the row.
    if (!event.google_event_id) {
      await this.enqueuePush(async () => {
        const fresh = repo.getEvent(this.db, eventId)
        if (fresh && !fresh.google_event_id) await this.pushEvent(account, fresh)
      })
      event = repo.getEvent(this.db, eventId)!
      if (!event.google_event_id) throw new Error('could not create the event on Google first')
    }

    let patched = await patchEvent(
      this.db,
      account,
      cal.google_calendar_id,
      event.google_event_id!,
      {
        conferenceData: {
          createRequest: { requestId: newId(), conferenceSolutionKey: { type: 'hangoutsMeet' } }
        }
      },
      { conferenceDataVersion: 1 }
    )
    // usually resolved synchronously; poll once if Google reports pending
    if (!meetLinkOf(patched) && patched.conferenceData?.createRequest?.status?.statusCode === 'pending') {
      await new Promise((r) => setTimeout(r, 1_500))
      patched = await getEventRemote(this.db, account, cal.google_calendar_id, event.google_event_id!)
    }
    const url = meetLinkOf(patched)
    if (!url) throw new Error('Google did not return a Meet link — try again in a moment')
    repo.setEventConferencing(this.db, eventId, url, patched.etag ?? null)
    this.onDbChanged('calendar_events')
    return repo.getEvent(this.db, eventId)!
  }
}

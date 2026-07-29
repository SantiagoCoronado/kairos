import type { DbDriver } from '../core/driver'
import type { MeetingEvent } from '../shared/ipc-contract'
import * as calendar from '../core/repo/calendar'
import * as meetings from '../core/repo/meetings'

/** Calendar-triggered "start recording?" nudges. An event with a conferencing
 *  URL reaching its start time earns exactly one prompt (toast + notification);
 *  recording never auto-starts. Opt-in via the meetingPromptsEnabled setting. */

// prompt from one scheduler tick before start until five minutes after —
// enough grace to catch a late join without nagging about long-over calls
export const PROMPT_LEAD_MS = 60_000
export const PROMPT_GRACE_MS = 5 * 60_000

export interface PromptCandidate {
  id: string
  title: string
  start_at: string
  all_day: number
  conferencing_url: string | null
}

export interface PromptedEvent {
  eventId: string
  title: string
  startAt: string
}

/** pure: which of these events deserve a prompt right now */
export function findPromptable(
  events: PromptCandidate[],
  opts: {
    now: Date
    alreadyPrompted: ReadonlySet<string>
    recordingActive: boolean
    hasMeeting: (eventId: string) => boolean
  }
): PromptCandidate[] {
  if (opts.recordingActive) return []
  const nowMs = opts.now.getTime()
  return events.filter((ev) => {
    if (!ev.conferencing_url || ev.all_day) return false
    const start = Date.parse(ev.start_at)
    if (nowMs < start - PROMPT_LEAD_MS || nowMs > start + PROMPT_GRACE_MS) return false
    if (opts.alreadyPrompted.has(ev.id)) return false
    return !opts.hasMeeting(ev.id)
  })
}

export interface PromptWatcherDeps {
  db: DbDriver
  enabled: () => boolean
  recordingActive: () => boolean
  emit: (ev: MeetingEvent) => void
  /** native-notification hook — injected so tests stay Electron-free */
  notify?: (prompt: PromptedEvent) => void
}

/** Ticked by the Scheduler. Session-scoped dedup only: a restart inside the
 *  grace window re-prompts once, which is harmless — no persisted column. */
export class MeetingPromptWatcher {
  // eventId → start ms, so stale entries can be pruned once their window passes
  private prompted = new Map<string, number>()

  constructor(
    private deps: PromptWatcherDeps,
    private clock: () => Date = () => new Date()
  ) {}

  /** exposed for tests: entries currently remembered as prompted */
  get promptedSize(): number {
    return this.prompted.size
  }

  tick(): void {
    const now = this.clock()
    const nowMs = now.getTime()
    for (const [id, start] of this.prompted) {
      if (nowMs > start + PROMPT_GRACE_MS) this.prompted.delete(id)
    }
    if (!this.deps.enabled()) return

    // overlap query returns a superset (in-progress events, strict-< bounds);
    // widened by a tick so edge starts can't slip out — the pure filter is
    // what actually narrows to starts inside [-lead, +grace]
    const events = calendar.listEventsInRange(
      this.deps.db,
      new Date(nowMs - PROMPT_GRACE_MS - 60_000).toISOString(),
      new Date(nowMs + PROMPT_LEAD_MS + 60_000).toISOString()
    )
    const due = findPromptable(events, {
      now,
      alreadyPrompted: new Set(this.prompted.keys()),
      recordingActive: this.deps.recordingActive(),
      hasMeeting: (eventId) =>
        meetings.listMeetings(this.deps.db, { calendar_event_id: eventId, limit: 1 }).length > 0
    })
    for (const ev of due) {
      this.prompted.set(ev.id, Date.parse(ev.start_at))
      const prompt: PromptedEvent = { eventId: ev.id, title: ev.title, startAt: ev.start_at }
      this.deps.emit({ kind: 'record-prompt', ...prompt })
      this.deps.notify?.(prompt)
    }
  }
}

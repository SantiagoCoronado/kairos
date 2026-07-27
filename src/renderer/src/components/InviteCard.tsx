import { useEffect, useMemo, useState } from 'react'
import { CalendarDays, Check, RefreshCw, Video } from 'lucide-react'
import type { CommsAttachment } from '../../../core/comms-types'
import { parseIcs, type IcsEvent } from '../../../core/ics'
import { api, useInvoke } from '../lib/api'
import { Button } from './ui'

/** local Date for anchoring the calendar view — date-only strings must not
 *  round-trip through UTC or negative-offset zones land a day early */
function eventDate(ev: IcsEvent): Date {
  if (ev.all_day && ev.start_at) {
    const [y, m, d] = ev.start_at.split('-').map(Number)
    return new Date(y, m - 1, d)
  }
  return new Date(ev.start_at ?? Date.now())
}

function fmtWhen(ev: IcsEvent): string {
  const start = eventDate(ev)
  const day = start.toLocaleDateString([], {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  })
  if (ev.all_day) return `${day} · all day`
  const t = (iso: string): string =>
    new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  return `${day} · ${t(ev.start_at!)}${ev.end_at ? ` – ${t(ev.end_at)}` : ''}`
}

/** Calendar-invite attachment (invite.ics) rendered as an event card with an
 *  add-to-Kairos-calendar action instead of a chip that opens Apple Calendar. */
export function InviteCard({
  attachment,
  onOpenCalendar
}: {
  attachment: CommsAttachment
  onOpenCalendar?: (day: Date) => void
}): React.JSX.Element {
  const [ev, setEv] = useState<IcsEvent | null>(null)
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void api
      .invoke('comms:attachmentData', attachment.id)
      .then((res) => {
        if (!res.ok) return setFailed(true)
        const b64 = res.dataUrl.slice(res.dataUrl.indexOf(',') + 1)
        const text = new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)))
        const first = parseIcs(text)[0]
        if (first?.start_at) setEv(first)
        else setFailed(true)
      })
      // IPC rejection or a non-base64 payload must not strand the skeleton
      .catch(() => setFailed(true))
  }, [attachment.id])

  // an event synced down from Google (or added from a duplicate invite part)
  // already covers this invite — offer "show" instead of a second copy
  const range = useMemo(() => {
    if (!ev?.start_at) return null
    const d = eventDate(ev)
    return [
      new Date(d.getTime() - 86_400_000).toISOString(),
      new Date(d.getTime() + 2 * 86_400_000).toISOString()
    ] as const
  }, [ev])
  const { data: nearby } = useInvoke(
    'calendarEvents:list',
    range ? [range[0], range[1]] : ['', ''],
    ['calendar_events'],
    range != null
  )
  const existing = useMemo(() => {
    if (!ev || !nearby) return null
    return (
      nearby.find(
        (e) =>
          e.title.trim().toLowerCase() === ev.summary.trim().toLowerCase() &&
          Date.parse(e.start_at) === Date.parse(ev.start_at!)
      ) ?? null
    )
  }, [nearby, ev])

  if (failed) {
    return (
      <p className="mt-1 text-[11px] text-faint">
        {attachment.filename || 'invite.ics'} — couldn’t read this invitation
      </p>
    )
  }
  if (!ev) {
    return <div className="mt-1 w-72 h-24 rounded-lg border border-border bg-panel animate-pulse" />
  }

  const cancelled = ev.method === 'CANCEL'
  const add = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await api.invoke('calendarEvents:create', {
        title: ev.summary || attachment.filename || 'Invitation',
        description: ev.description,
        location: ev.location,
        start_at: ev.start_at!,
        end_at: ev.end_at!,
        all_day: ev.all_day,
        attendees: [...(ev.organizer ? [ev.organizer] : []), ...ev.attendees],
        conferencing_url: ev.conferencing_url
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-1 max-w-sm rounded-lg border border-border bg-panel px-3 py-2.5 space-y-1.5">
      <div className="flex items-start gap-2">
        <CalendarDays size={15} className="shrink-0 mt-0.5 text-accent" />
        <div className="min-w-0">
          <p className={`text-[13px] leading-snug ${cancelled ? 'line-through text-faint' : ''}`}>
            {ev.summary || '(no title)'}
          </p>
          <p className="text-[11.5px] text-muted">{fmtWhen(ev)}</p>
          {ev.organizer && (
            <p className="text-[11px] text-faint truncate">
              {ev.organizer.displayName || ev.organizer.email}
            </p>
          )}
          {ev.location && !ev.location.startsWith('http') && (
            <p className="text-[11px] text-faint truncate">{ev.location}</p>
          )}
        </div>
      </div>
      <div className="flex items-center gap-1.5 flex-wrap">
        {cancelled ? (
          <span className="text-[11px] text-danger">This event was cancelled.</span>
        ) : existing ? (
          <span className="inline-flex items-center gap-1 text-[11px] text-accent">
            <Check size={12} /> In your calendar
          </span>
        ) : (
          <Button variant="ghost" className="!px-2 !py-1 !text-[11.5px]" onClick={() => void add()} disabled={busy}>
            {busy ? <RefreshCw size={11} className="animate-spin" /> : 'Add to calendar'}
          </Button>
        )}
        {onOpenCalendar && !cancelled && (
          <Button
            variant="ghost"
            className="!px-2 !py-1 !text-[11.5px]"
            onClick={() => onOpenCalendar(eventDate(ev))}
          >
            Show in calendar
          </Button>
        )}
        {ev.conferencing_url && (
          <a
            href={ev.conferencing_url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-[11.5px] text-accent hover:underline"
          >
            <Video size={12} /> Join
          </a>
        )}
      </div>
      {error && <p className="text-[10.5px] text-danger">{error}</p>}
    </div>
  )
}

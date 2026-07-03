import { useEffect, useMemo, useState } from 'react'
import { Check, Repeat, Trash2, Video, X } from 'lucide-react'
import type { CalendarAttendee, CalendarCalendar, CalendarEventRecord } from '../../../../core/types'
import type { AttendeeSuggestion } from '../../../../shared/ipc-contract'
import { api } from '../../lib/api'
import { Button, Input, Select, cn } from '../ui'
import { EVENT_COLORS } from './colors'
import {
  addDays,
  combineDateTime,
  fromDateKey,
  parseEventDate,
  toDateKey,
  toTimeKey
} from '../../lib/dates'

export type EditorTarget =
  | { kind: 'create'; start: Date; end: Date; allDay?: boolean }
  | { kind: 'edit'; event: CalendarEventRecord }

export function EventEditor({
  target,
  calendars,
  onClose
}: {
  target: EditorTarget
  calendars: CalendarCalendar[]
  onClose: () => void
}): React.JSX.Element {
  const existing = target.kind === 'edit' ? target.event : null
  const readOnlyRecurring = Boolean(existing?.recurring_event_id)
  const writable = useMemo(() => calendars.filter((c) => c.is_writable), [calendars])

  const [title, setTitle] = useState(existing?.title ?? '')
  const [calendarId, setCalendarId] = useState(existing?.calendar_id ?? 'local')
  const [allDay, setAllDay] = useState(
    existing ? Boolean(existing.all_day) : (target.kind === 'create' && target.allDay) || false
  )
  const initStart = existing ? parseEventDate(existing.start_at) : (target as { start: Date }).start
  const initEnd = existing ? parseEventDate(existing.end_at) : (target as { end: Date }).end
  const [startDate, setStartDate] = useState(toDateKey(initStart))
  const [startTime, setStartTime] = useState(toTimeKey(initStart))
  // all-day storage end is exclusive; the form shows the inclusive last day
  const [endDate, setEndDate] = useState(
    existing?.all_day ? toDateKey(addDays(initEnd, -1)) : toDateKey(initEnd)
  )
  const [endTime, setEndTime] = useState(toTimeKey(initEnd))
  // timed events only show an end date when they already span days (rare,
  // usually synced from Google) — everything else is same-day implicitly
  const [multiDay] = useState(
    () => Boolean(existing && !existing.all_day && toDateKey(initStart) !== toDateKey(initEnd))
  )
  const [color, setColor] = useState<string | null>(existing?.color ?? null)
  const [location, setLocation] = useState(existing?.location ?? '')
  const [description, setDescription] = useState(existing?.description ?? '')
  const [attendees, setAttendees] = useState<CalendarAttendee[]>(existing?.attendees ?? [])
  const [attendeeInput, setAttendeeInput] = useState('')
  const [suggestions, setSuggestions] = useState<AttendeeSuggestion[]>([])
  const [highlight, setHighlight] = useState(-1)
  const [conferencingUrl, setConferencingUrl] = useState(existing?.conferencing_url ?? '')
  const [wantMeet, setWantMeet] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [meetUrl, setMeetUrl] = useState<string | null>(null)

  const calendar = calendars.find((c) => c.id === calendarId)
  const isGoogle = Boolean(calendar?.account_id)
  const canMove = !existing?.google_event_id

  const addAttendee = (email: string, displayName?: string): void => {
    const clean = email.trim().replace(/,$/, '')
    if (!clean) return
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(clean)) {
      setError(`not an email: ${clean}`)
      return
    }
    setError(null)
    if (!attendees.some((a) => a.email.toLowerCase() === clean.toLowerCase())) {
      setAttendees([...attendees, { email: clean, ...(displayName ? { displayName } : {}) }])
    }
    setAttendeeInput('')
    setSuggestions([])
    setHighlight(-1)
  }

  // invite autocomplete: people with emails + attendees from past events
  useEffect(() => {
    const q = attendeeInput.trim()
    if (!q) {
      setSuggestions([])
      setHighlight(-1)
      return
    }
    const t = setTimeout(() => {
      void api.invoke('calendar:attendeeSuggest', q).then((hits) => {
        setSuggestions(
          hits.filter((h) => !attendees.some((a) => a.email.toLowerCase() === h.email)).slice(0, 6)
        )
        setHighlight(0)
      })
    }, 120)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attendeeInput])

  const buildTimes = (): { start_at: string; end_at: string } => {
    if (allDay) {
      // exclusive storage end = day after the inclusive form value
      return {
        start_at: startDate,
        end_at: toDateKey(addDays(fromDateKey(endDate < startDate ? startDate : endDate), 1))
      }
    }
    const s = combineDateTime(startDate, startTime)
    let e = combineDateTime(multiDay ? endDate : startDate, endTime)
    if (e <= s) e = new Date(s.getTime() + 30 * 60_000)
    return { start_at: s.toISOString(), end_at: e.toISOString() }
  }

  const save = (): void => {
    setBusy(true)
    setError(null)
    const times = buildTimes()
    const shared = {
      title: title.trim() || '(untitled)',
      ...times,
      all_day: allDay,
      color,
      location: location.trim() || null,
      description: description.trim() || null,
      attendees,
      conferencing_url: conferencingUrl.trim() || null,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
    }
    const p = existing
      ? api.invoke('calendarEvents:update', existing.id, {
          ...shared,
          ...(canMove ? { calendar_id: calendarId } : {})
        })
      : api.invoke('calendarEvents:create', { ...shared, calendar_id: calendarId }).then(async (e) => {
          // Meet-on-create: the event must exist on Google first, then one
          // more call attaches the conference. Failure is non-fatal — the
          // event exists; "Add Meet" is still available from the editor.
          if (wantMeet && isGoogle) await api.invoke('calendarEvents:addMeet', e.id).catch(() => {})
          return e
        })
    void p.then(onClose).catch((err) => {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    })
  }

  const remove = (): void => {
    if (!existing) return
    if (!confirmDelete) {
      setConfirmDelete(true)
      return
    }
    setBusy(true)
    void api
      .invoke('calendarEvents:delete', existing.id)
      .then(onClose)
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err))
        setBusy(false)
      })
  }

  const addMeet = (): void => {
    if (!existing) return
    setBusy(true)
    setError(null)
    void api
      .invoke('calendarEvents:addMeet', existing.id)
      .then((e) => {
        setMeetUrl(e.conferencing_url)
        setConferencingUrl(e.conferencing_url ?? '')
        setBusy(false)
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err))
        setBusy(false)
      })
  }

  const disabled = readOnlyRecurring || busy

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center" onMouseDown={onClose}>
      <div
        className="w-[440px] max-h-[85vh] overflow-y-auto bg-overlay border border-border-strong rounded-xl shadow-2xl p-4 space-y-3"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <span className="font-mono text-[11px] uppercase tracking-[0.2em] text-muted">
            {existing ? 'edit event' : 'new event'}
          </span>
          <button onClick={onClose} className="text-faint hover:text-text">
            <X size={15} />
          </button>
        </div>

        {readOnlyRecurring && (
          <p className="flex items-center gap-1.5 text-[11.5px] text-muted bg-raised rounded-md px-2 py-1.5">
            <Repeat size={11} className="shrink-0" />
            Recurring events can only be edited in Google Calendar.
          </p>
        )}

        <Input
          autoFocus={!existing}
          className="w-full text-[14px]"
          placeholder="Event title"
          value={title}
          disabled={disabled}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && !disabled && save()}
        />

        <div className="flex items-center gap-2">
          <Select
            value={calendarId}
            disabled={disabled || !canMove}
            onChange={(e) => setCalendarId(e.target.value)}
            className="flex-1"
            title={canMove ? 'Calendar' : 'Synced events cannot move between calendars'}
          >
            {writable.map((c) => (
              <option key={c.id} value={c.id}>
                {c.id === 'local' ? 'Kairos (local)' : c.summary}
              </option>
            ))}
          </Select>
          <label className="flex items-center gap-1.5 text-[12px] text-muted select-none">
            <input
              type="checkbox"
              checked={allDay}
              disabled={disabled}
              onChange={(e) => setAllDay(e.target.checked)}
              className="accent-accent"
            />
            all-day
          </label>
        </div>

        <div className="flex items-center gap-1.5">
          <Input
            type="date"
            className="flex-1 min-w-0 font-mono text-[12px]"
            value={startDate}
            disabled={disabled}
            onChange={(e) => {
              const v = e.target.value
              if (!v) return
              setStartDate(v)
              if (!allDay && !multiDay) setEndDate(v)
              else if (endDate < v) setEndDate(v)
            }}
          />
          {!allDay && (
            <>
              <Input
                type="time"
                className="w-32 shrink-0 font-mono text-[12px]"
                value={startTime}
                disabled={disabled}
                onChange={(e) => e.target.value && setStartTime(e.target.value)}
              />
              <span className="text-faint text-[12px]">→</span>
              <Input
                type="time"
                className="w-32 shrink-0 font-mono text-[12px]"
                value={endTime}
                disabled={disabled}
                onChange={(e) => e.target.value && setEndTime(e.target.value)}
              />
            </>
          )}
          {(allDay || multiDay) && (
            <>
              {allDay && <span className="text-faint text-[12px]">→</span>}
              <Input
                type="date"
                className="flex-1 min-w-0 font-mono text-[12px]"
                value={endDate}
                disabled={disabled}
                onChange={(e) => e.target.value && setEndDate(e.target.value)}
              />
            </>
          )}
        </div>

        <div className="flex items-center gap-1">
          <button
            className={cn(
              'w-5 h-5 rounded-full border text-[9px] flex items-center justify-center',
              color === null ? 'border-border-strong' : 'border-transparent',
              'bg-raised text-faint'
            )}
            title="Calendar default"
            disabled={disabled}
            onClick={() => setColor(null)}
          >
            —
          </button>
          {EVENT_COLORS.map((c) => (
            <button
              key={c.id}
              className={cn(
                'w-5 h-5 rounded-full border-2',
                color === c.id ? 'border-text' : 'border-transparent'
              )}
              style={{ backgroundColor: c.hex }}
              title={c.name}
              disabled={disabled}
              onClick={() => setColor(c.id)}
            />
          ))}
        </div>

        <Input
          className="w-full text-[12.5px]"
          placeholder="Location"
          value={location}
          disabled={disabled}
          onChange={(e) => setLocation(e.target.value)}
        />

        <textarea
          className="w-full h-16 bg-raised border border-border rounded-md px-2.5 py-1.5 text-[12.5px] text-text placeholder:text-faint focus:outline-none focus:border-border-strong resize-none"
          placeholder="Description"
          value={description}
          disabled={disabled}
          onChange={(e) => setDescription(e.target.value)}
        />

        {/* attendees */}
        <div className="space-y-1">
          <div className="flex flex-wrap gap-1">
            {attendees.map((a) => (
              <span
                key={a.email}
                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-raised font-mono text-[10.5px] text-muted"
                title={a.responseStatus}
              >
                {a.email}
                {a.responseStatus === 'accepted' && <span className="text-ok">✓</span>}
                {a.responseStatus === 'declined' && <span className="text-danger">✗</span>}
                {!disabled && (
                  <button
                    className="text-faint hover:text-danger"
                    onClick={() => setAttendees(attendees.filter((x) => x.email !== a.email))}
                  >
                    <X size={9} />
                  </button>
                )}
              </span>
            ))}
          </div>
          <div className="relative">
            <Input
              className="w-full text-[12px]"
              placeholder="Invite people (name or email)"
              value={attendeeInput}
              disabled={disabled}
              onChange={(e) => setAttendeeInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault()
                  setHighlight((h) => Math.min(h + 1, suggestions.length - 1))
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault()
                  setHighlight((h) => Math.max(h - 1, 0))
                } else if (e.key === 'Escape' && suggestions.length > 0) {
                  e.stopPropagation()
                  setSuggestions([])
                  setHighlight(-1)
                } else if (e.key === 'Enter' || e.key === ',') {
                  e.preventDefault()
                  const pick = highlight >= 0 ? suggestions[highlight] : undefined
                  if (pick) addAttendee(pick.email, pick.name ?? undefined)
                  else addAttendee(attendeeInput)
                }
              }}
              onBlur={() => {
                // a suggestion click uses onMouseDown (fires before blur);
                // plain blur commits whatever was typed
                setSuggestions([])
                setHighlight(-1)
                if (attendeeInput.trim()) addAttendee(attendeeInput)
              }}
            />
            {suggestions.length > 0 && (
              <div className="absolute inset-x-0 top-full mt-1 z-30 bg-overlay border border-border-strong rounded-md shadow-2xl overflow-hidden">
                {suggestions.map((s, i) => (
                  <button
                    key={s.email}
                    className={cn(
                      'w-full flex items-baseline gap-2 px-2.5 py-1.5 text-left',
                      i === highlight ? 'bg-raised' : 'hover:bg-raised/60'
                    )}
                    onMouseDown={(e) => {
                      e.preventDefault()
                      addAttendee(s.email, s.name ?? undefined)
                    }}
                    onMouseEnter={() => setHighlight(i)}
                  >
                    {s.name && <span className="text-[12.5px] text-text truncate">{s.name}</span>}
                    <span className="font-mono text-[11px] text-muted truncate">{s.email}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          {attendees.length > 0 && isGoogle && (
            <p className="text-[11px] text-faint">Google will email invitations on save.</p>
          )}
          {attendees.length > 0 && !isGoogle && (
            <p className="text-[11px] text-faint">
              Local events don’t send invites — move the event to a Google calendar for that.
            </p>
          )}
        </div>

        {/* conferencing */}
        <div className="flex items-center gap-1.5">
          <Input
            className="flex-1 font-mono text-[11.5px]"
            placeholder="Conferencing link (Zoom, Meet…)"
            value={conferencingUrl}
            disabled={disabled}
            onChange={(e) => setConferencingUrl(e.target.value)}
          />
          {existing && isGoogle && calendar?.is_writable && !existing.conferencing_url && !meetUrl && (
            <Button variant="ghost" className="shrink-0 text-[11.5px]" disabled={busy} onClick={addMeet}>
              <span className="inline-flex items-center gap-1">
                <Video size={12} /> Add Meet
              </span>
            </Button>
          )}
          {!existing && isGoogle && !conferencingUrl && (
            <Button
              variant={wantMeet ? 'accent' : 'ghost'}
              className="shrink-0 text-[11.5px]"
              disabled={busy}
              title="Google generates the Meet link when the event is created"
              onClick={() => setWantMeet((w) => !w)}
            >
              <span className="inline-flex items-center gap-1">
                {wantMeet ? <Check size={12} /> : <Video size={12} />}
                {wantMeet ? 'Meet on create' : 'Add Meet'}
              </span>
            </Button>
          )}
        </div>
        {conferencingUrl && (
          <a
            href={conferencingUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-[11.5px] text-accent hover:underline"
          >
            <Video size={11} /> Join call
          </a>
        )}

        {error && <p className="text-[11.5px] text-danger">{error}</p>}

        <div className="flex items-center justify-between pt-1">
          {existing && !readOnlyRecurring ? (
            <Button
              variant="ghost"
              className={cn('text-[12px]', confirmDelete ? 'text-danger' : 'text-muted')}
              disabled={busy}
              onClick={remove}
            >
              <span className="inline-flex items-center gap-1">
                <Trash2 size={12} />
                {confirmDelete ? 'Confirm delete' : 'Delete'}
              </span>
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-1.5">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            {!readOnlyRecurring && (
              <Button variant="accent" disabled={busy} onClick={save}>
                {existing ? 'Save' : 'Create'}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

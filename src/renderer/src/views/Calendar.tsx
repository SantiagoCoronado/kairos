import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, CircleDot, Plus, RefreshCw, SlidersHorizontal } from 'lucide-react'
import type { CalendarEventRecord } from '../../../core/types'
import type { ViewId } from '../components/Sidebar'
import { api, useInvoke } from '../lib/api'
import { startRecording, useMeetingRecording } from '../lib/meeting-store'
import { Button, Chip, Segmented } from '../components/ui'
import {
  addDays,
  addMonths,
  fmtDayTitle,
  fmtMonthTitle,
  fmtWeekTitle,
  monthGrid,
  startOfDay,
  startOfWeek,
  weekDays
} from '../lib/dates'
import { useIsMobile } from '../lib/mobile'
import { MonthGrid, shiftEventDays } from '../components/calendar/MonthGrid'
import { WeekGrid } from '../components/calendar/WeekGrid'
import { EventEditor, type EditorTarget } from '../components/calendar/EventEditor'
import { calendarHex } from '../components/calendar/colors'

const MODE_KEY = 'kairos.calendarMode'

type CalendarMode = 'month' | 'week' | 'day'

export function CalendarView({
  onNavigate,
  focusDate
}: {
  onNavigate: (v: ViewId) => void
  /** deep link (invite card "show in calendar") — new Date identity per jump */
  focusDate?: Date | null
}): React.JSX.Element {
  const mobile = useIsMobile()
  const [mode, setMode] = useState<CalendarMode>(() => {
    const stored = localStorage.getItem(MODE_KEY)
    if (stored === 'week' || stored === 'day' || stored === 'month') return stored
    // a 7-column grid is unreadable at phone width — day is the usable default
    return mobile ? 'day' : 'month'
  })
  const [anchor, setAnchor] = useState(() => focusDate ?? new Date())
  const [editor, setEditor] = useState<EditorTarget | null>(null)
  const [showCalendars, setShowCalendars] = useState(false)
  const recPhase = useMeetingRecording().phase
  // events with an attached recording get the AudioLines glyph in the grid
  // (meetings reads are remote-allowed, so the phone calendar shows them too)
  const { data: allMeetings } = useInvoke('meetings:list', [{}], ['meetings'])
  const meetingEventIds = useMemo(
    () =>
      new Set(
        (allMeetings ?? [])
          .map((m) => m.calendar_event_id)
          .filter((id): id is string => id !== null)
      ),
    [allMeetings]
  )

  useEffect(() => {
    if (focusDate) {
      setAnchor(focusDate)
      // transient jump — don't overwrite the user's stored mode preference
      setMode(mobile ? 'day' : 'week')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusDate])

  const setModePersist = (m: CalendarMode): void => {
    localStorage.setItem(MODE_KEY, m)
    setMode(m)
  }

  // opening the calendar re-checks Google right away (throttled main-side)
  useEffect(() => {
    void api.invoke('calendar:pokeSync')
  }, [])

  const days = useMemo(() => {
    if (mode === 'month') return monthGrid(anchor)
    if (mode === 'day') return [startOfDay(anchor)]
    return weekDays(anchor)
  }, [mode, anchor])
  // ±1 day buffer so events spilling over midnight land in the fetch window
  const rangeStart = useMemo(() => addDays(days[0], -1).toISOString(), [days])
  const rangeEnd = useMemo(() => addDays(days[days.length - 1], 2).toISOString(), [days])

  const { data: events } = useInvoke(
    'calendarEvents:list',
    [rangeStart, rangeEnd],
    ['calendar_events', 'calendars']
  )
  const { data: overlay } = useInvoke(
    'calendar:overlay',
    [rangeStart, rangeEnd],
    ['tasks', 'notes', 'agent_tasks']
  )
  const { data: calendars } = useInvoke('calendar:calendars', [], ['calendars', 'calendar_accounts'])
  const calendarMap = useMemo(() => new Map((calendars ?? []).map((c) => [c.id, c])), [calendars])

  const step = (dir: 1 | -1): void => {
    setAnchor((a) => {
      if (mode === 'month') return addMonths(a, dir)
      if (mode === 'day') return addDays(a, dir)
      return addDays(startOfWeek(a), dir * 7)
    })
  }

  // keyboard: arrows navigate, t = today, n = new event
  useEffect(() => {
    const down = (e: KeyboardEvent): void => {
      if (editor || e.metaKey || e.ctrlKey || e.altKey) return
      const tag = (e.target as HTMLElement).tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      if (e.key === 'ArrowLeft') step(-1)
      if (e.key === 'ArrowRight') step(1)
      if (e.key === 't') setAnchor(new Date())
      if (e.key === 'n') openNewEvent()
    }
    window.addEventListener('keydown', down)
    return () => window.removeEventListener('keydown', down)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, mode])

  const openNewEvent = (): void => {
    const start = new Date()
    start.setMinutes(0, 0, 0)
    start.setHours(start.getHours() + 1)
    setEditor({ kind: 'create', start, end: new Date(start.getTime() + 60 * 60_000) })
  }

  const patchTimes = (id: string, startAt: Date, endAt: Date): void => {
    void api
      .invoke('calendarEvents:update', id, {
        start_at: startAt.toISOString(),
        end_at: endAt.toISOString()
      })
      .catch(() => {})
  }

  const moveByDays = (e: CalendarEventRecord, dayDelta: number): void => {
    void api.invoke('calendarEvents:update', e.id, shiftEventDays(e, dayDelta)).catch(() => {})
  }

  // month-grid date taps: a whole week doesn't fit a phone, land on the day
  const showDay = (day: Date): void => {
    setAnchor(day)
    setModePersist(mobile ? 'day' : 'week')
  }

  return (
    <div className="h-full flex flex-col">
      {/* toolbar — title takes its own row on phones so the controls wrap under it.
          md:pt-6 clears the invisible 24px titlebar drag strip that overlays the
          top of the main column on the desktop shell (App.tsx) — clicks there
          never reach the controls. Phones have no drag strip, so pt-3 stands.
          Every control gets h-7 (+ transparent border on ghosts) so the boxes
          match the bordered Segmented/accent controls and center on one line. */}
      <div className="shrink-0 flex flex-wrap items-center gap-2 px-4 pt-3 md:pt-6 pb-2.5">
        <h1 className="text-[15px] font-medium text-text leading-none basis-full md:basis-auto md:min-w-44">
          {mode === 'month' ? fmtMonthTitle(anchor) : mode === 'day' ? fmtDayTitle(days[0]) : fmtWeekTitle(days)}
        </h1>
        <Button
          variant="ghost"
          className="h-7 w-7 !p-0 inline-flex items-center justify-center border border-transparent"
          onClick={() => step(-1)}
          title="Previous (←)"
        >
          <ChevronLeft size={15} />
        </Button>
        <Button
          variant="ghost"
          className="h-7 w-7 !p-0 inline-flex items-center justify-center border border-transparent"
          onClick={() => step(1)}
          title="Next (→)"
        >
          <ChevronRight size={15} />
        </Button>
        <Button
          variant="ghost"
          className="h-7 !py-0 inline-flex items-center border border-transparent text-[12px]"
          onClick={() => setAnchor(new Date())}
          title="Today (t)"
        >
          Today
        </Button>
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          <Segmented
            value={mode}
            options={[
              { value: 'month', label: 'Month' },
              { value: 'week', label: 'Week' },
              { value: 'day', label: 'Day' }
            ]}
            onChange={setModePersist}
          />
          <div className="relative">
            <Button
              variant="ghost"
              className="h-7 w-7 !p-0 inline-flex items-center justify-center border border-transparent"
              title="Calendars"
              onClick={() => setShowCalendars((s) => !s)}
            >
              <SlidersHorizontal size={14} />
            </Button>
            {showCalendars && (
              <CalendarsPopover onClose={() => setShowCalendars(false)} />
            )}
          </div>
          {window.api && recPhase === 'idle' && (
            <Button
              variant="ghost"
              className="h-7 !py-0 inline-flex items-center border border-transparent text-[12px]"
              title="Record now (mic + system audio, stored locally) — link to an event later"
              onClick={() => void startRecording()}
            >
              <span className="inline-flex items-center gap-1 text-danger">
                <CircleDot size={12} /> Record
              </span>
            </Button>
          )}
          <Button
            variant="accent"
            className="h-7 !py-0 inline-flex items-center text-[12px]"
            onClick={openNewEvent}
            title="New event (n)"
          >
            <span className="inline-flex items-center gap-1">
              <Plus size={13} /> Event
            </span>
          </Button>
        </div>
      </div>

      {/* grid */}
      {mode === 'month' ? (
        <MonthGrid
          days={days}
          anchor={anchor}
          events={events ?? []}
          calendars={calendarMap}
          overlay={overlay}
          onEventClick={(e) => setEditor({ kind: 'edit', event: e })}
          onDayCreate={(day) => {
            const start = new Date(day)
            start.setHours(9, 0, 0, 0)
            setEditor({ kind: 'create', start, end: new Date(start.getTime() + 60 * 60_000) })
          }}
          onEventMove={moveByDays}
          onShowDay={showDay}
          onNavigate={onNavigate}
        />
      ) : (
        <WeekGrid
          days={days}
          events={events ?? []}
          calendars={calendarMap}
          overlay={overlay}
          onEventClick={(e) => setEditor({ kind: 'edit', event: e })}
          onCreate={(start, end) => setEditor({ kind: 'create', start, end })}
          onMoveResize={patchTimes}
          onNavigate={onNavigate}
          onSwipeWeek={step}
          meetingEventIds={meetingEventIds}
        />
      )}

      {editor && (
        <EventEditor target={editor} calendars={calendars ?? []} onClose={() => setEditor(null)} />
      )}
    </div>
  )
}

const STATUS_TONE = {
  connected: 'ok',
  needs_auth: 'danger',
  error: 'danger',
  disabled: 'muted'
} as const

function CalendarsPopover({ onClose }: { onClose: () => void }): React.JSX.Element {
  const { data: calendars } = useInvoke('calendar:calendars', [], ['calendars', 'calendar_accounts'])
  const { data: accounts } = useInvoke('calendar:accounts', [], ['calendar_accounts'])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [onClose])

  const connect = (): void => {
    setBusy(true)
    setError(null)
    void api.invoke('calendar:connectGoogle').then((res) => {
      setBusy(false)
      if (!res.ok) setError(res.message)
    })
  }

  const syncNow = (): void => {
    setSyncing(true)
    void api.invoke('calendar:syncNow').finally(() => setTimeout(() => setSyncing(false), 800))
  }

  return (
    <div
      ref={ref}
      className="absolute right-0 top-8 z-40 w-64 bg-overlay border border-border-strong rounded-lg shadow-2xl p-2.5 space-y-2"
    >
      <div className="space-y-1">
        {(calendars ?? []).map((c) => (
          <label key={c.id} className="flex items-center gap-2 text-[12.5px] text-text select-none cursor-pointer">
            <input
              type="checkbox"
              checked={Boolean(c.is_visible)}
              onChange={(e) => void api.invoke('calendar:setVisible', c.id, e.target.checked)}
              className="accent-accent"
            />
            <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: calendarHex(c) }} />
            <span className="truncate flex-1">{c.id === 'local' ? 'Kairos (local)' : c.summary}</span>
            {!c.is_writable && <span className="text-faint text-[10px]">read-only</span>}
          </label>
        ))}
      </div>

      <div className="border-t border-border pt-2 space-y-1.5">
        {(accounts ?? []).map((a) => (
          <div key={a.id} className="flex items-center gap-1.5 text-[11.5px]">
            <Chip tone={STATUS_TONE[a.status]}>gcal</Chip>
            <span className="truncate flex-1" title={a.error ?? undefined}>
              {a.display_name}
            </span>
            <button
              className="text-faint hover:text-danger text-[10.5px]"
              onClick={() => void api.invoke('calendar:disconnect', a.id)}
            >
              remove
            </button>
          </div>
        ))}
        <div className="flex gap-1.5">
          <Button className="flex-1 !py-1 text-[11.5px]" disabled={busy} onClick={connect}>
            {busy ? 'waiting for browser…' : accounts?.length ? '+ Google account' : 'Connect Google'}
          </Button>
          {(accounts?.length ?? 0) > 0 && (
            <Button variant="ghost" className="!px-2 !py-1" title="Sync now" onClick={syncNow}>
              <RefreshCw size={12} className={syncing ? 'animate-spin' : ''} />
            </Button>
          )}
        </div>
        {error && <p className="text-[11px] text-danger">{error}</p>}
      </div>
    </div>
  )
}

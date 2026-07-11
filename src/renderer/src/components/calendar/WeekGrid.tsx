import { useEffect, useMemo, useRef, useState } from 'react'
import { Bell, Bot, CheckSquare } from 'lucide-react'
import type { CalendarCalendar, CalendarEventRecord } from '../../../../core/types'
import type { CalendarOverlay } from '../../../../shared/ipc-contract'
import type { ViewId } from '../Sidebar'
import { layoutDayEvents } from '../../lib/calendar-layout'
import {
  addDays,
  fmtTime,
  isToday,
  minutesOfDay,
  parseEventDate,
  toDateKey,
  WEEKDAYS
} from '../../lib/dates'
import { eventHex } from './colors'
import { EventCard } from './EventCard'
import { clampMinutes, snapMinutes, usePointerDrag } from './useCalendarDrag'

export const HOUR_PX = 48
const GUTTER_PX = 48
const MIN_EVENT_MIN = 15

interface Segment {
  event: CalendarEventRecord
  startMin: number
  endMin: number
}

type Drag =
  | { kind: 'create'; dayIdx: number; anchorMin: number; startMin: number; endMin: number }
  | {
      kind: 'move'
      event: CalendarEventRecord
      grabOffsetMin: number
      durationMin: number
      dayIdx: number
      startMin: number
      endMin: number
    }
  | { kind: 'resize'; event: CalendarEventRecord; dayIdx: number; startMin: number; endMin: number }
  | { kind: 'swipe'; startX: number; dx: number }

const SWIPE_MIN_PX = 50

/** touch drag that reads as clearly horizontal (not a vertical scroll/create
 *  attempt) is a week-swipe, not an event-create drag */
function isSwipeGesture(e: PointerEvent, delta: { dx: number; dy: number }): boolean {
  return e.pointerType === 'touch' && Math.abs(delta.dx) > Math.abs(delta.dy) * 1.5
}

export function WeekGrid({
  days,
  events,
  calendars,
  overlay,
  onEventClick,
  onCreate,
  onMoveResize,
  onNavigate,
  onSwipeWeek
}: {
  days: Date[]
  events: CalendarEventRecord[]
  calendars: Map<string, CalendarCalendar>
  overlay: CalendarOverlay | undefined
  onEventClick: (e: CalendarEventRecord) => void
  onCreate: (startAt: Date, endAt: Date) => void
  onMoveResize: (id: string, startAt: Date, endAt: Date) => void
  onNavigate: (view: ViewId) => void
  onSwipeWeek?: (dir: 1 | -1) => void
}): React.JSX.Element {
  const bodyRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<Drag | null>(null)
  // mirror for the pointer handlers: reading state inside setState updaters
  // (and doing side effects there) trips React's render-phase warnings
  const dragRef = useRef<Drag | null>(null)
  const updateDrag = (d: Drag | null): void => {
    dragRef.current = d
    setDrag(d)
  }
  const [nowTick, setNowTick] = useState(() => new Date())

  useEffect(() => {
    const t = setInterval(() => setNowTick(new Date()), 60_000)
    return () => clearInterval(t)
  }, [])

  // open at ~7:30 so the workday is in view
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 7.5 * HOUR_PX })
  }, [])

  const { allDay, timedByDay } = useMemo(() => {
    const allDayEvents = events.filter((e) => e.all_day)
    const timed = events.filter((e) => !e.all_day)
    const byDay: Segment[][] = days.map((day) => {
      const dayStart = day.getTime()
      const dayEnd = addDays(day, 1).getTime()
      const segs: Segment[] = []
      for (const e of timed) {
        const s = parseEventDate(e.start_at).getTime()
        const en = parseEventDate(e.end_at).getTime()
        if (s >= dayEnd || en <= dayStart) continue
        segs.push({
          event: e,
          startMin: Math.max(0, (s - dayStart) / 60_000),
          endMin: Math.min(24 * 60, (en - dayStart) / 60_000)
        })
      }
      return segs
    })
    return { allDay: allDayEvents, timedByDay: byDay }
  }, [events, days])

  // ---- pointer → grid coordinates ----

  const pointToGrid = (ev: PointerEvent): { dayIdx: number; min: number } => {
    const rect = bodyRef.current!.getBoundingClientRect()
    const colW = (rect.width - GUTTER_PX) / 7
    const dayIdx = Math.max(0, Math.min(6, Math.floor((ev.clientX - rect.left - GUTTER_PX) / colW)))
    const min = clampMinutes(((ev.clientY - rect.top) / HOUR_PX) * 60)
    return { dayIdx, min }
  }

  const commitTimes = (dayIdx: number, startMin: number, endMin: number): [Date, Date] => {
    const start = new Date(days[dayIdx])
    start.setMinutes(startMin)
    const end = new Date(days[dayIdx])
    end.setMinutes(endMin)
    return [start, end]
  }

  const beginCreate = usePointerDrag<{ dayIdx: number; anchorMin: number }>({
    onStart: (ctx, ev, delta) => {
      if (onSwipeWeek && isSwipeGesture(ev, delta)) {
        updateDrag({ kind: 'swipe', startX: ev.clientX - delta.dx, dx: delta.dx })
        return
      }
      updateDrag({
        kind: 'create',
        dayIdx: ctx.dayIdx,
        anchorMin: ctx.anchorMin,
        startMin: ctx.anchorMin,
        endMin: ctx.anchorMin + MIN_EVENT_MIN
      })
    },
    onMove: (ctx, ev) => {
      const d = dragRef.current
      if (d?.kind === 'swipe') {
        updateDrag({ ...d, dx: ev.clientX - d.startX })
        return
      }
      const { min } = pointToGrid(ev)
      const cur = snapMinutes(min)
      updateDrag({
        kind: 'create',
        dayIdx: ctx.dayIdx,
        anchorMin: ctx.anchorMin,
        startMin: Math.min(ctx.anchorMin, cur),
        endMin: Math.max(ctx.anchorMin + MIN_EVENT_MIN, cur)
      })
    },
    onEnd: (ctx, ev, activated) => {
      const d = dragRef.current
      updateDrag(null)
      if (d?.kind === 'swipe') {
        if (Math.abs(d.dx) >= SWIPE_MIN_PX) onSwipeWeek?.(d.dx < 0 ? 1 : -1)
        return
      }
      if (!activated) {
        // plain click: 1-hour draft at the clicked slot
        const [s, e] = commitTimes(ctx.dayIdx, ctx.anchorMin, Math.min(24 * 60, ctx.anchorMin + 60))
        onCreate(s, e)
        return
      }
      const { min } = pointToGrid(ev)
      const cur = snapMinutes(min)
      const startMin = Math.min(ctx.anchorMin, cur)
      const endMin = Math.max(ctx.anchorMin + MIN_EVENT_MIN, cur)
      const [s, e] = commitTimes(ctx.dayIdx, startMin, endMin)
      onCreate(s, e)
    }
  })

  const beginMove = usePointerDrag<{ event: CalendarEventRecord; seg: Segment; dayIdx: number }>({
    onStart: (ctx, ev) => {
      const { min } = pointToGrid(ev)
      const evStart = parseEventDate(ctx.event.start_at)
      const evEnd = parseEventDate(ctx.event.end_at)
      const durationMin = (evEnd.getTime() - evStart.getTime()) / 60_000
      updateDrag({
        kind: 'move',
        event: ctx.event,
        grabOffsetMin: min - ctx.seg.startMin,
        durationMin,
        dayIdx: ctx.dayIdx,
        startMin: ctx.seg.startMin,
        endMin: Math.min(24 * 60, ctx.seg.startMin + durationMin)
      })
    },
    onMove: (_ctx, ev) => {
      const d = dragRef.current
      if (d?.kind !== 'move') return
      const { dayIdx, min } = pointToGrid(ev)
      const startMin = snapMinutes(clampMinutes(min - d.grabOffsetMin))
      updateDrag({ ...d, dayIdx, startMin, endMin: Math.min(24 * 60, startMin + d.durationMin) })
    },
    onEnd: (ctx, _ev, activated) => {
      const d = dragRef.current
      updateDrag(null)
      if (!activated) {
        onEventClick(ctx.event)
        return
      }
      if (d?.kind !== 'move') return
      const start = new Date(days[d.dayIdx])
      start.setMinutes(d.startMin)
      // duration-preserving even when the event crosses midnight
      const end = new Date(start.getTime() + d.durationMin * 60_000)
      onMoveResize(ctx.event.id, start, end)
    }
  })

  const beginResize = usePointerDrag<{ event: CalendarEventRecord; seg: Segment; dayIdx: number }>({
    onStart: (ctx) =>
      updateDrag({
        kind: 'resize',
        event: ctx.event,
        dayIdx: ctx.dayIdx,
        startMin: ctx.seg.startMin,
        endMin: ctx.seg.endMin
      }),
    onMove: (_ctx, ev) => {
      const d = dragRef.current
      if (d?.kind !== 'resize') return
      const { min } = pointToGrid(ev)
      updateDrag({ ...d, endMin: Math.max(d.startMin + MIN_EVENT_MIN, snapMinutes(min)) })
    },
    onEnd: (ctx, _ev, activated) => {
      const d = dragRef.current
      updateDrag(null)
      if (!activated || d?.kind !== 'resize') return
      const start = parseEventDate(ctx.event.start_at)
      const end = new Date(days[d.dayIdx])
      end.setMinutes(d.endMin)
      if (end.getTime() > start.getTime()) onMoveResize(ctx.event.id, start, end)
    }
  })

  // ---- overlay chips ----

  const tasksByDay = useMemo(() => {
    const map = new Map<string, NonNullable<typeof overlay>['tasks']>()
    for (const t of overlay?.tasks ?? []) {
      if (!t.due_date) continue
      const list = map.get(t.due_date) ?? []
      list.push(t)
      map.set(t.due_date, list)
    }
    return map
  }, [overlay])

  const timedOverlayByDay = useMemo(() => {
    const map = new Map<string, { id: string; min: number; label: string; view: ViewId; icon: 'note' | 'bot' }[]>()
    const push = (iso: string, id: string, label: string, view: ViewId, icon: 'note' | 'bot'): void => {
      const d = new Date(iso)
      const key = toDateKey(d)
      const list = map.get(key) ?? []
      list.push({ id, min: minutesOfDay(d), label, view, icon })
      map.set(key, list)
    }
    for (const n of overlay?.notes ?? []) {
      if (n.remind_at) push(n.remind_at, n.id, n.title || 'note', 'notes', 'note')
    }
    for (const a of overlay?.agentTasks ?? []) {
      if (a.next_run) push(a.next_run, a.id, a.name, 'automations', 'bot')
    }
    return map
  }, [overlay])

  const dragging = drag !== null && drag.kind !== 'swipe'
  const draggedId = drag && drag.kind !== 'create' && drag.kind !== 'swipe' ? drag.event.id : null

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* day headers + all-day lane */}
      <div className="grid shrink-0 border-b border-border" style={{ gridTemplateColumns: `${GUTTER_PX}px repeat(7, 1fr)` }}>
        <div />
        {days.map((day, i) => (
          <div key={i} className="px-2 pt-1.5 pb-1 border-l border-border min-w-0">
            <div className="flex items-baseline gap-1.5">
              <span className="font-mono text-[10px] uppercase tracking-wider text-faint">
                {WEEKDAYS[i]}
              </span>
              <span
                className={`text-[15px] tabular-nums ${
                  isToday(day)
                    ? 'text-accent font-medium'
                    : 'text-muted'
                }`}
              >
                {day.getDate()}
              </span>
            </div>
            <div className="space-y-px pb-0.5 pt-0.5">
              {allDay
                .filter((e) => {
                  const key = toDateKey(day)
                  return e.start_at <= key && key < e.end_at
                })
                .map((e) => (
                  <button
                    key={e.id}
                    onClick={() => onEventClick(e)}
                    className="w-full text-left truncate rounded px-1 py-px text-[11px] leading-4 text-text"
                    style={{ backgroundColor: `${eventHex(e, calendars)}33`, borderLeft: `2px solid ${eventHex(e, calendars)}` }}
                    title={e.title}
                  >
                    {e.title || '(untitled)'}
                  </button>
                ))}
              {(tasksByDay.get(toDateKey(day)) ?? []).map((t) => (
                <button
                  key={t.id}
                  onClick={() => onNavigate('tasks')}
                  className="w-full flex items-center gap-1 truncate rounded px-1 py-px text-[11px] leading-4 text-muted bg-raised hover:text-text"
                  title={`Task due: ${t.title}`}
                >
                  <CheckSquare size={10} className="shrink-0" />
                  <span className="truncate">{t.title}</span>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* hour grid */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        <div
          ref={bodyRef}
          className="relative grid"
          style={{ gridTemplateColumns: `${GUTTER_PX}px repeat(7, 1fr)`, height: 24 * HOUR_PX }}
        >
          {/* gutter */}
          <div className="relative select-none">
            {Array.from({ length: 23 }, (_, h) => (
              <span
                key={h}
                className="absolute right-1.5 -translate-y-1/2 font-mono text-[9.5px] text-faint"
                style={{ top: (h + 1) * HOUR_PX }}
              >
                {String(h + 1).padStart(2, '0')}:00
              </span>
            ))}
          </div>

          {days.map((day, dayIdx) => {
            const laid = layoutDayEvents(
              timedByDay[dayIdx].filter((s) => s.event.id !== draggedId),
              (s) => s.startMin,
              (s) => s.endMin
            )
            const todayCol = isToday(day)
            const nowMin = minutesOfDay(nowTick)
            return (
              <div
                key={dayIdx}
                className="relative border-l border-border"
                onPointerDown={(e) => {
                  if (e.target !== e.currentTarget) return
                  const rect = e.currentTarget.getBoundingClientRect()
                  const min = snapMinutes(clampMinutes(((e.clientY - rect.top) / HOUR_PX) * 60), 30)
                  beginCreate(e, { dayIdx, anchorMin: Math.min(min, 23 * 60) })
                }}
              >
                {/* hour lines */}
                {Array.from({ length: 23 }, (_, h) => (
                  <div
                    key={h}
                    className="absolute inset-x-0 border-t border-border/60 pointer-events-none"
                    style={{ top: (h + 1) * HOUR_PX }}
                  />
                ))}

                {/* timed overlay chips (notes / automations) */}
                {(timedOverlayByDay.get(toDateKey(day)) ?? []).map((o) => (
                  <button
                    key={o.id}
                    onClick={() => onNavigate(o.view)}
                    className="absolute inset-x-0.5 z-10 flex items-center gap-1 px-1 rounded bg-raised/90 border border-border text-[10px] text-muted hover:text-text truncate"
                    style={{ top: (o.min / 60) * HOUR_PX, height: 15 }}
                    title={o.label}
                  >
                    {o.icon === 'note' ? <Bell size={9} className="shrink-0" /> : <Bot size={9} className="shrink-0" />}
                    <span className="truncate">{o.label}</span>
                  </button>
                ))}

                {/* events */}
                {laid.map(({ item: seg, col, cols }) => (
                  <EventCard
                    key={seg.event.id}
                    event={seg.event}
                    hex={eventHex(seg.event, calendars)}
                    top={(seg.startMin / 60) * HOUR_PX}
                    height={Math.max(((seg.endMin - seg.startMin) / 60) * HOUR_PX, 14)}
                    leftPct={(col / cols) * 100}
                    widthPct={(1 / cols) * 100}
                    dimmed={dragging}
                    onBodyPointerDown={(e) => beginMove(e, { event: seg.event, seg, dayIdx })}
                    onResizePointerDown={
                      seg.event.recurring_event_id
                        ? undefined
                        : (e) => beginResize(e, { event: seg.event, seg, dayIdx })
                    }
                  />
                ))}

                {/* drag ghost */}
                {drag && drag.kind !== 'swipe' && drag.dayIdx === dayIdx && (
                  <div
                    className="absolute inset-x-0.5 z-20 rounded border border-accent/60 bg-accent/15 pointer-events-none px-1.5 py-0.5"
                    style={{
                      top: (drag.startMin / 60) * HOUR_PX,
                      height: Math.max(((drag.endMin - drag.startMin) / 60) * HOUR_PX, 14)
                    }}
                  >
                    <span className="text-[10.5px] font-mono text-accent">
                      {fmtTime(commitTimes(dayIdx, drag.startMin, drag.endMin)[0])}
                      {' – '}
                      {fmtTime(commitTimes(dayIdx, drag.startMin, drag.endMin)[1])}
                    </span>
                    {drag.kind !== 'create' && (
                      <div className="text-[11px] text-text truncate">{drag.event.title}</div>
                    )}
                  </div>
                )}

                {/* now indicator */}
                {todayCol && (
                  <div
                    className="absolute inset-x-0 z-30 pointer-events-none"
                    style={{ top: (nowMin / 60) * HOUR_PX }}
                  >
                    <div className="h-px bg-danger" />
                    <div className="absolute -left-0.5 -top-[2.5px] w-[5px] h-[5px] rounded-full bg-danger" />
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

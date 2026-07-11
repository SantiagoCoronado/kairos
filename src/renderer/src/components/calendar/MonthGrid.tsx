import { useMemo, useRef, useState } from 'react'
import { Bell, Bot, CheckSquare } from 'lucide-react'
import type { CalendarCalendar, CalendarEventRecord } from '../../../../core/types'
import type { CalendarOverlay } from '../../../../shared/ipc-contract'
import type { ViewId } from '../Sidebar'
import { addDays, fmtTime, fromDateKey, isToday, parseEventDate, toDateKey, WEEKDAYS } from '../../lib/dates'
import { eventHex } from './colors'
import { touchBlockRef, usePointerDrag } from './useCalendarDrag'

const MAX_PILLS = 4

export function MonthGrid({
  days,
  anchor,
  events,
  calendars,
  overlay,
  onEventClick,
  onDayCreate,
  onEventMove,
  onShowDay,
  onNavigate
}: {
  days: Date[] // 42
  anchor: Date
  events: CalendarEventRecord[]
  calendars: Map<string, CalendarCalendar>
  overlay: CalendarOverlay | undefined
  onEventClick: (e: CalendarEventRecord) => void
  onDayCreate: (day: Date) => void
  onEventMove: (e: CalendarEventRecord, dayDelta: number) => void
  onShowDay: (day: Date) => void
  onNavigate: (view: ViewId) => void
}): React.JSX.Element {
  const gridRef = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<{ event: CalendarEventRecord; fromIdx: number; overIdx: number } | null>(null)

  const byDay = useMemo(() => {
    const map = new Map<string, CalendarEventRecord[]>()
    for (const day of days) {
      const key = toDateKey(day)
      const dayStart = day.getTime()
      const dayEnd = addDays(day, 1).getTime()
      const items = events.filter((e) => {
        if (e.all_day) return e.start_at <= key && key < e.end_at
        const s = parseEventDate(e.start_at).getTime()
        const en = parseEventDate(e.end_at).getTime()
        return s < dayEnd && en > dayStart
      })
      map.set(key, items)
    }
    return map
  }, [events, days])

  const overlayByDay = useMemo(() => {
    const map = new Map<string, { id: string; label: string; view: ViewId; icon: 'task' | 'note' | 'bot' }[]>()
    const push = (key: string, id: string, label: string, view: ViewId, icon: 'task' | 'note' | 'bot'): void => {
      const list = map.get(key) ?? []
      list.push({ id, label, view, icon })
      map.set(key, list)
    }
    for (const t of overlay?.tasks ?? []) if (t.due_date) push(t.due_date, t.id, t.title, 'tasks', 'task')
    for (const n of overlay?.notes ?? [])
      if (n.remind_at) push(toDateKey(new Date(n.remind_at)), n.id, n.title || 'note', 'notes', 'note')
    for (const a of overlay?.agentTasks ?? [])
      if (a.next_run) push(toDateKey(new Date(a.next_run)), a.id, a.name, 'automations', 'bot')
    return map
  }, [overlay])

  const cellFromPointer = (ev: PointerEvent): number => {
    const rect = gridRef.current!.getBoundingClientRect()
    const col = Math.max(0, Math.min(6, Math.floor(((ev.clientX - rect.left) / rect.width) * 7)))
    const row = Math.max(0, Math.min(5, Math.floor(((ev.clientY - rect.top) / rect.height) * 6)))
    return row * 7 + col
  }

  const beginPillDrag = usePointerDrag<{ event: CalendarEventRecord; fromIdx: number }>({
    onStart: (ctx) => setDrag({ event: ctx.event, fromIdx: ctx.fromIdx, overIdx: ctx.fromIdx }),
    onMove: (_ctx, ev) => {
      const idx = cellFromPointer(ev)
      setDrag((d) => (d ? { ...d, overIdx: idx } : d))
    },
    onEnd: (ctx, ev, activated) => {
      setDrag(null)
      if (!activated) {
        onEventClick(ctx.event)
        return
      }
      const delta = cellFromPointer(ev) - ctx.fromIdx
      if (delta !== 0) onEventMove(ctx.event, delta)
    }
  })

  return (
    <div className="flex-1 min-h-0 flex flex-col cal-touch">
      <div className="grid grid-cols-7 shrink-0 border-b border-border">
        {WEEKDAYS.map((wd) => (
          <div
            key={wd}
            className="px-2 py-1 border-l border-border font-mono text-[10px] uppercase tracking-wider text-faint"
          >
            {wd}
          </div>
        ))}
      </div>
      <div ref={gridRef} className="flex-1 min-h-0 grid grid-cols-7 grid-rows-6">
      {days.map((day, idx) => {
        const key = toDateKey(day)
        const items = byDay.get(key) ?? []
        const chips = overlayByDay.get(key) ?? []
        const outside = day.getMonth() !== anchor.getMonth()
        const visible = items.slice(0, MAX_PILLS)
        const hidden = items.length - visible.length
        return (
          <div
            key={key}
            className={`relative border-b border-l border-border p-1 min-w-0 overflow-hidden ${
              outside ? 'bg-panel/40' : ''
            } ${drag?.overIdx === idx && drag.fromIdx !== idx ? 'bg-accent/10' : ''}`}
            onDoubleClick={() => onDayCreate(day)}
          >
            <div className="flex justify-between items-start">
              <button
                onClick={() => onShowDay(day)}
                className={`min-w-5 h-5 px-0.5 rounded text-[12px] tabular-nums text-center hover:bg-raised ${
                  isToday(day)
                    ? 'bg-accent/20 text-accent font-medium'
                    : outside
                      ? 'text-faint'
                      : 'text-muted'
                }`}
                title="Open week view"
              >
                {day.getDate()}
              </button>
            </div>
            <div className="space-y-px mt-0.5">
              {visible.map((e) => {
                const hex = eventHex(e, calendars)
                return (
                  <div
                    key={e.id}
                    ref={touchBlockRef}
                    onPointerDown={
                      e.recurring_event_id
                        ? undefined
                        : (pe) => beginPillDrag(pe, { event: e, fromIdx: idx })
                    }
                    onClick={e.recurring_event_id ? () => onEventClick(e) : undefined}
                    className={`w-full text-left truncate rounded px-1 py-px text-[11px] leading-4 text-text select-none ${
                      drag?.event.id === e.id ? 'opacity-40' : ''
                    } ${e.recurring_event_id ? 'cursor-pointer' : 'cursor-grab'}`}
                    style={{ backgroundColor: `${hex}2e`, borderLeft: `2px solid ${hex}` }}
                    title={e.title}
                  >
                    {!e.all_day && (
                      <span className="font-mono text-[9.5px] text-muted mr-1">
                        {fmtTime(parseEventDate(e.start_at))}
                      </span>
                    )}
                    {e.title || '(untitled)'}
                  </div>
                )
              })}
              {hidden > 0 && (
                <button
                  onClick={() => onShowDay(day)}
                  className="w-full text-left px-1 text-[10.5px] text-faint hover:text-text"
                >
                  +{hidden} more
                </button>
              )}
              {chips.slice(0, 2).map((c) => (
                <button
                  key={c.id}
                  onClick={() => onNavigate(c.view)}
                  className="w-full flex items-center gap-1 truncate rounded px-1 py-px text-[10.5px] leading-4 text-muted bg-raised/70 hover:text-text"
                  title={c.label}
                >
                  {c.icon === 'task' && <CheckSquare size={9} className="shrink-0" />}
                  {c.icon === 'note' && <Bell size={9} className="shrink-0" />}
                  {c.icon === 'bot' && <Bot size={9} className="shrink-0" />}
                  <span className="truncate">{c.label}</span>
                </button>
              ))}
            </div>
          </div>
        )
      })}
      </div>
    </div>
  )
}

/** shift an event by whole days, preserving time-of-day and duration */
export function shiftEventDays(e: CalendarEventRecord, dayDelta: number): { start_at: string; end_at: string } {
  if (e.all_day) {
    return {
      start_at: toDateKey(addDays(fromDateKey(e.start_at), dayDelta)),
      end_at: toDateKey(addDays(fromDateKey(e.end_at), dayDelta))
    }
  }
  const s = parseEventDate(e.start_at)
  const en = parseEventDate(e.end_at)
  const shift = (d: Date): Date => {
    const nd = addDays(d, dayDelta)
    nd.setHours(d.getHours(), d.getMinutes(), d.getSeconds(), 0)
    return nd
  }
  return { start_at: shift(s).toISOString(), end_at: shift(en).toISOString() }
}

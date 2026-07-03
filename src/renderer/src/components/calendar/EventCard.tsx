import { Repeat, Video } from 'lucide-react'
import type { CalendarEventRecord } from '../../../../core/types'
import { fmtTime, parseEventDate } from '../../lib/dates'

/** One timed event block in the week grid, absolutely positioned by the parent. */
export function EventCard({
  event,
  hex,
  top,
  height,
  leftPct,
  widthPct,
  dimmed,
  onBodyPointerDown,
  onResizePointerDown
}: {
  event: CalendarEventRecord
  hex: string
  top: number
  height: number
  leftPct: number
  widthPct: number
  dimmed: boolean
  onBodyPointerDown: (e: React.PointerEvent) => void
  onResizePointerDown?: (e: React.PointerEvent) => void
}): React.JSX.Element {
  const compact = height < 30
  return (
    <div
      className={`absolute z-10 rounded overflow-hidden select-none cursor-pointer transition-opacity ${
        dimmed ? 'opacity-40' : ''
      }`}
      style={{
        top,
        height,
        left: `calc(${leftPct}% + 2px)`,
        width: `calc(${widthPct}% - 4px)`,
        backgroundColor: `${hex}2e`,
        borderLeft: `2px solid ${hex}`
      }}
      onPointerDown={onBodyPointerDown}
      title={event.title}
    >
      <div className={`px-1.5 ${compact ? 'py-0 flex items-baseline gap-1.5' : 'py-0.5'}`}>
        <div className="text-[11.5px] leading-4 text-text truncate flex items-center gap-1">
          {event.recurring_event_id && <Repeat size={9} className="shrink-0 text-muted" />}
          {event.conferencing_url && <Video size={9} className="shrink-0 text-muted" />}
          <span className="truncate">{event.title || '(untitled)'}</span>
        </div>
        {!compact && (
          <div className="font-mono text-[9.5px] text-muted">
            {fmtTime(parseEventDate(event.start_at))} – {fmtTime(parseEventDate(event.end_at))}
          </div>
        )}
      </div>
      {onResizePointerDown && height >= 22 && (
        <div
          className="absolute inset-x-0 bottom-0 h-1.5 cursor-ns-resize"
          onPointerDown={onResizePointerDown}
        />
      )}
    </div>
  )
}

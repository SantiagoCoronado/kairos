import { useMemo } from 'react'
import { AudioLines, CircleDot } from 'lucide-react'
import { useInvoke } from '../lib/api'
import { startRecording, useMeetingRecording } from '../lib/meeting-store'
import { fmtMeetingDuration, groupMeetingsByDay } from '../lib/meeting-ui'
import { MeetingRow } from '../components/meeting/MeetingSection'
import { Button, EmptyState } from '../components/ui'

/** Every recording, event-linked or ad-hoc, newest first by day. The only
 *  place an ad-hoc recording (Record with no event) is reachable after it
 *  scrolls off Today's 24-hour "recent meetings" — EventEditor only lists
 *  the recordings of its own event. */
export function MeetingsView(): React.JSX.Element {
  const { data } = useInvoke('meetings:list', [{}], ['meetings'])
  const rec = useMeetingRecording()
  const all = data ?? []
  const live = all.filter((m) => m.status === 'recording')
  const rows = useMemo(() => all.filter((m) => m.status !== 'recording'), [all])
  const groups = useMemo(() => groupMeetingsByDay(rows), [rows])
  const totalSeconds = rows.reduce((acc, m) => acc + (m.duration_seconds ?? 0), 0)
  const failed = rows.filter((m) => m.status === 'error').length

  return (
    <div className="max-w-3xl mx-auto px-6 py-5 space-y-4">
      <div className="flex items-center gap-3">
        <div className="min-w-0">
          <h1 className="text-[17px] font-medium text-text flex items-center gap-2">
            <AudioLines size={16} className="text-faint" /> Meetings
          </h1>
          <p className="text-[11.5px] text-faint mt-0.5">
            {rows.length === 0
              ? 'Recordings are stored locally in ~/Kairos/recordings'
              : `${rows.length} recording${rows.length === 1 ? '' : 's'}` +
                (totalSeconds > 0 ? ` · ${fmtMeetingDuration(totalSeconds)}` : '') +
                (failed > 0 ? ` · ${failed} failed` : '') +
                ' · stored locally in ~/Kairos/recordings'}
          </p>
        </div>
        <div className="flex-1" />
        {window.api && rec.phase === 'idle' && (
          <Button
            variant="ghost"
            className="h-7 !py-0 inline-flex items-center border border-transparent text-[12px]"
            title="Record now (mic + system audio, stored locally) — rename it here afterwards"
            onClick={() => void startRecording()}
          >
            <span className="inline-flex items-center gap-1 text-danger">
              <CircleDot size={12} /> Record
            </span>
          </Button>
        )}
      </div>

      {live.map((m) => (
        <div
          key={m.id}
          className="flex items-center gap-2 rounded-md border border-danger/30 bg-danger/5 px-2.5 py-1.5 text-[12.5px]"
        >
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-danger/60" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-danger" />
          </span>
          <span className="text-text">Recording now</span>
          <span className="min-w-0 truncate text-muted">{m.title || 'Untitled meeting'}</span>
          <span className="flex-1" />
          <span className="text-[11px] text-faint">stop from the bar above</span>
        </div>
      ))}

      {rows.length === 0 && live.length === 0 && (
        <EmptyState>
          No recordings yet — hit Record here, or from a calendar event to link it.
        </EmptyState>
      )}

      {groups.map((g) => (
        <section key={g.label} className="space-y-1">
          <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-faint px-0.5">
            {g.label}
          </div>
          {g.meetings.map((m) => (
            <MeetingRow key={m.id} meeting={m} showTitle />
          ))}
        </section>
      ))}
    </div>
  )
}

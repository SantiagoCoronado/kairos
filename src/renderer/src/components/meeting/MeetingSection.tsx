import { useState } from 'react'
import { Circle, FileText, FolderOpen, Pause, Play, RotateCcw, Sparkles, Square, Trash2 } from 'lucide-react'
import type { Meeting, MeetingTranscript } from '../../../../core/types'
import { api, useInvoke } from '../../lib/api'
import { SummaryModal } from './SummaryModal'
import { TranscriptModal } from './TranscriptModal'
import {
  pauseRecording,
  resumeRecording,
  startRecording,
  stopRecording,
  useMeetingRecording
} from '../../lib/meeting-store'
import { fmtMeetingDuration } from '../../lib/meeting-ui'
import { useMeetingPlayback, type MeetingPlayback } from '../../lib/meeting-playback'
import { Button, Chip, InlineText, cn } from '../ui'

/** Recording block inside EventEditor (saved events only): start/stop a
 *  recording linked to this event, list past recordings with playback. */
export function MeetingSection({
  eventId,
  eventTitle
}: {
  eventId: string
  eventTitle: string
}): React.JSX.Element {
  const rec = useMeetingRecording()
  const { data: meetings } = useInvoke(
    'meetings:list',
    [{ calendar_event_id: eventId }],
    ['meetings']
  )
  const recordingHere = rec.phase === 'recording' && meetings?.some((m) => m.id === rec.meetingId)
  const busyElsewhere =
    (rec.phase === 'recording' || rec.phase === 'stopping') && !recordingHere

  const rows = (meetings ?? []).filter((m) => m.status !== 'recording')

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <span className="text-[11px] uppercase tracking-wide text-faint">Recording</span>
        <div className="flex-1" />
        {recordingHere ? (
          <>
            {rec.pausedAtMs === null ? (
              <Button
                variant="ghost"
                className="!py-1 text-[11.5px]"
                title="Pause recording"
                onClick={() => void pauseRecording()}
              >
                <span className="inline-flex items-center gap-1">
                  <Pause size={11} fill="currentColor" /> Pause
                </span>
              </Button>
            ) : (
              <Button
                variant="ghost"
                className="!py-1 text-[11.5px] text-accent"
                title="Resume recording"
                onClick={() => void resumeRecording()}
              >
                <span className="inline-flex items-center gap-1">
                  <Play size={11} fill="currentColor" /> Resume
                </span>
              </Button>
            )}
            <Button
              variant="ghost"
              className="!py-1 text-[11.5px] text-danger"
              title="Stop and save the recording"
              onClick={() => void stopRecording()}
            >
              <span className="inline-flex items-center gap-1">
                <Square size={11} fill="currentColor" /> Stop
              </span>
            </Button>
          </>
        ) : (
          <Button
            variant="ghost"
            className="!py-1 text-[11.5px]"
            disabled={busyElsewhere}
            title={
              busyElsewhere
                ? 'Another meeting is recording'
                : 'Record this meeting (mic + system audio, stored locally)'
            }
            onClick={() =>
              void startRecording({ calendarEventId: eventId, title: eventTitle })
            }
          >
            <span className="inline-flex items-center gap-1 text-danger">
              <Circle size={10} fill="currentColor" /> Record
            </span>
          </Button>
        )}
      </div>
      {rows.map((m) => (
        <MeetingRow key={m.id} meeting={m} />
      ))}
    </div>
  )
}

/** One recording: date, duration, status, and every action the row's state
 *  allows. `showTitle` is for the all-recordings list — inside EventEditor
 *  the event already names the meeting. Ad-hoc recordings start untitled,
 *  so there the title is editable in place. */
export function MeetingRow({
  meeting: m,
  showTitle = false,
  onOpenEvent
}: {
  meeting: Meeting
  showTitle?: boolean
  /** event-linked rows: jump to the event's day (all-recordings list) */
  onOpenEvent?: () => void
}): React.JSX.Element {
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [transcript, setTranscript] = useState<MeetingTranscript | null>(null)
  const [showSummary, setShowSummary] = useState(false)
  // one playback per row, shared with the transcript modal — a second hook
  // instance would start a second copy of the same audio
  const playback = useMeetingPlayback(m)
  const started = new Date(m.started_at)

  const openTranscript = async (): Promise<void> => {
    const res = await api.invoke('meetings:get', m.id)
    if (res.transcript) setTranscript(res.transcript)
  }
  // under a day header (all-recordings list) the date would repeat per row
  const dateLabel = started.toLocaleString(undefined, {
    ...(showTitle ? {} : { month: 'short', day: 'numeric' }),
    hour: 'numeric',
    minute: '2-digit'
  })

  const retry = async (): Promise<void> => {
    setActionError(null)
    try {
      await api.invoke('meetings:retranscribe', m.id)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md bg-panel px-2.5 py-1.5">
      <span className="shrink-0 whitespace-nowrap text-[12px] text-text tabular-nums">
        {dateLabel}
      </span>
      {showTitle &&
        (m.calendar_event_id ? (
          onOpenEvent ? (
            <button
              className="min-w-0 truncate text-left text-[13px] text-text hover:text-accent"
              title="Open the linked event's day in Calendar"
              onClick={onOpenEvent}
            >
              {m.title || 'Untitled meeting'}
            </button>
          ) : (
            <span className="min-w-0 truncate text-[13px] text-text" title={m.title}>
              {m.title || 'Untitled meeting'}
            </span>
          )
        ) : (
          <InlineText
            value={m.title || 'Untitled meeting'}
            className="min-w-0 flex-1 basis-40 text-[13px] text-text"
            onSave={(v) => void api.invoke('meetings:rename', m.id, v)}
          />
        ))}
      {m.duration_seconds != null && (
        <span className="shrink-0 whitespace-nowrap text-[11.5px] text-muted tabular-nums">
          {fmtMeetingDuration(m.duration_seconds)}
        </span>
      )}
      {m.status === 'error' && (
        <span title={m.error ?? undefined}>
          <Chip tone="danger">failed</Chip>
        </span>
      )}
      {actionError && (
        <span className="text-[11px] text-danger" title={actionError}>
          {actionError}
        </span>
      )}
      {m.status === 'processing' && <Chip tone="muted">transcribing…</Chip>}
      {m.status === 'ready' && m.error && (
        <span title={m.error}>
          <Chip tone="muted">partial</Chip>
        </span>
      )}
      {/* ml-auto (not a flex-1 spacer) so the actions track the right edge
          even when the row wraps to a second line */}
      <div className="ml-auto flex flex-wrap items-center justify-end gap-x-2 gap-y-1">
        {m.status === 'ready' && m.summary_md && (
          <button
            className="shrink-0 inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded text-accent hover:bg-raised"
            title="View summary and action items"
            onClick={() => setShowSummary(true)}
          >
            <Sparkles size={10} /> summary
          </button>
        )}
        {m.status === 'ready' && !m.summary_md && (
          <button
            className="shrink-0 inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded text-muted hover:bg-raised hover:text-text"
            title="Generate summary and action items"
            onClick={() => void api.invoke('meetings:summarize', m.id)}
          >
            <Sparkles size={10} /> summarize
          </button>
        )}
        {m.status === 'ready' && (
          <button
            className="shrink-0 inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded text-muted hover:bg-raised hover:text-text"
            title="View transcript"
            onClick={() => void openTranscript()}
          >
            <FileText size={10} /> transcript
          </button>
        )}
        {m.status === 'ready' && !m.audio_deleted_at && (m.mic_path || m.system_path) && (
          <PlayButton playback={playback} />
        )}
        {window.api &&
          !m.audio_deleted_at &&
          (m.status === 'error' || (m.status === 'ready' && m.error)) && (
          <button
            className="shrink-0 inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded text-muted hover:bg-raised hover:text-text"
            title={`Retry transcription${m.error ? ` — last error: ${m.error}` : ''}`}
            onClick={() => void retry()}
          >
            <RotateCcw size={10} /> retry
          </button>
        )}
        {window.api && !m.audio_deleted_at && (
          <button
            className="shrink-0 p-1 rounded text-faint hover:bg-raised hover:text-text"
            title="Show recording files in Finder"
            onClick={() => void api.invoke('meetings:reveal', m.id)}
          >
            <FolderOpen size={12} />
          </button>
        )}
        <button
          className={cn(
            'shrink-0 p-1 rounded hover:bg-raised',
            confirmDelete ? 'text-danger' : 'text-faint hover:text-text'
          )}
          title={confirmDelete ? 'Confirm delete (audio + row)' : 'Delete recording'}
          onClick={() => {
            if (!confirmDelete) {
              setConfirmDelete(true)
              setTimeout(() => setConfirmDelete(false), 2500)
              return
            }
            void api.invoke('meetings:delete', m.id)
          }}
        >
          <Trash2 size={12} />
        </button>
      </div>
      {transcript && (
        <TranscriptModal
          meeting={m}
          transcript={transcript}
          playback={playback}
          onClose={() => setTranscript(null)}
        />
      )}
      {showSummary && <SummaryModal meeting={m} onClose={() => setShowSummary(false)} />}
    </div>
  )
}

/** plays the mic + system archives together as one recording */
function PlayButton({ playback }: { playback: MeetingPlayback }): React.JSX.Element {
  const { playing, loading, error, toggle } = playback

  return (
    <button
      className={cn(
        'shrink-0 inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded hover:bg-raised',
        error ? 'text-danger' : playing ? 'text-accent' : 'text-muted'
      )}
      title={error ?? (playing ? 'Pause' : 'Play recording')}
      disabled={loading}
      onClick={() => void toggle()}
    >
      {playing ? <Pause size={10} /> : <Play size={10} />}
      {playing ? 'pause' : 'play'}
    </button>
  )
}

import { useEffect } from 'react'
import { Copy, Pause, Play, X } from 'lucide-react'
import type { Meeting, MeetingTranscript } from '../../../../core/types'
import { fmtMeetingDuration, fmtElapsed } from '../../lib/meeting-ui'
import { useMeetingPlayback } from '../../lib/meeting-playback'
import { Button, cn } from '../ui'

/** Full transcript with timestamps; clicking a segment seeks the recording. */
export function TranscriptModal({
  meeting,
  transcript,
  onClose
}: {
  meeting: Meeting
  transcript: MeetingTranscript
  onClose: () => void
}): React.JSX.Element {
  const { playing, loading, error: audioError, t, toggle, seekTo } = useMeetingPlayback(meeting)
  const audioGone = Boolean(meeting.audio_deleted_at) || (!meeting.mic_path && !meeting.system_path)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const started = new Date(meeting.started_at)

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center"
      onMouseDown={onClose}
    >
      <div
        className="w-[560px] max-w-[95vw] h-[70vh] max-h-[85vh] bg-overlay border border-border-strong rounded-xl shadow-2xl flex flex-col overflow-hidden"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between px-5 pt-4 pb-3 border-b border-border shrink-0">
          <div className="min-w-0">
            <h2 className="text-[14px] text-text font-medium truncate">
              {meeting.title || 'Meeting transcript'}
            </h2>
            <p className="text-[11px] text-faint">
              {started.toLocaleString(undefined, {
                weekday: 'short',
                month: 'short',
                day: 'numeric',
                hour: 'numeric',
                minute: '2-digit'
              })}
              {meeting.duration_seconds != null &&
                ` · ${fmtMeetingDuration(meeting.duration_seconds)}`}
              {transcript.model && ` · ${transcript.model}`}
            </p>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            {!audioGone && (
              <Button
                variant="ghost"
                className="!px-2 !py-1 text-[11.5px] tabular-nums"
                disabled={loading}
                onClick={() => void toggle()}
                title={playing ? 'Pause' : 'Play recording'}
              >
                <span className="inline-flex items-center gap-1.5">
                  {playing ? <Pause size={12} /> : <Play size={12} />}
                  {loading ? 'loading…' : fmtElapsed(t * 1000)}
                </span>
              </Button>
            )}
            <Button
              variant="ghost"
              className="!px-2 !py-1"
              title="Copy transcript"
              onClick={() => void navigator.clipboard.writeText(transcript.text)}
            >
              <Copy size={12} />
            </Button>
            <button onClick={onClose} className="text-faint hover:text-text ml-1">
              <X size={15} />
            </button>
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-1">
          {audioError && <p className="text-[11.5px] text-danger">{audioError}</p>}
          {transcript.segments.length === 0 && (
            <p className="text-[12px] text-faint">
              Nothing was transcribed — the recording may have been silent.
            </p>
          )}
          {transcript.segments.map((s, i) => (
            <button
              key={i}
              className={cn(
                'w-full text-left flex gap-2.5 rounded-md px-2 py-1 hover:bg-panel',
                playing && t >= s.t0 && t < s.t1 && 'bg-panel'
              )}
              title={audioGone ? undefined : 'Play from here'}
              onClick={() => !audioGone && void seekTo(s.t0)}
            >
              <span className="shrink-0 w-10 text-[10.5px] text-faint tabular-nums pt-0.5">
                {fmtElapsed(s.t0 * 1000)}
              </span>
              <span className="text-[12.5px] text-text leading-5">{s.text}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

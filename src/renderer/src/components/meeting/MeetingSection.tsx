import { useRef, useState } from 'react'
import { Circle, FileText, Pause, Play, Square, Trash2 } from 'lucide-react'
import type { Meeting, MeetingTranscript } from '../../../../core/types'
import { api, useInvoke } from '../../lib/api'
import { TranscriptModal } from './TranscriptModal'
import {
  startRecording,
  stopRecording,
  useMeetingRecording
} from '../../lib/meeting-store'
import { fmtMeetingDuration } from '../../lib/meeting-ui'
import { Button, Chip, cn } from '../ui'

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
          <Button
            variant="ghost"
            className="!py-1 text-[11.5px] text-danger"
            onClick={() => void stopRecording()}
          >
            <span className="inline-flex items-center gap-1">
              <Square size={11} fill="currentColor" /> Stop
            </span>
          </Button>
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

function MeetingRow({ meeting: m }: { meeting: Meeting }): React.JSX.Element {
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [transcript, setTranscript] = useState<MeetingTranscript | null>(null)
  const started = new Date(m.started_at)

  const openTranscript = async (): Promise<void> => {
    const res = await api.invoke('meetings:get', m.id)
    if (res.transcript) setTranscript(res.transcript)
  }
  const dateLabel = started.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })

  return (
    <div className="flex items-center gap-2 rounded-md bg-panel px-2.5 py-1.5">
      <span className="text-[12px] text-text">{dateLabel}</span>
      {m.duration_seconds != null && (
        <span className="text-[11.5px] text-muted tabular-nums">
          {fmtMeetingDuration(m.duration_seconds)}
        </span>
      )}
      {m.status === 'error' && (
        <span title={m.error ?? undefined}>
          <Chip tone="danger">failed</Chip>
        </span>
      )}
      {m.status === 'processing' && <Chip tone="muted">transcribing…</Chip>}
      <div className="flex-1" />
      {m.status === 'ready' && (
        <button
          className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded text-muted hover:bg-raised hover:text-text"
          title="View transcript"
          onClick={() => void openTranscript()}
        >
          <FileText size={10} /> transcript
        </button>
      )}
      {m.status === 'ready' && !m.audio_deleted_at && (
        <>
          {m.mic_path && <AudioButton meetingId={m.id} channel="mic" label="me" />}
          {m.system_path && <AudioButton meetingId={m.id} channel="system" label="them" />}
        </>
      )}
      {transcript && (
        <TranscriptModal meeting={m} transcript={transcript} onClose={() => setTranscript(null)} />
      )}
      <button
        className={cn(
          'p-1 rounded hover:bg-raised',
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
  )
}

/** per-channel play/pause; bytes arrive once as a data URL (VoiceNoteChip pattern) */
function AudioButton({
  meetingId,
  channel,
  label
}: {
  meetingId: string
  channel: 'mic' | 'system'
  label: string
}): React.JSX.Element {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const [state, setState] = useState<'idle' | 'loading' | 'playing' | 'error'>('idle')

  const toggle = async (): Promise<void> => {
    if (state === 'playing') {
      audioRef.current?.pause()
      setState('idle')
      return
    }
    if (state === 'loading') return
    if (!audioRef.current) {
      setState('loading')
      const res = await api.invoke('meetings:audioData', meetingId, channel)
      if (!res.ok) {
        setState('error')
        return
      }
      const audio = new Audio(res.dataUrl)
      audio.addEventListener('ended', () => setState('idle'))
      audioRef.current = audio
    }
    void audioRef.current.play()
    setState('playing')
  }

  return (
    <button
      className={cn(
        'inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded hover:bg-raised',
        state === 'error' ? 'text-danger' : state === 'playing' ? 'text-accent' : 'text-muted'
      )}
      title={state === 'error' ? 'Playback failed' : `Play ${label} channel`}
      onClick={() => void toggle()}
    >
      {state === 'playing' ? <Pause size={10} /> : <Play size={10} />}
      {label}
    </button>
  )
}

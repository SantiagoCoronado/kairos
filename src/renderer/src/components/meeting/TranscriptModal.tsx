import { useEffect, useRef, useState } from 'react'
import { Copy, Pause, Play, X } from 'lucide-react'
import type { Meeting, MeetingTranscript } from '../../../../core/types'
import { api } from '../../lib/api'
import { fmtMeetingDuration, fmtElapsed } from '../../lib/meeting-ui'
import { Button, cn } from '../ui'

/** Full transcript: Me/Them attribution with timestamps; clicking a
 *  segment seeks the recording. Playback keeps the two channel archives
 *  (mic + system) in sync — they were recorded simultaneously. */
export function TranscriptModal({
  meeting,
  transcript,
  onClose
}: {
  meeting: Meeting
  transcript: MeetingTranscript
  onClose: () => void
}): React.JSX.Element {
  const micRef = useRef<HTMLAudioElement | null>(null)
  const sysRef = useRef<HTMLAudioElement | null>(null)
  const [loading, setLoading] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [t, setT] = useState(0)
  const [audioError, setAudioError] = useState<string | null>(null)
  const audioGone = Boolean(meeting.audio_deleted_at) || (!meeting.mic_path && !meeting.system_path)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      micRef.current?.pause()
      sysRef.current?.pause()
    }
  }, [onClose])

  const ensureAudio = async (): Promise<HTMLAudioElement | null> => {
    if (micRef.current || sysRef.current) return micRef.current ?? sysRef.current
    setLoading(true)
    try {
      const load = async (channel: 'mic' | 'system'): Promise<HTMLAudioElement | null> => {
        const res = await api.invoke('meetings:audioData', meeting.id, channel)
        return res.ok ? new Audio(res.dataUrl) : null
      }
      const [mic, sys] = await Promise.all([
        meeting.mic_path ? load('mic') : null,
        meeting.system_path ? load('system') : null
      ])
      if (!mic && !sys) {
        setAudioError('Audio unavailable.')
        return null
      }
      micRef.current = mic
      sysRef.current = sys
      const master = mic ?? sys!
      master.addEventListener('timeupdate', () => setT(master.currentTime))
      master.addEventListener('ended', () => setPlaying(false))
      return master
    } finally {
      setLoading(false)
    }
  }

  const each = (fn: (a: HTMLAudioElement) => void): void => {
    for (const a of [micRef.current, sysRef.current]) if (a) fn(a)
  }

  const toggle = async (): Promise<void> => {
    if (playing) {
      each((a) => a.pause())
      setPlaying(false)
      return
    }
    const master = await ensureAudio()
    if (!master) return
    each((a) => void a.play())
    setPlaying(true)
  }

  const seekTo = async (seconds: number): Promise<void> => {
    const master = await ensureAudio()
    if (!master) return
    each((a) => {
      a.currentTime = seconds
    })
    setT(seconds)
    each((a) => void a.play())
    setPlaying(true)
  }

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
              <span
                className={cn(
                  'shrink-0 w-10 text-[10.5px] font-mono uppercase tracking-wide pt-0.5',
                  s.channel === 'me' ? 'text-accent' : 'text-muted'
                )}
              >
                {s.channel === 'me' ? 'me' : 'them'}
              </span>
              <span className="text-[12.5px] text-text leading-5">{s.text}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

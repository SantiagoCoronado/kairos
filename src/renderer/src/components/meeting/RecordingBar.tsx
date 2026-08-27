import { useEffect, useState } from 'react'
import { Pause, Play, Square, X } from 'lucide-react'
import {
  cancelStarting,
  dismissError,
  pauseRecording,
  resumeRecording,
  splitCaptureError,
  stopRecording,
  useMeetingRecording
} from '../../lib/meeting-store'
import { fmtElapsed, recordedMs } from '../../lib/meeting-ui'
import { LevelMeter } from './LevelMeter'
import { cn } from '../ui'

/** Recording banner — a full-width band at the top of the main column
 *  while a meeting captures, in every view. It lives IN the column (not
 *  floating over it) so it can never sit under the titlebar drag strip:
 *  the old chip did, and its Stop button dragged the window instead.
 *  `no-drag` carves it out of the native drag region for the same reason. */
export function RecordingBar(): React.JSX.Element | null {
  const rec = useMeetingRecording()
  const [nowMs, setNowMs] = useState(() => Date.now())

  const ticking = rec.phase === 'recording' && rec.pausedAtMs === null
  useEffect(() => {
    if (!ticking) return undefined
    setNowMs(Date.now())
    const iv = setInterval(() => setNowMs(Date.now()), 1000)
    return () => clearInterval(iv)
  }, [ticking])

  if (rec.phase === 'idle') return null

  // capture is being negotiated (permission prompts included) — the user
  // must see that something is happening, and be able to back out of it
  if (rec.phase === 'starting') {
    return (
      <Band tone="danger">
        <Dot pulse />
        <StateText>Starting capture…</StateText>
        <span className="text-[11.5px] text-muted truncate">
          answer the microphone prompt if macOS shows one
        </span>
        <div className="flex-1" />
        <BarButton onClick={cancelStarting} title="Cancel starting">
          <X size={12} /> Cancel
        </BarButton>
      </Band>
    )
  }

  if (rec.phase === 'error') {
    // the hint is the one thing the user can act on — it gets its own line
    // instead of vanishing behind a truncated headline
    const { headline, hint } = splitCaptureError(rec.message)
    return (
      <Band tone="danger" align="start">
        <div className="min-w-0 flex-1 text-[12px] leading-snug py-0.5">
          <div role="status" aria-live="polite" className="text-danger break-words">
            {headline}
          </div>
          {hint && <div className="text-muted break-words mt-0.5">{hint}</div>}
        </div>
        <BarButton onClick={dismissError} title="Dismiss">
          <X size={12} /> Dismiss
        </BarButton>
      </Band>
    )
  }

  if (rec.phase === 'stopping') {
    return (
      <Band tone="danger">
        <Dot />
        <StateText>Saving recording…</StateText>
      </Band>
    )
  }

  const paused = rec.pausedAtMs !== null
  const title = rec.title.trim()
  return (
    <Band tone={paused ? 'accent' : 'danger'}>
      <Dot pulse={!paused} tone={paused ? 'accent' : 'danger'} />
      <StateText className={paused ? 'text-accent' : 'text-danger'}>
        {paused ? 'Paused' : 'Recording'}
      </StateText>
      {title && (
        <span className="text-[12px] text-muted truncate min-w-0" title={title}>
          {title}
        </span>
      )}
      <span className="text-[12px] text-text tabular-nums shrink-0">
        {fmtElapsed(recordedMs(rec, nowMs))}
      </span>
      {/* live input per channel — the proof we're actually hearing both
          sides, not just that a recorder exists. Incompressible (~330px),
          so a narrow column drops them rather than overflowing the band:
          the title is the only thing that can shrink. */}
      <span
        className={cn(
          'hidden @min-[760px]:inline-flex items-center gap-3 ml-1',
          paused ? 'text-accent/60' : 'text-danger'
        )}
      >
        <LevelMeter channel="mic" label="you" active={!paused} />
        <LevelMeter channel="system" label="them" active={!paused} />
      </span>
      <div className="flex-1" />
      {paused ? (
        <BarButton onClick={() => void resumeRecording()} title="Resume recording">
          <Play size={12} fill="currentColor" /> Resume
        </BarButton>
      ) : (
        <BarButton onClick={() => void pauseRecording()} title="Pause recording">
          <Pause size={12} fill="currentColor" /> Pause
        </BarButton>
      )}
      <BarButton onClick={() => void stopRecording()} title="Stop and save the recording" danger>
        <Square size={11} fill="currentColor" /> Stop
      </BarButton>
    </Band>
  )
}

function Band({
  tone,
  align = 'center',
  children
}: {
  tone: 'danger' | 'accent'
  align?: 'center' | 'start'
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      className={cn(
        // in flow, so it never hides under (or steals clicks from) the
        // column's absolute drag strip; `no-drag` carves it out of the
        // native drag region; z above every modal scrim (z-50) and the
        // toast stack (z-60) — a hot mic stays visible with Settings or
        // the command palette open
        'no-drag @container relative z-[70] shrink-0 flex gap-2.5 px-4 py-1.5 border-b',
        align === 'center' ? 'items-center' : 'items-start',
        tone === 'danger' ? 'bg-danger/10 border-danger/30' : 'bg-accent/10 border-accent/30'
      )}
    >
      {children}
    </div>
  )
}

/** the one thing assistive tech should hear change: Recording → Paused →
 *  Saving. The ticking clock lives outside it, or a screen reader would
 *  announce every second of the meeting. */
function StateText({
  className,
  children
}: {
  className?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <span role="status" aria-live="polite" className={cn('text-[12px] font-medium text-text', className)}>
      {children}
    </span>
  )
}

function Dot({
  pulse = false,
  tone = 'danger'
}: {
  pulse?: boolean
  tone?: 'danger' | 'accent'
}): React.JSX.Element {
  return (
    <span
      className={cn(
        'w-2.5 h-2.5 rounded-full shrink-0',
        tone === 'danger' ? 'bg-danger' : 'bg-accent',
        pulse && 'animate-pulse'
      )}
    />
  )
}

function BarButton({
  danger = false,
  className,
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { danger?: boolean }): React.JSX.Element {
  return (
    <button
      type="button"
      className={cn(
        'shrink-0 inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11.5px] transition-colors',
        danger
          ? 'border-danger/40 text-danger hover:bg-danger/15'
          : 'border-border-strong text-text hover:bg-raised',
        className
      )}
      {...props}
    >
      {children}
    </button>
  )
}

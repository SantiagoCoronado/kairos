import { useEffect, useState } from 'react'
import { Square, X } from 'lucide-react'
import {
  dismissError,
  stopRecording,
  useMeetingRecording
} from '../../lib/meeting-store'
import { fmtElapsed } from '../../lib/meeting-ui'
import { cn } from '../ui'

/** Global recording indicator — floats top-right in every view while a
 *  meeting records (the user must never wonder whether the mic is live). */
export function RecordingChip(): React.JSX.Element | null {
  const rec = useMeetingRecording()
  const [nowMs, setNowMs] = useState(() => Date.now())

  useEffect(() => {
    if (rec.phase !== 'recording') return undefined
    const iv = setInterval(() => setNowMs(Date.now()), 1000)
    return () => clearInterval(iv)
  }, [rec.phase])

  if (rec.phase === 'idle' || rec.phase === 'starting') return null

  if (rec.phase === 'error') {
    return (
      <div className="fixed top-3 right-4 z-[60] flex items-center gap-2 bg-overlay border border-border-strong rounded-full pl-3 pr-1.5 py-1 shadow-lg">
        <span className="text-[11.5px] text-danger max-w-72 truncate" title={rec.message}>
          {rec.message}
        </span>
        <button
          className="text-faint hover:text-text p-0.5"
          onClick={dismissError}
          title="Dismiss"
        >
          <X size={12} />
        </button>
      </div>
    )
  }

  const stopping = rec.phase === 'stopping'
  return (
    <div className="fixed top-3 right-4 z-[60] flex items-center gap-2 bg-overlay border border-border-strong rounded-full pl-3 pr-1.5 py-1 shadow-lg">
      <span
        className={cn(
          'w-2 h-2 rounded-full bg-danger',
          !stopping && 'animate-pulse'
        )}
      />
      <span className="text-[11.5px] text-text tabular-nums">
        {stopping ? 'Saving…' : fmtElapsed(nowMs - rec.startedAtMs)}
      </span>
      {!stopping && (
        <button
          className="text-faint hover:text-danger p-0.5"
          onClick={() => void stopRecording()}
          title="Stop recording"
        >
          <Square size={12} fill="currentColor" />
        </button>
      )}
    </div>
  )
}

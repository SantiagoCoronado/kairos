import { useEffect, useState } from 'react'
import { CheckCircle2, Circle, RefreshCw, X } from 'lucide-react'
import type { Meeting } from '../../../../core/types'
import { api, useInvoke } from '../../lib/api'
import { fmtMeetingDuration } from '../../lib/meeting-ui'
import { Markdown } from '../Markdown'
import { Button, Chip, cn } from '../ui'

/** Structured meeting summary: prose (markdown), decisions, action items
 *  with live task state (they were fanned out as real tasks), participants.
 *  Re-summarize regenerates the text only — fan-out never repeats. */
export function SummaryModal({
  meeting,
  onClose
}: {
  meeting: Meeting
  onClose: () => void
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // live view of the fanned-out tasks (done state updates as you work them)
  const { data: allTasks } = useInvoke('tasks:list', [{}], ['tasks'])
  const meetingTasks = new Map(
    (allTasks ?? []).filter((t) => t.meeting_id === meeting.id).map((t) => [t.id, t])
  )
  const { data: fresh } = useInvoke('meetings:get', [meeting.id], ['meetings'])
  const m = fresh?.meeting ?? meeting

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const resummarize = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    const res = await api.invoke('meetings:summarize', m.id, true)
    setBusy(false)
    if (!res.ok) setError(res.message)
  }

  const started = new Date(m.started_at)

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center"
      onMouseDown={onClose}
    >
      <div
        className="w-[560px] max-w-[95vw] max-h-[85vh] bg-overlay border border-border-strong rounded-xl shadow-2xl flex flex-col overflow-hidden"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between px-5 pt-4 pb-3 border-b border-border shrink-0">
          <div className="min-w-0">
            <h2 className="text-[14px] text-text font-medium truncate">
              {m.title || 'Meeting summary'}
            </h2>
            <p className="text-[11px] text-faint">
              {started.toLocaleString(undefined, {
                weekday: 'short',
                month: 'short',
                day: 'numeric',
                hour: 'numeric',
                minute: '2-digit'
              })}
              {m.duration_seconds != null && ` · ${fmtMeetingDuration(m.duration_seconds)}`}
            </p>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <Button
              variant="ghost"
              className="!px-2 !py-1 text-[11.5px]"
              disabled={busy}
              title="Regenerate the summary (tasks and interactions are not re-created)"
              onClick={() => void resummarize()}
            >
              <span className="inline-flex items-center gap-1">
                <RefreshCw size={11} className={cn(busy && 'animate-spin')} />
                {busy ? 'summarizing…' : 're-summarize'}
              </span>
            </Button>
            <button onClick={onClose} className="text-faint hover:text-text ml-1">
              <X size={15} />
            </button>
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-4">
          {error && <p className="text-[11.5px] text-danger">{error}</p>}
          {m.summary_md ? (
            <Markdown text={m.summary_md} />
          ) : (
            <p className="text-[12px] text-faint">No summary yet.</p>
          )}

          {m.summary.decisions.length > 0 && (
            <div className="space-y-1">
              <span className="font-mono text-[10px] uppercase tracking-wider text-faint">
                decisions
              </span>
              {m.summary.decisions.map((d, i) => (
                <p key={i} className="text-[12.5px] text-text leading-5">
                  · {d}
                </p>
              ))}
            </div>
          )}

          {m.summary.action_items.length > 0 && (
            <div className="space-y-1">
              <span className="font-mono text-[10px] uppercase tracking-wider text-faint">
                action items
              </span>
              {m.summary.action_items.map((it, i) => {
                const task = it.task_id ? meetingTasks.get(it.task_id) : undefined
                const done = task?.status === 'done'
                return (
                  <div key={i} className="flex items-start gap-1.5 text-[12.5px] leading-5">
                    {done ? (
                      <CheckCircle2 size={13} className="shrink-0 mt-1 text-ok" />
                    ) : (
                      <Circle size={13} className="shrink-0 mt-1 text-faint" />
                    )}
                    <span className={cn('text-text', done && 'line-through text-muted')}>
                      {it.text}
                    </span>
                    {task?.person_id && <Chip tone="muted">assigned</Chip>}
                    {!it.task_id && <Chip tone="muted">no task</Chip>}
                  </div>
                )
              })}
            </div>
          )}

          {m.summary.participants.length > 0 && (
            <div className="space-y-1">
              <span className="font-mono text-[10px] uppercase tracking-wider text-faint">
                participants
              </span>
              <p className="text-[12px] text-muted">{m.summary.participants.join(' · ')}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

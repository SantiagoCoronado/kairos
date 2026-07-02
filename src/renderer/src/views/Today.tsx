import { CalendarDays } from 'lucide-react'
import type { Task } from '../../../core/types'
import { api, useInvoke } from '../lib/api'
import { Chip, EmptyState, cn } from '../components/ui'
import { ProgressBar } from './Objectives'

export function TodayView({
  onOpenPerson
}: {
  onOpenPerson: (id: string) => void
}): React.JSX.Element {
  const { data: agenda } = useInvoke(
    'today:get',
    [],
    ['tasks', 'people', 'interactions', 'objectives']
  )
  const { data: calendar } = useInvoke('calendar:today', [], [])

  const dateLabel = new Date().toLocaleDateString(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric'
  })

  const nothingDue =
    agenda &&
    agenda.overdue_tasks.length === 0 &&
    agenda.due_today_tasks.length === 0 &&
    agenda.followups.length === 0

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      <div>
        <h1 className="text-lg font-medium">{dateLabel}</h1>
        <p className="text-[12px] text-faint font-mono mt-0.5">
          {agenda
            ? `${agenda.overdue_tasks.length} overdue · ${agenda.due_today_tasks.length} due today · ${agenda.followups.length} follow-ups`
            : '…'}
        </p>
      </div>

      {calendar && 'events' in calendar && calendar.events.length > 0 && (
        <Section title="calendar">
          {calendar.events.map((e, i) => (
            <div key={i} className="flex items-center gap-3 py-1.5">
              <CalendarDays size={13} className="text-faint shrink-0" />
              <span className="font-mono text-[11px] text-muted w-24 shrink-0">
                {e.allDay
                  ? 'all day'
                  : new Date(e.start).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit'
                    })}
              </span>
              <span className="text-[13px] truncate">{e.title}</span>
              <span className="text-[11px] text-faint truncate">{e.calendar}</span>
            </div>
          ))}
        </Section>
      )}

      {nothingDue && <EmptyState>Clear runway. Nothing due today.</EmptyState>}

      {agenda && agenda.overdue_tasks.length > 0 && (
        <Section title="overdue" tone="danger">
          {agenda.overdue_tasks.map((t) => (
            <TaskLine key={t.id} task={t} showDue />
          ))}
        </Section>
      )}

      {agenda && agenda.due_today_tasks.length > 0 && (
        <Section title="due today">
          {agenda.due_today_tasks.map((t) => (
            <TaskLine key={t.id} task={t} />
          ))}
        </Section>
      )}

      {agenda && agenda.followups.length > 0 && (
        <Section title="follow-ups due">
          {agenda.followups.map((f) => (
            <div key={f.id} className="flex items-center gap-2.5 py-1.5">
              <button
                onClick={() => onOpenPerson(f.id)}
                className="text-[13px] hover:text-accent text-left"
              >
                {f.name}
              </button>
              <Chip tone={f.days_overdue > 7 ? 'danger' : 'accent'}>
                {f.days_since}d since last touch
              </Chip>
              <div className="flex-1" />
              <button
                className="font-mono text-[10.5px] text-faint hover:text-muted"
                onClick={() => {
                  const d = new Date()
                  d.setDate(d.getDate() + 7)
                  void api.invoke('followups:snooze', f.id, d.toISOString().slice(0, 10))
                }}
              >
                snooze 1w
              </button>
            </div>
          ))}
        </Section>
      )}

      {agenda && agenda.objectives.length > 0 && (
        <Section title="objectives">
          <div className="space-y-2.5 pt-1">
            {agenda.objectives.map((o) => (
              <div key={o.id} className="space-y-1">
                <div className="flex items-center justify-between">
                  <span className="text-[12.5px]">{o.title}</span>
                  <span className="font-mono text-[10.5px] text-faint">
                    {Math.round(o.progress * 100)}%
                  </span>
                </div>
                <ProgressBar value={o.progress} thin />
              </div>
            ))}
          </div>
        </Section>
      )}
    </div>
  )
}

function Section({
  title,
  tone,
  children
}: {
  title: string
  tone?: 'danger'
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="border border-border rounded-lg bg-panel px-4 py-3">
      <span
        className={cn(
          'font-mono text-[10px] uppercase tracking-[0.18em]',
          tone === 'danger' ? 'text-danger' : 'text-faint'
        )}
      >
        {title}
      </span>
      <div className="mt-1">{children}</div>
    </div>
  )
}

function TaskLine({ task: t, showDue }: { task: Task; showDue?: boolean }): React.JSX.Element {
  return (
    <div className="flex items-center gap-2.5 py-1.5">
      <button
        className="text-muted hover:text-ok"
        onClick={() => void api.invoke('tasks:update', t.id, { status: 'done' })}
      >
        ○
      </button>
      <span className="text-[13px] flex-1 truncate">{t.title}</span>
      {t.priority === 1 && <Chip tone="danger">P1</Chip>}
      <Chip tone={t.area === 'work' ? 'accent' : 'muted'}>{t.area}</Chip>
      {showDue && t.due_date && (
        <span className="font-mono text-[10.5px] text-danger">{t.due_date}</span>
      )}
    </div>
  )
}

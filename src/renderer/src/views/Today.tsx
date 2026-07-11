import { useEffect, useRef, useState } from 'react'
import { CalendarDays, RefreshCw, Sparkles } from 'lucide-react'
import type { ClaudeLimits } from '../../../shared/ipc-contract'
import type { Task } from '../../../core/types'
import { api, useInvoke } from '../lib/api'
import { Chip, EmptyState, cn } from '../components/ui'
import { PushBell } from '../components/PushBell'
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
  const { data: settings } = useInvoke('settings:get', [], ['settings'])
  const { data: usage, reload: reloadUsage } = useInvoke('usage:claudeToday', [], [])
  const { data: stats, reload: reloadStats } = useInvoke('usage:claudeStats', [], [])
  const { data: limits, reload: reloadLimits } = useInvoke('usage:claudeLimits', [], [])

  const [syncing, setSyncing] = useState(false)
  const resyncUsage = (): void => {
    setSyncing(true)
    reloadUsage()
    reloadStats()
    reloadLimits()
    setTimeout(() => setSyncing(false), 600)
  }

  // usage comes from files on disk / the network, not the db — timer refresh
  useEffect(() => {
    const t = setInterval(() => {
      reloadUsage()
      reloadStats()
      reloadLimits()
    }, 60_000)
    return () => clearInterval(t)
  }, [reloadUsage, reloadStats, reloadLimits])

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
    <div className="p-4 md:p-6 max-w-3xl mx-auto space-y-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-medium">{dateLabel}</h1>
          <p className="text-[12px] text-faint font-mono mt-0.5">
            {agenda
              ? `${agenda.overdue_tasks.length} overdue · ${agenda.due_today_tasks.length} due today · ${agenda.followups.length} follow-ups`
              : '…'}
          </p>
        </div>
        {/* remote-only: enable web push on this device (renders null elsewhere) */}
        <PushBell />
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
              {/* phone width is for the event + time; calendar attribution is desktop-only */}
              <span className="text-[11px] text-faint truncate hidden md:inline">{e.calendar}</span>
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

      {settings?.showClaudeUsage && usage && usage.messages > 0 && (
        <Section
          title="claude usage"
          action={
            <button
              onClick={resyncUsage}
              title="Resync usage"
              className="text-faint hover:text-muted -my-1 p-1"
            >
              <RefreshCw size={12} className={syncing ? 'animate-spin' : ''} />
            </button>
          }
        >
          <div className="flex items-center gap-3 py-1.5">
            <Sparkles size={13} className="text-faint shrink-0" />
            <span className="text-[13px]">
              <span className="text-faint">today</span> · {fmtTokens(usage.totalTokens)} tokens
              {usage.costUsd > 0 && (
                <span className="text-muted">
                  {' '}
                  · {usage.costIsPartial ? '>' : '~'}${usage.costUsd.toFixed(2)}
                </span>
              )}
            </span>
            <div className="flex-1" />
            <span className="font-mono text-[10.5px] text-faint">
              {usage.messages} msgs · {usage.sessions} session{usage.sessions === 1 ? '' : 's'}
            </span>
          </div>

          {stats && stats.messages > 0 && (
            <>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-1.5 mt-2">
                {[
                  ['sessions', stats.sessions.toLocaleString()],
                  ['messages', stats.messages.toLocaleString()],
                  ['total tokens', fmtTokens(stats.totalTokens)],
                  ['active days', String(stats.activeDays)],
                  ['current streak', `${stats.currentStreak}d`],
                  ['longest streak', `${stats.longestStreak}d`],
                  ['peak hour', stats.peakHour === null ? '—' : fmtHour(stats.peakHour)],
                  ['favorite model', prettyModel(stats.favoriteModel)]
                ].map(([label, value]) => (
                  <div key={label} className="bg-raised/60 rounded-md px-2.5 py-2 min-w-0">
                    <div className="font-mono text-[9.5px] uppercase tracking-wider text-faint truncate">
                      {label}
                    </div>
                    <div className="text-[14px] font-medium mt-0.5 truncate">{value}</div>
                  </div>
                ))}
              </div>

              <div className="flex flex-col gap-4 md:flex-row md:items-end md:gap-5 mt-3">
                <LimitBars limits={limits ?? null} />
                {/* a year of week-columns is ~700px wide — scroll it on phones */}
                <div className="max-w-full overflow-x-auto">
                  <UsageHeatmap days={stats.days} />
                </div>
              </div>

              {stats.totalTokens > GATSBY_TOKENS * 2 && (
                <p className="text-[11px] text-faint mt-2">
                  You&apos;ve used ~{Math.round(stats.totalTokens / GATSBY_TOKENS).toLocaleString()}
                  × more tokens than The Great Gatsby.
                </p>
              )}
            </>
          )}
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

function fmtTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`
  return String(n)
}

/** ≈ token count of The Great Gatsby (~47k words) */
const GATSBY_TOKENS = 62_000

function fmtHour(h: number): string {
  const ampm = h < 12 ? 'AM' : 'PM'
  const hh = h % 12 === 0 ? 12 : h % 12
  return `${hh} ${ampm}`
}

function prettyModel(model: string | null): string {
  if (!model) return '—'
  const parts = model
    .replace(/^claude-/, '')
    .replace(/-\d{8}$/, '') // trailing snapshot date
    .split('-')
  const name = parts[0].charAt(0).toUpperCase() + parts[0].slice(1)
  const version = parts.slice(1).join('.')
  return version ? `${name} ${version}` : name
}

/** rate-limit windows: how much of each budget is used, and when it resets */
function LimitBars({ limits }: { limits: ClaudeLimits | null }): React.JSX.Element {
  if (!limits) {
    return (
      <div className="flex-1 min-w-0 self-center text-[11px] text-faint">
        usage limits unavailable — is Claude Code logged in?
      </div>
    )
  }
  return (
    <div className="flex-1 min-w-0 space-y-2.5">
      {limits.buckets.map((b) => {
        const pct = Math.max(0, Math.min(100, b.utilization))
        return (
          <div key={b.key}>
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-mono text-[9.5px] uppercase tracking-wider text-faint truncate">
                {b.label}
              </span>
              <span
                className={`font-mono text-[10.5px] shrink-0 ${pct >= 80 ? 'text-danger' : 'text-muted'}`}
              >
                {Math.round(pct)}% used
              </span>
            </div>
            <div className="h-[5px] rounded-full bg-raised mt-1 overflow-hidden">
              <div
                className={`h-full rounded-full ${pct >= 80 ? 'bg-danger' : 'bg-accent'}`}
                style={{ width: `${pct}%` }}
              />
            </div>
            {b.resetsAt && (
              <div className="text-[10px] text-faint mt-0.5">resets {fmtReset(b.resetsAt)}</div>
            )}
          </div>
        )
      })}
    </div>
  )
}

function fmtReset(iso: string): string {
  const d = new Date(iso)
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  return d.toDateString() === new Date().toDateString()
    ? time
    : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`
}

/** GitHub-style activity grid: columns are weeks, rows Mon–Sun */
function UsageHeatmap({ days }: { days: { date: string; tokens: number }[] }): React.JSX.Element {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null)

  // intensity thresholds from the quartiles of non-zero days
  const nz = days
    .filter((d) => d.tokens > 0)
    .map((d) => d.tokens)
    .sort((a, b) => a - b)
  const q = (p: number): number => (nz.length ? nz[Math.min(nz.length - 1, Math.floor(p * nz.length))] : 0)
  const [t1, t2, t3] = [q(0.25), q(0.5), q(0.75)]
  const level = (n: number): number => (n === 0 ? 0 : n <= t1 ? 1 : n <= t2 ? 2 : n <= t3 ? 3 : 4)
  const cls = ['bg-raised/70', 'bg-accent/25', 'bg-accent/45', 'bg-accent/70', 'bg-accent']
  const weeks: { date: string; tokens: number }[][] = []
  for (let i = 0; i < days.length; i += 7) weeks.push(days.slice(i, i + 7))

  const showTip = (e: React.MouseEvent<HTMLDivElement>, d: { date: string; tokens: number }): void => {
    const cell = e.currentTarget.getBoundingClientRect()
    const wrap = wrapRef.current!.getBoundingClientRect()
    const day = new Date(`${d.date}T12:00:00`)
    const label = day.toLocaleDateString([], { month: 'short', day: 'numeric' })
    setTip({
      x: cell.left - wrap.left + cell.width / 2,
      y: cell.top - wrap.top,
      text: `${label} — ${d.tokens === 0 ? 'no usage' : `${fmtTokens(d.tokens)} tokens`}`
    })
  }

  return (
    <div ref={wrapRef} className="relative shrink-0">
      <div className="flex gap-[3px]" onMouseLeave={() => setTip(null)}>
        {weeks.map((w, i) => (
          <div key={i} className="flex flex-col gap-[3px]">
            {w.map((d) => (
              <div
                key={d.date}
                className={`w-[11px] h-[11px] rounded-[2.5px] ${cls[level(d.tokens)]}`}
                onMouseEnter={(e) => showTip(e, d)}
              />
            ))}
          </div>
        ))}
      </div>
      {tip && (
        <div
          className="absolute z-10 -translate-x-1/2 -translate-y-full pointer-events-none whitespace-nowrap rounded-md bg-overlay border border-border-strong px-2 py-0.5 text-[11px] text-text shadow-lg"
          style={{ left: tip.x, top: tip.y - 5 }}
        >
          {tip.text}
        </div>
      )}
    </div>
  )
}

function Section({
  title,
  tone,
  action,
  children
}: {
  title: string
  tone?: 'danger'
  action?: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="border border-border rounded-lg bg-panel px-4 py-3">
      <div className="flex items-center justify-between">
        <span
          className={cn(
            'font-mono text-[10px] uppercase tracking-[0.18em]',
            tone === 'danger' ? 'text-danger' : 'text-faint'
          )}
        >
          {title}
        </span>
        {action}
      </div>
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

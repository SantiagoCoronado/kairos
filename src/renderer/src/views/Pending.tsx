import { useEffect, useState } from 'react'
import { AudioLines, Bot, CheckSquare, Inbox, Send, StickyNote, Users } from 'lucide-react'
import type { PendingItem, PendingKind } from '../../../core/types'
import { localDate } from '../../../core/ids'
import type { ViewId } from '../components/Sidebar'
import { api, useInvoke } from '../lib/api'
import { pushUndo } from '../lib/undo'
import { toast } from '../lib/toast'
import { EmptyState, cn } from '../components/ui'

// The triage queue: everything Kairos knows needs attention, computed live in
// core/repo/pending.ts. Rows deep-link to the item's home view; snooze and
// dismiss are inbox-local (they never mutate the source), while each kind's
// leading action resolves the item the domain way.

const KIND_VIEW: Partial<Record<PendingKind, ViewId>> = {
  task: 'tasks',
  followup: 'people',
  reminder: 'notes',
  thread: 'inbox',
  outbox: 'inbox',
  agent_run: 'automations'
  // meeting rows route through onOpenCalendar (day focus), not a plain view
}

const KIND_ICON: Partial<Record<PendingKind, typeof CheckSquare>> = {
  task: CheckSquare,
  followup: Users,
  reminder: StickyNote,
  thread: Inbox,
  outbox: Send,
  meeting: AudioLines,
  agent_run: Bot
}

/** failures first — a failed send outranks a due task */
const SECTIONS: { kind: PendingKind; title: string }[] = [
  { kind: 'outbox', title: 'sends' },
  { kind: 'task', title: 'tasks due' },
  { kind: 'followup', title: 'follow-ups' },
  { kind: 'reminder', title: 'reminders' },
  { kind: 'meeting', title: 'meetings' },
  { kind: 'agent_run', title: 'automation runs' },
  { kind: 'thread', title: 'unread' }
]

interface SnoozePreset {
  label: string
  until: Date
}

/** Follow-up snooze is date-granular (people.snoozed_until), so sub-day
 *  presets are meaningless there — dayOnly filters them out. */
function snoozePresets(now: Date, dayOnly: boolean): SnoozePreset[] {
  const at = (d: Date, h: number): Date => {
    const x = new Date(d)
    x.setHours(h, 0, 0, 0)
    return x
  }
  const addDays = (n: number): Date => {
    const x = new Date(now)
    x.setDate(x.getDate() + n)
    return x
  }
  const presets: SnoozePreset[] = []
  if (!dayOnly) {
    presets.push({ label: '1 hour', until: new Date(now.getTime() + 60 * 60 * 1000) })
    const evening = at(now, 18)
    if (evening.getTime() > now.getTime() + 30 * 60 * 1000)
      presets.push({ label: 'this evening', until: evening })
  }
  presets.push({ label: 'tomorrow', until: at(addDays(1), 9) })
  const monday = new Date(now)
  monday.setDate(monday.getDate() + (((8 - monday.getDay()) % 7) || 7))
  presets.push({ label: 'next week', until: at(monday, 9) })
  return presets
}

export function PendingView({
  onNavigate,
  onOpenPerson,
  onOpenCalendar
}: {
  onNavigate: (v: ViewId) => void
  onOpenPerson: (id: string) => void
  onOpenCalendar: (day: Date) => void
}): React.JSX.Element {
  const { data: payload, reload } = useInvoke(
    'pending:list',
    [],
    ['pending', 'tasks', 'people', 'interactions', 'notes', 'comms', 'meetings', 'agent_tasks']
  )
  const [snoozeKey, setSnoozeKey] = useState<string | null>(null)

  // due-ness moves with the clock even when nothing writes to the db — a
  // reminder crossing its remind_at must appear without a db:changed ping.
  // The same tick re-arms the active TTL (main expires it if we vanish
  // without the unmount cleanup — e.g. a remote client dropping).
  useEffect(() => {
    const t = setInterval(() => {
      reload()
      void api.invoke('pending:setViewActive', true)
    }, 60_000)
    return () => clearInterval(t)
  }, [reload])

  // what's on screen counts as seen (badge watermark) — both transitions
  useEffect(() => {
    void api.invoke('pending:setViewActive', true)
    return () => void api.invoke('pending:setViewActive', false)
  }, [])

  // a triage write can lose the race with the item resolving for real
  // (automation completes the task, sync marks the thread read) — 'not
  // pending' is the outcome the user wanted, so refresh instead of erroring
  const triage = (p: Promise<unknown>, done: () => void): void => {
    p.then(done).catch(() => reload())
  }

  const open = (item: PendingItem): void => {
    if (item.kind === 'followup') onOpenPerson(item.id)
    else if (item.kind === 'meeting') onOpenCalendar(item.at ? new Date(item.at) : new Date())
    else onNavigate(KIND_VIEW[item.kind] ?? 'today')
  }

  const retrySend = (item: PendingItem): void => {
    void api
      .invoke('comms:retryOutbox', item.id)
      .then((res) => {
        if (!res.ok)
          toast({ variant: 'error', text: 'Retry failed', detail: res.message, timeoutMs: 6000 })
      })
      .catch(() => reload())
  }

  const discardSend = (item: PendingItem): void => {
    // commit-style undo: the delete is deferred until the window closes,
    // so ⌘Z simply cancels it — nothing to resurrect
    pushUndo({
      label: 'Send discarded',
      commit: () => void api.invoke('comms:discardOutbox', item.id)
    })
  }

  const summarize = (item: PendingItem): void => {
    void api
      .invoke('meetings:summarize', item.id)
      .then((res) => {
        if (!res.ok)
          toast({ variant: 'error', text: 'Summarize failed', detail: res.message, timeoutMs: 6000 })
      })
      .catch(() => reload())
  }

  const dismiss = (item: PendingItem): void => {
    triage(api.invoke('pending:dismiss', item.key), () =>
      pushUndo({
        label: 'Dismissed — resurfaces if it renews',
        revert: () => void api.invoke('pending:undismiss', item.key)
      })
    )
  }

  const snooze = (item: PendingItem, preset: SnoozePreset): void => {
    setSnoozeKey(null)
    if (item.kind === 'followup') {
      // domain snooze: the People view shows the same parked state.
      // snoozed_until is a LOCAL day — never toISOString().slice
      triage(api.invoke('followups:snooze', item.id, localDate(preset.until)), () =>
        pushUndo({
          label: `Follow-up snoozed until ${preset.label}`,
          revert: () => void api.invoke('followups:clearSnooze', item.id)
        })
      )
      return
    }
    triage(api.invoke('pending:snooze', item.key, preset.until.toISOString()), () =>
      pushUndo({
        label: `Snoozed until ${preset.label}`,
        revert: () => void api.invoke('pending:unsnooze', item.key)
      })
    )
  }

  const completeTask = (item: PendingItem): void => {
    triage(api.invoke('tasks:update', item.id, { status: 'done' }), () =>
      pushUndo({
        label: 'Task completed',
        revert: () => void api.invoke('tasks:update', item.id, { status: 'todo' })
      })
    )
  }

  const clearReminder = (item: PendingItem): void => {
    const prev = item.at
    triage(api.invoke('notes:update', item.id, { remind_at: null }), () =>
      pushUndo({
        label: 'Reminder cleared',
        revert: () => void api.invoke('notes:update', item.id, { remind_at: prev })
      })
    )
  }

  return (
    <div className="p-4 md:p-6 max-w-3xl mx-auto space-y-6">
      <div>
        <h1 className="text-lg font-medium">Pending</h1>
        <p className="text-[12px] text-faint font-mono mt-0.5">
          {payload
            ? `${payload.total} thing${payload.total === 1 ? '' : 's'} need${payload.total === 1 ? 's' : ''} you`
            : '…'}
        </p>
      </div>

      {payload && payload.total === 0 && <EmptyState>Nothing needs you.</EmptyState>}

      {payload &&
        SECTIONS.map(({ kind, title }) => {
          const items = payload.items.filter((i) => i.kind === kind)
          // the thread section must survive having zero materialized rows as
          // long as the count says threads exist — the tail row is the way out
          const tail = kind === 'thread' && payload.more_threads > 0
          if (items.length === 0 && !tail) return null
          const Icon = KIND_ICON[kind] ?? CheckSquare
          return (
            <Section key={kind} title={title}>
              {items.map((item) => (
                <div key={item.key} className="relative flex items-center gap-3 py-1.5 group">
                  <Icon
                    size={13}
                    className={cn(
                      'shrink-0',
                      item.tone === 'danger'
                        ? 'text-danger'
                        : item.tone === 'accent'
                          ? 'text-accent'
                          : 'text-faint'
                    )}
                  />
                  <button
                    onClick={() => open(item)}
                    className="text-[13px] truncate min-w-0 hover:text-accent text-left"
                  >
                    {item.title}
                  </button>
                  <span className="text-[11px] text-faint truncate min-w-0 flex-1">
                    {item.subtitle}
                  </span>
                  <div className="shrink-0 items-center gap-2.5 hidden group-hover:flex">
                    {item.kind === 'task' && (
                      <RowAction onClick={() => completeTask(item)}>done</RowAction>
                    )}
                    {item.kind === 'reminder' && (
                      <RowAction onClick={() => clearReminder(item)}>clear</RowAction>
                    )}
                    {item.kind === 'outbox' &&
                      item.provider === 'whatsapp' &&
                      item.fingerprint.startsWith('failed') && (
                        <RowAction onClick={() => retrySend(item)}>retry</RowAction>
                      )}
                    {item.kind === 'outbox' && (
                      <RowAction onClick={() => discardSend(item)}>discard</RowAction>
                    )}
                    {item.kind === 'meeting' && item.tone === 'muted' && (
                      <RowAction onClick={() => summarize(item)}>summarize</RowAction>
                    )}
                    <RowAction onClick={() => setSnoozeKey(item.key)}>snooze</RowAction>
                    <RowAction onClick={() => dismiss(item)}>dismiss</RowAction>
                  </div>
                  {snoozeKey === item.key && (
                    <>
                      <div className="fixed inset-0 z-10" onClick={() => setSnoozeKey(null)} />
                      <div className="absolute right-0 top-7 z-20 min-w-32 bg-overlay border border-border-strong rounded-md shadow-lg p-1">
                        {snoozePresets(new Date(), item.kind === 'followup').map((p) => (
                          <button
                            key={p.label}
                            onClick={() => snooze(item, p)}
                            className="w-full text-left px-2.5 py-1.5 rounded text-[12px] text-muted hover:text-text hover:bg-raised"
                          >
                            {p.label}
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              ))}
              {tail && (
                <button
                  onClick={() => onNavigate('inbox')}
                  className="font-mono text-[10.5px] text-faint hover:text-muted py-1.5"
                >
                  {payload.more_threads} more in Inbox →
                </button>
              )}
            </Section>
          )
        })}
    </div>
  )
}

function RowAction({
  onClick,
  children
}: {
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button onClick={onClick} className="font-mono text-[10.5px] text-faint hover:text-muted">
      {children}
    </button>
  )
}

function Section({
  title,
  children
}: {
  title: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="border border-border rounded-lg bg-panel px-4 py-3">
      <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-faint">{title}</span>
      <div className="mt-1">{children}</div>
    </div>
  )
}

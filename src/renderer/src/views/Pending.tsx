import { useEffect } from 'react'
import { CheckSquare, Inbox, StickyNote, Users } from 'lucide-react'
import type { PendingItem, PendingKind } from '../../../core/types'
import type { ViewId } from '../components/Sidebar'
import { useInvoke } from '../lib/api'
import { EmptyState, cn } from '../components/ui'

// The triage queue: everything Kairos knows needs attention, computed live in
// core/repo/pending.ts. Rows deep-link to the item's home view — resolution
// (complete, reply, snooze) happens there; phase 2 adds inline triage.

const KIND_VIEW: Partial<Record<PendingKind, ViewId>> = {
  task: 'tasks',
  followup: 'people',
  reminder: 'notes',
  thread: 'inbox'
}

const KIND_ICON: Partial<Record<PendingKind, typeof CheckSquare>> = {
  task: CheckSquare,
  followup: Users,
  reminder: StickyNote,
  thread: Inbox
}

const SECTIONS: { kind: PendingKind; title: string }[] = [
  { kind: 'task', title: 'tasks due' },
  { kind: 'followup', title: 'follow-ups' },
  { kind: 'reminder', title: 'reminders' },
  { kind: 'thread', title: 'unread' }
]

export function PendingView({
  onNavigate,
  onOpenPerson
}: {
  onNavigate: (v: ViewId) => void
  onOpenPerson: (id: string) => void
}): React.JSX.Element {
  const { data: payload, reload } = useInvoke(
    'pending:list',
    [],
    ['pending', 'tasks', 'people', 'interactions', 'notes', 'comms']
  )

  // due-ness moves with the clock even when nothing writes to the db — a
  // reminder crossing its remind_at must appear without a db:changed ping
  useEffect(() => {
    const t = setInterval(reload, 60_000)
    return () => clearInterval(t)
  }, [reload])

  const open = (item: PendingItem): void => {
    if (item.kind === 'followup') onOpenPerson(item.id)
    else onNavigate(KIND_VIEW[item.kind] ?? 'today')
  }

  return (
    <div className="p-4 md:p-6 max-w-3xl mx-auto space-y-6">
      <div>
        <h1 className="text-lg font-medium">Pending</h1>
        <p className="text-[12px] text-faint font-mono mt-0.5">
          {payload ? `${payload.total} thing${payload.total === 1 ? '' : 's'} need${payload.total === 1 ? 's' : ''} you` : '…'}
        </p>
      </div>

      {payload && payload.items.length === 0 && <EmptyState>Nothing needs you.</EmptyState>}

      {payload &&
        SECTIONS.map(({ kind, title }) => {
          const items = payload.items.filter((i) => i.kind === kind)
          if (items.length === 0) return null
          const Icon = KIND_ICON[kind] ?? CheckSquare
          return (
            <Section key={kind} title={title}>
              {items.map((item) => (
                <button
                  key={item.key}
                  onClick={() => open(item)}
                  className="w-full flex items-center gap-3 py-1.5 text-left group"
                >
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
                  <span className="text-[13px] truncate group-hover:text-accent">
                    {item.title}
                  </span>
                  <span className="text-[11px] text-faint truncate min-w-0 flex-1">
                    {item.subtitle}
                  </span>
                </button>
              ))}
              {kind === 'thread' && payload.more_threads > 0 && (
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

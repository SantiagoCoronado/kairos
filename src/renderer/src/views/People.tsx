import { useEffect, useMemo, useState } from 'react'
import { Archive, ArchiveRestore, BellOff, Plus, Trash2, Unlink, X } from 'lucide-react'
import type { Person, Area, InteractionKind, FollowupDue } from '../../../core/types'
import { api, useInvoke } from '../lib/api'
import { Input, Button, Select, Chip, Segmented, EmptyState, InlineText, cn } from '../components/ui'

const KINDS: InteractionKind[] = ['coffee', 'call', 'message', 'email', 'meeting', 'other']

export function PeopleView({
  selectedId,
  onSelect
}: {
  selectedId: string | null
  onSelect: (id: string | null) => void
}): React.JSX.Element {
  const setSelectedId = onSelect
  const [search, setSearch] = useState('')
  const [area, setArea] = useState<Area | 'all'>('all')
  const [newName, setNewName] = useState('')
  const [showArchived, setShowArchived] = useState(false)

  const { data: persons } = useInvoke(
    'people:list',
    [
      {
        search: search || undefined,
        area: area === 'all' ? undefined : area,
        archived: showArchived || undefined
      }
    ],
    ['people']
  )
  const { data: statuses } = useInvoke('followups:statuses', [], ['people', 'interactions'])

  const statusById = useMemo(() => {
    const m = new Map<string, FollowupDue>()
    statuses?.forEach((s) => m.set(s.id, s))
    return m
  }, [statuses])

  const addPerson = async (): Promise<void> => {
    const name = newName.trim()
    if (!name) return
    const p = await api.invoke('people:upsert', { name, area: area === 'all' ? 'personal' : area })
    setNewName('')
    setSelectedId(p.id)
  }

  return (
    <div className="flex h-full">
      <div className="w-72 shrink-0 border-r border-border flex flex-col">
        <div className="p-3 space-y-2 border-b border-border">
          <Input
            className="w-full"
            placeholder="Search people…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="flex items-center justify-between gap-2">
            <Segmented
              value={area}
              onChange={setArea}
              options={[
                { value: 'all', label: 'All' },
                { value: 'personal', label: 'Personal' },
                { value: 'work', label: 'Work' }
              ]}
            />
          </div>
          <div className="flex gap-1.5">
            <Input
              className="flex-1"
              placeholder="New person… (Enter)"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void addPerson()}
            />
            <Button variant="ghost" onClick={() => void addPerson()}>
              <Plus size={14} />
            </Button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          {persons?.length === 0 && (
            <EmptyState>{showArchived ? 'No archived people.' : 'No people yet.'}</EmptyState>
          )}
          {persons?.map((p) => {
            const st = statusById.get(p.id)
            return (
              <button
                key={p.id}
                onClick={() => setSelectedId(p.id)}
                className={cn(
                  'w-full text-left px-3 py-2 border-b border-border/50 hover:bg-raised/50',
                  selectedId === p.id && 'bg-raised'
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[13px] truncate">{p.name}</span>
                  {st && st.days_overdue >= 0 && (
                    <Chip tone="danger">{st.days_overdue}d over</Chip>
                  )}
                </div>
                <div className="flex items-center gap-1.5 mt-0.5">
                  {p.company && <span className="text-[11px] text-faint truncate">{p.company}</span>}
                  {st && st.days_overdue < 0 && (
                    <span className="font-mono text-[10px] text-faint">
                      due in {-st.days_overdue}d
                    </span>
                  )}
                </div>
              </button>
            )
          })}
        </div>
        <button
          onClick={() => {
            setShowArchived((v) => !v)
            setSelectedId(null)
          }}
          className={cn(
            'shrink-0 px-3 py-2 border-t border-border text-left font-mono text-[10.5px] uppercase tracking-wider',
            showArchived ? 'text-text bg-raised' : 'text-faint hover:text-text'
          )}
        >
          {showArchived ? '← back to people' : 'archived'}
        </button>
      </div>

      <div className="flex-1 min-w-0 overflow-y-auto">
        {selectedId ? (
          <PersonDetail id={selectedId} onGone={() => setSelectedId(null)} />
        ) : (
          <EmptyState>
            {showArchived ? 'Select an archived person.' : 'Select a person, or add someone new.'}
          </EmptyState>
        )}
      </div>
    </div>
  )
}

const SNOOZE_CHOICES: { label: string; days: number }[] = [
  { label: '1 day', days: 1 },
  { label: '3 days', days: 3 },
  { label: '1 week', days: 7 },
  { label: '2 weeks', days: 14 },
  { label: '1 month', days: 30 }
]

function PersonDetail({
  id,
  onGone
}: {
  id: string
  /** the person left this list (archived, unarchived, or deleted) — drop selection */
  onGone: () => void
}): React.JSX.Element {
  const { data: detail } = useInvoke('people:detail', [id], ['people', 'interactions', 'tasks'])
  const { data: identities } = useInvoke('people:identities', [id], ['comms', 'people'])
  const [kind, setKind] = useState<InteractionKind>('coffee')
  const [summary, setSummary] = useState('')
  const [snoozeOpen, setSnoozeOpen] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  // the armed delete button disarms itself if not confirmed quickly
  useEffect(() => {
    if (!confirmDelete) return undefined
    const t = setTimeout(() => setConfirmDelete(false), 3000)
    return () => clearTimeout(t)
  }, [confirmDelete])

  if (!detail) return <EmptyState>Loading…</EmptyState>
  const { person, interactions, open_tasks } = detail
  const archived = person.archived_at !== null

  const patch = (fields: Partial<Person>): void => {
    void api.invoke('people:upsert', { id: person.id, name: person.name, ...fields })
  }

  const logIt = async (): Promise<void> => {
    const s = summary.trim()
    if (!s) return
    await api.invoke('interactions:log', { person_id: person.id, kind, summary: s })
    setSummary('')
  }

  const snoozeFor = (days: number): void => {
    const d = new Date()
    d.setDate(d.getDate() + days)
    void api.invoke('followups:snooze', person.id, d.toISOString().slice(0, 10))
    setSnoozeOpen(false)
  }

  return (
    <div className="p-6 max-w-2xl space-y-6">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <InlineText
            value={person.name}
            className="text-lg font-medium"
            onSave={(v) => patch({ name: v })}
          />
          <div className="flex items-center gap-2">
            <Segmented
              value={person.area}
              onChange={(v) => patch({ area: v })}
              options={[
                { value: 'personal', label: 'Personal' },
                { value: 'work', label: 'Work' }
              ]}
            />
            {archived && <Chip tone="danger">archived</Chip>}
            {person.snoozed_until && (
              <span className="inline-flex items-center gap-1">
                <Chip tone="muted">snoozed → {person.snoozed_until}</Chip>
                <button
                  title="Clear snooze"
                  onClick={() => void api.invoke('followups:clearSnooze', person.id)}
                  className="text-faint hover:text-danger"
                >
                  <X size={11} />
                </button>
              </span>
            )}
          </div>
        </div>
        <div className="flex gap-1.5 relative">
          {!archived && (
            <>
              <Button
                variant="ghost"
                title="Snooze follow-up…"
                onClick={() => setSnoozeOpen((v) => !v)}
              >
                <BellOff size={14} />
              </Button>
              {snoozeOpen && (
                <div className="absolute right-0 top-full mt-1 z-20 w-40 rounded-md border border-border bg-panel shadow-lg overflow-hidden">
                  <p className="px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-wider text-faint border-b border-border/50">
                    snooze follow-up for
                  </p>
                  {SNOOZE_CHOICES.map((c) => (
                    <button
                      key={c.days}
                      onClick={() => snoozeFor(c.days)}
                      className="w-full text-left px-2.5 py-1.5 text-[12.5px] hover:bg-raised"
                    >
                      {c.label}
                    </button>
                  ))}
                  {person.snoozed_until && (
                    <button
                      onClick={() => {
                        void api.invoke('followups:clearSnooze', person.id)
                        setSnoozeOpen(false)
                      }}
                      className="w-full text-left px-2.5 py-1.5 text-[12.5px] text-danger hover:bg-raised border-t border-border/50"
                    >
                      clear snooze
                    </button>
                  )}
                </div>
              )}
              <Button
                variant="ghost"
                title="Archive (hides from People and linked chats; reversible)"
                onClick={() => {
                  void api.invoke('people:archive', person.id).then(onGone)
                }}
              >
                <Archive size={14} />
              </Button>
            </>
          )}
          {archived && (
            <>
              <Button
                variant="ghost"
                title="Unarchive"
                onClick={() => {
                  void api.invoke('people:unarchive', person.id).then(onGone)
                }}
              >
                <ArchiveRestore size={14} />
              </Button>
              <Button
                variant="ghost"
                title={confirmDelete ? 'Click again to permanently delete' : 'Delete permanently'}
                onClick={() => {
                  if (!confirmDelete) {
                    setConfirmDelete(true)
                    return
                  }
                  void api.invoke('people:delete', person.id).then(onGone)
                }}
                className={confirmDelete ? 'text-danger' : ''}
              >
                {confirmDelete ? (
                  <span className="inline-flex items-center gap-1 text-danger">
                    <Trash2 size={14} /> sure?
                  </span>
                ) : (
                  <Trash2 size={14} />
                )}
              </Button>
            </>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label="company" value={person.company} onSave={(v) => patch({ company: v || null })} />
        <Field label="role" value={person.role} onSave={(v) => patch({ role: v || null })} />
        <Field label="email" value={person.email} onSave={(v) => patch({ email: v || null })} />
        <Field label="phone" value={person.phone} onSave={(v) => patch({ phone: v || null })} />
        <Field label="nickname" value={person.nickname} onSave={(v) => patch({ nickname: v || null })} />
        <div className="space-y-1">
          <span className="font-mono text-[10px] uppercase tracking-wider text-faint">
            follow-up cadence (days)
          </span>
          <Input
            type="number"
            min={1}
            className="w-full"
            placeholder="none"
            defaultValue={person.cadence_days ?? ''}
            key={`cad-${person.id}-${person.cadence_days}`}
            onBlur={(e) => {
              const v = e.target.value ? Number(e.target.value) : null
              if (v !== person.cadence_days) patch({ cadence_days: v })
            }}
          />
        </div>
      </div>

      <div className="space-y-1">
        <span className="font-mono text-[10px] uppercase tracking-wider text-faint">notes</span>
        <textarea
          className="w-full h-20 bg-raised border border-border rounded-md px-2.5 py-1.5 text-[13px] resize-y focus:outline-none focus:border-border-strong"
          defaultValue={person.notes}
          key={`notes-${person.id}`}
          onBlur={(e) => {
            if (e.target.value !== person.notes) patch({ notes: e.target.value })
          }}
        />
      </div>

      {(identities?.length ?? 0) > 0 && (
        <div className="space-y-1.5">
          <span className="font-mono text-[10px] uppercase tracking-wider text-faint">
            linked accounts
          </span>
          {identities!.map((ident) => (
            <div key={ident.id} className="flex items-center gap-2 text-[12.5px]">
              <Chip tone="muted">{ident.provider}</Chip>
              <span className="truncate text-muted">{ident.handle}</span>
              <button
                title="Unlink — messages from this handle stop pointing at this person"
                onClick={() => void api.invoke('comms:unlinkSender', ident.provider, ident.handle)}
                className="text-faint hover:text-danger"
              >
                <Unlink size={12} />
              </button>
            </div>
          ))}
        </div>
      )}

      {open_tasks.length > 0 && (
        <div className="space-y-1.5">
          <span className="font-mono text-[10px] uppercase tracking-wider text-faint">
            open tasks
          </span>
          {open_tasks.map((t) => (
            <div key={t.id} className="flex items-center gap-2 text-[13px]">
              <button
                className="text-muted hover:text-ok"
                onClick={() => void api.invoke('tasks:update', t.id, { status: 'done' })}
              >
                ○
              </button>
              <span>{t.title}</span>
              {t.due_date && <span className="font-mono text-[10.5px] text-faint">{t.due_date}</span>}
            </div>
          ))}
        </div>
      )}

      <div className="space-y-2">
        <span className="font-mono text-[10px] uppercase tracking-wider text-faint">
          log interaction
        </span>
        <div className="flex gap-1.5">
          <Select value={kind} onChange={(e) => setKind(e.target.value as InteractionKind)}>
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </Select>
          <Input
            className="flex-1"
            placeholder="What happened? (Enter to log)"
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void logIt()}
          />
        </div>
      </div>

      <div className="space-y-0">
        {interactions.length === 0 && (
          <p className="text-faint text-[12px]">No interactions logged yet.</p>
        )}
        {interactions.map((i) => (
          <div key={i.id} className="flex gap-3 py-2 border-b border-border/50">
            <span className="font-mono text-[10.5px] text-faint w-20 shrink-0 pt-0.5">
              {i.occurred_at.slice(0, 10)}
            </span>
            <div className="min-w-0">
              <Chip>{i.kind}</Chip>
              <p className="text-[13px] mt-1">{i.summary}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function Field({
  label,
  value,
  onSave
}: {
  label: string
  value: string | null
  onSave: (v: string) => void
}): React.JSX.Element {
  return (
    <div className="space-y-1">
      <span className="font-mono text-[10px] uppercase tracking-wider text-faint">{label}</span>
      <Input
        className="w-full"
        defaultValue={value ?? ''}
        key={`${label}-${value}`}
        onBlur={(e) => {
          if (e.target.value !== (value ?? '')) onSave(e.target.value)
        }}
      />
    </div>
  )
}

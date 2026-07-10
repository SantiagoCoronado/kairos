import { useEffect, useMemo, useState } from 'react'
import { Archive, BellOff, Plus } from 'lucide-react'
import type { Person, Area, InteractionKind, FollowupDue } from '../../../core/types'
import type { MacContact } from '../../../shared/ipc-contract'
import { api, useInvoke } from '../lib/api'
import { Input, Button, Select, Chip, Segmented, EmptyState, InlineText, cn } from '../components/ui'

const normPhone = (p: string): string => p.replace(/\D/g, '')

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

  const { data: persons } = useInvoke(
    'people:list',
    [{ search: search || undefined, area: area === 'all' ? undefined : area }],
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

  // macOS Contacts autocomplete under the new-person input
  const [suggestions, setSuggestions] = useState<MacContact[]>([])
  const [suggestHint, setSuggestHint] = useState<string | null>(null)
  useEffect(() => {
    const q = newName.trim()
    if (q.length < 2) {
      setSuggestions([])
      setSuggestHint(null)
      return undefined
    }
    const t = setTimeout(() => {
      void api.invoke('contacts:search', q).then((res) => {
        if ('error' in res) {
          setSuggestions([])
          setSuggestHint(
            res.error === 'not-authorized'
              ? 'Grant Contacts access in System Settings → Privacy to autocomplete'
              : null // helper missing/failed: quietly act like a plain input
          )
        } else {
          setSuggestions(res.contacts)
          setSuggestHint(null)
        }
      })
    }, 150)
    return () => clearTimeout(t)
  }, [newName])

  const addFromContact = async (c: MacContact): Promise<void> => {
    // an existing person with the same email/phone gets selected, not duplicated
    const existing = persons?.find(
      (p) =>
        (p.email && c.emails.some((e) => e.toLowerCase() === p.email!.toLowerCase())) ||
        (p.phone && c.phones.some((ph) => normPhone(ph) === normPhone(p.phone!)))
    )
    if (existing) {
      setNewName('')
      setSuggestions([])
      setSelectedId(existing.id)
      return
    }
    const p = await api.invoke('people:upsert', {
      name: c.name,
      email: c.emails[0] ?? null,
      phone: c.phones[0] ?? null,
      company: c.org || null,
      area: area === 'all' ? 'personal' : area
    })
    setNewName('')
    setSuggestions([])
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
          <div className="relative">
            <div className="flex gap-1.5">
              <Input
                className="flex-1"
                placeholder="New person… (Enter)"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void addPerson()
                  if (e.key === 'Escape') setSuggestions([])
                }}
              />
              <Button variant="ghost" onClick={() => void addPerson()}>
                <Plus size={14} />
              </Button>
            </div>
            {suggestions.length > 0 && (
              <div className="absolute left-0 right-0 top-full mt-1 z-20 rounded-md border border-border bg-panel shadow-lg overflow-hidden">
                {suggestions.map((c, i) => (
                  <button
                    key={`${c.name}-${i}`}
                    // mousedown beats the input's blur, keeping the click alive
                    onMouseDown={(e) => {
                      e.preventDefault()
                      void addFromContact(c)
                    }}
                    className="w-full text-left px-2.5 py-1.5 hover:bg-raised border-b border-border/50 last:border-b-0"
                  >
                    <div className="text-[12.5px] truncate">{c.name}</div>
                    <div className="text-[10.5px] text-faint truncate">
                      {[c.emails[0] ?? c.phones[0], c.org || null]
                        .filter(Boolean)
                        .join(' · ')}
                    </div>
                  </button>
                ))}
                <div className="px-2.5 py-1 text-[10px] text-faint bg-raised/50">
                  from macOS Contacts — Enter still creates “{newName.trim()}” as typed
                </div>
              </div>
            )}
            {suggestHint && <p className="mt-1 text-[10.5px] text-faint">{suggestHint}</p>}
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          {persons?.length === 0 && <EmptyState>No people yet.</EmptyState>}
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
      </div>

      <div className="flex-1 min-w-0 overflow-y-auto">
        {selectedId ? (
          <PersonDetail id={selectedId} onArchived={() => setSelectedId(null)} />
        ) : (
          <EmptyState>Select a person, or add someone new.</EmptyState>
        )}
      </div>
    </div>
  )
}

function PersonDetail({
  id,
  onArchived
}: {
  id: string
  onArchived: () => void
}): React.JSX.Element {
  const { data: detail } = useInvoke('people:detail', [id], ['people', 'interactions', 'tasks'])
  const [kind, setKind] = useState<InteractionKind>('coffee')
  const [summary, setSummary] = useState('')

  if (!detail) return <EmptyState>Loading…</EmptyState>
  const { person, interactions, open_tasks } = detail

  const patch = (fields: Partial<Person>): void => {
    void api.invoke('people:upsert', { id: person.id, name: person.name, ...fields })
  }

  const logIt = async (): Promise<void> => {
    const s = summary.trim()
    if (!s) return
    await api.invoke('interactions:log', { person_id: person.id, kind, summary: s })
    setSummary('')
  }

  const snoozeWeek = (): void => {
    const d = new Date()
    d.setDate(d.getDate() + 7)
    void api.invoke('followups:snooze', person.id, d.toISOString().slice(0, 10))
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
            {person.snoozed_until && <Chip tone="muted">snoozed → {person.snoozed_until}</Chip>}
          </div>
        </div>
        <div className="flex gap-1.5">
          <Button variant="ghost" title="Snooze follow-up 1 week" onClick={snoozeWeek}>
            <BellOff size={14} />
          </Button>
          <Button
            variant="ghost"
            title="Archive"
            onClick={() => {
              void api.invoke('people:archive', person.id).then(onArchived)
            }}
          >
            <Archive size={14} />
          </Button>
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

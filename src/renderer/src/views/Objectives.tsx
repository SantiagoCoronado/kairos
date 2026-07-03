import { useEffect, useRef, useState } from 'react'
import { Plus, Link2, Trash2, ChevronDown, ChevronRight, GripVertical, X } from 'lucide-react'
import type { ObjectiveWithKRs, KeyResult, Area } from '../../../core/types'
import { api, useInvoke } from '../lib/api'
import { Input, Select, Chip, Segmented, EmptyState, InlineText, cn } from '../components/ui'

export function currentPeriod(d: Date = new Date()): string {
  return `${d.getFullYear()}-Q${Math.floor(d.getMonth() / 3) + 1}`
}

/** '2026-Q3' → 'Q3 2026'; anything else renders as typed */
export function formatPeriod(p: string): string {
  const m = p.match(/^(\d{4})-Q([1-4])$/)
  return m ? `Q${m[2]} ${m[1]}` : p
}

/** accept 'Q4 2026', '2026 Q4', '2026-Q4' … → canonical '2026-Q4'; free labels pass through */
export function canonicalizePeriod(raw: string): string {
  const s = raw.trim()
  let m = s.match(/^q([1-4])[\s/-]*(\d{4})$/i)
  if (m) return `${m[2]}-Q${m[1]}`
  m = s.match(/^(\d{4})[\s/-]*q([1-4])$/i)
  if (m) return `${m[1]}-Q${m[2]}`
  return s
}

const COLLAPSED_KEY = 'kairos.objectives.collapsed'

function loadCollapsed(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]') as string[])
  } catch {
    return new Set()
  }
}

type DropEdge = 'before' | 'after' | null

function dropEdge(e: React.DragEvent): 'before' | 'after' {
  const rect = e.currentTarget.getBoundingClientRect()
  return e.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
}

export function ObjectivesView(): React.JSX.Element {
  const [period, setPeriod] = useState<string>(currentPeriod())
  const [area, setArea] = useState<Area | 'all'>('all')
  const [newTitle, setNewTitle] = useState('')
  // time frames created in the UI that have no objectives yet
  const [draftPeriods, setDraftPeriods] = useState<string[]>([])
  const [addingPeriod, setAddingPeriod] = useState(false)
  const [newPeriod, setNewPeriod] = useState('')
  // stores COLLAPSED ids so new objectives default to expanded
  const [collapsed, setCollapsed] = useState<Set<string>>(loadCollapsed)
  const checkedDefault = useRef(false)

  const { data: periods } = useInvoke('objectives:periods', [], ['objectives'])
  const { data: objectives } = useInvoke(
    'objectives:list',
    [{ period: period === 'all' ? undefined : period, area: area === 'all' ? undefined : area }],
    ['objectives', 'tasks']
  )

  // if the current quarter has no objectives yet, start on All instead of an empty view
  useEffect(() => {
    if (!periods || checkedDefault.current) return
    checkedDefault.current = true
    if (!periods.includes(currentPeriod())) setPeriod('all')
  }, [periods])

  const allPeriods = [...new Set([...(periods ?? []), ...draftPeriods])].sort().reverse()

  const toggleCollapsed = (id: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]))
      return next
    })
  }

  const addPeriod = (): void => {
    const p = canonicalizePeriod(newPeriod)
    if (p) {
      if (!allPeriods.includes(p)) setDraftPeriods((d) => [...d, p])
      setPeriod(p)
    }
    setNewPeriod('')
    setAddingPeriod(false)
  }

  const addObjective = async (): Promise<void> => {
    const title = newTitle.trim()
    if (!title) return
    await api.invoke('objectives:create', {
      title,
      period: period === 'all' ? currentPeriod() : period,
      area: area === 'all' ? 'personal' : area
    })
    setNewTitle('')
  }

  /** drop dragged before/after target; dropping into another quarter adopts it */
  const dropObjective = (draggedId: string, target: ObjectiveWithKRs, edge: 'before' | 'after'): void => {
    if (!objectives || draggedId === target.id) return
    const dragged = objectives.find((o) => o.id === draggedId)
    if (!dragged) return
    void (async () => {
      if (dragged.period !== target.period)
        await api.invoke('objectives:update', draggedId, { period: target.period })
      let beforeId: string | null
      if (edge === 'before') {
        beforeId = target.id
      } else {
        const rest = objectives.filter((o) => o.id !== draggedId)
        const i = rest.findIndex((o) => o.id === target.id)
        beforeId = rest[i + 1]?.id ?? null
      }
      await api.invoke('objectives:reorder', draggedId, beforeId)
    })()
  }

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-4">
      <div className="flex items-center gap-2">
        <Input
          className="flex-1"
          placeholder="New objective… (Enter)"
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void addObjective()}
        />
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

      <div className="flex items-center gap-1.5 flex-wrap">
        <Chip tone={period === 'all' ? 'accent' : 'muted'} onClick={() => setPeriod('all')}>
          All
        </Chip>
        {allPeriods.map((p) => (
          <Chip key={p} tone={period === p ? 'accent' : 'muted'} onClick={() => setPeriod(p)}>
            {formatPeriod(p)}
          </Chip>
        ))}
        {addingPeriod ? (
          <Input
            autoFocus
            className="w-28 py-0.5 text-[12px]"
            placeholder="Q4 2026…"
            value={newPeriod}
            onChange={(e) => setNewPeriod(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') addPeriod()
              if (e.key === 'Escape') {
                setNewPeriod('')
                setAddingPeriod(false)
              }
            }}
            onBlur={() => {
              setNewPeriod('')
              setAddingPeriod(false)
            }}
          />
        ) : (
          <Chip onClick={() => setAddingPeriod(true)}>
            <Plus size={10} /> time frame
          </Chip>
        )}
      </div>

      {objectives?.length === 0 && (
        <EmptyState>
          No objectives {period === 'all' ? 'yet' : `for ${formatPeriod(period)}`}. Add one above.
        </EmptyState>
      )}
      {objectives?.map((o) => (
        <ObjectiveCard
          key={o.id}
          objective={o}
          periods={allPeriods}
          expanded={!collapsed.has(o.id)}
          onToggle={() => toggleCollapsed(o.id)}
          onDropObjective={dropObjective}
        />
      ))}
    </div>
  )
}

function ObjectiveCard({
  objective: o,
  periods,
  expanded,
  onToggle,
  onDropObjective
}: {
  objective: ObjectiveWithKRs
  periods: string[]
  expanded: boolean
  onToggle: () => void
  onDropObjective: (draggedId: string, target: ObjectiveWithKRs, edge: 'before' | 'after') => void
}): React.JSX.Element {
  const [newKr, setNewKr] = useState('')
  const [newKrTarget, setNewKrTarget] = useState('100')
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [dragArmed, setDragArmed] = useState(false)
  const [edge, setEdge] = useState<DropEdge>(null)

  const addKr = async (): Promise<void> => {
    const title = newKr.trim()
    if (!title) return
    await api.invoke('krs:add', o.id, { title, target_value: Number(newKrTarget) || 100 })
    setNewKr('')
  }

  const askDelete = (): void => {
    setConfirmingDelete(true)
    setTimeout(() => setConfirmingDelete(false), 3000)
  }

  const pct = Math.round(o.progress * 100)
  const periodOptions = periods.includes(o.period) ? periods : [o.period, ...periods]

  return (
    <div
      className={cn(
        'group border border-border rounded-lg bg-panel p-4 space-y-3',
        o.status !== 'active' && 'opacity-60',
        edge === 'before' && 'shadow-[0_-2px_0_0_var(--color-accent)]',
        edge === 'after' && 'shadow-[0_2px_0_0_var(--color-accent)]'
      )}
      draggable={dragArmed}
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', o.id)
        e.dataTransfer.effectAllowed = 'move'
      }}
      onDragEnd={() => setDragArmed(false)}
      onDragOver={(e) => {
        e.preventDefault()
        setEdge(dropEdge(e))
      }}
      onDragLeave={() => setEdge(null)}
      onDrop={(e) => {
        e.preventDefault()
        setEdge(null)
        const id = e.dataTransfer.getData('text/plain')
        if (id) onDropObjective(id, o, dropEdge(e))
      }}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <span
            className="shrink-0 -ml-1.5 text-faint opacity-0 group-hover:opacity-100 cursor-grab active:cursor-grabbing"
            title="Drag to reorder"
            onMouseDown={() => setDragArmed(true)}
            onMouseUp={() => setDragArmed(false)}
          >
            <GripVertical size={14} />
          </span>
          <button
            onClick={onToggle}
            className="text-faint hover:text-text shrink-0"
            title={expanded ? 'Collapse key results' : 'Expand key results'}
          >
            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
          <InlineText
            value={o.title}
            className="flex-1 min-w-0 text-[14px] font-medium text-text"
            onSave={(title) => void api.invoke('objectives:update', o.id, { title })}
          />
          <Chip
            tone={o.area === 'work' ? 'accent' : 'muted'}
            onClick={() =>
              void api.invoke('objectives:update', o.id, {
                area: o.area === 'work' ? 'personal' : 'work'
              })
            }
          >
            {o.area}
          </Chip>
          <select
            value={o.period}
            onChange={(e) => void api.invoke('objectives:update', o.id, { period: e.target.value })}
            title="Move to another time frame"
            className="bg-raised rounded px-1 py-0.5 font-mono text-[10.5px] text-muted border-none focus:outline-none cursor-pointer"
          >
            {periodOptions.map((p) => (
              <option key={p} value={p}>
                {formatPeriod(p)}
              </option>
            ))}
          </select>
          {!expanded && <Chip>{o.key_results.length} KRs</Chip>}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="font-mono text-[11px] text-muted">{pct}%</span>
          <Select
            value={o.status}
            onChange={(e) =>
              void api.invoke('objectives:update', o.id, {
                status: e.target.value as ObjectiveWithKRs['status']
              })
            }
          >
            <option value="active">active</option>
            <option value="achieved">achieved</option>
            <option value="dropped">dropped</option>
          </Select>
          {confirmingDelete ? (
            <Chip tone="danger" onClick={() => void api.invoke('objectives:delete', o.id)}>
              delete?
            </Chip>
          ) : (
            <button
              onClick={askDelete}
              title="Delete objective and its key results"
              className="text-faint hover:text-danger opacity-0 group-hover:opacity-100"
            >
              <Trash2 size={14} />
            </button>
          )}
        </div>
      </div>

      <ProgressBar value={o.progress} />

      {expanded && (
        <div className="ml-2 pl-3 border-l border-border space-y-2">
          {o.key_results.map((kr) => (
            <KrRow key={kr.id} kr={kr} />
          ))}
          <div className="flex gap-1.5 items-center">
            <Plus size={13} className="text-faint shrink-0" />
            <Input
              className="flex-1 py-1"
              placeholder="Add key result… (Enter)"
              value={newKr}
              onChange={(e) => setNewKr(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void addKr()}
            />
            <Input
              className="w-20 py-1 font-mono text-[11px]"
              title="target value"
              value={newKrTarget}
              onChange={(e) => setNewKrTarget(e.target.value)}
            />
          </div>
        </div>
      )}
    </div>
  )
}

function KrRow({ kr }: { kr: KeyResult }): React.JSX.Element {
  const [showTasks, setShowTasks] = useState(false)
  const span = kr.target_value - kr.start_value
  const ratio =
    span === 0
      ? kr.current_value >= kr.target_value
        ? 1
        : 0
      : Math.max(0, Math.min(1, (kr.current_value - kr.start_value) / span))

  return (
    <div className="group/kr space-y-1">
      <div className="flex items-center gap-2">
        <InlineText
          value={kr.title}
          className="flex-1 min-w-0 text-[12.5px] text-muted"
          onSave={(title) => void api.invoke('krs:update', kr.id, { title })}
        />
        <Input
          type="number"
          className="w-20 py-0.5 font-mono text-[11px] text-right"
          defaultValue={kr.current_value}
          key={`${kr.id}-cur-${kr.current_value}`}
          onBlur={(e) => {
            const v = Number(e.target.value)
            if (!Number.isNaN(v) && v !== kr.current_value)
              void api.invoke('krs:updateProgress', kr.id, v)
          }}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
        <span className="font-mono text-[11px] text-faint shrink-0">/</span>
        <input
          type="number"
          title="target value"
          className="w-14 bg-transparent font-mono text-[11px] text-faint focus:outline-none focus:text-text"
          defaultValue={kr.target_value}
          key={`${kr.id}-tgt-${kr.target_value}`}
          onBlur={(e) => {
            const v = Number(e.target.value)
            if (!Number.isNaN(v) && v !== kr.target_value)
              void api.invoke('krs:update', kr.id, { target_value: v })
          }}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
        <input
          title="unit"
          placeholder="unit"
          className="w-12 bg-transparent font-mono text-[11px] text-faint focus:outline-none focus:text-text"
          defaultValue={kr.unit}
          key={`${kr.id}-unit-${kr.unit}`}
          onBlur={(e) => {
            const v = e.target.value.trim()
            if (v !== kr.unit) void api.invoke('krs:update', kr.id, { unit: v })
          }}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
        <button
          className={cn('shrink-0', showTasks ? 'text-accent' : 'text-faint hover:text-muted')}
          title="Linked tasks"
          onClick={() => setShowTasks(!showTasks)}
        >
          <Link2 size={13} />
        </button>
        <button
          onClick={() => void api.invoke('krs:delete', kr.id)}
          title="Delete key result"
          className="text-faint hover:text-danger opacity-0 group-hover/kr:opacity-100 shrink-0"
        >
          <Trash2 size={13} />
        </button>
      </div>
      <ProgressBar value={ratio} thin />
      {showTasks && <KrTasks krId={kr.id} />}
    </div>
  )
}

function KrTasks({ krId }: { krId: string }): React.JSX.Element {
  const { data: linked } = useInvoke('krs:tasks', [krId], ['tasks', 'objectives'])
  const { data: openTasks } = useInvoke('tasks:list', [{ status: ['todo', 'in_progress'] }], ['tasks'])

  const linkedIds = new Set(linked?.map((t) => t.id))
  const linkable = openTasks?.filter((t) => !linkedIds.has(t.id)) ?? []

  return (
    <div className="ml-2 pl-3 border-l border-border space-y-1 py-1">
      {linked?.map((t) => (
        <div key={t.id} className="group/link flex items-center gap-2 text-[12.5px]">
          <button
            className={cn('hover:text-ok', t.status === 'done' ? 'text-ok' : 'text-muted')}
            onClick={() =>
              void api.invoke('tasks:update', t.id, {
                status: t.status === 'done' ? 'todo' : 'done'
              })
            }
          >
            {t.status === 'done' ? '●' : '○'}
          </button>
          <span className={cn(t.status === 'done' && 'line-through text-faint')}>{t.title}</span>
          <button
            onClick={() => void api.invoke('krs:unlinkTask', krId, t.id)}
            title="Unlink task"
            className="text-faint hover:text-danger opacity-0 group-hover/link:opacity-100"
          >
            <X size={12} />
          </button>
        </div>
      ))}
      <Select
        className="py-1 text-[12px]"
        value=""
        onChange={(e) => {
          if (e.target.value) void api.invoke('krs:linkTask', krId, e.target.value)
        }}
      >
        <option value="">link a task…</option>
        {linkable.map((t) => (
          <option key={t.id} value={t.id}>
            {t.title}
          </option>
        ))}
      </Select>
    </div>
  )
}

export function ProgressBar({ value, thin }: { value: number; thin?: boolean }): React.JSX.Element {
  const pct = Math.max(0, Math.min(100, value * 100))
  return (
    <div className={cn('w-full bg-raised rounded-full overflow-hidden', thin ? 'h-1' : 'h-1.5')}>
      <div
        className={cn('h-full rounded-full transition-all', pct >= 100 ? 'bg-ok' : 'bg-accent')}
        style={{ width: `${pct}%` }}
      />
    </div>
  )
}

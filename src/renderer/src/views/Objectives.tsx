import { useState } from 'react'
import { Plus, Link2 } from 'lucide-react'
import type { ObjectiveWithKRs, KeyResult, Area } from '../../../core/types'
import { api, useInvoke } from '../lib/api'
import { Input, Select, Chip, Segmented, EmptyState, cn } from '../components/ui'

export function currentPeriod(d: Date = new Date()): string {
  return `${d.getFullYear()}-Q${Math.floor(d.getMonth() / 3) + 1}`
}

export function ObjectivesView(): React.JSX.Element {
  const [period, setPeriod] = useState(currentPeriod())
  const [area, setArea] = useState<Area | 'all'>('all')
  const [newTitle, setNewTitle] = useState('')

  const { data: objectives } = useInvoke(
    'objectives:list',
    [{ period: period || undefined, area: area === 'all' ? undefined : area }],
    ['objectives', 'tasks']
  )

  const addObjective = async (): Promise<void> => {
    const title = newTitle.trim()
    if (!title) return
    await api.invoke('objectives:create', {
      title,
      period: period || currentPeriod(),
      area: area === 'all' ? 'personal' : area
    })
    setNewTitle('')
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
        <Input
          className="w-24 font-mono text-[12px]"
          value={period}
          onChange={(e) => setPeriod(e.target.value)}
          title="Period filter, e.g. 2026-Q3. Clear to see all."
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

      {objectives?.length === 0 && (
        <EmptyState>No objectives for {period || 'any period'}. Add one above.</EmptyState>
      )}
      {objectives?.map((o) => <ObjectiveCard key={o.id} objective={o} />)}
    </div>
  )
}

function ObjectiveCard({ objective: o }: { objective: ObjectiveWithKRs }): React.JSX.Element {
  const [newKr, setNewKr] = useState('')
  const [newKrTarget, setNewKrTarget] = useState('100')

  const addKr = async (): Promise<void> => {
    const title = newKr.trim()
    if (!title) return
    await api.invoke('krs:add', o.id, { title, target_value: Number(newKrTarget) || 100 })
    setNewKr('')
  }

  const pct = Math.round(o.progress * 100)

  return (
    <div
      className={cn(
        'border border-border rounded-lg bg-panel p-4 space-y-3',
        o.status !== 'active' && 'opacity-60'
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <h3 className="text-[14px] font-medium truncate">{o.title}</h3>
          <Chip tone={o.area === 'work' ? 'accent' : 'muted'}>{o.area}</Chip>
          <Chip>{o.period}</Chip>
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
        </div>
      </div>

      <ProgressBar value={o.progress} />

      <div className="space-y-2">
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
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <span className="flex-1 text-[13px] truncate">{kr.title}</span>
        <Input
          type="number"
          className="w-20 py-0.5 font-mono text-[11px] text-right"
          defaultValue={kr.current_value}
          key={`${kr.id}-${kr.current_value}`}
          onBlur={(e) => {
            const v = Number(e.target.value)
            if (!Number.isNaN(v) && v !== kr.current_value)
              void api.invoke('krs:updateProgress', kr.id, v)
          }}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
        <span className="font-mono text-[11px] text-faint w-24 shrink-0">
          / {kr.target_value} {kr.unit}
        </span>
        <button
          className={cn('shrink-0', showTasks ? 'text-accent' : 'text-faint hover:text-muted')}
          title="Linked tasks"
          onClick={() => setShowTasks(!showTasks)}
        >
          <Link2 size={13} />
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
        <div key={t.id} className="flex items-center gap-2 text-[12.5px]">
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

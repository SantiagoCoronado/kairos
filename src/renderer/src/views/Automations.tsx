import { useEffect, useState } from 'react'
import {
  Bot,
  Play,
  Square,
  Trash2,
  Plus,
  Sparkles,
  MessageSquare,
  ChevronDown,
  ChevronRight,
  LayoutGrid,
  Sun,
  Mail,
  CalendarCheck,
  Users,
  Inbox,
  BookOpen,
  Zap
} from 'lucide-react'
import type {
  AgentTask,
  AgentTaskRun,
  AgentSchedule,
  AgentTriggerType,
  AppEventName,
  NewAgentTask
} from '../../../core/types'
import type { AppSettings } from '../../../shared/ipc-contract'
import { api, useInvoke } from '../lib/api'
import { Input, Button, Select, Chip, Segmented, EmptyState, cn } from '../components/ui'

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

const EVENT_LABELS: Record<AppEventName, string> = {
  email_received: 'New email arrives',
  message_received: 'New message (any account)',
  task_created: 'Task created',
  note_created: 'Note created',
  interaction_logged: 'Interaction logged'
}

const MODELS: { value: string; label: string }[] = [
  { value: '', label: 'Default model' },
  { value: 'fable', label: 'Fable 5' },
  { value: 'opus', label: 'Opus 4.8' },
  { value: 'sonnet', label: 'Sonnet 5' },
  { value: 'haiku', label: 'Haiku 4.5' }
]

function scheduleSummary(t: AgentTask): string {
  if (t.trigger_type === 'event') {
    const label = t.trigger_event ? EVENT_LABELS[t.trigger_event] : 'On event'
    return t.trigger_count > 1 ? `${label} · every ${t.trigger_count}` : label
  }
  switch (t.schedule) {
    case 'once':
      return t.scheduled_date
        ? `Once · ${new Date(t.scheduled_date).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`
        : 'Once'
    case 'daily':
      return `Daily ${t.scheduled_time ?? '09:00'}`
    case 'weekly':
      return `Weekly ${WEEKDAYS[t.scheduled_day ?? 1]} ${t.scheduled_time ?? '09:00'}`
    case 'monthly':
      return `Monthly day ${t.scheduled_day ?? 1} · ${t.scheduled_time ?? '09:00'}`
  }
}

function relTime(iso: string | null): string {
  if (!iso) return '—'
  const delta = new Date(iso).getTime() - Date.now()
  const abs = Math.abs(delta)
  const unit =
    abs < 60_000
      ? [Math.round(abs / 1000), 's']
      : abs < 3_600_000
        ? [Math.round(abs / 60_000), 'm']
        : abs < 86_400_000
          ? [Math.round(abs / 3_600_000), 'h']
          : [Math.round(abs / 86_400_000), 'd']
  return delta >= 0 ? `in ${unit[0]}${unit[1]}` : `${unit[0]}${unit[1]} ago`
}

function duration(run: AgentTaskRun, nowMs: number): string {
  const end = run.finished_at ? new Date(run.finished_at).getTime() : nowMs
  const s = Math.max(0, Math.round((end - new Date(run.started_at).getTime()) / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function fmtCost(usd: number): string {
  return usd >= 0.995 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(3)}`
}

const RUN_DOT: Record<AgentTaskRun['status'], string> = {
  running: 'bg-accent animate-pulse',
  success: 'bg-ok',
  error: 'bg-danger',
  stopped: 'bg-border-strong'
}

/** small on/off switch (active ↔ paused, or the master automations toggle) */
function Toggle({
  on,
  title,
  onChange
}: {
  on: boolean
  title: string
  onChange: () => void
}): React.JSX.Element {
  return (
    <button
      role="switch"
      aria-checked={on}
      title={title}
      onClick={(e) => {
        e.stopPropagation()
        onChange()
      }}
      className={cn(
        'relative w-7 h-4 rounded-full border transition-colors shrink-0',
        on ? 'bg-accent/30 border-accent/60' : 'bg-raised border-border-strong'
      )}
    >
      <span
        className={cn(
          'absolute top-1/2 -translate-y-1/2 w-2.5 h-2.5 rounded-full transition-all',
          on ? 'left-[14px] bg-accent' : 'left-[3px] bg-faint'
        )}
      />
    </button>
  )
}

// kairos-native ports of Odysseus's builtin task templates — prompt presets
// over the existing tool surface, no coded action machinery
const PRESETS: { label: string; desc: string; icon: typeof Sun; task: NewAgentTask }[] = [
  {
    label: 'Morning brief',
    desc: 'Daily 08:00 — agenda, due follow-ups, unread mail',
    icon: Sun,
    task: {
      name: 'Morning brief',
      prompt:
        'Build my morning brief: check today_agenda (overdue + due-today tasks, objectives), followups_due, and scan unread email threads with comms_search. Summarize the day in a few tight bullets: what needs action first, who to reply to, what can wait.',
      schedule: 'daily',
      scheduled_time: '08:00'
    }
  },
  {
    label: 'Email urgency watch',
    desc: 'On new email — flag anything urgent',
    icon: Mail,
    task: {
      name: 'Email urgency watch',
      prompt:
        'New mail just arrived. Check the most recent unread email threads (comms_search / comms_thread_get). Identify anything urgent or needing a fast reply. Your final summary must name ONLY the urgent items with a one-line reason each; if nothing is urgent, say exactly "Nothing urgent."',
      trigger_type: 'event',
      trigger_event: 'email_received',
      trigger_count: 1
    }
  },
  {
    label: 'Weekly review draft',
    desc: 'Fri 17:00 — recap tasks + objectives',
    icon: CalendarCheck,
    task: {
      name: 'Weekly review draft',
      prompt:
        'Draft my weekly review: list open work tasks (tasks_list, area work), check objectives_review progress, and note what moved this week. Produce a short recap: wins, stalled items, and three priorities for next week.',
      schedule: 'weekly',
      scheduled_time: '17:00',
      scheduled_day: 5
    }
  },
  {
    label: 'Follow-up nudger',
    desc: 'Daily 09:00 — who to reach out to',
    icon: Users,
    task: {
      name: 'Follow-up nudger',
      prompt:
        'Check followups_due. For each person due or overdue, look at their recent interactions (person_get) and propose a one-line conversation opener based on what we last talked about. If nobody is due, say so in one line.',
      schedule: 'daily',
      scheduled_time: '09:00'
    }
  },
  {
    label: 'Inbox catch-up',
    desc: 'Daily 18:00 — summarize unread threads',
    icon: Inbox,
    task: {
      name: 'Inbox catch-up',
      prompt:
        'Summarize today\'s unread conversations: use comms_search to find recent unread messages, group by thread, and give me a one-line summary per conversation with who is waiting on me.',
      schedule: 'daily',
      scheduled_time: '18:00'
    }
  },
  {
    label: 'Memory tidy',
    desc: 'Sun 20:00 — dedupe the memory file',
    icon: BookOpen,
    task: {
      name: 'Memory tidy',
      prompt:
        'Read the persistent memory file (memory_read). Remove duplicates and stale entries, merge related facts, keep it short and factual, then rewrite it with memory_save mode replace. Summarize what you pruned.',
      schedule: 'weekly',
      scheduled_time: '20:00',
      scheduled_day: 0
    }
  }
]

export function AutomationsView({
  onOpenSession
}: {
  onOpenSession: (sessionId: string) => void
}): React.JSX.Element {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const { data: taskList } = useInvoke('agentTasks:list', [], ['agent_tasks'])
  const selected = taskList?.find((t) => t.id === selectedId) ?? null

  useEffect(() => {
    void api.invoke('settings:get').then(setSettings)
  }, [])
  const enabled = settings?.automationsEnabled ?? true
  const toggleMaster = (): void => {
    void api.invoke('settings:set', { automationsEnabled: !enabled }).then(setSettings)
  }

  return (
    <div className="h-full flex flex-col p-6 mx-auto max-w-5xl gap-4 min-h-0">
      <div className="flex items-center gap-2.5">
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-faint select-none">
          automations
        </span>
        <Toggle
          on={enabled}
          title={enabled ? 'Turn all automations off' : 'Turn all automations on'}
          onChange={toggleMaster}
        />
        {!enabled && (
          <span className="text-[12px] text-faint">
            paused — nothing runs automatically ("run now" still works)
          </span>
        )}
      </div>
      <QuickCreate onCreated={setSelectedId} />
      <div className={cn('flex-1 min-h-0 flex gap-4', !enabled && 'opacity-60')}>
        <div className="w-72 shrink-0 flex flex-col border border-border rounded-lg bg-panel overflow-y-auto divide-y divide-border">
          {taskList?.length === 0 && (
            <EmptyState>No automations yet. Describe one above.</EmptyState>
          )}
          {taskList?.map((t) => (
            <TaskListItem
              key={t.id}
              task={t}
              selected={t.id === selectedId}
              onSelect={() => setSelectedId(t.id)}
            />
          ))}
        </div>
        <div className="flex-1 min-w-0 overflow-y-auto">
          {selected ? (
            <TaskDetail
              key={selected.id}
              task={selected}
              allTasks={taskList ?? []}
              onDeleted={() => setSelectedId(null)}
              onOpenSession={onOpenSession}
            />
          ) : (
            <div className="h-full min-h-0 flex flex-col gap-4">
              <RecentActivity onOpenSession={onOpenSession} />
              <UsagePanel />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ---------- NL quick create ----------

function QuickCreate({ onCreated }: { onCreated: (id: string) => void }): React.JSX.Element {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showPresets, setShowPresets] = useState(false)

  const usePreset = async (preset: (typeof PRESETS)[number]): Promise<void> => {
    setShowPresets(false)
    const created = await api.invoke('agentTasks:create', { ...preset.task, notify: true })
    onCreated(created.id)
  }

  const draftIt = async (): Promise<void> => {
    const t = text.trim()
    if (!t || busy) return
    setBusy(true)
    setError(null)
    try {
      const parsed = await api.invoke('agentTasks:parse', t)
      if (!parsed.ok) {
        setError(parsed.message)
        return
      }
      const created = await api.invoke('agentTasks:create', { ...parsed.draft, notify: true })
      setText('')
      onCreated(created.id)
    } finally {
      setBusy(false)
    }
  }

  const blank = async (): Promise<void> => {
    const created = await api.invoke('agentTasks:create', {
      name: 'New automation',
      prompt: '',
      schedule: 'daily',
      scheduled_time: '09:00'
    })
    onCreated(created.id)
  }

  return (
    <div className="space-y-1 relative">
      <div className="flex items-center gap-2">
        <Input
          className="flex-1"
          placeholder='Describe a task… e.g. "every morning at 8 summarize my due follow-ups" (Enter)'
          value={text}
          disabled={busy}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void draftIt()}
        />
        <Button variant="accent" disabled={busy || !text.trim()} onClick={() => void draftIt()}>
          <span className="inline-flex items-center gap-1">
            <Sparkles size={13} /> {busy ? 'drafting…' : 'Draft'}
          </span>
        </Button>
        <Button variant="ghost" title="Preset templates" onClick={() => setShowPresets((s) => !s)}>
          <LayoutGrid size={14} />
        </Button>
        <Button variant="ghost" title="Blank automation" onClick={() => void blank()}>
          <Plus size={14} />
        </Button>
      </div>
      {error && <p className="text-[12px] text-danger">{error}</p>}

      {showPresets && (
        <div className="absolute z-20 top-11 right-0 w-[520px] bg-overlay border border-border-strong rounded-xl shadow-2xl p-3 grid grid-cols-2 gap-2">
          {PRESETS.map((p) => {
            const Icon = p.icon
            return (
              <button
                key={p.label}
                className="flex items-start gap-2.5 text-left px-3 py-2.5 rounded-lg border border-border bg-panel hover:border-border-strong transition-colors"
                onClick={() => void usePreset(p)}
              >
                <Icon size={15} className="text-accent shrink-0 mt-0.5" />
                <span className="min-w-0">
                  <span className="block text-[13px] text-text">{p.label}</span>
                  <span className="block text-[11px] text-faint leading-snug">{p.desc}</span>
                </span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ---------- list ----------

function TaskListItem({
  task,
  selected,
  onSelect
}: {
  task: AgentTask
  selected: boolean
  onSelect: () => void
}): React.JSX.Element {
  const paused = task.status === 'paused'
  return (
    <button
      onClick={onSelect}
      className={cn(
        'group w-full text-left px-3 py-2.5 space-y-1 transition-colors',
        selected ? 'bg-raised' : 'hover:bg-raised/50'
      )}
    >
      <div className="flex items-center gap-2">
        {task.trigger_type === 'event' ? (
          <Zap size={13} className={cn('shrink-0', paused ? 'text-faint' : 'text-accent')} />
        ) : (
          <Bot size={13} className={cn('shrink-0', paused ? 'text-faint' : 'text-accent')} />
        )}
        <span className={cn('flex-1 text-[13px] truncate', paused ? 'text-muted' : 'text-text')}>
          {task.name}
        </span>
        <span
          className="opacity-0 group-hover:opacity-100"
          onClick={(e) => e.stopPropagation()}
        >
          <IconAction title="Run now" onClick={() => void api.invoke('agentTasks:runNow', task.id)}>
            <Sparkles size={12} />
          </IconAction>
        </span>
        <Toggle
          on={task.status === 'active'}
          title={task.status === 'active' ? 'Turn off' : 'Turn on'}
          onChange={() =>
            void api.invoke(
              task.status === 'active' ? 'agentTasks:pause' : 'agentTasks:resume',
              task.id
            )
          }
        />
      </div>
      <div className="flex items-center gap-2 pl-5">
        <span className="font-mono text-[10.5px] text-faint">{scheduleSummary(task)}</span>
        <Chip
          tone={task.status === 'active' ? 'ok' : task.status === 'paused' ? 'muted' : 'accent'}
        >
          {task.status === 'paused' ? 'off' : task.status}
        </Chip>
      </div>
      {task.status === 'active' && task.next_run && (
        <p className="pl-5 font-mono text-[10.5px] text-faint">next {relTime(task.next_run)}</p>
      )}
      {task.status === 'active' && task.trigger_type === 'event' && task.trigger_count > 1 && (
        <p className="pl-5 font-mono text-[10.5px] text-faint">
          {task.trigger_counter}/{task.trigger_count} events counted
        </p>
      )}
    </button>
  )
}

function IconAction({
  children,
  title,
  onClick
}: {
  children: React.ReactNode
  title: string
  onClick: () => void
}): React.JSX.Element {
  return (
    <span
      role="button"
      title={title}
      onClick={onClick}
      className="p-0.5 rounded text-faint hover:text-text cursor-pointer"
    >
      {children}
    </span>
  )
}

// ---------- detail ----------

function TaskDetail({
  task,
  allTasks,
  onDeleted,
  onOpenSession
}: {
  task: AgentTask
  allTasks: AgentTask[]
  onDeleted: () => void
  onOpenSession: (sessionId: string) => void
}): React.JSX.Element {
  const [name, setName] = useState(task.name)
  const [prompt, setPrompt] = useState(task.prompt)
  const [triggerType, setTriggerType] = useState<AgentTriggerType>(task.trigger_type)
  const [triggerEvent, setTriggerEvent] = useState<AppEventName>(
    task.trigger_event ?? 'email_received'
  )
  const [triggerCount, setTriggerCount] = useState(task.trigger_count)
  const [schedule, setSchedule] = useState<AgentSchedule>(task.schedule)
  const [time, setTime] = useState(task.scheduled_time ?? '09:00')
  const [day, setDay] = useState(task.scheduled_day ?? (task.schedule === 'monthly' ? 1 : 1))
  const [date, setDate] = useState(task.scheduled_date ?? '')
  const [model, setModel] = useState(task.model ?? '')
  const [notify, setNotify] = useState(task.notify === 1)
  const [thenTaskId, setThenTaskId] = useState(task.then_task_id ?? '')
  const [saveError, setSaveError] = useState<string | null>(null)

  const { data: runs } = useInvoke('agentTasks:runs', [task.id, 30], ['agent_tasks'])
  const running = runs?.some((r) => r.status === 'running') ?? false

  const dirty =
    name !== task.name ||
    prompt !== task.prompt ||
    triggerType !== task.trigger_type ||
    triggerEvent !== (task.trigger_event ?? 'email_received') ||
    triggerCount !== task.trigger_count ||
    schedule !== task.schedule ||
    time !== (task.scheduled_time ?? '09:00') ||
    day !== (task.scheduled_day ?? 1) ||
    date !== (task.scheduled_date ?? '') ||
    model !== (task.model ?? '') ||
    notify !== (task.notify === 1) ||
    thenTaskId !== (task.then_task_id ?? '')

  const save = (): void => {
    setSaveError(null)
    api
      .invoke('agentTasks:update', task.id, {
        name: name.trim() || task.name,
        prompt,
        trigger_type: triggerType,
        trigger_event: triggerType === 'event' ? triggerEvent : null,
        trigger_count: Math.max(1, triggerCount || 1),
        schedule,
        scheduled_time: schedule === 'once' ? null : time,
        scheduled_day: schedule === 'weekly' || schedule === 'monthly' ? day : null,
        scheduled_date: schedule === 'once' ? date || null : null,
        model: model || null,
        notify,
        then_task_id: thenTaskId || null
      })
      .catch((err: unknown) =>
        setSaveError(err instanceof Error ? err.message : String(err))
      )
  }

  return (
    <div className="space-y-4">
      <div className="border border-border rounded-lg bg-panel p-4 space-y-3">
        <div className="flex items-center gap-2">
          <input
            className="flex-1 bg-transparent text-[14px] font-medium text-text placeholder:text-faint focus:outline-none"
            value={name}
            placeholder="Automation name"
            onChange={(e) => setName(e.target.value)}
          />
          {running ? (
            <Button onClick={() => void api.invoke('agentTasks:stop', task.id)} title="Stop the running turn">
              <span className="inline-flex items-center gap-1">
                <Square size={12} /> stop
              </span>
            </Button>
          ) : (
            <Button onClick={() => void api.invoke('agentTasks:runNow', task.id)}>
              <span className="inline-flex items-center gap-1">
                <Play size={12} /> run now
              </span>
            </Button>
          )}
          <span className="inline-flex items-center gap-1.5 text-[11px] text-muted select-none">
            {task.status === 'active' ? 'on' : 'off'}
            <Toggle
              on={task.status === 'active'}
              title={task.status === 'active' ? 'Turn off' : 'Turn on'}
              onChange={() =>
                void api.invoke(
                  task.status === 'active' ? 'agentTasks:pause' : 'agentTasks:resume',
                  task.id
                )
              }
            />
          </span>
          <Button
            variant="ghost"
            title="Delete automation"
            onClick={() => {
              void api.invoke('agentTasks:delete', task.id)
              onDeleted()
            }}
          >
            <Trash2 size={13} className="text-danger" />
          </Button>
        </div>

        <textarea
          className="w-full bg-raised border border-border rounded-md px-2.5 py-2 text-[13px] text-text placeholder:text-faint focus:outline-none focus:border-border-strong resize-y min-h-[80px]"
          placeholder="What should the agent do each run?"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
        />

        <div className="flex items-center gap-2 flex-wrap">
          <Segmented
            value={triggerType}
            onChange={setTriggerType}
            options={[
              { value: 'schedule', label: 'Schedule' },
              { value: 'event', label: 'On event' }
            ]}
          />
          {triggerType === 'event' ? (
            <>
              <Select
                value={triggerEvent}
                onChange={(e) => setTriggerEvent(e.target.value as AppEventName)}
              >
                {(Object.keys(EVENT_LABELS) as AppEventName[]).map((ev) => (
                  <option key={ev} value={ev}>
                    {EVENT_LABELS[ev]}
                  </option>
                ))}
              </Select>
              <label className="inline-flex items-center gap-1.5 text-[12px] text-muted">
                every
                <Input
                  type="number"
                  min={1}
                  className="w-14"
                  value={triggerCount}
                  onChange={(e) => setTriggerCount(Number(e.target.value))}
                />
                ×
              </label>
            </>
          ) : (
            <>
              <Segmented
                value={schedule}
                onChange={setSchedule}
                options={[
                  { value: 'once', label: 'Once' },
                  { value: 'daily', label: 'Daily' },
                  { value: 'weekly', label: 'Weekly' },
                  { value: 'monthly', label: 'Monthly' }
                ]}
              />
              {schedule === 'once' ? (
                <Input
                  type="datetime-local"
                  value={date ? date.slice(0, 16) : ''}
                  onChange={(e) => setDate(e.target.value)}
                />
              ) : (
                <Input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
              )}
              {schedule === 'weekly' && (
                <Select value={String(day)} onChange={(e) => setDay(Number(e.target.value))}>
                  {WEEKDAYS.map((w, i) => (
                    <option key={w} value={i}>
                      {w}
                    </option>
                  ))}
                </Select>
              )}
              {schedule === 'monthly' && (
                <Select value={String(day)} onChange={(e) => setDay(Number(e.target.value))}>
                  {Array.from({ length: 31 }, (_, i) => (
                    <option key={i + 1} value={i + 1}>
                      day {i + 1}
                    </option>
                  ))}
                </Select>
              )}
            </>
          )}
          <Select value={model} onChange={(e) => setModel(e.target.value)}>
            {MODELS.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </Select>
          <label className="inline-flex items-center gap-1.5 text-[12px] text-muted select-none cursor-pointer">
            <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} />
            notify
          </label>
          <Select
            title="Run another automation after this one succeeds"
            value={thenTaskId}
            onChange={(e) => setThenTaskId(e.target.value)}
          >
            <option value="">then: nothing</option>
            {allTasks
              .filter((t) => t.id !== task.id)
              .map((t) => (
                <option key={t.id} value={t.id}>
                  then: {t.name}
                </option>
              ))}
          </Select>
          <div className="flex-1" />
          {dirty && (
            <Button variant="accent" onClick={save}>
              Save
            </Button>
          )}
        </div>
        {saveError && <p className="text-[12px] text-danger">{saveError}</p>}

        <div className="flex items-center gap-3 font-mono text-[10.5px] text-faint">
          <span>{scheduleSummary(task)}</span>
          {task.next_run && task.status === 'active' && <span>next {relTime(task.next_run)}</span>}
          {task.last_run && <span>last {relTime(task.last_run)}</span>}
          <span>{task.run_count} runs</span>
        </div>
      </div>

      <div className="space-y-2">
        <span className="font-mono text-[10px] uppercase tracking-wider text-faint select-none">
          run history
        </span>
        <div className="border border-border rounded-lg bg-panel divide-y divide-border">
          {(runs?.length ?? 0) === 0 && <EmptyState>No runs yet.</EmptyState>}
          {runs?.map((r) => <RunRow key={r.id} run={r} onOpenSession={onOpenSession} />)}
        </div>
      </div>
    </div>
  )
}

// ---------- runs ----------

function useNowWhileRunning(active: boolean): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [active])
  return now
}

function RunRow({
  run,
  showTaskName,
  onOpenSession
}: {
  run: AgentTaskRun & { task_name?: string }
  showTaskName?: boolean
  onOpenSession: (sessionId: string) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const now = useNowWhileRunning(run.status === 'running')
  let steps: { tool: string }[] = []
  try {
    steps = JSON.parse(run.steps)
  } catch {
    /* ignore */
  }

  return (
    <div className="px-3 py-2 space-y-1.5">
      <button className="w-full flex items-center gap-2 text-left" onClick={() => setOpen(!open)}>
        {open ? (
          <ChevronDown size={12} className="text-faint shrink-0" />
        ) : (
          <ChevronRight size={12} className="text-faint shrink-0" />
        )}
        <span className={cn('w-2 h-2 rounded-full shrink-0', RUN_DOT[run.status])} />
        {showTaskName && run.task_name && (
          <span className="text-[12.5px] text-text truncate">{run.task_name}</span>
        )}
        <span className="font-mono text-[11px] text-muted">
          {new Date(run.started_at).toLocaleString([], {
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit'
          })}
        </span>
        <span className="font-mono text-[11px] text-faint">{duration(run, now)}</span>
        {steps.length > 0 && (
          <span className="font-mono text-[10.5px] text-faint">{steps.length} tools</span>
        )}
        {run.cost_usd != null && (
          <span className="font-mono text-[10.5px] text-faint">
            {fmtTokens((run.input_tokens ?? 0) + (run.output_tokens ?? 0))} tok ·{' '}
            {fmtCost(run.cost_usd)}
          </span>
        )}
        <span className="flex-1" />
        {run.session_id && run.status !== 'running' && (
          <span
            role="button"
            className="inline-flex items-center gap-1 text-[11px] text-accent hover:brightness-125 cursor-pointer"
            onClick={(e) => {
              e.stopPropagation()
              onOpenSession(run.session_id!)
            }}
          >
            <MessageSquare size={11} /> open session
          </span>
        )}
      </button>
      {open && (
        <div className="pl-6 space-y-1.5">
          {steps.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {steps.map((s, i) => (
                <span
                  key={i}
                  className="font-mono text-[10px] text-accent bg-accent/10 rounded px-1.5 py-0.5"
                >
                  {s.tool}
                </span>
              ))}
            </div>
          )}
          {run.cost_usd != null && (
            <p className="font-mono text-[10.5px] text-faint">
              in {fmtTokens(run.input_tokens ?? 0)} · out {fmtTokens(run.output_tokens ?? 0)} ·
              cache r {fmtTokens(run.cache_read_tokens ?? 0)} / w{' '}
              {fmtTokens(run.cache_creation_tokens ?? 0)} · {fmtCost(run.cost_usd)}
              {run.model && ` · ${run.model}`}
            </p>
          )}
          {run.error && <p className="text-[12px] text-danger whitespace-pre-wrap">{run.error}</p>}
          {run.result && (
            <p className="text-[12.5px] text-muted whitespace-pre-wrap leading-relaxed max-h-72 overflow-y-auto">
              {run.result}
            </p>
          )}
          {!run.error && !run.result && run.status === 'running' && (
            <p className="text-[12px] text-faint font-mono animate-pulse">running…</p>
          )}
        </div>
      )}
    </div>
  )
}

/** per-automation token/cost rollup — the data behind "which model should this run on?" */
function UsagePanel(): React.JSX.Element | null {
  const { data: usage } = useInvoke('agentTasks:usage', [], ['agent_tasks'])
  const rows = usage?.filter((u) => u.runs_30d > 0)
  if (!rows || rows.length === 0) return null
  return (
    <div className="flex-1 min-h-0 flex flex-col gap-2">
      <span className="font-mono text-[10px] uppercase tracking-wider text-faint select-none shrink-0">
        usage · trailing 7 / 30 days
      </span>
      <div className="flex-1 min-h-0 overflow-y-auto overflow-x-auto border border-border rounded-lg bg-panel">
        <table className="w-full text-[12px]">
          <thead className="sticky top-0 bg-panel">
            <tr className="text-left font-mono text-[10px] uppercase tracking-wider text-faint">
              <th className="px-3 py-2 font-normal">automation</th>
              <th className="px-3 py-2 font-normal">model</th>
              <th className="px-3 py-2 font-normal text-right">7d runs</th>
              <th className="px-3 py-2 font-normal text-right">7d tokens</th>
              <th className="px-3 py-2 font-normal text-right">7d cost</th>
              <th className="px-3 py-2 font-normal text-right">30d runs</th>
              <th className="px-3 py-2 font-normal text-right">30d tokens</th>
              <th className="px-3 py-2 font-normal text-right">30d cost</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((u) => (
              <tr key={u.task_id}>
                <td className="px-3 py-2 text-text truncate max-w-48">{u.task_name}</td>
                <td className="px-3 py-2 font-mono text-[11px] text-muted">
                  {u.model ?? 'default'}
                </td>
                <td className="px-3 py-2 font-mono text-[11px] text-muted text-right">
                  {u.runs_7d}
                </td>
                <td className="px-3 py-2 font-mono text-[11px] text-muted text-right">
                  {fmtTokens(u.tokens_7d)}
                </td>
                <td className="px-3 py-2 font-mono text-[11px] text-muted text-right">
                  {fmtCost(u.cost_7d)}
                </td>
                <td className="px-3 py-2 font-mono text-[11px] text-muted text-right">
                  {u.runs_30d}
                </td>
                <td className="px-3 py-2 font-mono text-[11px] text-muted text-right">
                  {fmtTokens(u.tokens_30d)}
                </td>
                <td className="px-3 py-2 font-mono text-[11px] text-muted text-right">
                  {fmtCost(u.cost_30d)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-faint shrink-0">
        tokens = input + output (cache traffic excluded; cost includes everything). Runs before
        this feature shipped count as 0 tokens.
      </p>
    </div>
  )
}

function RecentActivity({
  onOpenSession
}: {
  onOpenSession: (sessionId: string) => void
}): React.JSX.Element {
  const { data: recent } = useInvoke('agentTasks:recentRuns', [20], ['agent_tasks'])
  return (
    <div className="flex-1 min-h-0 flex flex-col gap-2">
      <span className="font-mono text-[10px] uppercase tracking-wider text-faint select-none shrink-0">
        recent activity
      </span>
      <div className="flex-1 min-h-0 overflow-y-auto border border-border rounded-lg bg-panel divide-y divide-border">
        {(recent?.length ?? 0) === 0 && (
          <EmptyState>Select an automation, or create one above.</EmptyState>
        )}
        {recent?.map((r) => (
          <RunRow key={r.id} run={r} showTaskName onOpenSession={onOpenSession} />
        ))}
      </div>
    </div>
  )
}

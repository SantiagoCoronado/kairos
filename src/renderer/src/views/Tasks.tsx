import { useMemo, useState } from 'react'
import { Circle, CheckCircle2, Trash2, Plus } from 'lucide-react'
import type { Task, Area, TaskFilter } from '../../../core/types'
import { api, useInvoke } from '../lib/api'
import { Input, Button, Select, Chip, Segmented, EmptyState, cn } from '../components/ui'

type AreaFilter = Area | 'all'

const PRIORITY_LABEL: Record<number, string> = { 1: 'P1', 2: 'P2', 3: 'P3', 4: 'P4' }

export function TasksView(): React.JSX.Element {
  const [area, setArea] = useState<AreaFilter>('all')
  const [showDone, setShowDone] = useState(false)
  const [projectId, setProjectId] = useState<string>('')
  const [quickTitle, setQuickTitle] = useState('')
  const [newProjectName, setNewProjectName] = useState('')
  const [addingProject, setAddingProject] = useState(false)

  const filter = useMemo<TaskFilter>(
    () => ({
      status: showDone ? undefined : ['todo', 'in_progress'],
      area: area === 'all' ? undefined : area,
      project_id: projectId || undefined
    }),
    [area, showDone, projectId]
  )

  const { data: taskList } = useInvoke('tasks:list', [filter], ['tasks', 'projects'])
  const { data: projectList } = useInvoke('projects:list', [{}], ['projects'])

  const projectName = (id: string | null): string | undefined =>
    projectList?.find((p) => p.id === id)?.name

  const quickAdd = async (): Promise<void> => {
    const title = quickTitle.trim()
    if (!title) return
    await api.invoke('tasks:create', {
      title,
      area: area === 'all' ? 'personal' : area,
      project_id: projectId || null
    })
    setQuickTitle('')
  }

  const addProject = async (): Promise<void> => {
    const name = newProjectName.trim()
    if (!name) return
    const p = await api.invoke('projects:create', {
      name,
      area: area === 'all' ? 'personal' : area
    })
    setNewProjectName('')
    setAddingProject(false)
    setProjectId(p.id)
  }

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-4">
      <div className="flex items-center gap-2">
        <Input
          className="flex-1"
          placeholder="Add a task… (Enter)"
          value={quickTitle}
          onChange={(e) => setQuickTitle(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void quickAdd()}
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

      <div className="flex items-center gap-2">
        <Select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
          <option value="">All projects</option>
          {projectList?.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
        {addingProject ? (
          <Input
            autoFocus
            placeholder="Project name… (Enter)"
            value={newProjectName}
            onChange={(e) => setNewProjectName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void addProject()
              if (e.key === 'Escape') setAddingProject(false)
            }}
          />
        ) : (
          <Button variant="ghost" onClick={() => setAddingProject(true)}>
            <span className="inline-flex items-center gap-1">
              <Plus size={13} /> project
            </span>
          </Button>
        )}
        <div className="flex-1" />
        <Button variant="ghost" onClick={() => setShowDone(!showDone)}>
          {showDone ? 'hide done' : 'show done'}
        </Button>
      </div>

      <div className="divide-y divide-border border border-border rounded-lg bg-panel">
        {taskList?.length === 0 && <EmptyState>No tasks. Add one above.</EmptyState>}
        {taskList?.map((t) => <TaskRow key={t.id} task={t} projectName={projectName(t.project_id)} />)}
      </div>
    </div>
  )
}

function TaskRow({
  task,
  projectName
}: {
  task: Task
  projectName?: string
}): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(task.title)
  const done = task.status === 'done'

  const toggle = (): void => {
    void api.invoke('tasks:update', task.id, { status: done ? 'todo' : 'done' })
  }
  const saveTitle = (): void => {
    const v = title.trim()
    if (v && v !== task.title) void api.invoke('tasks:update', task.id, { title: v })
    setEditing(false)
  }
  const cyclePriority = (): void => {
    void api.invoke('tasks:update', task.id, { priority: (task.priority % 4) + 1 })
  }
  const setDue = (value: string): void => {
    void api.invoke('tasks:update', task.id, { due_date: value || null })
  }

  const today = new Date().toISOString().slice(0, 10)
  const overdue = !done && task.due_date !== null && task.due_date < today

  return (
    <div className="group flex items-center gap-2.5 px-3 py-2">
      <button onClick={toggle} className="text-muted hover:text-text shrink-0">
        {done ? <CheckCircle2 size={16} className="text-ok" /> : <Circle size={16} />}
      </button>

      {editing ? (
        <Input
          autoFocus
          className="flex-1 py-0.5"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={saveTitle}
          onKeyDown={(e) => {
            if (e.key === 'Enter') saveTitle()
            if (e.key === 'Escape') {
              setTitle(task.title)
              setEditing(false)
            }
          }}
        />
      ) : (
        <button
          onClick={() => setEditing(true)}
          className={cn(
            'flex-1 text-left text-[13px] truncate',
            done ? 'text-faint line-through' : 'text-text'
          )}
        >
          {task.title}
        </button>
      )}

      <div className="flex items-center gap-1.5 shrink-0">
        {projectName && <Chip>{projectName}</Chip>}
        <Chip tone={task.area === 'work' ? 'accent' : 'muted'}>{task.area}</Chip>
        <Chip tone={task.priority === 1 ? 'danger' : 'muted'} onClick={cyclePriority}>
          {PRIORITY_LABEL[task.priority]}
        </Chip>
        <input
          type="date"
          value={task.due_date ?? ''}
          onChange={(e) => setDue(e.target.value)}
          className={cn(
            'bg-transparent border-none font-mono text-[10.5px] w-[88px] focus:outline-none',
            overdue ? 'text-danger' : task.due_date ? 'text-muted' : 'text-faint opacity-0 group-hover:opacity-100'
          )}
        />
        <button
          onClick={() => void api.invoke('tasks:delete', task.id)}
          className="text-faint hover:text-danger opacity-0 group-hover:opacity-100"
        >
          <Trash2 size={14} />
        </button>
      </div>
    </div>
  )
}

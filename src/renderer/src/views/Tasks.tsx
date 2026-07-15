import { useMemo, useState } from 'react'
import { Circle, CheckCircle2, Trash2, Plus, GripVertical } from 'lucide-react'
import type { Task, Area, TaskFilter, TaskSort, TaskStatus, Project } from '../../../core/types'
import { api, useInvoke } from '../lib/api'
import { Input, Button, Select, Chip, Segmented, EmptyState, cn } from '../components/ui'
import { CaptureMic } from '../components/CaptureMic'

type AreaFilter = Area | 'all'
type ViewMode = 'list' | 'board'
type DropEdge = 'before' | 'after' | null

const PRIORITY_LABEL: Record<number, string> = { 1: 'P1', 2: 'P2', 3: 'P3', 4: 'P4' }
const VIEW_KEY = 'kairos.tasks.view'

/** read drop position from the pointer: top half = before, bottom = after */
function dropEdge(e: React.DragEvent): 'before' | 'after' {
  const rect = e.currentTarget.getBoundingClientRect()
  return e.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
}

export function TasksView(): React.JSX.Element {
  const [view, setView] = useState<ViewMode>(() =>
    localStorage.getItem(VIEW_KEY) === 'board' ? 'board' : 'list'
  )
  const [sort, setSort] = useState<TaskSort>('manual')
  const [area, setArea] = useState<AreaFilter>('all')
  const [showDone, setShowDone] = useState(false)
  const [projectId, setProjectId] = useState<string>('')
  const [quickTitle, setQuickTitle] = useState('')
  const [newProjectName, setNewProjectName] = useState('')
  const [addingProject, setAddingProject] = useState(false)

  const setViewPersisted = (v: ViewMode): void => {
    setView(v)
    localStorage.setItem(VIEW_KEY, v)
  }

  const filter = useMemo<TaskFilter>(
    () => ({
      status:
        view === 'board'
          ? ['todo', 'in_progress', 'done']
          : showDone
            ? undefined
            : ['todo', 'in_progress'],
      area: area === 'all' ? undefined : area,
      project_id: projectId || undefined,
      sort: view === 'board' ? 'manual' : sort
    }),
    [view, area, showDone, projectId, sort]
  )

  const { data: taskList } = useInvoke('tasks:list', [filter], ['tasks', 'projects'])
  const { data: projectList } = useInvoke('projects:list', [{}], ['projects'])

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

  const addToColumn = async (status: TaskStatus, title: string): Promise<void> => {
    await api.invoke('tasks:create', {
      title,
      status,
      area: area === 'all' ? 'personal' : area,
      project_id: projectId || null
    })
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

  /**
   * Drop `draggedId` before/after `target`. Dropping into a different status
   * group also adopts that group's status (list groups by status, board
   * columns ARE statuses).
   */
  const dropTask = (draggedId: string, target: Task, edge: 'before' | 'after'): void => {
    if (!taskList || draggedId === target.id) return
    const dragged = taskList.find((t) => t.id === draggedId)
    if (!dragged) return
    void (async () => {
      if (dragged.status !== target.status)
        await api.invoke('tasks:update', draggedId, { status: target.status })
      let beforeId: string | null
      if (edge === 'before') {
        beforeId = target.id
      } else {
        const rest = taskList.filter((t) => t.id !== draggedId)
        const i = rest.findIndex((t) => t.id === target.id)
        beforeId = rest[i + 1]?.id ?? null
      }
      await api.invoke('tasks:reorder', draggedId, beforeId)
    })()
  }

  return (
    <div className={cn('p-6 mx-auto space-y-4', view === 'board' ? 'max-w-5xl' : 'max-w-3xl')}>
      <div className="flex items-center gap-2">
        <Input
          className="flex-1"
          placeholder="Add a task… (Enter)"
          value={quickTitle}
          onChange={(e) => setQuickTitle(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void quickAdd()}
        />
        <CaptureMic kind="task" />
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
        {view === 'list' && (
          <Segmented
            value={sort}
            onChange={setSort}
            options={[
              { value: 'manual', label: 'Manual' },
              { value: 'due', label: 'Due' },
              { value: 'priority', label: 'Priority' }
            ]}
          />
        )}
        {view === 'list' && (
          <Button variant="ghost" onClick={() => setShowDone(!showDone)}>
            {showDone ? 'hide done' : 'show done'}
          </Button>
        )}
        <Segmented
          value={view}
          onChange={setViewPersisted}
          options={[
            { value: 'list', label: 'List' },
            { value: 'board', label: 'Board' }
          ]}
        />
      </div>

      {view === 'list' ? (
        <div className="divide-y divide-border border border-border rounded-lg bg-panel">
          {taskList?.length === 0 && <EmptyState>No tasks. Add one above.</EmptyState>}
          {taskList?.map((t) => (
            <TaskRow
              key={t.id}
              task={t}
              projects={projectList ?? []}
              draggable={sort === 'manual'}
              onDropTask={dropTask}
            />
          ))}
        </div>
      ) : (
        <TaskBoard
          tasks={taskList ?? []}
          projects={projectList ?? []}
          onDropTask={dropTask}
          onAdd={addToColumn}
        />
      )}
    </div>
  )
}

function ProjectSelect({
  task,
  projects,
  className
}: {
  task: Task
  projects: Project[]
  className?: string
}): React.JSX.Element {
  return (
    <select
      value={task.project_id ?? ''}
      onChange={(e) => void api.invoke('tasks:update', task.id, { project_id: e.target.value || null })}
      title="Move to project"
      className={cn(
        'bg-transparent border-none font-mono text-[10.5px] rounded px-1 py-0.5 max-w-[110px] truncate',
        'focus:outline-none cursor-pointer',
        task.project_id ? 'bg-raised text-muted' : 'text-faint opacity-0 group-hover:opacity-100',
        className
      )}
    >
      <option value="">no project</option>
      {projects.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
        </option>
      ))}
    </select>
  )
}

function TaskRow({
  task,
  projects,
  draggable,
  onDropTask
}: {
  task: Task
  projects: Project[]
  draggable: boolean
  onDropTask: (draggedId: string, target: Task, edge: 'before' | 'after') => void
}): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(task.title)
  const [dragArmed, setDragArmed] = useState(false)
  const [edge, setEdge] = useState<DropEdge>(null)
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
    <div
      className={cn(
        'group flex items-center gap-2.5 px-3 py-2',
        // inset shadow = drop indicator without layout shift
        edge === 'before' && 'shadow-[inset_0_2px_0_0_var(--color-accent)]',
        edge === 'after' && 'shadow-[inset_0_-2px_0_0_var(--color-accent)]'
      )}
      draggable={draggable && dragArmed}
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', task.id)
        e.dataTransfer.effectAllowed = 'move'
      }}
      onDragEnd={() => setDragArmed(false)}
      onMouseUp={() => setDragArmed(false)}
      onDragOver={(e) => {
        if (!draggable) return
        e.preventDefault()
        setEdge(dropEdge(e))
      }}
      onDragLeave={() => setEdge(null)}
      onDrop={(e) => {
        if (!draggable) return
        e.preventDefault()
        setEdge(null)
        const id = e.dataTransfer.getData('text/plain')
        if (id) onDropTask(id, task, dropEdge(e))
      }}
    >
      {draggable && (
        <span
          className="shrink-0 -ml-1 text-faint opacity-0 group-hover:opacity-100 cursor-grab active:cursor-grabbing"
          title="Drag to reorder"
          onMouseDown={() => setDragArmed(true)}
          onMouseUp={() => setDragArmed(false)}
        >
          <GripVertical size={13} />
        </span>
      )}
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
        <div className="flex-1 min-w-0 flex items-stretch">
          <button
            onClick={() => setEditing(true)}
            className={cn(
              'text-left text-[13px] truncate min-w-0',
              done ? 'text-faint line-through' : 'text-text'
            )}
          >
            {task.title}
          </button>
          {/* Notion-style: the empty space after the title drags the row */}
          <div
            className={cn('flex-1 min-w-3', draggable && 'cursor-grab active:cursor-grabbing')}
            onMouseDown={() => draggable && setDragArmed(true)}
            onMouseUp={() => setDragArmed(false)}
          />
        </div>
      )}

      <div className="flex items-center gap-1.5 shrink-0">
        <ProjectSelect task={task} projects={projects} />
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

// ---------- kanban board ----------

const COLUMNS: { status: TaskStatus; label: string }[] = [
  { status: 'todo', label: 'To do' },
  { status: 'in_progress', label: 'In progress' },
  { status: 'done', label: 'Done' }
]

function TaskBoard({
  tasks,
  projects,
  onDropTask,
  onAdd
}: {
  tasks: Task[]
  projects: Project[]
  onDropTask: (draggedId: string, target: Task, edge: 'before' | 'after') => void
  onAdd: (status: TaskStatus, title: string) => Promise<void>
}): React.JSX.Element {
  const [dragOver, setDragOver] = useState<TaskStatus | null>(null)
  const [addingCol, setAddingCol] = useState<TaskStatus | null>(null)
  const [newTitle, setNewTitle] = useState('')

  const submitAdd = (status: TaskStatus): void => {
    const title = newTitle.trim()
    if (!title) {
      setAddingCol(null)
      return
    }
    // keep the input open so several cards can be added in a row
    void onAdd(status, title)
    setNewTitle('')
  }

  const dropOnColumn = (e: React.DragEvent, status: TaskStatus): void => {
    e.preventDefault()
    setDragOver(null)
    const id = e.dataTransfer.getData('text/plain')
    const task = tasks.find((t) => t.id === id)
    if (id && task && task.status !== status) {
      void api.invoke('tasks:update', id, { status })
    }
  }

  return (
    <div className="grid grid-cols-3 gap-3 items-start">
      {COLUMNS.map((col) => {
        const colTasks = tasks.filter((t) => t.status === col.status)
        return (
          <div
            key={col.status}
            onDragOver={(e) => {
              e.preventDefault()
              setDragOver(col.status)
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(null)
            }}
            onDrop={(e) => dropOnColumn(e, col.status)}
            className={cn(
              'rounded-lg border bg-panel p-2 space-y-1.5 min-h-[160px] transition-colors',
              dragOver === col.status ? 'border-accent/60 bg-accent/5' : 'border-border'
            )}
          >
            <div className="group/col flex items-center justify-between px-1 pb-1 select-none">
              <span className="font-mono text-[10px] uppercase tracking-wider text-faint">
                {col.label}
              </span>
              <span className="flex items-center gap-1.5">
                <button
                  title={`Add to ${col.label}`}
                  onClick={() => {
                    setAddingCol(col.status)
                    setNewTitle('')
                  }}
                  className="text-faint hover:text-text opacity-0 group-hover/col:opacity-100"
                >
                  <Plus size={12} />
                </button>
                <span className="font-mono text-[10px] text-faint">{colTasks.length}</span>
              </span>
            </div>
            {addingCol === col.status && (
              <Input
                autoFocus
                className="py-1 text-[12.5px]"
                placeholder={`Add to ${col.label.toLowerCase()}… (Enter)`}
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submitAdd(col.status)
                  if (e.key === 'Escape') setAddingCol(null)
                }}
                onBlur={() => {
                  if (!newTitle.trim()) setAddingCol(null)
                }}
              />
            )}
            {colTasks.map((t) => (
              <BoardCard key={t.id} task={t} projects={projects} onDropTask={onDropTask} />
            ))}
            {colTasks.length === 0 && (
              <p className="text-center text-[11.5px] text-faint py-6 select-none">drop here</p>
            )}
          </div>
        )
      })}
    </div>
  )
}

function BoardCard({
  task,
  projects,
  onDropTask
}: {
  task: Task
  projects: Project[]
  onDropTask: (draggedId: string, target: Task, edge: 'before' | 'after') => void
}): React.JSX.Element {
  const [edge, setEdge] = useState<DropEdge>(null)
  const done = task.status === 'done'
  const today = new Date().toISOString().slice(0, 10)
  const overdue = !done && task.due_date !== null && task.due_date < today

  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', task.id)
        e.dataTransfer.effectAllowed = 'move'
      }}
      onDragOver={(e) => {
        e.preventDefault()
        e.stopPropagation()
        setEdge(dropEdge(e))
      }}
      onDragLeave={() => setEdge(null)}
      onDrop={(e) => {
        e.preventDefault()
        e.stopPropagation() // the column handler must not also fire
        setEdge(null)
        const id = e.dataTransfer.getData('text/plain')
        if (id) onDropTask(id, task, dropEdge(e))
      }}
      className={cn(
        'group border border-border rounded-md bg-raised/60 px-2.5 py-2 space-y-1.5 cursor-grab active:cursor-grabbing',
        edge === 'before' && 'shadow-[0_-2px_0_0_var(--color-accent)]',
        edge === 'after' && 'shadow-[0_2px_0_0_var(--color-accent)]'
      )}
    >
      <div className="flex items-start gap-2">
        <button
          onClick={() =>
            void api.invoke('tasks:update', task.id, { status: done ? 'todo' : 'done' })
          }
          className="text-muted hover:text-text shrink-0 mt-0.5"
        >
          {done ? <CheckCircle2 size={14} className="text-ok" /> : <Circle size={14} />}
        </button>
        <span
          className={cn(
            'flex-1 text-[12.5px] leading-snug',
            done ? 'text-faint line-through' : 'text-text'
          )}
        >
          {task.title}
        </span>
        <button
          onClick={() => void api.invoke('tasks:delete', task.id)}
          className="text-faint hover:text-danger opacity-0 group-hover:opacity-100 shrink-0"
        >
          <Trash2 size={13} />
        </button>
      </div>
      <div className="flex items-center gap-1.5 flex-wrap pl-6">
        <ProjectSelect task={task} projects={projects} />
        <Chip tone={task.priority === 1 ? 'danger' : 'muted'}>{PRIORITY_LABEL[task.priority]}</Chip>
        {task.due_date && (
          <span className={cn('font-mono text-[10px]', overdue ? 'text-danger' : 'text-faint')}>
            {task.due_date}
          </span>
        )}
      </div>
    </div>
  )
}

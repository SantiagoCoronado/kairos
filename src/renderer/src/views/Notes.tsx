import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Pin,
  PinOff,
  Archive,
  ArchiveRestore,
  Trash2,
  Bell,
  BellOff,
  Palette,
  Copy,
  Plus,
  X,
  Square,
  CheckSquare,
  ListChecks,
  Sparkles
} from 'lucide-react'
import type { Note, NoteItem, NoteRepeat, NotePatch, NoteFilter } from '../../../core/types'
import { api, useInvoke } from '../lib/api'
import { Input, Button, Select, Chip, Segmented, EmptyState, cn } from '../components/ui'

const DRAFT_KEY = 'kairos.notes.draft'

// desaturated tints that sit on the monochrome theme; keys stored in the DB
const COLORS: { key: string; tint: string }[] = [
  { key: 'red', tint: '#7f1d1d' },
  { key: 'amber', tint: '#78350f' },
  { key: 'green', tint: '#14532d' },
  { key: 'blue', tint: '#1e3a5f' },
  { key: 'purple', tint: '#4c1d95' },
  { key: 'grey', tint: '#374151' }
]
const tintOf = (key: string | null): string | undefined =>
  COLORS.find((c) => c.key === key)?.tint

const REPEAT_LABEL: Record<NoteRepeat, string> = {
  none: 'Does not repeat',
  daily: 'Daily',
  weekly: 'Weekly',
  monthly: 'Monthly',
  yearly: 'Yearly'
}

// ---------- datetime helpers (remind_at is stored as UTC ISO) ----------

function toLocalInput(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
const fromLocalInput = (v: string): string => new Date(v).toISOString()

function presetLaterToday(): Date {
  const d = new Date()
  d.setHours(18, 0, 0, 0)
  if (d.getTime() <= Date.now()) d.setHours(20, 0, 0, 0)
  return d
}
function presetTomorrow(): Date {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  d.setHours(9, 0, 0, 0)
  return d
}
function presetNextWeek(): Date {
  const d = new Date()
  d.setDate(d.getDate() + 7)
  d.setHours(9, 0, 0, 0)
  return d
}

function fmtReminder(iso: string): string {
  const d = new Date(iso)
  const today = new Date()
  const sameDay = d.toDateString() === today.toDateString()
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  if (sameDay) return time
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`
}

// ---------- misc helpers ----------

const URL_SPLIT_RE = /(https?:\/\/[^\s]+)/g

function Linkified({ text }: { text: string }): React.JSX.Element {
  const parts = text.split(URL_SPLIT_RE)
  return (
    <>
      {parts.map((p, i) =>
        /^https?:\/\//.test(p) ? (
          <a
            key={i}
            href={p}
            target="_blank"
            rel="noreferrer"
            className="text-accent underline underline-offset-2 break-all"
            onClick={(e) => e.stopPropagation()}
          >
            {p}
          </a>
        ) : (
          <span key={i}>{p}</span>
        )
      )}
    </>
  )
}

function noteToClipboard(n: Note): string {
  const lines: string[] = []
  if (n.title) lines.push(n.title)
  if (n.content) lines.push(n.content)
  for (const it of n.items) lines.push(`- [${it.done ? 'x' : ' '}] ${it.text}`)
  return lines.join('\n')
}

/** read drop position from the pointer: top half = before, bottom = after */
function dropEdge(e: React.DragEvent): 'before' | 'after' {
  const rect = e.currentTarget.getBoundingClientRect()
  return e.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
}

// ---------- view ----------

export function NotesView({
  onOpenSession
}: {
  onOpenSession: (sessionId: string) => void
}): React.JSX.Element {
  const [search, setSearch] = useState('')
  const [label, setLabel] = useState<string>('')
  const [bucket, setBucket] = useState<'active' | 'archived'>('active')
  const [editing, setEditing] = useState<Note | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [undo, setUndo] = useState<{ id: string; label: string } | null>(null)
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const filter = useMemo<NoteFilter>(
    () => ({
      archived: bucket === 'archived',
      label: label || undefined,
      search: search.trim() || undefined
    }),
    [bucket, label, search]
  )
  const { data: noteList } = useInvoke('notes:list', [filter], ['notes'])
  const { data: labels } = useInvoke('notes:labels', [], ['notes'])

  // keep the editor in sync when the underlying note changes (e.g. item toggle)
  useEffect(() => {
    if (editing && noteList) {
      const fresh = noteList.find((n) => n.id === editing.id)
      if (fresh && fresh.updated_at !== editing.updated_at) setEditing(fresh)
    }
  }, [noteList]) // eslint-disable-line react-hooks/exhaustive-deps

  const showUndo = (id: string, message: string): void => {
    if (undoTimer.current) clearTimeout(undoTimer.current)
    setUndo({ id, label: message })
    undoTimer.current = setTimeout(() => setUndo(null), 6000)
  }

  const archive = (n: Note): void => {
    void api.invoke('notes:update', n.id, { archived: true })
    showUndo(n.id, 'Note archived')
  }
  const undoArchive = (): void => {
    if (undo) void api.invoke('notes:update', undo.id, { archived: false })
    setUndo(null)
  }

  const dropNote = (draggedId: string, target: Note, edge: 'before' | 'after'): void => {
    if (!noteList || draggedId === target.id) return
    void (async () => {
      let beforeId: string | null
      if (edge === 'before') {
        beforeId = target.id
      } else {
        const rest = noteList.filter((n) => n.id !== draggedId)
        const i = rest.findIndex((n) => n.id === target.id)
        beforeId = rest[i + 1]?.id ?? null
      }
      await api.invoke('notes:reorder', draggedId, beforeId)
    })()
  }

  // manual drag order only makes sense in the unfiltered active view
  const draggable = bucket === 'active' && !search.trim() && !label && selected.size === 0
  const pinnedNotes = noteList?.filter((n) => n.pinned) ?? []
  const otherNotes = noteList?.filter((n) => !n.pinned) ?? []

  const toggleSelect = (id: string): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const bulk = async (patch: { pinned?: boolean; archived?: boolean }): Promise<void> => {
    await Promise.all([...selected].map((id) => api.invoke('notes:update', id, patch)))
    setSelected(new Set())
  }
  const bulkDelete = async (): Promise<void> => {
    await Promise.all([...selected].map((id) => api.invoke('notes:delete', id)))
    setSelected(new Set())
  }

  return (
    <div className="p-6 mx-auto max-w-5xl space-y-4">
      <div className="flex items-center gap-2">
        <Input
          className="flex-1"
          placeholder="Search notes…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <Segmented
          value={bucket}
          onChange={setBucket}
          options={[
            { value: 'active', label: 'Notes' },
            { value: 'archived', label: 'Archived' }
          ]}
        />
      </div>

      {(labels?.length ?? 0) > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap">
          {labels!.map((t) => (
            <Chip key={t} tone={label === t ? 'accent' : 'muted'} onClick={() => setLabel(label === t ? '' : t)}>
              {t}
            </Chip>
          ))}
        </div>
      )}

      {bucket === 'active' && <Composer />}

      {noteList?.length === 0 && (
        <EmptyState>
          {bucket === 'archived' ? 'No archived notes.' : 'No notes yet. Capture one above.'}
        </EmptyState>
      )}

      {pinnedNotes.length > 0 && (
        <NoteGrid
          heading="pinned"
          notes={pinnedNotes}
          draggable={draggable}
          selected={selected}
          onOpen={setEditing}
          onToggleSelect={toggleSelect}
          onArchive={archive}
          onDrop={dropNote}
          onOpenSession={onOpenSession}
        />
      )}
      {otherNotes.length > 0 && (
        <NoteGrid
          heading={pinnedNotes.length > 0 ? 'others' : undefined}
          notes={otherNotes}
          draggable={draggable}
          selected={selected}
          onOpen={setEditing}
          onToggleSelect={toggleSelect}
          onArchive={archive}
          onDrop={dropNote}
          onOpenSession={onOpenSession}
        />
      )}

      {editing && <NoteEditor note={editing} onClose={() => setEditing(null)} />}

      <div className="fixed bottom-5 left-1/2 -translate-x-1/2 z-50 flex flex-col items-center gap-2">
        {selected.size > 0 && (
          <div className="flex items-center gap-3 bg-overlay border border-border-strong rounded-lg shadow-2xl px-4 py-2.5">
            <span className="font-mono text-[11px] text-muted">{selected.size} selected</span>
            <button
              className="text-[13px] text-muted hover:text-text inline-flex items-center gap-1"
              onClick={() => void bulk({ pinned: true })}
            >
              <Pin size={12} /> pin
            </button>
            <button
              className="text-[13px] text-muted hover:text-text inline-flex items-center gap-1"
              onClick={() => void bulk({ archived: bucket === 'active' })}
            >
              <Archive size={12} /> {bucket === 'active' ? 'archive' : 'unarchive'}
            </button>
            <button
              className="text-[13px] text-danger hover:brightness-125 inline-flex items-center gap-1"
              onClick={() => void bulkDelete()}
            >
              <Trash2 size={12} /> delete
            </button>
            <button className="text-faint hover:text-text" onClick={() => setSelected(new Set())}>
              <X size={13} />
            </button>
          </div>
        )}
        {undo && (
          <div className="flex items-center gap-3 bg-overlay border border-border-strong rounded-lg shadow-2xl px-4 py-2.5">
            <span className="text-[13px] text-text">{undo.label}</span>
            <button className="text-[13px] text-accent hover:brightness-125" onClick={undoArchive}>
              Undo
            </button>
            <button className="text-faint hover:text-text" onClick={() => setUndo(null)}>
              <X size={13} />
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

// ---------- masonry grid ----------

function NoteGrid({
  heading,
  notes,
  draggable,
  selected,
  onOpen,
  onToggleSelect,
  onArchive,
  onDrop,
  onOpenSession
}: {
  heading?: string
  notes: Note[]
  draggable: boolean
  selected: Set<string>
  onOpen: (n: Note) => void
  onToggleSelect: (id: string) => void
  onArchive: (n: Note) => void
  onDrop: (draggedId: string, target: Note, edge: 'before' | 'after') => void
  onOpenSession: (sessionId: string) => void
}): React.JSX.Element {
  return (
    <div className="space-y-2">
      {heading && (
        <span className="font-mono text-[10px] uppercase tracking-wider text-faint select-none">
          {heading}
        </span>
      )}
      <div className="columns-2 lg:columns-3 gap-3 [&>*]:mb-3">
        {notes.map((n) => (
          <NoteCard
            key={n.id}
            note={n}
            draggable={draggable}
            selected={selected.has(n.id)}
            selectMode={selected.size > 0}
            onOpen={() => onOpen(n)}
            onToggleSelect={() => onToggleSelect(n.id)}
            onArchive={() => onArchive(n)}
            onDrop={onDrop}
            onOpenSession={onOpenSession}
          />
        ))}
      </div>
    </div>
  )
}

function NoteCard({
  note,
  draggable,
  selected,
  selectMode,
  onOpen,
  onToggleSelect,
  onArchive,
  onDrop,
  onOpenSession
}: {
  note: Note
  draggable: boolean
  selected: boolean
  selectMode: boolean
  onOpen: () => void
  onToggleSelect: () => void
  onArchive: () => void
  onDrop: (draggedId: string, target: Note, edge: 'before' | 'after') => void
  onOpenSession: (sessionId: string) => void
}): React.JSX.Element {
  const [edge, setEdge] = useState<'before' | 'after' | null>(null)
  const [showPalette, setShowPalette] = useState(false)
  const tint = tintOf(note.color)
  const archived = note.archived === 1

  const solve = (itemIndex?: number): void => {
    void api.invoke('notes:solve', note.id, itemIndex).then(({ sessionId }) => onOpenSession(sessionId))
  }

  const overdue = note.remind_at !== null && new Date(note.remind_at).getTime() <= Date.now()
  const labelList = note.labels ? note.labels.split(/\s+/).filter(Boolean) : []
  const pending = note.items.filter((it) => !it.done)
  const doneItems = note.items.filter((it) => it.done)

  return (
    <div
      draggable={draggable}
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', note.id)
        e.dataTransfer.effectAllowed = 'move'
      }}
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
        if (id) onDrop(id, note, dropEdge(e))
      }}
      onClick={(e) => {
        // ⌘-click (or any click while a selection exists) toggles selection
        if (e.metaKey || e.ctrlKey || selectMode) onToggleSelect()
        else onOpen()
      }}
      className={cn(
        'group break-inside-avoid border rounded-lg bg-panel p-3 space-y-2 cursor-pointer',
        'hover:border-border-strong transition-colors',
        selected ? 'border-accent' : 'border-border',
        edge === 'before' && 'shadow-[inset_0_2px_0_0_var(--color-accent)]',
        edge === 'after' && 'shadow-[inset_0_-2px_0_0_var(--color-accent)]'
      )}
      style={tint ? { backgroundColor: `${tint}40` } : undefined}
    >
      {(note.title || note.pinned === 1) && (
        <div className="flex items-start gap-2">
          {note.title && (
            <span className="flex-1 text-[13.5px] font-medium text-text leading-snug">
              {note.title}
            </span>
          )}
          {note.pinned === 1 && <Pin size={12} className="text-accent shrink-0 mt-0.5" />}
        </div>
      )}

      {note.content && (
        <p className="text-[12.5px] text-muted leading-relaxed whitespace-pre-wrap break-words max-h-64 overflow-hidden">
          <Linkified text={note.content} />
        </p>
      )}

      {note.items.length > 0 && (
        <div className="space-y-1">
          {[...pending, ...doneItems].slice(0, 12).map((it) => {
            const idx = note.items.indexOf(it)
            return (
              <div key={idx} className="group/item flex items-start gap-1.5">
                <button
                  className="flex items-start gap-1.5 flex-1 min-w-0 text-left"
                  onClick={(e) => {
                    e.stopPropagation()
                    void api.invoke('notes:toggleItem', note.id, idx)
                  }}
                >
                  {it.done ? (
                    <CheckSquare size={13} className="text-ok shrink-0 mt-0.5" />
                  ) : (
                    <Square size={13} className="text-muted shrink-0 mt-0.5" />
                  )}
                  <span
                    className={cn(
                      'text-[12.5px] leading-snug',
                      it.done ? 'text-faint line-through' : 'text-muted'
                    )}
                  >
                    {it.text}
                  </span>
                </button>
                {!it.done && !archived && (
                  <button
                    title="Solve this item with the agent"
                    className="shrink-0 mt-0.5 text-faint hover:text-accent opacity-0 group-hover/item:opacity-100"
                    onClick={(e) => {
                      e.stopPropagation()
                      solve(idx)
                    }}
                  >
                    <Sparkles size={11} />
                  </button>
                )}
              </div>
            )
          })}
          {note.items.length > 12 && (
            <span className="text-[11px] text-faint">+{note.items.length - 12} more</span>
          )}
        </div>
      )}

      {(note.remind_at || labelList.length > 0 || note.agent_session_id) && (
        <div className="flex items-center gap-1.5 flex-wrap" onClick={(e) => e.stopPropagation()}>
          {note.remind_at && (
            <Chip tone={overdue ? 'danger' : 'accent'}>
              <Bell size={10} />
              {fmtReminder(note.remind_at)}
              {note.repeat !== 'none' && ` · ${note.repeat}`}
            </Chip>
          )}
          {note.agent_session_id && (
            <Chip tone="accent" onClick={() => onOpenSession(note.agent_session_id!)}>
              <Sparkles size={10} /> agent
            </Chip>
          )}
          {labelList.map((t) => (
            <Chip key={t}>{t}</Chip>
          ))}
        </div>
      )}

      {/* hover actions */}
      <div
        className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity relative"
        onClick={(e) => e.stopPropagation()}
      >
        <IconBtn
          title={note.pinned === 1 ? 'Unpin' : 'Pin'}
          onClick={() => void api.invoke('notes:update', note.id, { pinned: note.pinned !== 1 })}
        >
          {note.pinned === 1 ? <PinOff size={13} /> : <Pin size={13} />}
        </IconBtn>
        <IconBtn title="Color" onClick={() => setShowPalette((s) => !s)}>
          <Palette size={13} />
        </IconBtn>
        <IconBtn
          title="Copy to clipboard"
          onClick={() => void navigator.clipboard.writeText(noteToClipboard(note))}
        >
          <Copy size={13} />
        </IconBtn>
        {!archived && (
          <IconBtn title="Solve with agent" onClick={() => solve()}>
            <Sparkles size={13} />
          </IconBtn>
        )}
        {archived ? (
          <IconBtn
            title="Unarchive"
            onClick={() => void api.invoke('notes:update', note.id, { archived: false })}
          >
            <ArchiveRestore size={13} />
          </IconBtn>
        ) : (
          <IconBtn title="Archive" onClick={onArchive}>
            <Archive size={13} />
          </IconBtn>
        )}
        <IconBtn title="Delete" danger onClick={() => void api.invoke('notes:delete', note.id)}>
          <Trash2 size={13} />
        </IconBtn>

        {showPalette && (
          <div className="absolute bottom-6 left-0 z-10 flex items-center gap-1.5 bg-overlay border border-border-strong rounded-lg shadow-xl px-2 py-1.5">
            <button
              title="No color"
              className={cn(
                'w-4 h-4 rounded-full border',
                note.color === null ? 'border-accent' : 'border-border-strong'
              )}
              onClick={() => {
                void api.invoke('notes:update', note.id, { color: null })
                setShowPalette(false)
              }}
            />
            {COLORS.map((c) => (
              <button
                key={c.key}
                title={c.key}
                className={cn(
                  'w-4 h-4 rounded-full border',
                  note.color === c.key ? 'border-accent' : 'border-transparent'
                )}
                style={{ backgroundColor: c.tint }}
                onClick={() => {
                  void api.invoke('notes:update', note.id, { color: c.key })
                  setShowPalette(false)
                }}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function IconBtn({
  children,
  title,
  danger,
  onClick
}: {
  children: React.ReactNode
  title: string
  danger?: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      title={title}
      onClick={onClick}
      className={cn(
        'p-1 rounded text-faint transition-colors',
        danger ? 'hover:text-danger' : 'hover:text-text'
      )}
    >
      {children}
    </button>
  )
}

// ---------- composer ----------

interface Draft {
  title: string
  content: string
  items: NoteItem[]
  checklist: boolean
  labels: string
}

const EMPTY_DRAFT: Draft = { title: '', content: '', items: [], checklist: false, labels: '' }

function loadDraft(): Draft | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY)
    return raw ? { ...EMPTY_DRAFT, ...(JSON.parse(raw) as Draft) } : null
  } catch {
    return null
  }
}

function Composer(): React.JSX.Element {
  const [open, setOpen] = useState(() => loadDraft() !== null)
  const [draft, setDraft] = useState<Draft>(() => loadDraft() ?? EMPTY_DRAFT)
  const [newItem, setNewItem] = useState('')

  // autosave the in-progress draft so an accidental close never loses it
  useEffect(() => {
    if (!open) return
    const empty =
      !draft.title && !draft.content && draft.items.length === 0 && !draft.labels
    if (empty) localStorage.removeItem(DRAFT_KEY)
    else localStorage.setItem(DRAFT_KEY, JSON.stringify(draft))
  }, [draft, open])

  const reset = (): void => {
    setDraft(EMPTY_DRAFT)
    setNewItem('')
    setOpen(false)
    localStorage.removeItem(DRAFT_KEY)
  }

  const save = async (): Promise<void> => {
    const items = [...draft.items, ...(newItem.trim() ? [{ text: newItem.trim(), done: false }] : [])]
    const hasContent = draft.title.trim() || draft.content.trim() || items.length > 0
    if (!hasContent) {
      reset()
      return
    }
    await api.invoke('notes:create', {
      title: draft.title.trim(),
      content: draft.checklist ? '' : draft.content,
      items: draft.checklist ? items : [],
      note_type: draft.checklist ? 'checklist' : 'note',
      labels: draft.labels
    })
    reset()
  }

  if (!open) {
    return (
      <div className="flex items-center gap-2">
        <Input
          className="flex-1"
          placeholder="Take a note…"
          onFocus={() => setOpen(true)}
          readOnly
        />
        <Button
          variant="ghost"
          title="New checklist"
          onClick={() => {
            setDraft({ ...EMPTY_DRAFT, checklist: true })
            setOpen(true)
          }}
        >
          <span className="inline-flex items-center gap-1">
            <ListChecks size={13} /> list
          </span>
        </Button>
      </div>
    )
  }

  return (
    <div className="border border-border-strong rounded-lg bg-panel p-3 space-y-2">
      <input
        autoFocus
        className="w-full bg-transparent text-[13.5px] font-medium text-text placeholder:text-faint focus:outline-none"
        placeholder="Title"
        value={draft.title}
        onChange={(e) => setDraft({ ...draft, title: e.target.value })}
      />
      {draft.checklist ? (
        <div className="space-y-1">
          {draft.items.map((it, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <button
                onClick={() =>
                  setDraft({
                    ...draft,
                    items: draft.items.map((x, j) => (j === i ? { ...x, done: !x.done } : x))
                  })
                }
              >
                {it.done ? (
                  <CheckSquare size={13} className="text-ok" />
                ) : (
                  <Square size={13} className="text-muted" />
                )}
              </button>
              <input
                className={cn(
                  'flex-1 bg-transparent text-[12.5px] focus:outline-none',
                  it.done ? 'text-faint line-through' : 'text-text'
                )}
                value={it.text}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    items: draft.items.map((x, j) => (j === i ? { ...x, text: e.target.value } : x))
                  })
                }
              />
              <button
                className="text-faint hover:text-danger"
                onClick={() => setDraft({ ...draft, items: draft.items.filter((_, j) => j !== i) })}
              >
                <X size={12} />
              </button>
            </div>
          ))}
          <div className="flex items-center gap-1.5">
            <Plus size={13} className="text-faint" />
            <input
              className="flex-1 bg-transparent text-[12.5px] text-text placeholder:text-faint focus:outline-none"
              placeholder="List item… (Enter)"
              value={newItem}
              onChange={(e) => setNewItem(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && newItem.trim()) {
                  setDraft({ ...draft, items: [...draft.items, { text: newItem.trim(), done: false }] })
                  setNewItem('')
                }
              }}
            />
          </div>
        </div>
      ) : (
        <textarea
          className="w-full bg-transparent text-[12.5px] text-muted placeholder:text-faint focus:outline-none resize-none min-h-[60px]"
          placeholder="Take a note…"
          value={draft.content}
          onChange={(e) => setDraft({ ...draft, content: e.target.value })}
        />
      )}
      <div className="flex items-center gap-2">
        <input
          className="flex-1 bg-transparent font-mono text-[11px] text-muted placeholder:text-faint focus:outline-none"
          placeholder="#labels"
          value={draft.labels}
          onChange={(e) => setDraft({ ...draft, labels: e.target.value })}
        />
        <Button
          variant="ghost"
          onClick={() => setDraft({ ...draft, checklist: !draft.checklist })}
          title={draft.checklist ? 'Switch to note' : 'Switch to checklist'}
        >
          <ListChecks size={13} />
        </Button>
        <Button variant="ghost" onClick={reset}>
          discard
        </Button>
        <Button variant="accent" onClick={() => void save()}>
          Save
        </Button>
      </div>
    </div>
  )
}

// ---------- editor modal ----------

function NoteEditor({ note, onClose }: { note: Note; onClose: () => void }): React.JSX.Element {
  const [title, setTitle] = useState(note.title)
  const [content, setContent] = useState(note.content)
  const [items, setItems] = useState<NoteItem[]>(note.items)
  const [checklist, setChecklist] = useState(note.note_type === 'checklist')
  const [labels, setLabels] = useState(note.labels)
  const [remindAt, setRemindAt] = useState<string | null>(note.remind_at)
  const [repeat, setRepeat] = useState<NoteRepeat>(note.repeat)
  const [newItem, setNewItem] = useState('')
  const [showReminder, setShowReminder] = useState(false)

  const saveAndClose = (): void => {
    const finalItems = [
      ...items,
      ...(newItem.trim() ? [{ text: newItem.trim(), done: false }] : [])
    ]
    const patch: NotePatch = {
      title: title.trim(),
      content: checklist ? '' : content,
      items: checklist ? finalItems : [],
      note_type: checklist ? 'checklist' : 'note',
      labels,
      remind_at: remindAt,
      repeat
    }
    void api.invoke('notes:update', note.id, patch)
    onClose()
  }

  // convert between note and checklist without losing text
  const toggleType = (): void => {
    if (checklist) {
      setContent(items.map((it) => it.text).join('\n'))
      setChecklist(false)
    } else {
      setItems(
        content
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
          .map((text) => ({ text, done: false }))
      )
      setChecklist(true)
    }
  }

  const setPreset = (d: Date): void => {
    setRemindAt(d.toISOString())
    setShowReminder(false)
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center"
      onMouseDown={saveAndClose}
    >
      <div
        className="w-[540px] max-h-[85vh] overflow-y-auto bg-overlay border border-border-strong rounded-xl shadow-2xl p-5 space-y-3"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') saveAndClose()
        }}
      >
        <input
          className="w-full bg-transparent text-[15px] font-medium text-text placeholder:text-faint focus:outline-none"
          placeholder="Title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />

        {checklist ? (
          <div className="space-y-1.5">
            {items.map((it, i) => (
              <div key={i} className="flex items-center gap-2">
                <button
                  onClick={() =>
                    setItems(items.map((x, j) => (j === i ? { ...x, done: !x.done } : x)))
                  }
                >
                  {it.done ? (
                    <CheckSquare size={14} className="text-ok" />
                  ) : (
                    <Square size={14} className="text-muted" />
                  )}
                </button>
                <input
                  className={cn(
                    'flex-1 bg-transparent text-[13px] focus:outline-none',
                    it.done ? 'text-faint line-through' : 'text-text'
                  )}
                  value={it.text}
                  onChange={(e) =>
                    setItems(items.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))
                  }
                />
                <button
                  className="text-faint hover:text-danger"
                  onClick={() => setItems(items.filter((_, j) => j !== i))}
                >
                  <X size={13} />
                </button>
              </div>
            ))}
            <div className="flex items-center gap-2">
              <Plus size={14} className="text-faint" />
              <input
                className="flex-1 bg-transparent text-[13px] text-text placeholder:text-faint focus:outline-none"
                placeholder="List item… (Enter)"
                value={newItem}
                onChange={(e) => setNewItem(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && newItem.trim()) {
                    setItems([...items, { text: newItem.trim(), done: false }])
                    setNewItem('')
                  }
                }}
              />
            </div>
          </div>
        ) : (
          <textarea
            className="w-full bg-transparent text-[13px] text-muted placeholder:text-faint focus:outline-none resize-none min-h-[120px] leading-relaxed"
            placeholder="Note…"
            value={content}
            onChange={(e) => setContent(e.target.value)}
          />
        )}

        <input
          className="w-full bg-transparent font-mono text-[11.5px] text-muted placeholder:text-faint focus:outline-none"
          placeholder="#labels"
          value={labels}
          onChange={(e) => setLabels(e.target.value)}
        />

        {/* reminder */}
        <div className="space-y-2 relative">
          <div className="flex items-center gap-2">
            {remindAt ? (
              <Chip tone={new Date(remindAt).getTime() <= Date.now() ? 'danger' : 'accent'} onClick={() => setShowReminder((s) => !s)}>
                <Bell size={10} /> {fmtReminder(remindAt)}
                {repeat !== 'none' && ` · ${repeat}`}
              </Chip>
            ) : (
              <Button variant="ghost" onClick={() => setShowReminder((s) => !s)}>
                <span className="inline-flex items-center gap-1">
                  <Bell size={13} /> remind me
                </span>
              </Button>
            )}
            {remindAt && (
              <Button variant="ghost" title="Clear reminder" onClick={() => { setRemindAt(null); setRepeat('none') }}>
                <BellOff size={13} />
              </Button>
            )}
          </div>

          {showReminder && (
            <div className="absolute z-10 top-8 left-0 w-[300px] bg-overlay border border-border-strong rounded-lg shadow-2xl p-3 space-y-2">
              <PresetRow label="Later today" date={presetLaterToday()} onPick={setPreset} />
              <PresetRow label="Tomorrow" date={presetTomorrow()} onPick={setPreset} />
              <PresetRow label="Next week" date={presetNextWeek()} onPick={setPreset} />
              <div className="border-t border-border pt-2 space-y-2">
                <Input
                  type="datetime-local"
                  className="w-full"
                  value={remindAt ? toLocalInput(remindAt) : ''}
                  onChange={(e) => e.target.value && setRemindAt(fromLocalInput(e.target.value))}
                />
                <Select
                  className="w-full"
                  value={repeat}
                  onChange={(e) => setRepeat(e.target.value as NoteRepeat)}
                >
                  {(Object.keys(REPEAT_LABEL) as NoteRepeat[]).map((r) => (
                    <option key={r} value={r}>
                      {REPEAT_LABEL[r]}
                    </option>
                  ))}
                </Select>
                <Button className="w-full" onClick={() => setShowReminder(false)}>
                  Done
                </Button>
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 pt-1 border-t border-border">
          <Button variant="ghost" onClick={toggleType}>
            <span className="inline-flex items-center gap-1">
              <ListChecks size={13} /> {checklist ? 'to note' : 'to checklist'}
            </span>
          </Button>
          <div className="flex-1" />
          <Button
            variant="ghost"
            onClick={() => {
              void api.invoke('notes:delete', note.id)
              onClose()
            }}
          >
            <span className="inline-flex items-center gap-1 text-danger">
              <Trash2 size={13} /> delete
            </span>
          </Button>
          <Button variant="accent" onClick={saveAndClose}>
            Done
          </Button>
        </div>
      </div>
    </div>
  )
}

function PresetRow({
  label,
  date,
  onPick
}: {
  label: string
  date: Date
  onPick: (d: Date) => void
}): React.JSX.Element {
  return (
    <button
      className="w-full flex items-center justify-between px-2 py-1.5 rounded-md text-[13px] text-muted hover:text-text hover:bg-raised"
      onClick={() => onPick(date)}
    >
      <span>{label}</span>
      <span className="font-mono text-[11px] text-faint">
        {date.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}
      </span>
    </button>
  )
}

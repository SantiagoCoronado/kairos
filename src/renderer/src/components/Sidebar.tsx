import { useEffect, useState } from 'react'
import { Sun, Users, CheckSquare, Sparkles, Settings, PanelLeft, Inbox, StickyNote, Bot, Terminal, CalendarDays, Bell, AudioLines } from 'lucide-react'
import { SettingsModal } from './SettingsModal'
import { useResizableWidth, ResizeHandle } from './ResizeHandle'
import { useInvoke } from '../lib/api'
import { useTerminalAvailable } from '../lib/mobile'

export type ViewId =
  | 'today'
  | 'pending'
  | 'inbox'
  | 'people'
  | 'tasks'
  | 'notes'
  | 'calendar'
  | 'meetings'
  | 'automations'
  | 'chat'
  | 'terminal'

/** Sidebar toggle pinned next to the traffic lights (12px bubbles from x=18,
 *  centerline y=24). Must be rendered INSIDE a .drag-region element — the
 *  `.drag-region button` rule is what excludes it from the native drag area;
 *  a floating element overlapping the region does not reliably punch a hole. */
export function SidebarToggle({
  hidden,
  onToggle
}: {
  hidden: boolean
  onToggle: () => void
}): React.JSX.Element {
  return (
    <button
      onClick={onToggle}
      title={hidden ? 'Show sidebar (⌘B)' : 'Hide sidebar (⌘B)'}
      className="absolute left-[86px] top-[11px] h-[26px] w-[26px] rounded-md flex items-center justify-center text-muted hover:text-text hover:bg-raised transition-colors"
    >
      <PanelLeft size={15} strokeWidth={1.75} />
    </button>
  )
}

const SIDEBAR_W_KEY = 'kairos.sidebar.w'
const SIDEBAR_W = { def: 208, min: 160, max: 320 }

const NAV: { id: ViewId; label: string; icon: typeof Sun }[] = [
  { id: 'today', label: 'Today', icon: Sun },
  { id: 'pending', label: 'Pending', icon: Bell },
  { id: 'inbox', label: 'Inbox', icon: Inbox },
  { id: 'people', label: 'People', icon: Users },
  { id: 'tasks', label: 'Tasks', icon: CheckSquare },
  { id: 'notes', label: 'Notes', icon: StickyNote },
  { id: 'calendar', label: 'Calendar', icon: CalendarDays },
  { id: 'meetings', label: 'Meetings', icon: AudioLines },
  { id: 'automations', label: 'Automations', icon: Bot },
  { id: 'chat', label: 'Chat', icon: Sparkles },
  { id: 'terminal', label: 'Terminal', icon: Terminal }
]

/** ⌘1–⌘9 follow sidebar order: slot N is the Nth entry of NAV, so reordering
 *  or inserting a sidebar entry reassigns the shortcuts with it (App's key
 *  handler and the hints below both read this). Entries past the ninth have
 *  no shortcut. Hold ⌘ for a second to see the numbers in the sidebar. */
export const VIEW_ORDER: ViewId[] = NAV.map((n) => n.id)
export const SHORTCUT_SLOTS = 9
const HINT_HOLD_MS = 1000

/** True once ⌘ (or Ctrl) has been held for HINT_HOLD_MS. Clears on release
 *  and on window blur — ⌘-Tab away, or a ⌘-drag out of the window, never
 *  delivers the keyup, so blur is the only reliable end signal there. */
function useModifierHeld(): boolean {
  const [held, setHeld] = useState(false)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const clear = (): void => {
      if (timer) clearTimeout(timer)
      timer = null
      setHeld(false)
    }
    const isModifier = (e: KeyboardEvent): boolean => e.key === 'Meta' || e.key === 'Control'
    const down = (e: KeyboardEvent): void => {
      if (!isModifier(e) || e.repeat || timer) return
      timer = setTimeout(() => setHeld(true), HINT_HOLD_MS)
    }
    // only clear once no modifier survives — releasing Ctrl while ⌘ is
    // still down must not drop the hints until ⌘ itself comes up
    const up = (e: KeyboardEvent): void => {
      if (isModifier(e) && !e.metaKey && !e.ctrlKey) clear()
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', clear)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', clear)
      if (timer) clearTimeout(timer)
    }
  }, [])
  return held
}

export function Sidebar({
  view,
  onNavigate,
  onHide,
  hidden = false
}: {
  view: ViewId
  onNavigate: (v: ViewId) => void
  onHide: () => void
  /** folded to nothing (⌘B, or the Inbox writing mode) — stays mounted so
   *  the width can tween and the nav state survives */
  hidden?: boolean
}): React.JSX.Element {
  const [showSettings, setShowSettings] = useState(false)
  const { data: unread } = useInvoke('comms:unreadTotal', [], ['comms'])
  const { data: pending, reload: reloadPending } = useInvoke(
    'pending:list',
    [],
    [
      'pending',
      'tasks',
      'people',
      'interactions',
      'notes',
      'comms',
      'meetings',
      'agent_tasks',
      'calendar_events'
    ]
  )
  // due-ness moves with the clock — same tick the Pending view runs, so the
  // badge can't lag the list when a reminder crosses its remind_at
  useEffect(() => {
    const t = setInterval(reloadPending, 60_000)
    return () => clearInterval(t)
  }, [reloadPending])
  // seen-style semantics are right for threads and runs but wrong for
  // failures, which stay actionable until retried/discarded — a danger item
  // keeps the badge lit even after you've glanced at it
  const pendingBadge = pending ? (pending.unseen > 0 ? pending.unseen : pending.danger) : 0
  const { data: dueNotes } = useInvoke('notes:dueCount', [], ['notes'])
  const { data: autoActivity } = useInvoke('agentTasks:activity', [], ['agent_tasks'])
  // terminal is denied over remote access unless the user opted in — don't
  // offer it or poll its badge where it isn't reachable
  const terminalOk = useTerminalAvailable()
  const { data: termAttention } = useInvoke('terminal:attentionCount', [], ['terminal'], terminalOk)
  const nav = terminalOk ? NAV : NAV.filter((n) => n.id !== 'terminal')
  const { width, startResize } = useResizableWidth(SIDEBAR_W_KEY, SIDEBAR_W)
  const showSlots = useModifierHeld()
  return (
    <aside
      className="relative shrink-0 overflow-hidden t-fold"
      data-folded={hidden}
      style={{ width: hidden ? 0 : width }}
    >
      {/* the inner keeps its full width while the outer folds, so nothing
          reflows mid-tween; inert keeps focus and shortcuts out of it */}
      <div
        className="h-full border-r border-border surface-sidebar flex flex-col select-none t-fold-inner"
        style={{ width }}
        inert={hidden}
      >
      {/* space for macOS traffic lights */}
      <div className="drag-region h-11 shrink-0 relative">
        <SidebarToggle hidden={false} onToggle={onHide} />
      </div>
      <nav className="flex-1 px-2 py-2 space-y-0.5">
        {nav.map(({ id, label, icon: Icon }) => {
          const slot = VIEW_ORDER.indexOf(id)
          const hasSlot = slot >= 0 && slot < SHORTCUT_SLOTS
          return (
          <button
            key={id}
            onClick={() => onNavigate(id)}
            title={hasSlot ? `${label} (⌘${slot + 1})` : label}
            className={`w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-left transition-colors ${
              view === id ? 'bg-raised text-text' : 'text-muted hover:text-text hover:bg-raised/50'
            }`}
          >
            <Icon size={15} strokeWidth={1.75} />
            <span className="text-[13px] flex-1 min-w-0 truncate">{label}</span>
            {id === 'pending' && pendingBadge > 0 && (
              <span
                title={
                  (pending?.danger ?? 0) > 0
                    ? 'Something failed — a send, meeting, or automation run'
                    : undefined
                }
                className={`min-w-4 h-4 px-1 rounded-full font-mono text-[10px] flex items-center justify-center ${
                  (pending?.danger ?? 0) > 0 ? 'bg-danger/20 text-danger' : 'bg-accent/20 text-accent'
                }`}
              >
                {pendingBadge > 99 ? '99+' : pendingBadge}
              </span>
            )}
            {id === 'inbox' && (unread ?? 0) > 0 && (
              <span className="min-w-4 h-4 px-1 rounded-full bg-accent/20 text-accent font-mono text-[10px] flex items-center justify-center">
                {unread! > 99 ? '99+' : unread}
              </span>
            )}
            {id === 'notes' && (dueNotes ?? 0) > 0 && (
              <span className="min-w-4 h-4 px-1 rounded-full bg-danger/20 text-danger font-mono text-[10px] flex items-center justify-center">
                {dueNotes! > 99 ? '99+' : dueNotes}
              </span>
            )}
            {id === 'automations' && (autoActivity?.running ?? 0) > 0 && (
              <span
                title={`${autoActivity!.running} automation${autoActivity!.running > 1 ? 's' : ''} running`}
                className="w-2 h-2 rounded-full bg-accent animate-pulse"
              />
            )}
            {id === 'automations' &&
              (autoActivity?.running ?? 0) === 0 &&
              (autoActivity?.unseenFinished ?? 0) > 0 && (
                <span
                  title="Automation runs finished since you last looked"
                  className="min-w-4 h-4 px-1 rounded-full bg-accent/20 text-accent font-mono text-[10px] flex items-center justify-center"
                >
                  {autoActivity!.unseenFinished > 99 ? '99+' : autoActivity!.unseenFinished}
                </span>
              )}
            {id === 'terminal' && (termAttention ?? 0) > 0 && (
              <span
                title="A terminal rang the bell (agent finished)"
                className="min-w-4 h-4 px-1 rounded-full bg-accent/20 text-accent font-mono text-[10px] flex items-center justify-center"
              >
                {termAttention! > 99 ? '99+' : termAttention}
              </span>
            )}
            {hasSlot && (
              <kbd
                aria-hidden
                className={`shrink-0 font-mono text-[10px] tabular-nums text-faint transition-opacity duration-150 ${
                  showSlots ? 'opacity-100' : 'opacity-0'
                }`}
              >
                ⌘{slot + 1}
              </kbd>
            )}
          </button>
          )
        })}
      </nav>
      <div className="px-4 py-3 border-t border-border flex items-center justify-between">
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-faint">
          kairos
        </span>
        <button
          className="text-faint hover:text-text"
          title="Settings"
          onClick={() => setShowSettings(true)}
        >
          <Settings size={13} />
        </button>
      </div>
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
      </div>
      {!hidden && <ResizeHandle onMouseDown={startResize} />}
    </aside>
  )
}

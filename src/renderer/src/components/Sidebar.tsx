import { useState } from 'react'
import { Sun, Users, CheckSquare, Target, Sparkles, Settings, PanelLeft, Inbox, StickyNote, Bot, Terminal, CalendarDays } from 'lucide-react'
import { SettingsModal } from './SettingsModal'
import { useInvoke } from '../lib/api'

export type ViewId =
  | 'today'
  | 'inbox'
  | 'people'
  | 'tasks'
  | 'notes'
  | 'calendar'
  | 'objectives'
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

const NAV: { id: ViewId; label: string; icon: typeof Sun }[] = [
  { id: 'today', label: 'Today', icon: Sun },
  { id: 'inbox', label: 'Inbox', icon: Inbox },
  { id: 'people', label: 'People', icon: Users },
  { id: 'tasks', label: 'Tasks', icon: CheckSquare },
  { id: 'notes', label: 'Notes', icon: StickyNote },
  { id: 'calendar', label: 'Calendar', icon: CalendarDays },
  { id: 'objectives', label: 'Objectives', icon: Target },
  { id: 'automations', label: 'Automations', icon: Bot },
  { id: 'chat', label: 'Chat', icon: Sparkles },
  { id: 'terminal', label: 'Terminal', icon: Terminal }
]

export function Sidebar({
  view,
  onNavigate,
  onHide
}: {
  view: ViewId
  onNavigate: (v: ViewId) => void
  onHide: () => void
}): React.JSX.Element {
  const [showSettings, setShowSettings] = useState(false)
  const { data: unread } = useInvoke('comms:unreadTotal', [], ['comms'])
  const { data: dueNotes } = useInvoke('notes:dueCount', [], ['notes'])
  return (
    <aside className="w-52 shrink-0 border-r border-border surface-sidebar flex flex-col select-none">
      {/* space for macOS traffic lights */}
      <div className="drag-region h-11 shrink-0 relative">
        <SidebarToggle hidden={false} onToggle={onHide} />
      </div>
      <nav className="flex-1 px-2 py-2 space-y-0.5">
        {NAV.map(({ id, label, icon: Icon }, i) => (
          <button
            key={id}
            onClick={() => onNavigate(id)}
            title={`${label} (⌘${i + 1})`}
            className={`w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-left transition-colors ${
              view === id ? 'bg-raised text-text' : 'text-muted hover:text-text hover:bg-raised/50'
            }`}
          >
            <Icon size={15} strokeWidth={1.75} />
            <span className="text-[13px] flex-1">{label}</span>
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
          </button>
        ))}
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
    </aside>
  )
}

import { Sun, Inbox, Sparkles, StickyNote, CalendarDays, Terminal } from 'lucide-react'
import type { ViewId } from './Sidebar'
import { useInvoke } from '../lib/api'
import { useTerminalAvailable } from '../lib/mobile'

const BASE_TABS: { id: ViewId; label: string; icon: typeof Sun }[] = [
  { id: 'today', label: 'Today', icon: Sun },
  { id: 'inbox', label: 'Inbox', icon: Inbox },
  { id: 'calendar', label: 'Calendar', icon: CalendarDays },
  { id: 'chat', label: 'Chat', icon: Sparkles },
  { id: 'notes', label: 'Notes', icon: StickyNote }
]
const TERMINAL_TAB = { id: 'terminal' as ViewId, label: 'Terminal', icon: Terminal }

/** Floating liquid-glass tab bar — the phone's whole navigation. Sits above
 *  the home indicator via the safe-area inset. */
export function MobileTabBar({
  view,
  onNavigate
}: {
  view: ViewId
  onNavigate: (v: ViewId) => void
}): React.JSX.Element {
  const { data: unread } = useInvoke('comms:unreadTotal', [], ['comms'])
  const { data: dueNotes } = useInvoke('notes:dueCount', [], ['notes'])
  const terminalOk = useTerminalAvailable()
  const tabs = terminalOk ? [...BASE_TABS, TERMINAL_TAB] : BASE_TABS
  const badge = (id: ViewId): number =>
    id === 'inbox' ? (unread ?? 0) : id === 'notes' ? (dueNotes ?? 0) : 0

  return (
    <nav
      className="glass fixed inset-x-4 z-40 rounded-3xl flex shadow-2xl select-none"
      style={{ bottom: 'calc(0.75rem + env(safe-area-inset-bottom))' }}
    >
      {tabs.map(({ id, label, icon: Icon }) => {
        const n = badge(id)
        const active = view === id || (id === 'today' && view === 'people')
        return (
          <button
            key={id}
            onClick={() => onNavigate(id)}
            className={`flex-1 flex flex-col items-center gap-0.5 py-2.5 rounded-3xl transition-colors ${
              active ? 'text-accent' : 'text-muted active:text-text'
            }`}
          >
            <span className="relative">
              <Icon size={20} strokeWidth={active ? 2 : 1.75} />
              {n > 0 && (
                <span className="absolute -top-1.5 -right-2.5 min-w-4 h-4 px-1 rounded-full bg-accent text-bg font-mono text-[9.5px] font-semibold flex items-center justify-center">
                  {n > 99 ? '99+' : n}
                </span>
              )}
            </span>
            <span className="text-[10px] leading-none">{label}</span>
          </button>
        )
      })}
    </nav>
  )
}

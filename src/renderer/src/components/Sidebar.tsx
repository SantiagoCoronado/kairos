import { Sun, Users, CheckSquare, Target, Sparkles } from 'lucide-react'

export type ViewId = 'today' | 'people' | 'tasks' | 'objectives' | 'chat'

const NAV: { id: ViewId; label: string; icon: typeof Sun }[] = [
  { id: 'today', label: 'Today', icon: Sun },
  { id: 'people', label: 'People', icon: Users },
  { id: 'tasks', label: 'Tasks', icon: CheckSquare },
  { id: 'objectives', label: 'Objectives', icon: Target },
  { id: 'chat', label: 'Chat', icon: Sparkles }
]

export function Sidebar({
  view,
  onNavigate
}: {
  view: ViewId
  onNavigate: (v: ViewId) => void
}): React.JSX.Element {
  return (
    <aside className="w-52 shrink-0 border-r border-border bg-panel flex flex-col">
      {/* space for macOS traffic lights */}
      <div className="drag-region h-11 shrink-0" />
      <nav className="flex-1 px-2 py-2 space-y-0.5">
        {NAV.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => onNavigate(id)}
            className={`w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-left transition-colors ${
              view === id ? 'bg-raised text-text' : 'text-muted hover:text-text hover:bg-raised/50'
            }`}
          >
            <Icon size={15} strokeWidth={1.75} />
            <span className="text-[13px]">{label}</span>
          </button>
        ))}
      </nav>
      <div className="px-4 py-3 border-t border-border">
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-faint">
          command center
        </span>
      </div>
    </aside>
  )
}

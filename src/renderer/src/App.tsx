import { useEffect, useState } from 'react'
import { PanelLeft } from 'lucide-react'
import { Sidebar, type ViewId } from './components/Sidebar'
import { CommandPalette } from './components/CommandPalette'
import { TodayView } from './views/Today'
import { PeopleView } from './views/People'
import { TasksView } from './views/Tasks'
import { ObjectivesView } from './views/Objectives'
import { ChatView } from './views/Chat'
import { api } from './lib/api'
import { applyTranslucency } from './lib/translucency'

const SIDEBAR_KEY = 'kairos.sidebarHidden'

export default function App(): React.JSX.Element {
  const [view, setView] = useState<ViewId>('today')
  const [personId, setPersonId] = useState<string | null>(null)
  const [sidebarHidden, setSidebarHidden] = useState(
    () => localStorage.getItem(SIDEBAR_KEY) === '1'
  )

  useEffect(() => {
    void api.invoke('settings:get').then((s) => applyTranslucency(s.translucency))
  }, [])

  const toggleSidebar = (): void => {
    setSidebarHidden((h) => {
      localStorage.setItem(SIDEBAR_KEY, h ? '0' : '1')
      return !h
    })
  }

  useEffect(() => {
    const down = (e: KeyboardEvent): void => {
      if (e.key === 'b' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        toggleSidebar()
      }
    }
    window.addEventListener('keydown', down)
    return () => window.removeEventListener('keydown', down)
  }, [])

  const openPerson = (id: string): void => {
    setPersonId(id)
    setView('people')
  }

  return (
    <div className="flex h-full">
      {/* sidebar toggle pinned next to the traffic lights (12px bubbles from
          x=18, centerline y=24) — same spot regardless of sidebar state */}
      <button
        onClick={toggleSidebar}
        title={sidebarHidden ? 'Show sidebar (⌘B)' : 'Hide sidebar (⌘B)'}
        className="no-drag fixed left-[86px] top-[11px] z-50 h-[26px] w-[26px] rounded-md flex items-center justify-center text-muted hover:text-text hover:bg-raised transition-colors"
      >
        <PanelLeft size={15} strokeWidth={1.75} />
      </button>
      {!sidebarHidden && <Sidebar view={view} onNavigate={setView} />}
      <main className="relative flex-1 min-w-0 flex flex-col bg-bg">
        {/* headerless, but the window must stay draggable. With the sidebar
            hidden the traffic lights float over this column, so reserve a
            real titlebar row; otherwise an invisible strip is enough. */}
        {sidebarHidden ? (
          <div className="drag-region h-12 shrink-0" />
        ) : (
          <div className="drag-region absolute top-0 inset-x-0 h-6 z-40" />
        )}
        <div className="flex-1 min-h-0 overflow-y-auto">
          {view === 'today' && <TodayView onOpenPerson={openPerson} />}
          {view === 'people' && <PeopleView selectedId={personId} onSelect={setPersonId} />}
          {view === 'tasks' && <TasksView />}
          {view === 'objectives' && <ObjectivesView />}
          {view === 'chat' && <ChatView />}
        </div>
      </main>
      <CommandPalette onNavigate={setView} onOpenPerson={openPerson} onToggleSidebar={toggleSidebar} />
    </div>
  )
}

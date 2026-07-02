import { useState } from 'react'
import { Sidebar, type ViewId } from './components/Sidebar'
import { CommandPalette } from './components/CommandPalette'
import { TodayView } from './views/Today'
import { PeopleView } from './views/People'
import { TasksView } from './views/Tasks'
import { ObjectivesView } from './views/Objectives'
import { ChatView } from './views/Chat'

export default function App(): React.JSX.Element {
  const [view, setView] = useState<ViewId>('today')
  const [personId, setPersonId] = useState<string | null>(null)

  const openPerson = (id: string): void => {
    setPersonId(id)
    setView('people')
  }

  return (
    <div className="flex h-full">
      <Sidebar view={view} onNavigate={setView} />
      <main className="flex-1 min-w-0 flex flex-col">
        <div className="drag-region h-11 shrink-0 border-b border-border flex items-center justify-between px-4">
          <span className="font-mono text-[11px] uppercase tracking-[0.2em] text-muted">
            {view}
          </span>
          <span className="font-mono text-[10px] text-faint">⌘K</span>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto">
          {view === 'today' && <TodayView onOpenPerson={openPerson} />}
          {view === 'people' && <PeopleView selectedId={personId} onSelect={setPersonId} />}
          {view === 'tasks' && <TasksView />}
          {view === 'objectives' && <ObjectivesView />}
          {view === 'chat' && <ChatView />}
        </div>
      </main>
      <CommandPalette onNavigate={setView} onOpenPerson={openPerson} />
    </div>
  )
}

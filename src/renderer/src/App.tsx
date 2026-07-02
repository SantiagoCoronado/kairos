import { useState } from 'react'
import { Sidebar, type ViewId } from './components/Sidebar'
import { TodayView } from './views/Today'
import { PeopleView } from './views/People'
import { TasksView } from './views/Tasks'
import { ObjectivesView } from './views/Objectives'
import { ChatView } from './views/Chat'

export default function App(): React.JSX.Element {
  const [view, setView] = useState<ViewId>('today')

  return (
    <div className="flex h-full">
      <Sidebar view={view} onNavigate={setView} />
      <main className="flex-1 min-w-0 flex flex-col">
        <div className="drag-region h-11 shrink-0 border-b border-border flex items-center px-4">
          <span className="font-mono text-[11px] uppercase tracking-[0.2em] text-muted">
            {view}
          </span>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto">
          {view === 'today' && <TodayView />}
          {view === 'people' && <PeopleView />}
          {view === 'tasks' && <TasksView />}
          {view === 'objectives' && <ObjectivesView />}
          {view === 'chat' && <ChatView />}
        </div>
      </main>
    </div>
  )
}

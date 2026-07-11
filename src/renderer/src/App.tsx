import { useEffect, useState } from 'react'
import { Sidebar, SidebarToggle, type ViewId } from './components/Sidebar'
import { MobileTabBar } from './components/MobileTabBar'
import { CommandPalette } from './components/CommandPalette'
import { useIsMobile, useKeyboardInset } from './lib/mobile'
import { TodayView } from './views/Today'
import { InboxView } from './views/Inbox'
import { PeopleView } from './views/People'
import { TasksView } from './views/Tasks'
import { NotesView } from './views/Notes'
import { CalendarView } from './views/Calendar'
import { AutomationsView } from './views/Automations'
import { ObjectivesView } from './views/Objectives'
import { ChatView } from './views/Chat'
import { TerminalView } from './views/Terminal'
import { api } from './lib/api'
import { applyTranslucency } from './lib/translucency'

const SIDEBAR_KEY = 'kairos.sidebarHidden'
const VIEW_ORDER: ViewId[] = [
  'today',
  'inbox',
  'people',
  'tasks',
  'notes',
  'calendar',
  'objectives',
  'automations',
  'chat',
  'terminal'
]

/** views the phone shell can host: the four tabs plus People, which stays
 *  reachable through person links on Today/Inbox even without its own tab */
const MOBILE_VIEWS: ViewId[] = ['today', 'inbox', 'chat', 'notes', 'people']

export default function App(): React.JSX.Element {
  const [view, setView] = useState<ViewId>('today')
  const mobile = useIsMobile()
  const keyboard = useKeyboardInset(mobile)
  const [personId, setPersonId] = useState<string | null>(null)
  const [chatSessionId, setChatSessionId] = useState<string | null>(null)
  const [sidebarHidden, setSidebarHidden] = useState(
    () => localStorage.getItem(SIDEBAR_KEY) === '1'
  )
  // once opened, the terminal stays mounted (hidden) so xterm state survives view switches
  const [terminalOpened, setTerminalOpened] = useState(false)
  useEffect(() => {
    if (view === 'terminal') setTerminalOpened(true)
  }, [view])

  useEffect(() => {
    void api.invoke('settings:get').then((s) => applyTranslucency(s.translucency))
  }, [])

  // deep links from main-process notifications (reminder clicks)
  useEffect(() => api.on('nav:goto', ({ view: v }) => setView(v)), [])

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
      // ⌘1–⌘N jump between views
      const n = Number(e.key)
      if ((e.metaKey || e.ctrlKey) && !e.altKey && n >= 1 && n <= VIEW_ORDER.length) {
        e.preventDefault()
        setView(VIEW_ORDER[n - 1])
      }
    }
    window.addEventListener('keydown', down)
    return () => window.removeEventListener('keydown', down)
  }, [])

  const openPerson = (id: string): void => {
    setPersonId(id)
    setView('people')
  }

  const openChatSession = (sessionId: string): void => {
    setChatSessionId(sessionId)
    setView('chat')
  }

  // shrinking into the phone shell while on a desktop-only view strands the
  // user on a blank pane — snap home instead (also catches nav:goto deep links)
  useEffect(() => {
    if (mobile && !MOBILE_VIEWS.includes(view)) setView('today')
  }, [mobile, view])

  const commonViews = (
    <>
      {view === 'today' && <TodayView onOpenPerson={openPerson} />}
      {view === 'inbox' && <InboxView onOpenPerson={openPerson} />}
      {view === 'people' && <PeopleView selectedId={personId} onSelect={setPersonId} />}
      {view === 'notes' && <NotesView onOpenSession={openChatSession} />}
      {view === 'chat' && (
        <ChatView key={chatSessionId ?? 'default'} initialSessionId={chatSessionId} />
      )}
    </>
  )

  if (mobile) {
    const keyboardOpen = keyboard > 50
    return (
      <div className="h-full flex flex-col bg-bg">
        <main
          className="flex-1 min-h-0 overflow-y-auto"
          style={{
            paddingTop: 'env(safe-area-inset-top)',
            // keyboard open: hug it (tab bar hides); closed: clear the
            // floating tab bar + home indicator
            paddingBottom: keyboardOpen
              ? `${keyboard + 8}px`
              : 'calc(4.5rem + env(safe-area-inset-bottom))'
          }}
        >
          {commonViews}
        </main>
        {!keyboardOpen && <MobileTabBar view={view} onNavigate={setView} />}
      </div>
    )
  }

  return (
    <div className="flex h-full">
      {!sidebarHidden && <Sidebar view={view} onNavigate={setView} onHide={toggleSidebar} />}
      <main className="relative flex-1 min-w-0 flex flex-col bg-bg">
        {/* headerless, but the window must stay draggable. With the sidebar
            hidden the traffic lights float over this column, so reserve a
            real titlebar row (carrying the toggle at the same window
            coordinates the sidebar renders it); otherwise an invisible
            strip is enough. */}
        {sidebarHidden ? (
          <div className="drag-region h-12 shrink-0 relative">
            <SidebarToggle hidden onToggle={toggleSidebar} />
          </div>
        ) : (
          <div className="drag-region absolute top-0 inset-x-0 h-6 z-40" />
        )}
        <div className="flex-1 min-h-0 overflow-y-auto">
          {commonViews}
          {view === 'tasks' && <TasksView />}
          {view === 'calendar' && <CalendarView onNavigate={setView} />}
          {view === 'objectives' && <ObjectivesView />}
          {view === 'automations' && <AutomationsView onOpenSession={openChatSession} />}
          {terminalOpened && (
            <div className={view === 'terminal' ? 'h-full overflow-hidden' : 'hidden'}>
              <TerminalView active={view === 'terminal'} />
            </div>
          )}
        </div>
      </main>
      <CommandPalette onNavigate={setView} onOpenPerson={openPerson} onToggleSidebar={toggleSidebar} />
    </div>
  )
}

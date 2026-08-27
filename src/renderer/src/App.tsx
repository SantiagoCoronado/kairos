import { useEffect, useState } from 'react'
import { Sidebar, SidebarToggle, VIEW_ORDER, type ViewId } from './components/Sidebar'
import { MobileTabBar } from './components/MobileTabBar'
import { CommandPalette } from './components/CommandPalette'
import { RecordingBar } from './components/meeting/RecordingBar'
import { IS_REMOTE, useIsMobile, useKeyboardInset, useTerminalAvailable } from './lib/mobile'
import { pushUndo } from './lib/undo'
import { dismissToast, toast } from './lib/toast'
import { getSnapshot as meetingSnapshot, startRecording } from './lib/meeting-store'
import { RECORD_PROMPT_TOAST_MS, recordPromptToast } from './lib/meeting-ui'
import { TodayView } from './views/Today'
import { PendingView } from './views/Pending'
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
import { undoLast } from './lib/undo'

// one visible prompt toast per event: a notification-click reprompt while the
// original toast is still up replaces it instead of stacking a duplicate
const promptToasts = new Map<string, number>()

const SIDEBAR_KEY = 'kairos.sidebarHidden'

/** views the phone shell can host: the tabs plus People, which stays
 *  reachable through person links on Today/Inbox even without its own tab.
 *  Terminal is appended only when it's reachable (opt-in over remote). */
const MOBILE_VIEWS: ViewId[] = ['today', 'inbox', 'chat', 'notes', 'calendar', 'people']

export default function App(): React.JSX.Element {
  const [view, setView] = useState<ViewId>('today')
  const mobile = useIsMobile()
  const terminalOk = useTerminalAvailable()
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

  // meeting summarized in the background → surface the fan-out with an
  // undo window (revert-style: the tasks exist; undo deletes them)
  useEffect(
    () =>
      api.on('meetings:event', (ev) => {
        // opt-in nudge from the calendar watcher: countdown toast whose Record
        // button is the trusted click getDisplayMedia needs — never auto-start
        if (ev.kind === 'record-prompt') {
          const prev = promptToasts.get(ev.eventId)
          if (prev != null) dismissToast(prev) // no-op if already gone
          const { text, detail } = recordPromptToast(ev, new Date())
          const id = toast({
            variant: 'success', // icon slot shows the countdown ring
            text,
            detail,
            timeoutMs: RECORD_PROMPT_TOAST_MS,
            countdownMs: RECORD_PROMPT_TOAST_MS,
            action: {
              label: 'Record',
              run: () => {
                dismissToast(id)
                promptToasts.delete(ev.eventId)
                void startRecording({ calendarEventId: ev.eventId, title: ev.title }).then(
                  (started) => {
                    // null = already recording (the bar shows it) or failure —
                    // only the failure needs surfacing here
                    const snap = meetingSnapshot()
                    if (!started && snap.phase === 'error')
                      toast({ variant: 'error', text: 'Recording failed', detail: snap.message, timeoutMs: 8000 })
                  }
                )
              }
            }
          })
          promptToasts.set(ev.eventId, id)
          return
        }
        if (ev.kind !== 'summarized' || ev.taskIds.length === 0) return
        const n = ev.taskIds.length
        pushUndo({
          label: `Meeting summarized — ${n} task${n === 1 ? '' : 's'} added`,
          // scoped undo: deletes the created tasks AND clears their summary
          // links (interactions stay — the meeting still happened)
          revert: () => void api.invoke('meetings:undoTasks', ev.meetingId, ev.taskIds)
        })
      }),
    []
  )

  // Deep links from main-process notifications (reminder clicks). A calendar
  // goto carrying a meeting id also focuses that meeting's day; a pending
  // goto carrying an item key scrolls to and highlights that row.
  //
  // Delivery is a handshake (issue #99): a nav:goto sent into a freshly
  // constructed window is LOST — React mounts after the load event, so no
  // main-side deferral can reliably land. Main stashes every notification
  // link; the mount effect below claims it (cold-window path), and the live
  // nav:goto handler claims-to-discard as an ack so a stashed copy of an
  // already-delivered link can't replay on the next mount. Electron only —
  // remote clients must not consume a Mac notification's intent.
  useEffect(() => {
    const applyNav = ({ view: v, id }: { view: ViewId; id?: string }): void => {
      if (v === 'calendar' && id) {
        void api
          .invoke('meetings:get', id)
          .then(({ meeting }) => setCalendarFocus(new Date(meeting.started_at)))
          .catch(() => {})
      }
      if (v === 'pending' && id) setPendingFocus(id)
      setView(v)
    }
    if (!IS_REMOTE) {
      void api
        .invoke('nav:claim')
        .then((link) => link && applyNav(link))
        .catch(() => {})
    }
    return api.on('nav:goto', (link) => {
      applyNav(link)
      if (!IS_REMOTE) void api.invoke('nav:claim').catch(() => {}) // ack: consume the stashed copy
    })
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
      // ⌘1–⌘N jump between views
      const n = Number(e.key)
      if ((e.metaKey || e.ctrlKey) && !e.altKey && n >= 1 && n <= VIEW_ORDER.length) {
        e.preventDefault()
        setView(VIEW_ORDER[n - 1])
      }
      // ⌘Z undoes the newest pending inbox action — but inside a text field
      // native text undo must win
      if (e.key === 'z' && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
        const el = document.activeElement as HTMLElement | null
        const typing =
          el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
        if (!typing && undoLast()) e.preventDefault()
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

  // "show in calendar" from invite cards — fresh Date identity each call so
  // the calendar re-anchors even for the same day twice
  const [calendarFocus, setCalendarFocus] = useState<Date | null>(null)
  const [pendingFocus, setPendingFocus] = useState<string | null>(null)
  const openCalendarAt = (day: Date): void => {
    setCalendarFocus(new Date(day))
    setView('calendar')
  }
  // a later plain visit to the calendar must open on today, not the old jump
  useEffect(() => {
    if (view !== 'calendar') setCalendarFocus(null)
  }, [view])

  // shrinking into the phone shell while on a desktop-only view strands the
  // user on a blank pane — snap home instead (also catches nav:goto deep links).
  // Terminal counts as hostable only when it's actually reachable here.
  const mobileViews = terminalOk ? [...MOBILE_VIEWS, 'terminal' as ViewId] : MOBILE_VIEWS
  useEffect(() => {
    if (mobile && !mobileViews.includes(view)) setView('today')
  }, [mobile, view, terminalOk])

  const commonViews = (
    <>
      {view === 'today' && <TodayView onOpenPerson={openPerson} />}
      {view === 'inbox' && <InboxView onOpenPerson={openPerson} onOpenCalendar={openCalendarAt} />}
      {view === 'people' && <PeopleView selectedId={personId} onSelect={setPersonId} />}
      {view === 'notes' && <NotesView onOpenSession={openChatSession} />}
      {view === 'calendar' && <CalendarView onNavigate={setView} focusDate={calendarFocus} />}
      {view === 'chat' && (
        <ChatView key={chatSessionId ?? 'default'} initialSessionId={chatSessionId} />
      )}
    </>
  )

  if (mobile) {
    const keyboardOpen = keyboard > 50
    // terminal manages its own scroll/height; give it the whole pane
    if (view === 'terminal' && terminalOk) {
      return (
        <div className="h-full flex flex-col bg-bg">
          <div
            className="flex-1 min-h-0 overflow-hidden"
            style={{ paddingTop: 'env(safe-area-inset-top)', paddingBottom: keyboardOpen ? `${keyboard}px` : 'calc(4.5rem + env(safe-area-inset-bottom))' }}
          >
            <TerminalView active />
          </div>
          {!keyboardOpen && <MobileTabBar view={view} onNavigate={setView} />}
        </div>
      )
    }
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
        {/* live-capture banner: in the column so it can't hide under the
            drag strip, in every view so a hot mic is never a surprise */}
        <RecordingBar />
        <div className="flex-1 min-h-0 overflow-y-auto">
          {commonViews}
          {view === 'pending' && (
            <PendingView
              onNavigate={setView}
              onOpenPerson={openPerson}
              onOpenCalendar={openCalendarAt}
              focusKey={pendingFocus}
              onFocusConsumed={() => setPendingFocus(null)}
            />
          )}
          {view === 'tasks' && <TasksView />}
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

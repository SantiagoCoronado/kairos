import { useEffect, useRef, useState } from 'react'
import { Terminal as Xterm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { Plus, X } from 'lucide-react'
import type { TerminalSessionInfo } from '../../../shared/ipc-contract'
import { api } from '../lib/api'
import '@xterm/xterm/css/xterm.css'

// Ptys live in the main process and survive view switches and window
// close/reopen; each pane replays the session backlog on mount. The view
// itself stays mounted (hidden via CSS) once opened — see App.tsx.

export function TerminalView({ active }: { active: boolean }): React.JSX.Element {
  const [sessions, setSessions] = useState<TerminalSessionInfo[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  // StrictMode double-runs the mount effect; without the guard two shells spawn
  const initRef = useRef(false)

  const newTab = (): void => {
    void api.invoke('terminal:create').then((s) => {
      setSessions((prev) => [...prev, s])
      setActiveId(s.id)
    })
  }

  useEffect(() => {
    if (initRef.current) return
    initRef.current = true
    void api.invoke('terminal:list').then((existing) => {
      if (existing.length === 0) {
        newTab()
      } else {
        setSessions(existing)
        setActiveId(existing[0].id)
      }
    })
  }, [])

  // pty exit is the single tab-removal path (the × button just kills the pty)
  useEffect(
    () =>
      api.on('terminal:event', (event) => {
        if (event.kind !== 'exit') return
        setSessions((prev) => {
          const idx = prev.findIndex((s) => s.id === event.sessionId)
          if (idx === -1) return prev
          const next = prev.filter((s) => s.id !== event.sessionId)
          setActiveId((cur) =>
            cur === event.sessionId ? (next[Math.min(idx, next.length - 1)]?.id ?? null) : cur
          )
          return next
        })
      }),
    []
  )

  // tell main whether the view is visible — bells only badge while it isn't,
  // and opening the view clears the badge
  useEffect(() => {
    void api.invoke('terminal:setViewActive', active)
  }, [active])

  // ⌘T: new tab while the terminal view is showing
  useEffect(() => {
    if (!active) return undefined
    const down = (e: KeyboardEvent): void => {
      if (e.key === 't' && e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        newTab()
      }
    }
    window.addEventListener('keydown', down)
    return () => window.removeEventListener('keydown', down)
  }, [active])

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* pt-6 clears the invisible 24px titlebar drag strip that overlays the
          top of the main column (App.tsx) — clicks there never reach us */}
      <div className="flex items-center gap-1 px-3 pt-6 pb-0 border-b border-border shrink-0">
        {sessions.map((s, i) => (
          <div
            key={s.id}
            onClick={() => setActiveId(s.id)}
            className={`group flex items-center gap-1.5 px-2.5 py-1.5 rounded-t-md font-mono text-[11px] cursor-pointer transition-colors ${
              s.id === activeId ? 'bg-raised text-text' : 'text-muted hover:text-text'
            }`}
          >
            <span>
              {s.title} {i + 1}
            </span>
            <button
              onClick={(e) => {
                e.stopPropagation()
                void api.invoke('terminal:kill', s.id)
              }}
              title="Close tab"
              className="opacity-0 group-hover:opacity-100 text-faint hover:text-accent transition-opacity"
            >
              <X size={11} />
            </button>
          </div>
        ))}
        <button
          onClick={newTab}
          title="New tab (⌘T)"
          className="ml-1 p-1.5 rounded-md text-muted hover:text-text hover:bg-raised transition-colors"
        >
          <Plus size={13} />
        </button>
      </div>
      <div className="flex-1 min-h-0 relative">
        {sessions.map((s) => (
          <TerminalPane key={s.id} sessionId={s.id} visible={s.id === activeId && active} />
        ))}
      </div>
    </div>
  )
}

function TerminalPane({
  sessionId,
  visible
}: {
  sessionId: string
  visible: boolean
}): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Xterm | null>(null)
  const fitRef = useRef<FitAddon | null>(null)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return undefined

    const term = new Xterm({
      allowTransparency: true,
      scrollback: 5000,
      fontSize: 12,
      // no ui-monospace: Chromium can't resolve it and xterm measures real glyphs
      fontFamily: "'SF Mono', 'JetBrains Mono', Menlo, monospace",
      theme: {
        background: 'rgba(0,0,0,0)', // keep the window translucency
        foreground: '#e8e8ea',
        cursor: '#e2b25a',
        selectionBackground: 'rgba(255,255,255,0.15)'
      }
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(el)
    termRef.current = term
    fitRef.current = fit

    // let app-level ⌘ shortcuts bubble instead of going to the shell;
    // Ctrl must always reach the pty (Ctrl+C, readline bindings)
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown' || !e.metaKey || e.ctrlKey || e.altKey) return true
      if (/^[1-9]$/.test(e.key)) return false // ⌘1–⌘9 view jumps
      if (['k', 'b', 't'].includes(e.key)) return false // palette, sidebar, new tab
      return true
    })

    term.onData((data) => void api.invoke('terminal:input', sessionId, data))
    term.onResize(({ cols, rows }) => void api.invoke('terminal:resize', sessionId, cols, rows))
    const offEvents = api.on('terminal:event', (event) => {
      if (event.sessionId === sessionId && event.kind === 'data') term.write(event.data)
    })
    void api.invoke('terminal:attach', sessionId).then((res) => {
      if (res?.backlog) term.write(res.backlog)
      fit.fit()
    })

    let resizeTimer: ReturnType<typeof setTimeout> | null = null
    const observer = new ResizeObserver(() => {
      if (resizeTimer) clearTimeout(resizeTimer)
      resizeTimer = setTimeout(() => {
        // hidden panes report 0×0; fitting then would corrupt the grid
        if (el.clientWidth > 0 && el.clientHeight > 0) fit.fit()
      }, 50)
    })
    observer.observe(el)

    return () => {
      offEvents()
      observer.disconnect()
      if (resizeTimer) clearTimeout(resizeTimer)
      term.dispose() // the pty stays alive in main; unmount ≠ close
      termRef.current = null
      fitRef.current = null
    }
  }, [sessionId])

  useEffect(() => {
    if (!visible) return
    requestAnimationFrame(() => {
      fitRef.current?.fit()
      termRef.current?.focus()
    })
  }, [visible])

  return (
    <div
      ref={containerRef}
      className={`absolute inset-0 px-3 py-2 ${visible ? '' : 'invisible'}`}
    />
  )
}

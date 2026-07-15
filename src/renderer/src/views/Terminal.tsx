import { useEffect, useRef, useState } from 'react'
import { Terminal as Xterm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { Plus, X } from 'lucide-react'
import type { TerminalSessionInfo } from '../../../shared/ipc-contract'
import { api } from '../lib/api'
import { useIsMobile } from '../lib/mobile'
import '@xterm/xterm/css/xterm.css'

// Ptys live in the main process and survive view switches and window
// close/reopen; each pane replays the session backlog on mount. The view
// itself stays mounted (hidden via CSS) once opened — see App.tsx.

export function TerminalView({ active }: { active: boolean }): React.JSX.Element {
  const [sessions, setSessions] = useState<TerminalSessionInfo[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  // StrictMode double-runs the mount effect; without the guard two shells spawn
  const initRef = useRef(false)
  // touch has no :hover — the close button must stay visible, not hover-revealed
  const isMobile = useIsMobile()

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
    // touch-none: gestures anywhere in the view must not pan the app shell's
    // overflow-y-auto column — scrollback is JS-driven (see TerminalPane)
    <div className={`h-full flex flex-col overflow-hidden ${isMobile ? 'touch-none' : ''}`}>
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
              className={`text-faint hover:text-accent transition-opacity ${
                isMobile ? 'opacity-70' : 'opacity-0 group-hover:opacity-100'
              }`}
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
          <TerminalPane
            key={s.id}
            sessionId={s.id}
            visible={s.id === activeId && active}
            isMobile={isMobile}
          />
        ))}
      </div>
    </div>
  )
}

function TerminalPane({
  sessionId,
  visible,
  isMobile
}: {
  sessionId: string
  visible: boolean
  isMobile: boolean
}): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Xterm | null>(null)
  const fitRef = useRef<FitAddon | null>(null)

  // ESC+CR is what terminals send for Option/Alt-Enter: zle binds it to
  // self-insert-unmeta (a literal newline in the buffer) and TUIs like
  // Claude Code treat it as insert-newline. The previous Ctrl-V trick was
  // readline-only — inside a TUI the button looked dead.
  const insertNewline = (): void => {
    void api.invoke('terminal:input', sessionId, '\x1b\r')
    termRef.current?.focus()
  }
  const sendBackspace = (): void => {
    void api.invoke('terminal:input', sessionId, '\x7f')
  }

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
      if (e.type !== 'keydown') return true
      // Shift+Enter: insert a literal newline instead of submitting the line
      if (e.key === 'Enter' && e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
        insertNewline()
        return false
      }
      if (!e.metaKey || e.ctrlKey || e.altKey) return true
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

    // xterm has no native scrollable content (.xterm-viewport's scrollHeight
    // always equals its clientHeight — scrollback is repainted, not scrolled
    // via the DOM) and only reacts to wheel events, which touch drags never
    // fire. Translate vertical drag distance into scrollLines() calls so
    // dragging the terminal on a phone actually moves the scrollback.
    //
    // Pointer events + setPointerCapture, NOT touch events: while output is
    // streaming, xterm's DOM renderer destroys the row span under the finger,
    // and iOS Safari then delivers the rest of the touch stream to the
    // detached node — it never bubbles here and the drag goes dead (Chromium
    // retargets and keeps working, which is why touch listeners passed CDP
    // verification but failed on a real iPhone mid-stream). Capturing the
    // pointer pins delivery to this container for the whole gesture.
    let dragPointer: number | null = null
    let dragLastY = 0
    let dragTotal = 0
    let dragRemainder = 0
    const onPointerDown = (ev: PointerEvent): void => {
      if (ev.pointerType !== 'touch' || !ev.isPrimary) return
      dragPointer = ev.pointerId
      dragLastY = ev.clientY
      dragTotal = 0
      dragRemainder = 0
      try {
        el.setPointerCapture(ev.pointerId)
      } catch {
        /* pointer already gone — the move/up handlers just won't fire */
      }
    }
    const onPointerMove = (ev: PointerEvent): void => {
      if (ev.pointerId !== dragPointer) return
      const lineHeight = el.clientHeight / Math.max(term.rows, 1)
      if (lineHeight <= 0) return
      dragTotal += Math.abs(dragLastY - ev.clientY)
      dragRemainder += dragLastY - ev.clientY
      dragLastY = ev.clientY
      const lines = Math.trunc(dragRemainder / lineHeight)
      if (lines !== 0) {
        term.scrollLines(lines)
        dragRemainder -= lines * lineHeight
      }
    }
    const onPointerEnd = (ev: PointerEvent): void => {
      if (ev.pointerId !== dragPointer) return
      dragPointer = null
      // capture retargets the tap's click away from xterm, so its own
      // focus-on-click never runs — restore tap-to-focus (opens the iOS
      // keyboard) ourselves when the gesture never became a drag
      if (ev.type === 'pointerup' && dragTotal < 10) term.focus()
    }
    // native pan/selection must not race the JS drag on any touchscreen,
    // not just the isMobile layout (the view-root touch-none only covers that)
    el.style.touchAction = 'none'
    el.addEventListener('pointerdown', onPointerDown)
    el.addEventListener('pointermove', onPointerMove)
    el.addEventListener('pointerup', onPointerEnd)
    el.addEventListener('pointercancel', onPointerEnd)

    return () => {
      offEvents()
      observer.disconnect()
      if (resizeTimer) clearTimeout(resizeTimer)
      el.removeEventListener('pointerdown', onPointerDown)
      el.removeEventListener('pointermove', onPointerMove)
      el.removeEventListener('pointerup', onPointerEnd)
      el.removeEventListener('pointercancel', onPointerEnd)
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
    // padding lives on the wrapper, NOT on the element xterm mounts into:
    // FitAddon reads the mount element's border-box height, so padding there
    // makes the grid one row too tall and clips the bottom line
    <div className={`absolute inset-0 px-3 py-2 ${visible ? '' : 'invisible'}`}>
      <div ref={containerRef} className="h-full w-full" />
      {/* touch keyboards have no Shift+Enter and don't auto-repeat into
          xterm's hidden textarea — give mobile explicit keys for both */}
      {isMobile && (
        <div className="absolute bottom-4 right-4 flex gap-2">
          <HoldRepeatKey label="⌫" title="Backspace (hold to repeat)" onFire={sendBackspace} />
          <HoldRepeatKey label="↵ newline" title="Insert line break" onFire={insertNewline} />
        </div>
      )}
    </div>
  )
}

/** On-screen terminal key with press-and-hold auto-repeat. */
function HoldRepeatKey({
  label,
  title,
  onFire
}: {
  label: string
  title: string
  onFire: () => void
}): React.JSX.Element {
  const timers = useRef<{
    delay?: ReturnType<typeof setTimeout>
    repeat?: ReturnType<typeof setInterval>
  }>({})

  const stop = (): void => {
    if (timers.current.delay) clearTimeout(timers.current.delay)
    if (timers.current.repeat) clearInterval(timers.current.repeat)
    timers.current = {}
  }
  const start = (e: React.PointerEvent): void => {
    // preventDefault suppresses the compatibility mousedown, which keeps the
    // hidden xterm textarea focused — no keyboard flicker, no focus steal
    e.preventDefault()
    stop()
    onFire()
    timers.current.delay = setTimeout(() => {
      timers.current.repeat = setInterval(onFire, 60)
    }, 400)
  }
  useEffect(() => stop, [])

  return (
    <button
      onPointerDown={start}
      onPointerUp={stop}
      onPointerLeave={stop}
      onPointerCancel={stop}
      // a held key must not summon the iOS long-press menu
      onContextMenu={(e) => e.preventDefault()}
      title={title}
      className="px-2.5 py-1.5 rounded-md glass text-muted hover:text-text font-mono text-[11px] select-none [-webkit-touch-callout:none]"
    >
      {label}
    </button>
  )
}

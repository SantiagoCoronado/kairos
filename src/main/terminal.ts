// Main-process pty sessions for the Terminal view. Sessions outlive the
// renderer (window close/reopen, dev reload): output is kept in a bounded
// backlog that 'terminal:attach' replays into a fresh xterm.
// No electron imports and pty spawn is injected so tests can run without
// the Electron-ABI native module.
import { basename } from 'node:path'
import { homedir } from 'node:os'
import { ulid } from 'ulid'
import type { IPty } from 'node-pty'
import type { TerminalEvent, TerminalSessionInfo } from '../shared/ipc-contract'
import { buildChildEnv } from './child-env'

export type PtySpawn = (
  file: string,
  args: string[],
  opts: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> }
) => IPty

/** per-session backlog cap; keeps attach replay bounded on flooding output */
const BACKLOG_CAP_BYTES = 512 * 1024
/** coalesce pty chunks for this long before one IPC broadcast */
const FLUSH_MS = 8

interface Session {
  id: string
  title: string
  pty: IPty
  backlog: string[]
  backlogBytes: number
  pending: string[]
  flushTimer: ReturnType<typeof setTimeout> | null
  /** rang the bell while the Terminal view was closed (agent finished) */
  attention: boolean
  /** bell scanner state: inside an OSC escape sequence (may span chunks) */
  inOsc: boolean
}

export class TerminalManager {
  private sessions = new Map<string, Session>()
  /** whether the renderer currently shows the Terminal view */
  private viewActive = false

  constructor(
    private spawn: PtySpawn,
    private emit: (event: TerminalEvent) => void,
    /** the set of attention-flagged sessions changed (sidebar badge) */
    private onAttention?: () => void
  ) {}

  create(): TerminalSessionInfo {
    const shell = process.env['SHELL'] ?? '/bin/zsh'
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(buildChildEnv())) {
      if (v !== undefined) env[k] = v
    }
    env['TERM'] = 'xterm-256color'
    env['COLORTERM'] = 'truecolor'

    const id = ulid()
    // login shell so the user's profile (and PATH) is sourced
    const pty = this.spawn(shell, ['-l'], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: homedir(),
      env
    })
    const session: Session = {
      id,
      title: basename(shell),
      pty,
      backlog: [],
      backlogBytes: 0,
      pending: [],
      flushTimer: null,
      attention: false,
      inOsc: false
    }
    this.sessions.set(id, session)

    pty.onData((data) => {
      // scan unconditionally — the OSC state machine must see every byte
      const bell = this.scanForBell(session, data)
      if (bell && !this.viewActive && !session.attention) {
        session.attention = true
        this.onAttention?.()
      }
      session.backlog.push(data)
      session.backlogBytes += data.length
      while (session.backlogBytes > BACKLOG_CAP_BYTES && session.backlog.length > 1) {
        session.backlogBytes -= session.backlog.shift()!.length
      }
      session.pending.push(data)
      session.flushTimer ??= setTimeout(() => {
        session.flushTimer = null
        const data = session.pending.join('')
        session.pending = []
        this.emit({ sessionId: id, kind: 'data', data })
      }, FLUSH_MS)
    })

    pty.onExit(({ exitCode }) => {
      if (session.flushTimer) clearTimeout(session.flushTimer)
      this.sessions.delete(id)
      if (session.attention) this.onAttention?.() // its badge count just dropped
      this.emit({ sessionId: id, kind: 'exit', exitCode })
    })

    return { id, title: session.title }
  }

  /**
   * BEL detector for the "agent finished" badge. BELs that terminate an OSC
   * sequence (title/cwd reports end in BEL) are protocol noise — only a
   * standalone BEL is something ringing the terminal bell, which is what
   * Claude Code & co. do on completion.
   */
  private scanForBell(session: Session, data: string): boolean {
    let bell = false
    for (let i = 0; i < data.length; i++) {
      const c = data.charCodeAt(i)
      if (session.inOsc) {
        if (c === 0x07) {
          session.inOsc = false
        } else if (c === 0x1b && data.charCodeAt(i + 1) === 0x5c) {
          session.inOsc = false // ST terminator (ESC \)
          i++
        }
      } else if (c === 0x1b && data[i + 1] === ']') {
        session.inOsc = true
        i++
      } else if (c === 0x07) {
        bell = true
      }
    }
    return bell
  }

  /** Renderer visibility report; opening the view clears every flag. */
  setViewActive(active: boolean): void {
    this.viewActive = active
    if (!active) return
    let changed = false
    for (const s of this.sessions.values()) {
      if (s.attention) {
        s.attention = false
        changed = true
      }
    }
    if (changed) this.onAttention?.()
  }

  /** Sessions that rang the bell since the view was last open. */
  attentionCount(): number {
    let n = 0
    for (const s of this.sessions.values()) if (s.attention) n++
    return n
  }

  list(): TerminalSessionInfo[] {
    return [...this.sessions.values()].map(({ id, title }) => ({ id, title }))
  }

  attach(id: string): { backlog: string } | null {
    const s = this.sessions.get(id)
    return s ? { backlog: s.backlog.join('') } : null
  }

  input(id: string, data: string): void {
    this.sessions.get(id)?.pty.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    if (cols > 0 && rows > 0) this.sessions.get(id)?.pty.resize(cols, rows)
  }

  kill(id: string): void {
    // registry cleanup + exit broadcast happen in the onExit handler
    this.sessions.get(id)?.pty.kill()
  }

  disposeAll(): void {
    for (const s of this.sessions.values()) {
      if (s.flushTimer) clearTimeout(s.flushTimer)
      s.pty.kill()
    }
    this.sessions.clear()
  }
}

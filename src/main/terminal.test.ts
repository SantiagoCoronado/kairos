import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { homedir } from 'node:os'
import type { IPty } from 'node-pty'
import { TerminalManager, type PtySpawn } from './terminal'
import type { TerminalEvent } from '../shared/ipc-contract'

interface FakePty {
  pty: IPty
  emitData: (data: string) => void
  emitExit: (exitCode: number) => void
  write: ReturnType<typeof vi.fn>
  resize: ReturnType<typeof vi.fn>
  kill: ReturnType<typeof vi.fn>
  spawnArgs: { file: string; args: string[]; opts: Parameters<PtySpawn>[2] }
}

function makeFakeSpawn(): { spawn: PtySpawn; ptys: FakePty[] } {
  const ptys: FakePty[] = []
  const spawn: PtySpawn = (file, args, opts) => {
    let onData: (d: string) => void = () => {}
    let onExit: (e: { exitCode: number }) => void = () => {}
    const write = vi.fn()
    const resize = vi.fn()
    const kill = vi.fn()
    const fake: FakePty = {
      emitData: (d) => onData(d),
      emitExit: (exitCode) => onExit({ exitCode }),
      write,
      resize,
      kill,
      spawnArgs: { file, args, opts },
      pty: {
        onData: (cb: (d: string) => void) => {
          onData = cb
          return { dispose: () => {} }
        },
        onExit: (cb: (e: { exitCode: number }) => void) => {
          onExit = cb
          return { dispose: () => {} }
        },
        write,
        resize,
        kill
      } as unknown as IPty
    }
    ptys.push(fake)
    return fake.pty
  }
  return { spawn, ptys }
}

describe('TerminalManager', () => {
  let events: TerminalEvent[]
  let manager: TerminalManager
  let ptys: FakePty[]

  beforeEach(() => {
    vi.useFakeTimers()
    events = []
    const fake = makeFakeSpawn()
    ptys = fake.ptys
    manager = new TerminalManager(fake.spawn, (e) => events.push(e))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('creates a login shell in the home directory with a terminal env', () => {
    const info = manager.create()
    expect(info.id).toBeTruthy()
    const { file, args, opts } = ptys[0].spawnArgs
    expect(file).toBe(process.env['SHELL'] ?? '/bin/zsh')
    expect(info.title).toBe(file.split('/').pop())
    expect(args).toEqual(['-l'])
    expect(opts.cwd).toBe(homedir())
    expect(opts.env['TERM']).toBe('xterm-256color')
    expect(opts.env['ANTHROPIC_API_KEY']).toBeUndefined()
    expect(opts.env['PATH']).toContain('/opt/homebrew/bin')
    expect(manager.list()).toEqual([info])
  })

  it('coalesces pty chunks into one event and replays them via attach', () => {
    const { id } = manager.create()
    ptys[0].emitData('hello ')
    ptys[0].emitData('world')
    expect(events).toHaveLength(0) // not flushed yet
    vi.runAllTimers()
    expect(events).toEqual([{ sessionId: id, kind: 'data', data: 'hello world' }])
    expect(manager.attach(id)).toEqual({ backlog: 'hello world' })
  })

  it('caps the backlog and keeps the tail', () => {
    const { id } = manager.create()
    for (let i = 0; i < 700; i++) ptys[0].emitData('x'.repeat(1024))
    ptys[0].emitData('THE-END')
    vi.runAllTimers()
    const backlog = manager.attach(id)!.backlog
    expect(backlog.length).toBeLessThanOrEqual(512 * 1024)
    expect(backlog.endsWith('THE-END')).toBe(true)
  })

  it('kill asks the pty to die; exit removes the session and broadcasts', () => {
    const { id } = manager.create()
    manager.kill(id)
    expect(ptys[0].kill).toHaveBeenCalled()
    ptys[0].emitExit(0)
    expect(manager.list()).toEqual([])
    expect(manager.attach(id)).toBeNull()
    expect(events).toEqual([{ sessionId: id, kind: 'exit', exitCode: 0 }])
  })

  it('forwards input and resize, ignoring unknown sessions and zero sizes', () => {
    const { id } = manager.create()
    manager.input(id, 'ls\r')
    expect(ptys[0].write).toHaveBeenCalledWith('ls\r')
    manager.resize(id, 120, 40)
    expect(ptys[0].resize).toHaveBeenCalledWith(120, 40)
    manager.resize(id, 0, 0)
    expect(ptys[0].resize).toHaveBeenCalledTimes(1)
    expect(() => {
      manager.input('nope', 'x')
      manager.resize('nope', 80, 24)
      manager.kill('nope')
    }).not.toThrow()
  })

  it('disposeAll kills every pty and clears the registry', () => {
    manager.create()
    manager.create()
    manager.disposeAll()
    expect(ptys[0].kill).toHaveBeenCalled()
    expect(ptys[1].kill).toHaveBeenCalled()
    expect(manager.list()).toEqual([])
  })
})

describe('bell attention (agent-finished badge)', () => {
  let ptys: FakePty[]
  let manager: TerminalManager
  let attentionPings: number

  beforeEach(() => {
    vi.useFakeTimers()
    const fake = makeFakeSpawn()
    ptys = fake.ptys
    attentionPings = 0
    manager = new TerminalManager(
      fake.spawn,
      () => {},
      () => attentionPings++
    )
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('a standalone BEL flags the session while the view is closed', () => {
    manager.create()
    ptys[0].emitData('done!\x07')
    expect(manager.attentionCount()).toBe(1)
    expect(attentionPings).toBe(1)
    // more bells on an already-flagged session don't re-ping
    ptys[0].emitData('\x07')
    expect(attentionPings).toBe(1)
  })

  it('BELs terminating OSC sequences are protocol noise, not bells', () => {
    manager.create()
    ptys[0].emitData('\x1b]0;my title\x07regular output')
    expect(manager.attentionCount()).toBe(0)
    // OSC spanning two chunks, ST-terminated, then a real bell
    ptys[0].emitData('\x1b]7;file://host/dir')
    ptys[0].emitData('rest of the osc\x1b\\')
    expect(manager.attentionCount()).toBe(0)
    ptys[0].emitData('\x07')
    expect(manager.attentionCount()).toBe(1)
  })

  it('escape sequences split at ANY chunk boundary still parse', () => {
    manager.create()
    // ESC / ] split across chunks: the whole OSC (incl. its BEL terminator)
    // must be swallowed, not read as text plus a bell
    ptys[0].emitData('before\x1b')
    ptys[0].emitData(']0;title\x07after')
    expect(manager.attentionCount()).toBe(0)
    // ST split across chunks: ESC ends one chunk, backslash starts the next —
    // must exit the sequence so the following genuine bell counts
    ptys[0].emitData('\x1b]7;file://x/y\x1b')
    ptys[0].emitData('\\')
    ptys[0].emitData('\x07')
    expect(manager.attentionCount()).toBe(1)
  })

  it('BEL inside DCS/APC payloads is data, not a bell', () => {
    manager.create()
    ptys[0].emitData('\x1bPtmux;inner\x07payload\x1b\\') // DCS passthrough
    expect(manager.attentionCount()).toBe(0)
    ptys[0].emitData('\x1b_apc\x07data\x1b\\') // APC
    expect(manager.attentionCount()).toBe(0)
    ptys[0].emitData('\x07')
    expect(manager.attentionCount()).toBe(1)
  })

  it('no flag while the view is open; opening the view clears flags', () => {
    manager.create()
    manager.setViewActive(true)
    ptys[0].emitData('\x07')
    expect(manager.attentionCount()).toBe(0)

    manager.setViewActive(false)
    ptys[0].emitData('\x07')
    expect(manager.attentionCount()).toBe(1)
    manager.setViewActive(true)
    expect(manager.attentionCount()).toBe(0)
    expect(attentionPings).toBe(2) // one for the flag, one for the clear
  })

  it('session exit drops its flag from the count', () => {
    manager.create()
    manager.create()
    ptys[0].emitData('\x07')
    ptys[1].emitData('\x07')
    expect(manager.attentionCount()).toBe(2)
    ptys[0].emitExit(0)
    expect(manager.attentionCount()).toBe(1)
  })
})

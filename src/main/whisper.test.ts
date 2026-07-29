import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  buildServerArgs,
  parseWhisperResponse,
  WhisperServer,
  DEFAULT_WHISPER_PORT,
  type WhisperChildLike,
  type WhisperConfig
} from './whisper'

describe('buildServerArgs', () => {
  const base: WhisperConfig = { binaryPath: '/bin/ws', modelPath: '/m/turbo.bin' }

  it('binds localhost with the model, autodetect language by default', () => {
    // '-l auto' is load-bearing: the binary's own default is 'en'
    expect(buildServerArgs(base)).toEqual([
      '-m',
      '/m/turbo.bin',
      '--host',
      '127.0.0.1',
      '--port',
      String(DEFAULT_WHISPER_PORT),
      '-l',
      'auto'
    ])
  })

  it('adds VAD and language when configured', () => {
    const args = buildServerArgs({
      ...base,
      vadModelPath: '/m/silero.bin',
      language: 'en',
      port: 9999
    })
    expect(args).toContain('--vad')
    expect(args.join(' ')).toContain('--vad-model /m/silero.bin')
    expect(args.join(' ')).toContain('-l en')
    expect(args.join(' ')).toContain('--port 9999')
  })
})

describe('parseWhisperResponse', () => {
  it('parses the OpenAI-compatible verbose_json shape', () => {
    const out = parseWhisperResponse({
      text: ' hello world ',
      language: 'en',
      segments: [
        { start: 0, end: 2.5, text: ' hello ' },
        { start: 2.5, end: 4, text: ' world ' }
      ]
    })
    expect(out.text).toBe('hello world')
    expect(out.language).toBe('en')
    expect(out.segments).toEqual([
      { t0: 0, t1: 2.5, text: 'hello' },
      { t0: 2.5, t1: 4, text: 'world' }
    ])
  })

  it('parses the legacy transcription/offsets (ms) shape', () => {
    const out = parseWhisperResponse({
      transcription: [{ offsets: { from: 1000, to: 3500 }, text: 'hey' }]
    })
    expect(out.segments).toEqual([{ t0: 1, t1: 3.5, text: 'hey' }])
    expect(out.text).toBe('hey')
  })

  it('drops malformed segments and tolerates garbage', () => {
    expect(parseWhisperResponse(null)).toEqual({ text: '', language: null, segments: [] })
    const out = parseWhisperResponse({
      segments: [
        { start: 'x', end: 1, text: 'bad' },
        { start: 0, end: 1, text: '   ' },
        { start: 0, end: 1, text: 'ok' }
      ]
    })
    expect(out.segments).toEqual([{ t0: 0, t1: 1, text: 'ok' }])
  })
})

interface FakeChild extends WhisperChildLike {
  killed: boolean
  fireExit: () => void
  fireError: (err: Error) => void
}

function makeRig(opts: { failFetches?: number } = {}): {
  server: WhisperServer
  children: FakeChild[]
  fetchCalls: { url: string; method?: string }[]
} {
  const children: FakeChild[] = []
  const fetchCalls: { url: string; method?: string }[] = []
  let failuresLeft = opts.failFetches ?? 0

  const spawn = (_file: string, _args: string[]): WhisperChildLike => {
    const cbs = new Map<string, (err?: Error) => void>()
    const child: FakeChild = {
      killed: false,
      kill: () => void (child.killed = true),
      on: ((e: string, cb: (err?: Error) => void) => void cbs.set(e, cb)) as FakeChild['on'],
      fireExit: () => cbs.get('exit')?.(),
      fireError: (err: Error) => cbs.get('error')?.(err)
    }
    children.push(child)
    return child
  }

  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    fetchCalls.push({ url: String(url), method: init?.method })
    if (failuresLeft > 0) {
      failuresLeft--
      throw new Error('ECONNREFUSED')
    }
    if (init?.method === 'POST')
      return new Response(
        JSON.stringify({ text: 'hi', language: 'en', segments: [{ start: 0, end: 1, text: 'hi' }] }),
        { status: 200 }
      )
    return new Response('ok', { status: 200 })
  }) as typeof fetch

  const server = new WhisperServer(
    { binaryPath: '/bin/ws', modelPath: '/m/base.bin', idleMs: 1000, readyTimeoutMs: 5000 },
    {
      spawn,
      fetchFn,
      readFile: async () => new Uint8Array([1, 2, 3]),
      log: () => {}
    }
  )
  return { server, children, fetchCalls }
}

afterEach(() => vi.useRealTimers())

describe('WhisperServer', () => {
  it('spawns once, reuses the sidecar across calls, parses results', async () => {
    const { server, children, fetchCalls } = makeRig()
    const r1 = await server.transcribe('/rec/a.wav')
    const r2 = await server.transcribe('/rec/b.wav')
    expect(r1.segments).toEqual([{ t0: 0, t1: 1, text: 'hi' }])
    expect(r2.text).toBe('hi')
    expect(children).toHaveLength(1)
    const posts = fetchCalls.filter((c) => c.method === 'POST')
    expect(posts).toHaveLength(2)
    expect(posts[0].url).toContain('/inference')
  })

  it('shuts down after the idle window and respawns on demand', async () => {
    vi.useFakeTimers()
    const { server, children } = makeRig()
    await server.transcribe('/rec/a.wav')
    expect(server.running).toBe(true)
    await vi.advanceTimersByTimeAsync(1001)
    expect(server.running).toBe(false)
    expect(children[0].killed).toBe(true)
    await server.transcribe('/rec/b.wav')
    expect(children).toHaveLength(2)
  })

  it('respawns after an unexpected sidecar exit', async () => {
    const { server, children } = makeRig()
    await server.transcribe('/rec/a.wav')
    children[0].fireExit()
    expect(server.running).toBe(false)
    await server.transcribe('/rec/b.wav')
    expect(children).toHaveLength(2)
  })

  it('fails fast with the real message on spawn error (missing/quarantined binary)', async () => {
    const { server, children } = makeRig({ failFetches: 99 }) // server never answers
    const attempt = server.transcribe('/rec/a.wav')
    // spawn errors emit 'error' (never 'exit') on the next tick
    await new Promise((r) => setTimeout(r, 0))
    children[0].fireError(new Error('spawn ENOENT'))
    await expect(attempt).rejects.toThrow(/failed to start: spawn ENOENT/)
    expect(server.running).toBe(false)
  })

  it('fails fast when the server never becomes ready', async () => {
    const { server, children } = makeRig({ failFetches: 99 })
    // deadline already passed → first failed poll throws
    const impatient = new WhisperServer(
      { binaryPath: '/bin/ws', modelPath: '/m/base.bin', readyTimeoutMs: -1 },
      {
        spawn: (f, a) => {
          void f
          void a
          const child: FakeChild = {
            killed: false,
            kill: () => void (child.killed = true),
            on: () => {},
            fireExit: () => {},
            fireError: () => {}
          }
          children.push(child)
          return child
        },
        fetchFn: (async () => {
          throw new Error('ECONNREFUSED')
        }) as typeof fetch,
        readFile: async () => new Uint8Array(),
        log: () => {}
      }
    )
    await expect(impatient.transcribe('/rec/a.wav')).rejects.toThrow(/did not become ready/)
    expect(children.at(-1)!.killed).toBe(true)
    void server
  })
})

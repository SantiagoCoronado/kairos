// whisper-server sidecar client. The binary (built + staged by
// scripts/build-whisper-server.sh, bundled as an extraResource) loads the
// model at startup and serves POST /inference. Lifecycle here is
// lazy-start + idle-shutdown (speaches pattern): the model costs GBs of
// RAM, so the server only lives while transcription work is flowing.
// spawn/fetch/timers are injected for tests (terminal.ts precedent).

import type { TranscriptSegment } from '../core/types'

export interface WhisperChildLike {
  kill(): void
  on(event: 'exit', cb: () => void): void
  on(event: 'error', cb: (err: Error) => void): void
}

export type WhisperSpawn = (file: string, args: string[]) => WhisperChildLike

export interface WhisperConfig {
  binaryPath: string
  modelPath: string
  /** Silero VAD model — gates hallucination on silent stretches */
  vadModelPath?: string | null
  /** ISO 639-1 code; null/undefined = autodetect */
  language?: string | null
  port?: number
  /** ms of inactivity before the sidecar is shut down */
  idleMs?: number
  /** ms to wait for the server to come up (model load included) */
  readyTimeoutMs?: number
}

export interface WhisperResult {
  text: string
  language: string | null
  /** channel-less segments — the caller tags them mic/system */
  segments: Omit<TranscriptSegment, 'channel'>[]
}

export const DEFAULT_WHISPER_PORT = 8178
const DEFAULT_IDLE_MS = 5 * 60_000
const DEFAULT_READY_TIMEOUT_MS = 120_000
const READY_POLL_MS = 250

/** CLI args for whisper-server — pure for tests */
export function buildServerArgs(cfg: WhisperConfig): string[] {
  const args = [
    '-m',
    cfg.modelPath,
    '--host',
    '127.0.0.1',
    '--port',
    String(cfg.port ?? DEFAULT_WHISPER_PORT)
  ]
  if (cfg.vadModelPath) args.push('--vad', '--vad-model', cfg.vadModelPath)
  // the binary defaults to 'en', not autodetect — always pass a language
  args.push('-l', cfg.language || 'auto')
  return args
}

/** Parse an /inference response defensively. verbose_json is the
 *  OpenAI-compatible shape ({text, language, segments:[{start,end,text}]});
 *  older builds emit {transcription:[{offsets:{from,to} (ms), text}]}. */
export function parseWhisperResponse(body: unknown): WhisperResult {
  const b = (body ?? {}) as Record<string, unknown>
  const segments: WhisperResult['segments'] = []

  const push = (t0: unknown, t1: unknown, text: unknown): void => {
    const s0 = Number(t0)
    const s1 = Number(t1)
    const txt = String(text ?? '').trim()
    if (Number.isFinite(s0) && Number.isFinite(s1) && txt)
      segments.push({ t0: s0, t1: s1, text: txt })
  }

  if (Array.isArray(b.segments)) {
    for (const s of b.segments as Record<string, unknown>[]) push(s.start, s.end, s.text)
  } else if (Array.isArray(b.transcription)) {
    for (const s of b.transcription as Record<string, unknown>[]) {
      const off = (s.offsets ?? {}) as Record<string, unknown>
      push(Number(off.from) / 1000, Number(off.to) / 1000, s.text)
    }
  }

  const text =
    typeof b.text === 'string' && b.text.trim()
      ? b.text.trim()
      : segments.map((s) => s.text).join('\n')
  return {
    text,
    language: typeof b.language === 'string' ? b.language : null,
    segments
  }
}

interface Deps {
  spawn: WhisperSpawn
  fetchFn: typeof fetch
  readFile: (path: string) => Promise<Uint8Array>
  log: (level: 'info' | 'warn' | 'error', message: string) => void
}

export class WhisperServer {
  private child: WhisperChildLike | null = null
  private ready: Promise<void> | null = null
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private inFlight = 0
  private spawnError: Error | null = null

  constructor(
    private readonly cfg: WhisperConfig,
    private readonly deps: Deps
  ) {}

  private get baseUrl(): string {
    return `http://127.0.0.1:${this.cfg.port ?? DEFAULT_WHISPER_PORT}`
  }

  async transcribe(wavPath: string): Promise<WhisperResult> {
    this.clearIdleTimer()
    this.inFlight++
    try {
      await this.ensureRunning()
      const bytes = await this.deps.readFile(wavPath)
      const form = new FormData()
      form.append('file', new Blob([bytes as BlobPart], { type: 'audio/wav' }), 'audio.wav')
      form.append('response_format', 'verbose_json')
      form.append('temperature', '0')
      const res = await this.deps.fetchFn(`${this.baseUrl}/inference`, {
        method: 'POST',
        body: form
      })
      if (!res.ok) throw new Error(`whisper-server ${res.status}: ${await res.text()}`)
      return parseWhisperResponse(await res.json())
    } finally {
      this.inFlight--
      if (this.inFlight === 0) this.scheduleIdleShutdown()
    }
  }

  stop(): void {
    this.clearIdleTimer()
    if (this.child) {
      this.deps.log('info', 'whisper: sidecar stopped')
      this.child.kill()
      this.child = null
      this.ready = null
    }
  }

  get running(): boolean {
    return this.child !== null
  }

  private async ensureRunning(): Promise<void> {
    if (!this.child) {
      this.deps.log('info', `whisper: starting sidecar (${this.cfg.modelPath})`)
      this.spawnError = null
      const child = this.deps.spawn(this.cfg.binaryPath, buildServerArgs(this.cfg))
      child.on('exit', () => {
        // crash or external kill — next transcribe() respawns
        if (this.child === child) {
          this.deps.log('warn', 'whisper: sidecar exited')
          this.child = null
          this.ready = null
        }
      })
      // spawn failures (missing binary, not executable, quarantined) emit
      // 'error', never 'exit' — without this we'd poll fetch for the full
      // ready timeout and surface a useless generic message
      child.on('error', (err: Error) => {
        if (this.child === child) {
          this.deps.log('error', `whisper: sidecar failed to start: ${err.message}`)
          this.spawnError = err
          this.child = null
          this.ready = null
        }
      })
      this.child = child
      this.ready = this.waitUntilReady()
    }
    await this.ready
  }

  private async waitUntilReady(): Promise<void> {
    const deadline = Date.now() + (this.cfg.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS)
    for (;;) {
      if (!this.child)
        throw this.spawnError
          ? new Error(`whisper-server failed to start: ${this.spawnError.message}`)
          : new Error('whisper-server exited during startup')
      try {
        // any HTTP response means the server (and thus the model) is up
        await this.deps.fetchFn(this.baseUrl, { method: 'GET' })
        return
      } catch {
        if (Date.now() > deadline) {
          this.stop()
          throw new Error('whisper-server did not become ready in time')
        }
        await new Promise((r) => setTimeout(r, READY_POLL_MS))
      }
    }
  }

  private scheduleIdleShutdown(): void {
    this.clearIdleTimer()
    if (!this.child) return
    this.idleTimer = setTimeout(() => this.stop(), this.cfg.idleMs ?? DEFAULT_IDLE_MS)
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
  }
}

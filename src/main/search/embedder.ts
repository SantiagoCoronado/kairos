// Client for the embedding worker (embed-worker.ts). The model runs in an
// Electron utilityProcess: the main thread never hosts inference (it used to
// stall ~3s per sweep) and a native crash there can't take the app down —
// the worker is restarted with backoff and the caller just gets a rejection,
// which the indexer's sweep loop already tolerates and retries.
import { utilityProcess, type UtilityProcess } from 'electron'
import { join } from 'node:path'
import { DATA_DIR } from '../db'
import { logLine } from '../logger'

export type EmbedderState = 'idle' | 'loading' | 'ready' | 'error'

const REQUEST_TIMEOUT_MS = 120_000 // first call includes the 113MB download
const RESTART_BACKOFF_MS = 15_000

let worker: UtilityProcess | null = null
let workerDiedAt = 0
let nextId = 1
const pending = new Map<
  number,
  { resolve: (v: Float32Array[]) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
>()

let state: EmbedderState = 'idle'
let lastError: string | null = null

export function embedderState(): { state: EmbedderState; error: string | null } {
  return { state, error: lastError }
}

function failAllPending(reason: string): void {
  for (const [, p] of pending) {
    clearTimeout(p.timer)
    p.reject(new Error(reason))
  }
  pending.clear()
}

function getWorker(): UtilityProcess {
  if (worker) return worker
  const sinceDeath = Date.now() - workerDiedAt
  if (sinceDeath < RESTART_BACKOFF_MS) {
    throw new Error(`embed worker restarting (retry in ${Math.ceil((RESTART_BACKOFF_MS - sinceDeath) / 1000)}s)`)
  }
  state = 'loading'
  const w = utilityProcess.fork(join(__dirname, 'embed-worker.js'), [], {
    serviceName: 'kairos-embedder'
  })
  w.on('message', (msg: { id: number; ok: boolean; vecs?: Float32Array[]; error?: string }) => {
    const p = pending.get(msg.id)
    if (!p) return
    pending.delete(msg.id)
    clearTimeout(p.timer)
    if (msg.ok && msg.vecs) {
      state = 'ready'
      lastError = null
      // structured clone hands back plain typed arrays — normalize just in case
      p.resolve(msg.vecs.map((v) => (v instanceof Float32Array ? v : new Float32Array(v))))
    } else {
      lastError = msg.error ?? 'embed failed'
      if (state !== 'ready') state = 'error'
      p.reject(new Error(lastError))
    }
  })
  w.on('exit', (code) => {
    logLine('warn', 'semantic', `embed worker exited (code ${code}) — ${pending.size} in-flight rejected`)
    worker = null
    workerDiedAt = Date.now()
    state = 'error'
    lastError = `worker exited (${code})`
    failAllPending('embed worker died')
  })
  worker = w
  return w
}

function request(kind: 'passages' | 'query', texts: string[]): Promise<Float32Array[]> {
  const w = getWorker()
  const id = nextId++
  return new Promise<Float32Array[]>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error('embed request timed out'))
    }, REQUEST_TIMEOUT_MS)
    pending.set(id, { resolve, reject, timer })
    w.postMessage({ id, kind, texts, cacheDir: join(DATA_DIR, 'models') })
  })
}

export async function embedPassages(texts: string[]): Promise<Float32Array[]> {
  if (texts.length === 0) return []
  return request('passages', texts)
}

export async function embedQuery(text: string): Promise<Float32Array> {
  const [v] = await request('query', [text])
  return v
}

export function stopEmbedder(): void {
  failAllPending('shutting down')
  worker?.kill()
  worker = null
}

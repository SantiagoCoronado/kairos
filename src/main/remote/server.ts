import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join, normalize, extname } from 'node:path'
import { networkInterfaces, hostname } from 'node:os'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { WebSocketServer, WebSocket } from 'ws'
import type { IpcEvents, RemoteStatus } from '../../shared/ipc-contract'
import { getSettings, saveSettings } from '../settings'
import { logLine } from '../logger'

/**
 * Remote-access server: lets a phone/browser run the same renderer bundle
 * against this process. HTTP serves the built renderer; a WebSocket at /ws
 * speaks the IpcApi contract (invoke request/response + pushed IpcEvents).
 *
 * Security model: intended for a private network (Tailscale). The static
 * bundle is served unauthenticated (it contains no data); every WebSocket —
 * the only thing that can touch data — requires the bearer token minted on
 * first enable. Shell/window channels are refused outright: a remote client
 * is a viewer of this app, not a terminal on this machine.
 */

const DENIED = [/^terminal:/, /^capture:/]
/** invoke payloads are JSON control traffic; attachments ride base64 data
 *  URLs in *responses*, so requests never need to be big */
const MAX_FRAME_BYTES = 1024 * 1024

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (...args: any[]) => unknown

let handlersRef: ReadonlyMap<string, Handler> | null = null
let server: Server | null = null
let wss: WebSocketServer | null = null
let runningPort = 0
let lastError: string | null = null

/** mirror of ipc.ts broadcast(): push an event frame to every connected client */
export function remoteBroadcast<K extends keyof IpcEvents>(
  channel: K,
  payload: IpcEvents[K]
): void {
  if (!wss || wss.clients.size === 0) return
  const frame = JSON.stringify({ event: channel, payload })
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(frame)
  }
}

export function getRemoteStatus(): RemoteStatus {
  const s = getSettings()
  return {
    running: server !== null,
    port: server ? runningPort : s.remotePort,
    token: s.remoteToken,
    urls: server && s.remoteToken ? connectUrls(runningPort, s.remoteToken) : [],
    clients: wss?.clients.size ?? 0,
    error: lastError
  }
}

/** reconcile server state with settings — call at startup and after settings:set */
export function syncRemoteServer(handlers: ReadonlyMap<string, Handler>): void {
  handlersRef = handlers
  const s = getSettings()
  if (s.remoteAccess && server && runningPort === s.remotePort) return
  stopRemoteServer()
  if (!s.remoteAccess) return
  if (!s.remoteToken) saveSettings({ remoteToken: randomBytes(24).toString('base64url') })
  start(getSettings().remotePort)
}

export function stopRemoteServer(): void {
  if (!server) return
  for (const client of wss?.clients ?? []) client.terminate()
  wss?.close()
  server.close()
  wss = null
  server = null
  logLine('info', 'remote', 'server stopped')
}

function start(port: number): void {
  lastError = null
  const httpServer = createServer((req, res) => void serveStatic(req, res))
  const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES })

  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname !== '/ws' || !tokenOk(url.searchParams.get('token'))) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      logLine('warn', 'remote', `rejected ws upgrade from ${req.socket.remoteAddress}`)
      return
    }
    sockets.handleUpgrade(req, socket, head, (client) => {
      logLine('info', 'remote', `client connected from ${req.socket.remoteAddress}`)
      client.on('message', (data) => void onInvoke(client, String(data)))
      client.on('close', () => logLine('info', 'remote', 'client disconnected'))
    })
  })

  httpServer.on('error', (err) => {
    lastError = err.message
    logLine('error', 'remote', `server error: ${err.message}`)
    stopRemoteServer()
  })

  // all interfaces: tailscale + LAN. Data access is token-gated at the WS.
  httpServer.listen(port, '0.0.0.0', () => {
    logLine('info', 'remote', `serving on :${port}`)
  })
  server = httpServer
  wss = sockets
  runningPort = port
}

function tokenOk(presented: string | null): boolean {
  const expected = getSettings().remoteToken
  if (!presented || !expected) return false
  const a = Buffer.from(presented)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

async function onInvoke(client: WebSocket, raw: string): Promise<void> {
  let id: number | null = null
  try {
    const msg = JSON.parse(raw) as { id: number; channel: string; args: unknown[] }
    id = msg.id
    if (DENIED.some((rx) => rx.test(msg.channel)))
      throw new Error(`${msg.channel} is not available over remote access`)
    const handler = handlersRef?.get(msg.channel)
    if (!handler) throw new Error(`unknown channel: ${msg.channel}`)
    const result = await handler(...(Array.isArray(msg.args) ? msg.args : []))
    client.send(JSON.stringify({ id, ok: true, result: result ?? null }))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logLine('error', 'remote', `invoke failed: ${message}`)
    if (id !== null) client.send(JSON.stringify({ id, ok: false, error: message }))
  }
}

// ---------------------------------------------------------------------------
// static bundle

/** out/main/../renderer — same relative layout in dev builds and inside app.asar */
const STATIC_ROOT = join(__dirname, '../renderer')

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.map': 'application/json'
}

async function serveStatic(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'GET') {
    res.writeHead(405).end()
    return
  }
  const url = new URL(req.url ?? '/', 'http://localhost')
  let rel = decodeURIComponent(url.pathname)
  if (rel === '/') rel = '/index.html'
  const path = normalize(join(STATIC_ROOT, rel))
  if (!path.startsWith(STATIC_ROOT)) {
    res.writeHead(403).end()
    return
  }
  try {
    const body = await readFile(path)
    res.writeHead(200, {
      'content-type': MIME[extname(path)] ?? 'application/octet-stream',
      'cache-control': 'no-cache'
    })
    res.end(body)
  } catch {
    res.writeHead(404).end('not found')
  }
}

// ---------------------------------------------------------------------------

/** candidate URLs, best first: tailscale (100.x CGNAT), then LAN, then hostname */
function connectUrls(port: number, token: string): string[] {
  const tail: string[] = []
  const lan: string[] = []
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue
      if (a.address.startsWith('100.')) tail.push(a.address)
      else lan.push(a.address)
    }
  }
  const hosts = [...tail, ...lan]
  if (hosts.length === 0) hosts.push(hostname())
  return hosts.map((h) => `http://${h}:${port}/#token=${token}`)
}

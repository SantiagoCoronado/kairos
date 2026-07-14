import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join, normalize, extname } from 'node:path'
import { networkInterfaces, hostname } from 'node:os'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { execFile } from 'node:child_process'
import { WebSocketServer, WebSocket } from 'ws'
import type { IpcEvents, RemoteStatus } from '../../shared/ipc-contract'
import { getSettings, saveSettings } from '../settings'
import { stageBuffer } from '../chat/uploads'
import { getVapidPublicKey, addPushSubscription, removePushSubscription, sendPushAll } from './push'
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

// capture:* window management is never remotely useful — except capture:submit,
// which is a plain DB write that the phone's voice capture rides. terminal:* is
// a shell on this machine — refused unless the user explicitly opts in
// (Settings → remote access → allow terminal).
const ALWAYS_DENIED = [/^capture:(?!submit$)/]
const TERMINAL = /^terminal:/

function isDenied(channel: string): boolean {
  if (ALWAYS_DENIED.some((rx) => rx.test(channel))) return true
  if (TERMINAL.test(channel) && !getSettings().remoteTerminal) return true
  return false
}
/** invoke payloads are mostly JSON control traffic (attachments ride base64
 *  data URLs in *responses*) — but stt:transcribe carries a base64 voice memo
 *  in the request (~1MB per minute of Safari AAC), so leave headroom */
const MAX_FRAME_BYTES = 8 * 1024 * 1024

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
  // terminal output is shell data — don't stream it to remote clients unless
  // terminal-over-remote is enabled, matching the invoke denylist
  if (channel === 'terminal:event' && !getSettings().remoteTerminal) return
  const frame = JSON.stringify({ event: channel, payload })
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(frame)
  }
}

export async function getRemoteStatus(): Promise<RemoteStatus> {
  const s = getSettings()
  const ts = server ? await tailscaleInfo() : { dns: null, serveActive: false }
  return {
    running: server !== null,
    port: server ? runningPort : s.remotePort,
    token: s.remoteToken,
    urls: server && s.remoteToken ? connectUrls(runningPort, s.remoteToken) : [],
    httpsUrl:
      server && ts.dns && s.remoteToken ? `https://${ts.dns}/#token=${s.remoteToken}` : null,
    serveActive: ts.serveActive,
    clients: wss?.clients.size ?? 0,
    error: lastError
  }
}

// --- tailscale detection (best-effort) -------------------------------------
// The HTTPS URL matters on iOS: PWA install + push need a secure context,
// and `tailscale serve` provides it with a real cert on the tailnet name.
// If the CLI isn't there, everything silently falls back to the plain URLs.

const TAILSCALE_BINS = ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', 'tailscale']
let tsCache: { dns: string | null; serveActive: boolean; at: number } | null = null

function tsExec(args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    const tryBin = (i: number): void => {
      if (i >= TAILSCALE_BINS.length) return resolve(null)
      execFile(TAILSCALE_BINS[i], args, { timeout: 3000 }, (err, stdout) => {
        if (err) tryBin(i + 1)
        else resolve(String(stdout))
      })
    }
    tryBin(0)
  })
}

async function tailscaleInfo(): Promise<{ dns: string | null; serveActive: boolean }> {
  if (tsCache && Date.now() - tsCache.at < 30_000) return tsCache
  let dns: string | null = null
  let serveActive = false
  const status = await tsExec(['status', '--json'])
  if (status) {
    try {
      dns = String((JSON.parse(status) as { Self?: { DNSName?: string } }).Self?.DNSName ?? '')
        .replace(/\.$/, '')
      if (!dns) dns = null
    } catch {
      dns = null
    }
  }
  if (dns) {
    const serve = await tsExec(['serve', 'status'])
    serveActive = serve !== null && serve.includes(`:${runningPort}`)
  }
  tsCache = { dns, serveActive, at: Date.now() }
  return tsCache
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
  const httpServer = createServer((req, res) => void handleHttp(req, res))
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
    if (isDenied(msg.channel))
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
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.map': 'application/json'
}

/** chat attachments from the phone; invoke payloads stay small but files don't */
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024

async function handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (req.method === 'POST' && url.pathname === '/upload') {
    handleUpload(req, res, url)
    return
  }
  if (url.pathname.startsWith('/push/')) {
    handlePush(req, res, url)
    return
  }
  if (req.method !== 'GET') {
    res.writeHead(405).end()
    return
  }
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

/** /push/key (GET), /push/subscribe, /push/unsubscribe (POST JSON) — all
 *  token-gated. Subscribing fires a confirmation push so the device knows
 *  immediately whether the whole APNs round-trip works. */
function handlePush(req: IncomingMessage, res: ServerResponse, url: URL): void {
  const token = String(req.headers['x-kairos-token'] ?? url.searchParams.get('token') ?? '')
  if (!tokenOk(token)) {
    res.writeHead(401).end()
    return
  }
  if (req.method === 'GET' && url.pathname === '/push/key') {
    res
      .writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ publicKey: getVapidPublicKey() }))
    return
  }
  if (req.method !== 'POST') {
    res.writeHead(405).end()
    return
  }
  const chunks: Buffer[] = []
  let total = 0
  req.on('data', (c: Buffer) => {
    total += c.length
    if (total > 64 * 1024) req.destroy()
    else chunks.push(c)
  })
  req.on('end', () => {
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        endpoint?: string
        keys?: { p256dh: string; auth: string }
      }
      if (!body.endpoint) throw new Error('missing endpoint')
      if (url.pathname === '/push/subscribe') {
        if (!body.keys?.p256dh || !body.keys.auth) throw new Error('missing keys')
        const count = addPushSubscription({ endpoint: body.endpoint, keys: body.keys })
        sendPushAll({ title: 'Kairos', body: 'Notifications enabled on this device.' })
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ count }))
      } else if (url.pathname === '/push/unsubscribe') {
        const count = removePushSubscription(body.endpoint)
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ count }))
      } else {
        res.writeHead(404).end()
      }
    } catch (err) {
      res.writeHead(400).end(err instanceof Error ? err.message : 'bad request')
    }
  })
}

/** POST /upload?name=… — raw file bytes in, staged ChatAttachment JSON out.
 *  Token-gated like the WS: uploads write to disk, so no anonymous writes. */
function handleUpload(req: IncomingMessage, res: ServerResponse, url: URL): void {
  const token = String(req.headers['x-kairos-token'] ?? url.searchParams.get('token') ?? '')
  if (!tokenOk(token)) {
    res.writeHead(401).end()
    return
  }
  const name = url.searchParams.get('name') ?? 'file'
  const chunks: Buffer[] = []
  let total = 0
  let aborted = false
  req.on('data', (c: Buffer) => {
    if (aborted) return
    total += c.length
    if (total > MAX_UPLOAD_BYTES) {
      aborted = true
      res.writeHead(413).end('file too large (50MB max)')
      req.destroy()
      return
    }
    chunks.push(c)
  })
  req.on('end', () => {
    if (aborted) return
    try {
      const att = stageBuffer(name, Buffer.concat(chunks))
      logLine('info', 'remote', `staged upload ${att.name} (${att.size} bytes)`)
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(att))
    } catch (err) {
      logLine('error', 'remote', `upload failed: ${err instanceof Error ? err.message : String(err)}`)
      res.writeHead(500).end('upload failed')
    }
  })
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

// Web push to installed PWAs (the phone). VAPID keys are minted once and
// kept with the subscriptions in DATA_DIR/push.json. Sending is fire-and-
// forget: a dead subscription (404/410 from the push service) self-prunes.
import webpush from 'web-push'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from '../db'
import { logLine } from '../logger'

const FILE = join(DATA_DIR, 'push.json')
// APNs (which relays pushes to iPhones) validates the VAPID subject exists
const VAPID_SUBJECT = 'mailto:santiago.coronado94@gmail.com'

interface PushState {
  publicKey: string
  privateKey: string
  subs: webpush.PushSubscription[]
}

let cached: PushState | null = null

function load(): PushState {
  if (cached) return cached
  try {
    cached = JSON.parse(readFileSync(FILE, 'utf8')) as PushState
  } catch {
    const keys = webpush.generateVAPIDKeys()
    cached = { publicKey: keys.publicKey, privateKey: keys.privateKey, subs: [] }
    save()
    logLine('info', 'push', 'generated VAPID keypair')
  }
  return cached
}

function save(): void {
  mkdirSync(DATA_DIR, { recursive: true })
  writeFileSync(FILE, JSON.stringify(cached, null, 2) + '\n')
}

export function getVapidPublicKey(): string {
  return load().publicKey
}

export function addPushSubscription(sub: webpush.PushSubscription): number {
  const s = load()
  if (!s.subs.some((x) => x.endpoint === sub.endpoint)) {
    s.subs.push(sub)
    save()
    logLine('info', 'push', `subscription added (${s.subs.length} device${s.subs.length > 1 ? 's' : ''})`)
  }
  return s.subs.length
}

export function removePushSubscription(endpoint: string): number {
  const s = load()
  const before = s.subs.length
  s.subs = s.subs.filter((x) => x.endpoint !== endpoint)
  if (s.subs.length !== before) {
    save()
    logLine('info', 'push', `subscription removed (${s.subs.length} left)`)
  }
  return s.subs.length
}

export interface PushPayload {
  title: string
  body: string
  threadId?: string
}

/** push `payload` to every registered device; dead endpoints self-prune */
export function sendPushAll(payload: PushPayload): void {
  const s = load()
  if (s.subs.length === 0) return
  const data = JSON.stringify(payload)
  const vapidDetails = {
    subject: VAPID_SUBJECT,
    publicKey: s.publicKey,
    privateKey: s.privateKey
  }
  for (const sub of [...s.subs]) {
    webpush
      .sendNotification(sub, data, { vapidDetails, TTL: 3600 })
      .then(() => logLine('info', 'push', `pushed "${payload.title}"`))
      .catch((err: { statusCode?: number; message?: string }) => {
        if (err.statusCode === 404 || err.statusCode === 410) {
          removePushSubscription(sub.endpoint)
          logLine('info', 'push', 'pruned dead subscription')
        } else {
          logLine('warn', 'push', `send failed: ${err.statusCode ?? err.message ?? String(err)}`)
        }
      })
  }
}

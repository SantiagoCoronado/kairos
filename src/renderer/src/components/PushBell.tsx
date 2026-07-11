import { useEffect, useState } from 'react'
import { Bell, BellOff, BellRing } from 'lucide-react'
import { getRemoteToken } from '../lib/api'
import { IS_REMOTE } from '../lib/mobile'

type PushState = 'unsupported' | 'off' | 'on' | 'denied' | 'busy'

/** urlBase64 (VAPID public key wire format) → the Uint8Array subscribe wants.
 *  Explicit ArrayBuffer backing: TS's BufferSource excludes ArrayBufferLike. */
function keyBytes(base64: string): Uint8Array<ArrayBuffer> {
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
  const raw = atob(padded.replace(/-/g, '+').replace(/_/g, '/'))
  const out = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

const pushHeaders = (): Record<string, string> => ({
  'x-kairos-token': getRemoteToken() ?? '',
  'content-type': 'application/json'
})

/**
 * Notification toggle for remote clients. Hidden entirely where push can't
 * work (inside Electron, or an iOS Safari tab — the PWA must be installed
 * to Home Screen before PushManager exists).
 */
export function PushBell(): React.JSX.Element | null {
  const [state, setState] = useState<PushState>('unsupported')

  useEffect(() => {
    if (!IS_REMOTE || !('serviceWorker' in navigator) || !('PushManager' in window)) return
    if (Notification.permission === 'denied') {
      setState('denied')
      return
    }
    void navigator.serviceWorker.getRegistration().then(async (reg) => {
      const sub = await reg?.pushManager.getSubscription()
      setState(sub ? 'on' : 'off')
    })
  }, [])

  const enable = async (): Promise<void> => {
    setState('busy')
    try {
      // permission prompt must ride the tap's user gesture
      const perm = await Notification.requestPermission()
      if (perm !== 'granted') {
        setState(perm === 'denied' ? 'denied' : 'off')
        return
      }
      const reg = await navigator.serviceWorker.getRegistration()
      if (!reg) throw new Error('no service worker')
      const keyRes = await fetch('/push/key', { headers: pushHeaders() })
      const { publicKey } = (await keyRes.json()) as { publicKey: string }
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: keyBytes(publicKey)
      })
      const res = await fetch('/push/subscribe', {
        method: 'POST',
        headers: pushHeaders(),
        body: JSON.stringify(sub.toJSON())
      })
      if (!res.ok) throw new Error(`subscribe failed (${res.status})`)
      setState('on')
    } catch {
      setState('off')
    }
  }

  const disable = async (): Promise<void> => {
    setState('busy')
    try {
      const reg = await navigator.serviceWorker.getRegistration()
      const sub = await reg?.pushManager.getSubscription()
      if (sub) {
        await fetch('/push/unsubscribe', {
          method: 'POST',
          headers: pushHeaders(),
          body: JSON.stringify({ endpoint: sub.endpoint })
        })
        await sub.unsubscribe()
      }
      setState('off')
    } catch {
      setState('on')
    }
  }

  if (state === 'unsupported') return null

  const label =
    state === 'on'
      ? 'Notifications on — tap to disable on this device'
      : state === 'denied'
        ? 'Notifications blocked — allow Kairos in iOS Settings → Notifications'
        : 'Notify this device about important messages'

  return (
    <button
      title={label}
      disabled={state === 'busy' || state === 'denied'}
      onClick={() => void (state === 'on' ? disable() : enable())}
      className={`shrink-0 h-9 w-9 rounded-md flex items-center justify-center transition-colors ${
        state === 'on' ? 'text-accent' : 'text-faint active:text-text'
      } ${state === 'denied' ? 'opacity-40' : ''}`}
    >
      {state === 'on' ? <BellRing size={17} /> : state === 'denied' ? <BellOff size={17} /> : <Bell size={17} />}
    </button>
  )
}

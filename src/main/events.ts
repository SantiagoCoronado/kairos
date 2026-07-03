import type { AppEventName } from '../core/types'
import { logLine } from './logger'

// Tiny main-process event bus for automation triggers. Deliberately minimal:
// no payloads beyond the name (event tasks re-query whatever they need), no
// once/off ceremony beyond the returned unsubscribe.

type Listener = (event: AppEventName) => void

const listeners = new Map<AppEventName, Set<Listener>>()

export function onAppEvent(event: AppEventName, cb: Listener): () => void {
  let set = listeners.get(event)
  if (!set) {
    set = new Set()
    listeners.set(event, set)
  }
  set.add(cb)
  return () => set!.delete(cb)
}

export function emitAppEvent(event: AppEventName): void {
  const set = listeners.get(event)
  if (!set?.size) return
  for (const cb of set) {
    try {
      cb(event)
    } catch (err) {
      logLine('error', 'events', `${event} listener failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

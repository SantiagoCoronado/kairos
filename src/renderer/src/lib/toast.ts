/** Global transient toasts — the delivery channel for background work
 *  (voice commands, anything async) so results land wherever the user is.
 *  Module-level store, subscribed by ToastHost via useSyncExternalStore. */

export type ToastVariant = 'working' | 'success' | 'error'

export interface Toast {
  id: number
  variant: ToastVariant
  text: string
  /** secondary line, e.g. the spoken transcript */
  detail?: string
}

interface ToastOptions {
  variant: ToastVariant
  text: string
  detail?: string
  /** auto-dismiss delay; omit for sticky (default for working/error) */
  timeoutMs?: number
}

const SUCCESS_TIMEOUT_MS = 4000

let nextId = 1
let toasts: readonly Toast[] = []
const listeners = new Set<() => void>()
const timers = new Map<number, ReturnType<typeof setTimeout>>()

function commit(next: readonly Toast[]): void {
  toasts = next
  listeners.forEach((fn) => fn())
}

function schedule(id: number, timeoutMs: number | undefined): void {
  const old = timers.get(id)
  if (old) clearTimeout(old)
  timers.delete(id)
  if (timeoutMs !== undefined) timers.set(id, setTimeout(() => dismissToast(id), timeoutMs))
}

export function subscribeToasts(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function getToasts(): readonly Toast[] {
  return toasts
}

/** success auto-dismisses unless told otherwise; working/error stick */
export function toast(opts: ToastOptions): number {
  const id = nextId++
  commit([...toasts, { id, variant: opts.variant, text: opts.text, detail: opts.detail }])
  schedule(id, opts.timeoutMs ?? (opts.variant === 'success' ? SUCCESS_TIMEOUT_MS : undefined))
  return id
}

/** morph a toast in place (working → success/error); no-op if dismissed */
export function updateToast(id: number, opts: ToastOptions): void {
  if (!toasts.some((t) => t.id === id)) return
  commit(
    toasts.map((t) =>
      t.id === id ? { id, variant: opts.variant, text: opts.text, detail: opts.detail } : t
    )
  )
  schedule(id, opts.timeoutMs ?? (opts.variant === 'success' ? SUCCESS_TIMEOUT_MS : undefined))
}

export function dismissToast(id: number): void {
  const timer = timers.get(id)
  if (timer) clearTimeout(timer)
  timers.delete(id)
  if (toasts.some((t) => t.id === id)) commit(toasts.filter((t) => t.id !== id))
}

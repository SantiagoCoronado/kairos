/** Undo window for inbox actions. Two shapes share one stack:
 *  - revert-style (archive, pin): the action already ran; undo runs the inverse
 *  - commit-style (send, delete): the action is DEFERRED and runs only when the
 *    window closes un-undone, so undo simply cancels it
 *  Each entry shows a toast with an Undo button; ⌘Z (outside text fields)
 *  undoes the newest entry. */

import { toast, dismissToast } from './toast'

export const UNDO_WINDOW_MS = 6000

interface UndoEntry {
  id: number
  toastId: number
  timer: ReturnType<typeof setTimeout>
  commit?: () => void
  revert?: () => void
}

let nextId = 1
const stack: UndoEntry[] = []

function take(id: number): UndoEntry | null {
  const i = stack.findIndex((e) => e.id === id)
  if (i < 0) return null
  const [entry] = stack.splice(i, 1)
  clearTimeout(entry.timer)
  return entry
}

function expire(id: number): void {
  take(id)?.commit?.()
}

function undoEntry(id: number): void {
  const entry = take(id)
  if (!entry) return
  dismissToast(entry.toastId)
  entry.revert?.()
}

export function pushUndo(opts: {
  label: string
  /** deferred work — runs when the window closes without an undo */
  commit?: () => void
  /** inverse of already-applied work (and/or UI restoration) */
  revert?: () => void
  windowMs?: number
}): void {
  const id = nextId++
  const windowMs = opts.windowMs ?? UNDO_WINDOW_MS
  const toastId = toast({
    variant: 'success',
    text: opts.label,
    timeoutMs: windowMs,
    action: { label: 'Undo ⌘Z', run: () => undoEntry(id) }
  })
  const timer = setTimeout(() => expire(id), windowMs)
  stack.push({ id, toastId, timer, commit: opts.commit, revert: opts.revert })
}

/** ⌘Z target. Returns false when there is nothing pending (let native undo run). */
export function undoLast(): boolean {
  const entry = stack[stack.length - 1]
  if (!entry) return false
  undoEntry(entry.id)
  return true
}

/** window teardown: a deferred send/delete must not silently evaporate */
function flushPending(): void {
  while (stack.length > 0) {
    const entry = stack.pop()!
    clearTimeout(entry.timer)
    entry.commit?.()
  }
}
if (typeof window !== 'undefined') window.addEventListener('beforeunload', flushPending)

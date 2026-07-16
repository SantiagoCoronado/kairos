// What the user is currently looking at, for context-aware voice commands
// ("make this email a task for tomorrow"). Views publish their focused
// entity here; the ⌘K voice pane reads it and ships it with the transcript.
// A plain module singleton — no re-renders needed, the palette reads it at
// record time.
import type { CaptureContext } from '../../../shared/ipc-contract'

let current: CaptureContext | null = null

export function setCaptureContext(ctx: CaptureContext): void {
  current = ctx
}

/** clear only if the leaving view still owns the context (id match) —
 *  unmount effects of the old view may run after the new view published */
export function clearCaptureContext(id: string): void {
  if (current?.id === id) current = null
}

export function getCaptureContext(): CaptureContext | null {
  return current
}

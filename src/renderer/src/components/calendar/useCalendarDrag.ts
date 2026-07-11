import { useEffect, useRef } from 'react'

const THRESHOLD_PX = 4
// touch precision is coarser than a mouse cursor — a wider dead zone keeps
// a resting finger's natural jitter from arming a drag
const TOUCH_THRESHOLD_PX = 10

export interface DragHandlers<T> {
  /** fires once the pointer moved past the click threshold */
  onStart?: (ctx: T, e: PointerEvent, delta: { dx: number; dy: number }) => void
  onMove: (ctx: T, e: PointerEvent) => void
  /** activated=false means the gesture never left the threshold — a click */
  onEnd: (ctx: T, e: PointerEvent, activated: boolean) => void
}

/**
 * Minimal pointer-drag lifecycle for the calendar grids (HTML5 DnD can't do
 * fine-grained y-positioning or resize). Window-level listeners so the drag
 * survives leaving the source element; a threshold separates click from drag.
 * Returns a `begin` function for pointerdown handlers.
 */
export function usePointerDrag<T>(handlers: DragHandlers<T>): (e: React.PointerEvent, ctx: T) => void {
  // keep latest handlers without re-binding listeners mid-drag
  const ref = useRef(handlers)
  ref.current = handlers
  const cleanupRef = useRef<(() => void) | null>(null)

  useEffect(() => () => cleanupRef.current?.(), [])

  return (e: React.PointerEvent, ctx: T): void => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX
    const startY = e.clientY
    const threshold = e.pointerType === 'touch' ? TOUCH_THRESHOLD_PX : THRESHOLD_PX
    let activated = false

    const move = (ev: PointerEvent): void => {
      const dx = ev.clientX - startX
      const dy = ev.clientY - startY
      if (!activated) {
        if (Math.abs(dx) < threshold && Math.abs(dy) < threshold) return
        activated = true
        ref.current.onStart?.(ctx, ev, { dx, dy })
      }
      ref.current.onMove(ctx, ev)
    }
    const up = (ev: PointerEvent): void => {
      cleanup()
      ref.current.onEnd(ctx, ev, activated)
    }
    const cancel = (ev: PointerEvent): void => {
      cleanup()
      // iOS routinely hijacks a not-yet-activated touch drag mid-gesture to
      // run its own native scroll (e.g. a scroll attempt that started on top
      // of an event card), sending pointercancel instead of further
      // pointermoves. That's an interrupted gesture, not a completed tap —
      // treating it as one is what made "drag the calendar" open the event
      // dialog. Only a real pointerup should ever resolve to a click.
      if (activated) ref.current.onEnd(ctx, ev, true)
    }
    const cleanup = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cancel)
      cleanupRef.current = null
    }
    cleanupRef.current = cleanup
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cancel)
  }
}

export function snapMinutes(min: number, step = 15): number {
  return Math.round(min / step) * step
}

export function clampMinutes(min: number): number {
  return Math.max(0, Math.min(24 * 60, min))
}

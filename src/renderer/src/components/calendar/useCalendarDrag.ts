import { useEffect, useRef } from 'react'

const THRESHOLD_PX = 4

export interface DragHandlers<T> {
  /** fires once the pointer moved past the click threshold */
  onStart?: (ctx: T, e: PointerEvent) => void
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
    let activated = false

    const move = (ev: PointerEvent): void => {
      if (!activated) {
        if (Math.abs(ev.clientX - startX) < THRESHOLD_PX && Math.abs(ev.clientY - startY) < THRESHOLD_PX)
          return
        activated = true
        ref.current.onStart?.(ctx, ev)
      }
      ref.current.onMove(ctx, ev)
    }
    const up = (ev: PointerEvent): void => {
      cleanup()
      ref.current.onEnd(ctx, ev, activated)
    }
    const cleanup = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      cleanupRef.current = null
    }
    cleanupRef.current = cleanup
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }
}

export function snapMinutes(min: number, step = 15): number {
  return Math.round(min / step) * step
}

export function clampMinutes(min: number): number {
  return Math.max(0, Math.min(24 * 60, min))
}

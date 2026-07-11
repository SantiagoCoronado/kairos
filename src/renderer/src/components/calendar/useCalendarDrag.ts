import { useEffect, useRef } from 'react'

const THRESHOLD_PX = 4 // mouse: movement below this is a click
const TOUCH_SLOP_PX = 10 // touch: finger-jitter allowance before the gesture is classified
const LONG_PRESS_MS = 350 // touch: hold this long (without moving) to arm a drag
const SWIPE_MIN_PX = 50 // touch: horizontal travel needed to commit a swipe

// One calendar gesture at a time. While a drag is armed (or a swipe is in
// flight) the blocker vetoes native scrolling so it can't pointercancel us.
let gestureOwned = false
const blockNativeScroll = (e: TouchEvent): void => {
  if (gestureOwned) e.preventDefault()
}
// iOS Safari honors window-level non-passive listeners; register once.
window.addEventListener('touchmove', blockNativeScroll, { passive: false })

/**
 * Ref callback for every element a calendar drag can start on (event cards,
 * day columns, month pills). Chromium only reliably delivers *cancelable*
 * touchmoves to non-passive listeners pre-registered on the touched element
 * itself — window/document listeners registered at pointerdown time (or even
 * at mount) may never be consulted, letting native scroll pointercancel an
 * armed drag. React can't register non-passive handlers, hence the raw ref.
 * Re-adding the same handler is a DOM no-op and listeners die with the node,
 * so no cleanup bookkeeping is needed.
 */
export function touchBlockRef(el: Element | null): void {
  el?.addEventListener('touchmove', blockNativeScroll as EventListener, { passive: false })
}

export interface DragHandlers<T> {
  /** fires once the pointer moved past the click threshold */
  onStart?: (ctx: T, e: PointerEvent) => void
  onMove: (ctx: T, e: PointerEvent) => void
  /** activated=false means the gesture never left the threshold — a click */
  onEnd: (ctx: T, e: PointerEvent, activated: boolean) => void
  /** touch only: a fast horizontal drag resolves as navigation (1 = next, -1 = prev)
   *  instead of a drag — mirrors Gmail/Google Calendar swipe-to-change-page */
  onSwipe?: (dir: 1 | -1) => void
}

/**
 * Minimal pointer-drag lifecycle for the calendar grids (HTML5 DnD can't do
 * fine-grained y-positioning or resize). Window-level listeners so the drag
 * survives leaving the source element. Returns a `begin` function for
 * pointerdown handlers.
 *
 * Mouse: a 4px threshold separates click from drag, drag starts immediately.
 *
 * Touch: the browser competes for every touch (scroll, page pan), so drags
 * must be armed by a long-press first — the grid needs `touch-action: pan-y`
 * so horizontal movement keeps delivering pointer events at all. The gesture
 * is classified by what happens first:
 *   - lift before moving            → tap (click)
 *   - horizontal move before hold   → swipe navigation (if onSwipe given)
 *   - vertical move before hold     → abandoned; the browser scrolls natively
 *   - hold still LONG_PRESS_MS      → drag armed; first move starts it, and
 *     touchmove is preventDefault'ed from then on so scroll can't steal it
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
    const touch = e.pointerType === 'touch'
    let activated = false
    let armed = !touch // mouse is always armed; touch arms via long-press
    let swipeDx: number | null = null // non-null → gesture resolved as a swipe

    // arming claims the touch: the pre-registered blockers start
    // preventDefault-ing so native scroll can never steal the drag
    const timer = touch
      ? window.setTimeout(() => {
          armed = true
          gestureOwned = true
        }, LONG_PRESS_MS)
      : 0

    const move = (ev: PointerEvent): void => {
      const dx = ev.clientX - startX
      const dy = ev.clientY - startY
      if (swipeDx !== null) {
        swipeDx = dx
        return
      }
      if (!activated) {
        if (touch && !armed) {
          if (Math.abs(dx) < TOUCH_SLOP_PX && Math.abs(dy) < TOUCH_SLOP_PX) return
          window.clearTimeout(timer)
          if (ref.current.onSwipe && Math.abs(dx) > Math.abs(dy) * 1.5) {
            swipeDx = dx
            gestureOwned = true
            return
          }
          cleanup() // moved before the hold: this is a scroll — the browser's
          return
        }
        if (!touch && Math.abs(dx) < THRESHOLD_PX && Math.abs(dy) < THRESHOLD_PX) return
        activated = true
        ref.current.onStart?.(ctx, ev)
      }
      ref.current.onMove(ctx, ev)
    }
    const up = (ev: PointerEvent): void => {
      const dxAtUp = swipeDx
      cleanup()
      if (dxAtUp !== null) {
        if (Math.abs(dxAtUp) >= SWIPE_MIN_PX) ref.current.onSwipe?.(dxAtUp < 0 ? 1 : -1)
        return
      }
      ref.current.onEnd(ctx, ev, activated)
    }
    const cancel = (ev: PointerEvent): void => {
      cleanup()
      // an unactivated pointercancel means the browser took the gesture for
      // native scrolling — an interrupted gesture, not a tap. Only a real
      // pointerup may resolve to a click.
      if (activated) ref.current.onEnd(ctx, ev, true)
    }
    const cleanup = (): void => {
      gestureOwned = false
      window.clearTimeout(timer)
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

import { useCallback, useRef, useState } from 'react'

export const clamp = (v: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, v))

export type WidthSpec = { def: number; min: number; max: number }

const storedWidth = (key: string, spec: WidthSpec): number => {
  const raw = Number(localStorage.getItem(key))
  return Number.isFinite(raw) && raw > 0 ? raw : spec.def
}

/** Drag-resizable column width, persisted to localStorage on mouseup.
 *  The spec is applied on every render, so a caller can shrink `max` with
 *  the window and the stored width springs back once there is room again. */
export function useResizableWidth(
  key: string,
  spec: WidthSpec
): { width: number; startResize: (e: React.MouseEvent) => void } {
  const [stored, setWidth] = useState(() => storedWidth(key, spec))
  const width = clamp(stored, spec.min, spec.max)
  const startResize = (e: React.MouseEvent): void => {
    e.preventDefault()
    const startX = e.clientX
    const startW = width
    // the unclamped choice, restored if the drag turns out to be a no-op
    const startStored = stored
    let latest = startW
    const move = (ev: MouseEvent): void => {
      latest = clamp(startW + ev.clientX - startX, spec.min, spec.max)
      setWidth(latest)
    }
    const up = (): void => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      // a drag the clamp swallowed whole must not replace the width the
      // reader chose when the window was wide enough to honor it — neither
      // the persisted copy nor the live one `move` already wrote
      if (latest === startW) setWidth(startStored)
      else localStorage.setItem(key, String(latest))
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }
  return { width, startResize }
}

/** Live width of the element the ref lands on; 0 until one has mounted.
 *  A callback ref, so the element may be rendered conditionally or swapped —
 *  whatever currently carries the ref is the one being measured. */
export function useMeasuredWidth(): [(el: HTMLElement | null) => void, number] {
  const [width, setWidth] = useState(0)
  const observer = useRef<ResizeObserver | null>(null)
  const ref = useCallback((el: HTMLElement | null) => {
    observer.current?.disconnect()
    observer.current = null
    if (!el) return
    setWidth(el.clientWidth)
    observer.current = new ResizeObserver(() => setWidth(el.clientWidth))
    observer.current.observe(el)
  }, [])
  return [ref, width]
}

/** 4px grab strip over a column's right border. Parent must be `relative`. */
export function ResizeHandle({
  onMouseDown
}: {
  onMouseDown: (e: React.MouseEvent) => void
}): React.JSX.Element {
  return (
    <div
      className="absolute top-0 right-0 h-full w-1 cursor-col-resize hover:bg-accent/30 z-10"
      onMouseDown={onMouseDown}
    />
  )
}

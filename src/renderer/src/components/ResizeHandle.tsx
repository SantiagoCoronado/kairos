import { useState } from 'react'

export const clamp = (v: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, v))

export type WidthSpec = { def: number; min: number; max: number }

const storedWidth = (key: string, spec: WidthSpec): number => {
  const raw = Number(localStorage.getItem(key))
  return Number.isFinite(raw) && raw > 0 ? clamp(raw, spec.min, spec.max) : spec.def
}

/** Drag-resizable column width, persisted to localStorage on mouseup. */
export function useResizableWidth(
  key: string,
  spec: WidthSpec
): { width: number; startResize: (e: React.MouseEvent) => void } {
  const [width, setWidth] = useState(() => storedWidth(key, spec))
  const startResize = (e: React.MouseEvent): void => {
    e.preventDefault()
    const startX = e.clientX
    const startW = width
    let latest = startW
    const move = (ev: MouseEvent): void => {
      latest = clamp(startW + ev.clientX - startX, spec.min, spec.max)
      setWidth(latest)
    }
    const up = (): void => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      localStorage.setItem(key, String(latest))
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }
  return { width, startResize }
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

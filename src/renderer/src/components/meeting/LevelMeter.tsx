import { useEffect, useRef } from 'react'
import type { MeetingChannel } from '../../lib/meeting-store'
import { getLevels } from '../../lib/meeting-levels'
import { cn } from '../ui'

/** samples of history across the meter; one per animation frame (~0.5 s) */
const BARS = 28
const BAR_W = 3
const GAP = 2
const HEIGHT = 20
const WIDTH = BARS * (BAR_W + GAP) - GAP

/** Scrolling level history for one channel, Voice-Memos style: the newest
 *  block enters on the right and slides left, so a live channel visibly
 *  moves and a dead one is a flat line. Canvas written from a rAF loop —
 *  no React re-render per frame (the LiveAudioVisualizer pattern). */
export function LevelMeter({
  channel,
  label,
  active,
  className
}: {
  channel: MeetingChannel
  label: string
  /** false while paused/stopping: the meter flattens and the loop stops */
  active: boolean
  className?: string
}): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const history = useRef<number[]>(new Array<number>(BARS).fill(0))

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return undefined
    const dpr = window.devicePixelRatio || 1
    canvas.width = WIDTH * dpr
    canvas.height = HEIGHT * dpr
    const ctx = canvas.getContext('2d')
    if (!ctx) return undefined
    ctx.scale(dpr, dpr)

    const paint = (): void => {
      ctx.clearRect(0, 0, WIDTH, HEIGHT)
      // currentColor: the meter inherits the bar's tone from CSS
      ctx.fillStyle = getComputedStyle(canvas).color
      history.current.forEach((level, i) => {
        // a live-but-silent channel still shows a hairline, so "flat" reads
        // as quiet rather than missing
        const h = Math.max(2, Math.round(level * HEIGHT))
        ctx.beginPath()
        ctx.roundRect(i * (BAR_W + GAP), (HEIGHT - h) / 2, BAR_W, h, BAR_W / 2)
        ctx.fill()
      })
    }

    if (!active) {
      history.current.fill(0)
      paint()
      return undefined
    }

    let raf = 0
    const tick = (): void => {
      history.current.push(getLevels()[channel])
      history.current.shift()
      paint()
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [channel, active])

  return (
    <span
      className={cn('inline-flex items-center gap-1.5 shrink-0', className)}
      title={`${label} — live input level`}
    >
      <span className="text-[10.5px] uppercase tracking-wide text-muted">{label}</span>
      <canvas
        ref={canvasRef}
        style={{ width: WIDTH, height: HEIGHT }}
        aria-hidden="true"
      />
    </span>
  )
}

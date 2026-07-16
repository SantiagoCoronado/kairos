import { useEffect, useMemo, useRef, useState } from 'react'
import { Search } from 'lucide-react'
import type { SemanticEntity, SemanticHit } from '../../../shared/ipc-contract'
import { api, useInvoke } from '../lib/api'
import type { ViewId } from '../components/Sidebar'
import { cn } from '../components/ui'

// The Atlas: every embedded item as a dot on the semantic map (UMAP coords
// computed in the embed worker, streamed here via map:data). Rendering is a
// hand-rolled canvas — at ~13k points Canvas2D holds 60fps and needs no deps.
// Interaction grammar: drag pans, wheel zooms toward the cursor, hover reads,
// click opens, search flies the camera to the answers.

const EMBED_MS = 400
const FLY_MS = 1100
const PULSE_MS = 800
const BUILD_MS = 1600

/** entity → color group: 0 messages, 1 notes+tasks, 2 events+people+chat */
const KIND: Record<SemanticEntity, number> = {
  comms_message: 0,
  note: 1,
  task: 1,
  person: 2,
  chat_message: 2,
  calendar_event: 2
}
const FILTER_LABELS = ['messages', 'notes + tasks', 'events + people']

const ease = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t
const elerp = (a: number, b: number, t: number): number => a * Math.pow(b / a, t)
const smooth = (a: number, b: number, x: number): number => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/** app theme tokens, read once per frame batch from the live stylesheet */
function themeColor(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

interface SearchAnim {
  qx: number
  qy: number
  label: string
  t0: number
  hits: SemanticHit[]
  localR: number
}

export function AtlasView({ onNavigate }: { onNavigate: (v: ViewId) => void }): React.JSX.Element {
  const { data } = useInvoke('map:data', [], ['semantic'])
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [query, setQuery] = useState('')
  const [kindOn, setKindOn] = useState([true, true, true])
  const [status, setStatus] = useState<{ kind: 'idle' | 'searching' | 'results' | 'error'; text?: string; hits?: SemanticHit[] }>({ kind: 'idle' })
  const [hoverText, setHoverText] = useState('')

  // ---- mutable render state (never re-renders React) ----
  const st = useRef({
    view: { ox: 0, oy: 0, scale: 260 },
    hover: -1,
    userMoved: false,
    flight: null as null | { from: { ox: number; oy: number; scale: number }; toX: number; toY: number; toScale: number },
    search: null as null | SearchAnim,
    buildT0: 0,
    dragging: false
  })

  // ---- unpack map data into typed arrays ----
  const world = useMemo(() => {
    const pts = data?.points ?? []
    const n = pts.length
    const px = new Float32Array(n)
    const py = new Float32Array(n)
    const kind = new Uint8Array(n)
    const order = new Float32Array(n)
    const keys: { e: SemanticEntity; id: string }[] = new Array(n)
    const clusters = data?.clusters ?? []
    for (let i = 0; i < n; i++) {
      const p = pts[i]
      px[i] = p.x
      py[i] = p.y
      kind[i] = KIND[p.e]
      keys[i] = { e: p.e, id: p.id }
      // build animation: condense from every cluster core at once
      let best = 1
      for (const c of clusters) {
        const d = Math.hypot(p.x - c.x, p.y - c.y) / 0.5
        if (d < best) best = d
      }
      order[i] = best * 0.82 + ((i * 2654435761) % 100) / 100 * 0.14
    }
    return { n, px, py, kind, order, keys, clusters }
  }, [data])

  // first data arrival triggers the bloom
  useEffect(() => {
    if (world.n > 0 && st.current.buildT0 === 0) st.current.buildT0 = performance.now()
  }, [world.n])

  // ---- hover hydration (debounced, cached) ----
  const hoverCache = useRef(new Map<string, string>())
  useEffect(() => {
    let cancelled = false
    const timer = setInterval(() => {
      const i = st.current.hover
      if (i < 0 || i >= world.n) {
        setHoverText('')
        return
      }
      const key = `${world.keys[i].e}:${world.keys[i].id}`
      const cached = hoverCache.current.get(key)
      if (cached !== undefined) {
        setHoverText(cached)
        return
      }
      void api.invoke('map:item', world.keys[i].e, world.keys[i].id).then((hit) => {
        if (cancelled) return
        const text = hit ? `${hit.title}${hit.snippet ? ` — ${hit.snippet}` : ''}` : ''
        if (hoverCache.current.size > 600) hoverCache.current.clear()
        hoverCache.current.set(key, text)
        if (st.current.hover === i) setHoverText(text)
      })
    }, 160)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [world])

  // ---- search ----
  const runSearch = async (q: string): Promise<void> => {
    const text = q.trim()
    if (!text) return
    setStatus({ kind: 'searching', text: `searching “${text}”…` })
    try {
      const res = await api.invoke('search:semantic', text, { limit: 5 })
      if (res.status !== 'ok') {
        setStatus({ kind: 'error', text: res.message ?? res.status })
        return
      }
      const placed = res.hits.filter((h) => h.map)
      if (placed.length === 0) {
        setStatus({ kind: 'results', text: 'found, but not yet on the map', hits: res.hits.slice(0, 3) })
        return
      }
      const top = placed.slice(0, 3)
      // the query lands at the score-weighted centroid of its answers
      let wx = 0, wy = 0, ws = 0
      for (const h of top) {
        const w = Math.max(0.01, h.score)
        wx += h.map!.x * w
        wy += h.map!.y * w
        ws += w
      }
      const qx = wx / ws, qy = wy / ws
      const localR = Math.max(0.04, ...top.map((h) => Math.hypot(h.map!.x - qx, h.map!.y - qy)))
      const canvas = canvasRef.current!
      const fit = (canvas.clientHeight * 0.3) / Math.max(0.05, localR * 1.6)
      st.current.flight = {
        from: { ...st.current.view },
        toX: qx,
        toY: qy,
        toScale: Math.max(320, Math.min(820, fit))
      }
      st.current.userMoved = false
      st.current.search = { qx, qy, label: text, t0: performance.now(), hits: top, localR }
      setStatus({ kind: 'results', hits: top })
    } catch (err) {
      setStatus({ kind: 'error', text: err instanceof Error ? err.message : 'search failed' })
    }
  }

  const openHit = (hit: SemanticHit): void => {
    onNavigate(hit.nav.view as ViewId)
  }

  // ---- canvas loop ----
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return undefined
    const ctx = canvas.getContext('2d')!
    const dpr = Math.min(devicePixelRatio || 1, 2)
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
    const s0 = st.current

    const sizeCanvas = (): void => {
      const w = canvas.clientWidth, h = canvas.clientHeight
      if (canvas.width !== Math.round(w * dpr)) {
        canvas.width = Math.round(w * dpr)
        canvas.height = Math.round(h * dpr)
      }
    }
    sizeCanvas()
    const ro = new ResizeObserver(sizeCanvas)
    ro.observe(canvas)

    // ---- terrain (rebuilt when the data changes) ----
    const TW = 260, TH = 260, WORLD = 1.35
    const terrain = document.createElement('canvas')
    terrain.width = TW
    terrain.height = TH
    const buildTerrain = (): void => {
      if (world.n === 0) return
      const den = new Float32Array(TW * TH)
      for (let i = 0; i < world.n; i++) {
        const gx = Math.round(((world.px[i] + WORLD) / (2 * WORLD)) * (TW - 1))
        const gy = Math.round(((world.py[i] + WORLD) / (2 * WORLD)) * (TH - 1))
        if (gx >= 0 && gx < TW && gy >= 0 && gy < TH) den[gy * TW + gx] += 1
      }
      const tmp = new Float32Array(TW * TH)
      const R = 4
      for (let pass = 0; pass < 3; pass++) {
        for (let y = 0; y < TH; y++) {
          let acc = 0
          for (let x = -R; x <= R; x++) acc += den[y * TW + Math.max(0, Math.min(TW - 1, x))]
          for (let x = 0; x < TW; x++) {
            tmp[y * TW + x] = acc / (2 * R + 1)
            acc += den[y * TW + Math.min(TW - 1, x + R + 1)] - den[y * TW + Math.max(0, x - R)]
          }
        }
        for (let x = 0; x < TW; x++) {
          let acc = 0
          for (let y = -R; y <= R; y++) acc += tmp[Math.max(0, Math.min(TH - 1, y)) * TW + x]
          for (let y = 0; y < TH; y++) {
            den[y * TW + x] = acc / (2 * R + 1)
            acc += tmp[Math.min(TH - 1, y + R + 1) * TW + x] - tmp[Math.max(0, y - R) * TW + x]
          }
        }
      }
      let max = 0
      for (let i = 0; i < den.length; i++) if (den[i] > max) max = den[i]
      if (max === 0) return
      const img = terrain.getContext('2d')!.createImageData(TW, TH)
      for (let i = 0; i < den.length; i++) {
        const d = Math.pow(den[i] / max, 0.55)
        const warm = smooth(0.45, 1, d)
        img.data[i * 4] = lerp(30, 74, d) + warm * 92
        img.data[i * 4 + 1] = lerp(30, 68, d) + warm * 62
        img.data[i * 4 + 2] = lerp(33, 70, d) + warm * 8
        img.data[i * 4 + 3] = d * 225
      }
      terrain.getContext('2d')!.putImageData(img, 0, 0)
    }
    buildTerrain()

    // ---- input ----
    let lx = 0, ly = 0
    const onDown = (e: PointerEvent): void => {
      s0.dragging = true
      s0.userMoved = true
      lx = e.clientX
      ly = e.clientY
      canvas.setPointerCapture(e.pointerId)
    }
    const onUp = (e: PointerEvent): void => {
      const moved = Math.hypot(e.clientX - lx, e.clientY - ly)
      s0.dragging = false
      // a tap (not a drag) on a dot opens the item
      if (moved < 4 && s0.hover >= 0 && s0.hover < world.n) {
        const k = world.keys[s0.hover]
        void api.invoke('map:item', k.e, k.id).then((hit) => hit && openHit(hit))
      }
    }
    const onMove = (e: PointerEvent): void => {
      if (s0.dragging) {
        s0.view.ox += (e.clientX - lx) / s0.view.scale
        s0.view.oy += (e.clientY - ly) / s0.view.scale
        lx = e.clientX
        ly = e.clientY
        return
      }
      const r = canvas.getBoundingClientRect()
      const wx = (e.clientX - r.left - canvas.clientWidth / 2) / s0.view.scale - s0.view.ox
      const wy = (e.clientY - r.top - canvas.clientHeight / 2) / s0.view.scale - s0.view.oy
      let best = -1
      let bd = (12 / s0.view.scale) ** 2
      for (let i = 0; i < world.n; i++) {
        if (!kindOnRef.current[world.kind[i]]) continue
        const dx = world.px[i] - wx, dy = world.py[i] - wy
        const d = dx * dx + dy * dy
        if (d < bd) {
          bd = d
          best = i
        }
      }
      s0.hover = best
    }
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      s0.userMoved = true
      const r = canvas.getBoundingClientRect()
      const mx = e.clientX - r.left - canvas.clientWidth / 2
      const my = e.clientY - r.top - canvas.clientHeight / 2
      const wx = mx / s0.view.scale - s0.view.ox
      const wy = my / s0.view.scale - s0.view.oy
      s0.view.scale = Math.max(120, Math.min(3800, s0.view.scale * Math.exp(-e.deltaY * 0.0015)))
      s0.view.ox = mx / s0.view.scale - wx
      s0.view.oy = my / s0.view.scale - wy
    }
    canvas.addEventListener('pointerdown', onDown)
    canvas.addEventListener('pointerup', onUp)
    canvas.addEventListener('pointermove', onMove)
    canvas.addEventListener('wheel', onWheel, { passive: false })

    // ---- frame ----
    const star = (x: number, y: number, size: number): void => {
      ctx.beginPath()
      ctx.moveTo(x, y - size)
      ctx.lineTo(x + size * 0.35, y - size * 0.35)
      ctx.lineTo(x + size, y)
      ctx.lineTo(x + size * 0.35, y + size * 0.35)
      ctx.lineTo(x, y + size)
      ctx.lineTo(x - size * 0.35, y + size * 0.35)
      ctx.lineTo(x - size, y)
      ctx.lineTo(x - size * 0.35, y - size * 0.35)
      ctx.closePath()
      ctx.fill()
    }

    const searchPhase = (): { phase: 'idle' | 'embed' | 'fly' | 'pulse' | 'settled'; p: number } => {
      const q = s0.search
      if (!q) return { phase: 'idle', p: 0 }
      const el = performance.now() - q.t0
      if (reduced) return { phase: 'settled', p: 1 }
      if (el < EMBED_MS) return { phase: 'embed', p: el / EMBED_MS }
      if (el < EMBED_MS + FLY_MS) return { phase: 'fly', p: (el - EMBED_MS) / FLY_MS }
      if (el < EMBED_MS + FLY_MS + PULSE_MS) return { phase: 'pulse', p: (el - EMBED_MS - FLY_MS) / PULSE_MS }
      return { phase: 'settled', p: Math.min(1, (el - EMBED_MS - FLY_MS - PULSE_MS) / 450) }
    }

    let raf = 0
    const frame = (): void => {
      raf = requestAnimationFrame(frame)
      const w = canvas.width, h = canvas.height
      const colBg = themeColor('--color-overlay') || '#17171a'
      const cols = [
        themeColor('--color-text') || '#e8e8ea',
        themeColor('--color-accent') || '#e2b25a',
        themeColor('--color-ok') || '#7fb47f'
      ]
      const colMuted = themeColor('--color-muted') || '#8a8a92'
      ctx.fillStyle = colBg
      ctx.fillRect(0, 0, w, h)

      const sv = searchPhase()
      const q = s0.search
      if (q && s0.flight && !s0.userMoved && sv.phase !== 'idle' && sv.phase !== 'embed') {
        const p = sv.phase === 'fly' ? ease(sv.p) : 1
        s0.view.ox = lerp(s0.flight.from.ox, -s0.flight.toX, p)
        s0.view.oy = lerp(s0.flight.from.oy, -s0.flight.toY, p)
        s0.view.scale = elerp(s0.flight.from.scale, s0.flight.toScale, p)
      }

      const cx = w / 2 + s0.view.ox * s0.view.scale * dpr
      const cy = h / 2 + s0.view.oy * s0.view.scale * dpr
      const sc = s0.view.scale * dpr
      const X = (i: number): number => cx + world.px[i] * sc
      const Y = (i: number): number => cy + world.py[i] * sc

      const build = reduced || s0.buildT0 === 0 ? 1 : Math.min(1, (performance.now() - s0.buildT0) / BUILD_MS)

      // terrain (recedes as you dive; rises with the build)
      ctx.globalAlpha = (0.9 - smooth(300, 900, s0.view.scale) * 0.55) * smooth(0.15, 0.9, build)
      ctx.imageSmoothingEnabled = true
      ctx.drawImage(terrain, cx - WORLD * sc, cy - WORLD * sc, 2 * WORLD * sc, 2 * WORLD * sc)
      ctx.globalAlpha = 1

      const localR = q?.localR ?? 0
      const pulseR = sv.phase === 'pulse' ? sv.p * localR * 1.35 : 0
      const qx = q ? cx + q.qx * sc : 0
      const qy = q ? cy + q.qy * sc : 0
      const hitSet = sv.phase === 'settled' && q ? new Set(q.hits.map((hh) => `${hh.entity}:${hh.entity_id}`)) : null

      const dotA = 0.25 + smooth(180, 420, s0.view.scale) * 0.5
      const size = Math.max(1.4, Math.min(3.6, s0.view.scale / 105)) * dpr
      for (let k = 0; k < 3; k++) {
        if (!kindOnRef.current[k]) continue
        ctx.fillStyle = cols[k]
        for (let i = 0; i < world.n; i++) {
          if (world.kind[i] !== k) continue
          if (world.order[i] > build) continue
          let a = dotA
          let sz = size
          const age = (build - world.order[i]) * BUILD_MS
          if (age < 220) a = Math.min(1, a + (1 - age / 220) * 0.5)
          if (sv.phase === 'pulse' && q) {
            const d = Math.hypot(world.px[i] - q.qx, world.py[i] - q.qy)
            if (d <= localR * 1.35 && Math.abs(d - pulseR) < 0.02) {
              a = 1
              sz = size * 2
            }
          } else if (sv.phase === 'settled' && hitSet) {
            const key = `${world.keys[i].e}:${world.keys[i].id}`
            if (hitSet.has(key)) {
              a = 1
              sz = size * 2.2
            } else if (q && Math.hypot(world.px[i] - q.qx, world.py[i] - q.qy) <= localR * 2.5) {
              a = Math.min(a, 0.3)
            }
          }
          ctx.globalAlpha = a
          ctx.fillRect(X(i), Y(i), sz, sz)
        }
      }
      ctx.globalAlpha = 1

      // cluster names: far-zoom layer, replaced by dots/text as you dive
      const hoodA = (1 - smooth(430, 760, s0.view.scale)) * (sv.phase === 'settled' ? 0.25 : 1) * smooth(0.4, 1, build)
      if (hoodA > 0.02) {
        ctx.font = `600 ${13 * dpr}px ui-monospace, Menlo, monospace`
        ctx.fillStyle = cols[0]
        for (const c of world.clusters) {
          if (!c.name) continue
          ctx.globalAlpha = hoodA * 0.9
          const label = c.name.toUpperCase()
          const tw = ctx.measureText(label).width
          ctx.fillText(label, cx + c.x * sc - tw / 2, cy + c.y * sc)
        }
        ctx.globalAlpha = 1
      }

      // search overlay
      if (q && sv.phase !== 'idle') {
        ctx.fillStyle = cols[1]
        if (sv.phase === 'embed') {
          ctx.globalAlpha = sv.p
          star(qx, qy, (14 - sv.p * 6) * dpr)
          ctx.globalAlpha = 1
        } else {
          star(qx, qy, 8 * dpr)
        }
        if (sv.phase === 'pulse') {
          ctx.strokeStyle = cols[1]
          ctx.lineWidth = 1.3 * dpr
          for (const mul of [1, 0.55]) {
            const r = pulseR * mul * sc
            if (r <= 0) continue
            ctx.globalAlpha = 0.8 * (1 - sv.p) + 0.15
            ctx.beginPath()
            ctx.arc(qx, qy, r, 0, Math.PI * 2)
            ctx.stroke()
          }
          ctx.globalAlpha = 1
        }
        if (sv.phase === 'settled') {
          ctx.strokeStyle = cols[1]
          ctx.lineWidth = 1.3 * dpr
          const colX = qx + 95 * dpr
          q.hits.forEach((hit, rank) => {
            if (!hit.map) return
            const hx = cx + hit.map.x * sc
            const hy = cy + hit.map.y * sc
            const reveal = Math.min(1, Math.max(0, sv.p * 3 - rank * 0.8))
            if (reveal <= 0) return
            const rowY = qy + (-34 + rank * 30) * dpr
            ctx.globalAlpha = 0.9 * reveal
            ctx.beginPath()
            ctx.moveTo(qx, qy)
            ctx.lineTo(qx + (hx - qx) * reveal, qy + (hy - qy) * reveal)
            ctx.stroke()
            if (reveal === 1) {
              ctx.globalAlpha = 0.45
              ctx.lineWidth = 0.8 * dpr
              ctx.beginPath()
              ctx.moveTo(hx, hy)
              ctx.lineTo(colX - 6 * dpr, rowY - 4 * dpr)
              ctx.stroke()
              ctx.lineWidth = 1.3 * dpr
              ctx.globalAlpha = 1
              ctx.font = `${10.5 * dpr}px ui-monospace, Menlo, monospace`
              const label = (hit.title + (hit.snippet ? ` — ${hit.snippet}` : '')).slice(0, 38)
              const tw = ctx.measureText(label).width
              ctx.fillStyle = colBg
              ctx.globalAlpha = 0.88
              ctx.fillRect(colX - 4 * dpr, rowY - 13 * dpr, tw + 8 * dpr, 18 * dpr)
              ctx.globalAlpha = 1
              ctx.fillStyle = cols[0]
              ctx.fillText(label, colX, rowY)
              ctx.fillStyle = cols[1]
            }
          })
          ctx.globalAlpha = 1
        }
      }

      if (s0.hover >= 0 && s0.hover < world.n && sv.phase === 'idle') {
        ctx.strokeStyle = cols[1]
        ctx.lineWidth = 1.5 * dpr
        ctx.strokeRect(X(s0.hover) - 3 * dpr, Y(s0.hover) - 3 * dpr, 7 * dpr, 7 * dpr)
      }

      // deep zoom: dots grow readable text (needs hydrated cache — only
      // draw what hover/summary fetches have already warmed)
      const readA = smooth(680, 1050, s0.view.scale)
      if (readA > 0 && sv.phase !== 'pulse') {
        ctx.font = `${10.5 * dpr}px ui-monospace, Menlo, monospace`
        ctx.fillStyle = colMuted
        const cell = 110 * dpr
        const used = new Set<number>()
        let drawn = 0
        for (let i = 0; i < world.n && drawn < 60; i++) {
          if (!kindOnRef.current[world.kind[i]] || world.order[i] > build) continue
          const x = X(i), y = Y(i)
          if (x < -20 || x > w + 20 || y < -20 || y > h + 20) continue
          const key = Math.floor(x / cell) * 8192 + Math.floor(y / cell)
          if (used.has(key)) continue
          used.add(key)
          const ck = `${world.keys[i].e}:${world.keys[i].id}`
          let text = hoverCache.current.get(ck)
          if (text === undefined) {
            // warm lazily; skip this frame
            if (hoverCache.current.size < 600) {
              hoverCache.current.set(ck, '')
              void api.invoke('map:item', world.keys[i].e, world.keys[i].id).then((hit) => {
                hoverCache.current.set(ck, hit ? `${hit.title}${hit.snippet ? ` — ${hit.snippet}` : ''}` : '')
              })
            }
            continue
          }
          if (!text) continue
          drawn++
          ctx.globalAlpha = readA * 0.85
          ctx.fillText(text.slice(0, 30) + (text.length > 30 ? '…' : ''), x + 7 * dpr, y + 3 * dpr)
        }
        ctx.globalAlpha = 1
      }
    }
    raf = requestAnimationFrame(frame)

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      canvas.removeEventListener('pointerdown', onDown)
      canvas.removeEventListener('pointerup', onUp)
      canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('wheel', onWheel)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [world])

  // filters live in a ref so the render loop sees them without re-mounting
  const kindOnRef = useRef(kindOn)
  kindOnRef.current = kindOn

  const indexed = data?.indexed ?? 0
  const projected = data?.projected ?? 0

  return (
    <div className="h-full flex flex-col pt-6">
      <div className="flex items-center gap-2 px-4 pb-2 shrink-0">
        <div className="relative flex-1 max-w-md">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void runSearch(query)
            }}
            placeholder="search everything by meaning…"
            className="w-full bg-raised border border-border rounded-md pl-8 pr-3 py-1.5 text-[12.5px] text-text placeholder:text-faint focus:outline-none focus:border-border-strong"
          />
        </div>
        <div className="flex gap-1.5">
          {FILTER_LABELS.map((label, k) => (
            <button
              key={label}
              onClick={() => setKindOn((cur) => cur.map((v, i) => (i === k ? !v : v)))}
              className={cn(
                'px-2.5 py-1.5 rounded-md border font-mono text-[11px] transition-colors',
                kindOn[k]
                  ? 'border-border text-text bg-raised'
                  : 'border-border text-faint opacity-50'
              )}
            >
              {label}
            </button>
          ))}
        </div>
        <span className="ml-auto font-mono text-[10.5px] text-faint">
          {projected < indexed ? `placing ${projected.toLocaleString()} / ${indexed.toLocaleString()}` : `${indexed.toLocaleString()} items`}
        </span>
      </div>

      <div className="relative flex-1 min-h-0 mx-4 mb-2 rounded-lg border border-border overflow-hidden">
        <canvas ref={canvasRef} className="w-full h-full cursor-crosshair touch-none" />
        {indexed === 0 && (
          <div className="absolute inset-0 flex items-center justify-center">
            <p className="text-[13px] text-faint font-mono">building the semantic index…</p>
          </div>
        )}
        {indexed > 0 && world.n === 0 && (
          <div className="absolute inset-0 flex items-center justify-center">
            <p className="text-[13px] text-faint font-mono">
              placing your archive on the map — first projection takes a minute
            </p>
          </div>
        )}
        {hoverText && (
          <p className="absolute left-3 bottom-2 max-w-[72%] font-mono text-[11.5px] text-text opacity-90 pointer-events-none truncate">
            “{hoverText}”
          </p>
        )}
      </div>

      <div className="px-4 pb-3 shrink-0 min-h-[64px]">
        {status.kind === 'idle' && (
          <p className="font-mono text-[11px] text-faint">
            drag to pan · scroll to zoom · hover to read · click a dot to open it · search flies you to the answers
          </p>
        )}
        {status.kind === 'searching' && <p className="font-mono text-[11px] text-muted">{status.text}</p>}
        {status.kind === 'error' && <p className="font-mono text-[11px] text-danger">{status.text}</p>}
        {status.kind === 'results' && (
          <div className="space-y-1">
            {status.text && <p className="font-mono text-[11px] text-muted">{status.text}</p>}
            {(status.hits ?? []).map((h) => (
              <button
                key={`${h.entity}:${h.entity_id}`}
                onClick={() => openHit(h)}
                className="flex items-center gap-2.5 w-full text-left font-mono text-[11.5px] group"
              >
                <span className="text-accent w-10 shrink-0">{h.score.toFixed(2)}</span>
                <span className="text-text truncate group-hover:text-accent transition-colors">
                  {h.title}
                  {h.snippet ? ` — ${h.snippet}` : ''}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

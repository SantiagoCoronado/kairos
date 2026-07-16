// The Atlas projector: keeps every embedding placed on the 2D map.
//
// Full fit: UMAP over all vectors (runs in the embed worker — pure-JS umap
// takes tens of seconds at 12k points), then grid-density clustering and a
// one-shot Haiku naming pass (cached by membership; fails soft to unnamed).
// Incremental: new items are placed at their nearest projected neighbor
// (cosine) plus a small jitter — instant, and the map stays stable. A full
// re-fit happens only when the corpus outgrows the last fit by 20%.
import { query } from '@anthropic-ai/claude-agent-sdk'
import type { DbDriver } from '../../core/driver'
import {
  buildClusterNamePrompt,
  countProjected,
  findMapClusters,
  getMeta,
  hashText,
  listMapPoints,
  listUnprojected,
  loadAllEmbeddings,
  normalizeCoords,
  parseClusterNames,
  replaceClusters,
  setMapCoords,
  setMeta,
  sourceTextFor,
  topK
} from '../../core/semantic'
import { getSettings } from '../settings'
import { buildChildEnv, resolveClaudeBinary } from '../chat/agent'
import { DATA_DIR } from '../db'
import { logLine } from '../logger'
import { projectUmap } from './embedder'

const CHECK_INTERVAL_MS = 60_000
const REFIT_GROWTH = 1.2
const INCREMENTAL_BATCH = 500
const NAME_SAMPLES_PER_CLUSTER = 10

export class AtlasProjector {
  private timer: NodeJS.Timeout | null = null
  private running = false
  private stopped = false

  constructor(private db: DbDriver, private onChanged: () => void) {}

  start(): void {
    // after the indexer's first sweeps have something to project
    setTimeout(() => void this.check(), 45_000)
    this.timer = setInterval(() => void this.check(), CHECK_INTERVAL_MS)
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
  }

  private async check(): Promise<void> {
    if (this.running || this.stopped) return
    if (!getSettings().semanticIndex) return
    this.running = true
    try {
      const { projected, total } = countProjected(this.db)
      if (total === 0) return
      const lastFit = Number(getMeta(this.db, 'umap_fit_count') ?? 0)
      if (lastFit === 0 || total >= lastFit * REFIT_GROWTH) {
        await this.fullFit()
      } else if (projected < total) {
        this.placeIncremental()
      }
    } catch (err) {
      logLine('warn', 'atlas', `projection failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      this.running = false
    }
  }

  /** UMAP over everything; rewrites every map coordinate */
  private async fullFit(): Promise<void> {
    const rows = loadAllEmbeddings(this.db)
    if (rows.length < 20) return // a map of five points helps nobody
    const dims = rows[0].vec.length
    const flat = new Float32Array(rows.length * dims)
    rows.forEach((r, i) => flat.set(r.vec, i * dims))
    const started = Date.now()
    logLine('info', 'atlas', `full UMAP fit starting (${rows.length} points)`)
    const coords = normalizeCoords(await projectUmap(flat, rows.length, dims))
    setMapCoords(
      this.db,
      rows.map((r, i) => ({
        entity: r.entity,
        entity_id: r.entity_id,
        x: coords[i * 2],
        y: coords[i * 2 + 1]
      }))
    )
    setMeta(this.db, 'umap_fit_count', String(rows.length))
    logLine('info', 'atlas', `full fit done in ${Math.round((Date.now() - started) / 1000)}s`)
    await this.recluster()
    this.onChanged()
  }

  /** place fresh embeddings at their nearest projected neighbor */
  private placeIncremental(): void {
    const fresh = listUnprojected(this.db, INCREMENTAL_BATCH)
    if (fresh.length === 0) return
    const all = loadAllEmbeddings(this.db)
    const coordOf = new Map<string, { x: number; y: number }>()
    for (const p of listMapPoints(this.db)) coordOf.set(`${p.entity}:${p.entity_id}`, p)
    const projectedRows = all.filter((r) => coordOf.has(`${r.entity}:${r.entity_id}`))
    if (projectedRows.length === 0) return
    const placed: { entity: typeof fresh[number]['entity']; entity_id: string; x: number; y: number }[] = []
    for (const f of fresh) {
      const [nearest] = topK(f.vec, projectedRows, 1)
      if (!nearest) continue
      const at = coordOf.get(`${nearest.entity}:${nearest.entity_id}`)!
      // deterministic jitter so identical neighbors don't stack exactly
      const j = parseInt(hashText(f.entity_id), 36)
      placed.push({
        entity: f.entity,
        entity_id: f.entity_id,
        x: at.x + (((j % 100) / 100 - 0.5) * 0.02),
        y: at.y + ((((j >> 4) % 100) / 100 - 0.5) * 0.02)
      })
    }
    setMapCoords(this.db, placed)
    logLine('info', 'atlas', `placed ${placed.length} new points incrementally`)
    this.onChanged()
  }

  /** grid-density clusters + cached Haiku names */
  private async recluster(): Promise<void> {
    const points = listMapPoints(this.db)
    const clusters = findMapClusters(points)
    if (clusters.length === 0) {
      replaceClusters(this.db, [])
      return
    }
    // sample member texts per cluster; the sample hash is the naming cache key
    const samples = clusters.map((c) => {
      const texts: string[] = []
      for (const idx of c.memberIndexes) {
        if (texts.length >= NAME_SAMPLES_PER_CLUSTER) break
        const p = points[idx]
        const t = sourceTextFor(this.db, p.entity, p.entity_id)
        if (t) texts.push(t)
      }
      return texts
    })
    const contentKey = hashText(JSON.stringify(samples))
    const prevKey = getMeta(this.db, 'cluster_name_key')
    let names = new Map<number, string>()
    if (prevKey === contentKey) {
      // membership unchanged — keep existing names by position
      const prev = this.db.all<{ name: string }>('SELECT name FROM semantic_clusters ORDER BY id')
      prev.forEach((r, i) => names.set(i, r.name))
    } else {
      names = await this.nameClusters(samples)
      if (names.size > 0) setMeta(this.db, 'cluster_name_key', contentKey)
    }
    replaceClusters(
      this.db,
      clusters.map((c, i) => ({
        name: names.get(i) ?? '',
        x: c.x,
        y: c.y,
        count: c.count,
        contentKey
      }))
    )
  }

  /** one-shot haiku naming; unnamed on any failure (labels are optional) */
  private async nameClusters(samples: string[][]): Promise<Map<number, string>> {
    const bin = resolveClaudeBinary()
    if (!bin) return new Map()
    try {
      const q = query({
        prompt: buildClusterNamePrompt(samples),
        options: {
          permissionMode: 'default',
          settingSources: [],
          strictMcpConfig: true,
          systemPrompt: 'You name groups of related items. You output only the requested JSON object, nothing else.',
          model: 'haiku',
          maxTurns: 1,
          cwd: DATA_DIR,
          env: buildChildEnv() as Record<string, string>,
          pathToClaudeCodeExecutable: bin
        }
      })
      let text = ''
      for await (const msg of q) {
        if (msg.type === 'assistant') {
          for (const block of msg.message.content) {
            if (block.type === 'text') text += block.text
          }
        }
      }
      const names = parseClusterNames(text, samples.length)
      logLine('info', 'atlas', `named ${names.size}/${samples.length} clusters`)
      return names
    } catch (err) {
      logLine('warn', 'atlas', `cluster naming failed: ${err instanceof Error ? err.message : String(err)}`)
      return new Map()
    }
  }
}

// Incremental semantic indexer: keeps one embedding per source row.
// Sweep = for each entity, embed whatever is missing/changed (hash compare),
// then drop orphans. The first sweep after install is the backfill (~25s for
// a 12k-message archive); after that a sweep is a no-op unless data changed,
// and new rows are picked up within seconds via nudge().
import type { DbDriver } from '../../core/driver'
import {
  EMBEDDABLE_ENTITIES,
  countEmbeddings,
  embeddingsVersion,
  hydrateHits,
  listStale,
  loadAllEmbeddings,
  purgeOrphans,
  topK,
  upsertEmbedding,
  type EmbeddableEntity,
  type EmbeddingRow,
  type HydratedHit
} from '../../core/semantic'
import { getSettings } from '../settings'
import { logLine } from '../logger'
import { embedPassages, embedQuery, embedderState } from './embedder'

const SWEEP_INTERVAL_MS = 2 * 60_000
const NUDGE_DELAY_MS = 3_000
const BATCH = 16 // bounds the worker's peak memory per request
/** per-sweep cap: even a huge backlog embeds in bounded slices */
const MAX_PER_SWEEP = 4000

export interface SemanticSearchResult {
  status: 'ok' | 'indexing' | 'disabled' | 'unavailable'
  message?: string
  hits: HydratedHit[]
  indexed: number
}

export class SemanticIndexer {
  private timer: NodeJS.Timeout | null = null
  private nudgeTimer: NodeJS.Timeout | null = null
  private running = false
  private stopped = false
  private backfillLogged = false

  // search cache: all vectors in memory, reloaded when the table version moves
  private cache: EmbeddingRow[] | null = null
  private cacheVersion = ''

  constructor(private db: DbDriver) {}

  start(): void {
    // boot delay: let first-run sync/migrations settle before a model load
    setTimeout(() => void this.sweep(), 15_000)
    this.timer = setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS)
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    if (this.nudgeTimer) clearTimeout(this.nudgeTimer)
  }

  /** data changed — sweep soon, debounced (bursts of writes = one sweep) */
  nudge(): void {
    if (this.stopped || this.nudgeTimer) return
    this.nudgeTimer = setTimeout(() => {
      this.nudgeTimer = null
      void this.sweep()
    }, NUDGE_DELAY_MS)
  }

  private async sweep(): Promise<void> {
    if (this.running || this.stopped) return
    if (!getSettings().semanticIndex) return
    this.running = true
    try {
      const started = Date.now()
      let embedded = 0
      for (const entity of EMBEDDABLE_ENTITIES) {
        embedded += await this.sweepEntity(entity, MAX_PER_SWEEP - embedded)
        if (embedded >= MAX_PER_SWEEP) break
      }
      const purged = purgeOrphans(this.db)
      if (embedded > 0 || purged > 0) {
        logLine(
          'info',
          'semantic',
          `sweep: ${embedded} embedded, ${purged} purged in ${Date.now() - started}ms (${countEmbeddings(this.db)} total)`
        )
        // a capped sweep means more work is waiting — go again shortly
        if (embedded >= MAX_PER_SWEEP) this.nudge()
      }
    } catch (err) {
      // model download failing (offline) just means we try again next sweep
      logLine('warn', 'semantic', `sweep failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      this.running = false
    }
  }

  private async sweepEntity(entity: EmbeddableEntity, budget: number): Promise<number> {
    if (budget <= 0) return 0
    let total = 0
    for (;;) {
      const stale = listStale(this.db, entity, Math.min(BATCH, budget - total))
      if (stale.length === 0) break
      if (!this.backfillLogged && countEmbeddings(this.db) === 0) {
        this.backfillLogged = true
        logLine('info', 'semantic', 'first index build starting (model downloads on first run)')
      }
      const vecs = await embedPassages(stale.map((s) => s.text))
      this.db.transaction(() => {
        for (let i = 0; i < stale.length; i++)
          upsertEmbedding(this.db, entity, stale[i].id, stale[i].text, vecs[i])
      })
      total += stale.length
      if (this.stopped || total >= budget) break
    }
    return total
  }

  private cachedRows(): EmbeddingRow[] {
    const v = embeddingsVersion(this.db)
    if (!this.cache || v !== this.cacheVersion) {
      this.cache = loadAllEmbeddings(this.db)
      this.cacheVersion = v
    }
    return this.cache
  }

  async search(
    query: string,
    opts?: { limit?: number; entities?: EmbeddableEntity[] }
  ): Promise<SemanticSearchResult> {
    if (!getSettings().semanticIndex)
      return { status: 'disabled', hits: [], indexed: 0 }
    const indexed = countEmbeddings(this.db)
    if (indexed === 0) {
      const { state, error } = embedderState()
      return {
        status: state === 'error' ? 'unavailable' : 'indexing',
        message: state === 'error' ? (error ?? 'model failed to load') : 'building the index…',
        hits: [],
        indexed
      }
    }
    const q = query.trim()
    if (!q) return { status: 'ok', hits: [], indexed }
    const qv = await embedQuery(q)
    const limit = Math.max(1, Math.min(50, opts?.limit ?? 10))
    const ranked = topK(qv, this.cachedRows(), limit, opts?.entities)
    return { status: 'ok', hits: hydrateHits(this.db, ranked), indexed }
  }
}

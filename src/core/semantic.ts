// Semantic index core: which rows get embedded, their text, the staleness
// queue, and the brute-force search — everything except the model itself,
// which the main process injects (see main/search/). SDK-free and driver-
// agnostic so all of it is unit-testable with a fake embedder.
import type { DbDriver } from './driver'
import { nowIso } from './ids'

export type EmbeddableEntity =
  | 'comms_message'
  | 'note'
  | 'task'
  | 'person'
  | 'chat_message'
  | 'calendar_event'

export const EMBEDDABLE_ENTITIES: EmbeddableEntity[] = [
  'comms_message',
  'note',
  'task',
  'person',
  'chat_message',
  'calendar_event'
]

/** a source row waiting to be embedded */
export interface SourceItem {
  id: string
  text: string
}

/** models place long texts poorly and slowly — messages/notes get clipped */
const TEXT_CAP = 1200

/** FNV-1a — stable, fast, good enough to detect "text changed" */
export function hashText(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}

// ---------- source texts ----------
// One SQL per entity building a searchable text per row. NULL/empty texts are
// filtered out after the fact (attachment-only messages, blank notes).

const SOURCE_SQL: Record<EmbeddableEntity, string> = {
  comms_message: `
    SELECT m.id, COALESCE(NULLIF(m.sender_name,''), m.sender_handle) || ': ' || m.body_text AS text
    FROM comms_messages m WHERE LENGTH(TRIM(m.body_text)) > 2`,
  note: `
    SELECT n.id, TRIM(n.title || '
' || n.content || '
' || COALESCE((SELECT GROUP_CONCAT(json_extract(j.value,'$.text'), '
') FROM json_each(n.items) j), '')) AS text
    FROM notes n WHERE n.archived = 0`,
  task: `
    SELECT t.id, t.title AS text FROM tasks t WHERE LENGTH(TRIM(t.title)) > 0`,
  person: `
    SELECT p.id, TRIM(p.name || ' ' || COALESCE(p.nickname,'') || ' ' || COALESCE(p.company,'')
      || ' ' || COALESCE(p.role,'') || '
' || p.notes) AS text
    FROM people p WHERE p.archived_at IS NULL`,
  chat_message: `
    SELECT c.id, c.text FROM chat_messages c
    WHERE c.role IN ('user','assistant') AND LENGTH(TRIM(c.text)) > 2`,
  calendar_event: `
    SELECT e.id, TRIM(e.title || ' ' || COALESCE(e.location,'') || '
' || COALESCE(e.description,'')) AS text
    FROM calendar_events e WHERE e.status != 'cancelled' AND LENGTH(TRIM(e.title)) > 0`
}

/** rows of `entity` whose embedding is missing or whose text changed */
export function listStale(db: DbDriver, entity: EmbeddableEntity, limit: number): SourceItem[] {
  const rows = db.all<{ id: string; text: string | null; content_hash: string | null }>(
    `SELECT s.id, s.text, e.content_hash
     FROM (${SOURCE_SQL[entity]}) s
     LEFT JOIN embeddings e ON e.entity = ? AND e.entity_id = s.id`,
    entity
  )
  const stale: SourceItem[] = []
  for (const r of rows) {
    if (!r.text) continue
    const text = r.text.slice(0, TEXT_CAP)
    if (r.content_hash === hashText(text)) continue
    stale.push({ id: r.id, text })
    if (stale.length >= limit) break
  }
  return stale
}

export function upsertEmbedding(
  db: DbDriver,
  entity: EmbeddableEntity,
  entityId: string,
  text: string,
  vec: Float32Array,
  now: Date = new Date()
): void {
  db.run(
    `INSERT INTO embeddings (entity, entity_id, content_hash, dims, vec, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(entity, entity_id) DO UPDATE SET
       content_hash = excluded.content_hash, dims = excluded.dims,
       vec = excluded.vec, updated_at = excluded.updated_at`,
    entity,
    entityId,
    hashText(text),
    vec.length,
    Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength),
    nowIso(now)
  )
}

/** drop embeddings whose source row is gone (deletes, archives) */
export function purgeOrphans(db: DbDriver): number {
  let purged = 0
  for (const entity of EMBEDDABLE_ENTITIES) {
    purged += db.run(
      `DELETE FROM embeddings WHERE entity = ?
       AND entity_id NOT IN (SELECT id FROM (${SOURCE_SQL[entity]}))`,
      entity
    ).changes
  }
  return purged
}

export function countEmbeddings(db: DbDriver): number {
  return db.get<{ n: number }>('SELECT COUNT(*) AS n FROM embeddings')!.n
}

/** cheap cache key: any indexer write moves it */
export function embeddingsVersion(db: DbDriver): string {
  const row = db.get<{ n: number; m: string | null }>(
    'SELECT COUNT(*) AS n, MAX(updated_at) AS m FROM embeddings'
  )!
  return `${row.n}:${row.m ?? ''}`
}

// ---------- search ----------

export interface EmbeddingRow {
  entity: EmbeddableEntity
  entity_id: string
  vec: Float32Array
}

export function loadAllEmbeddings(db: DbDriver): EmbeddingRow[] {
  return db
    .all<{ entity: EmbeddableEntity; entity_id: string; vec: Buffer | Uint8Array }>(
      'SELECT entity, entity_id, vec FROM embeddings'
    )
    .map((r) => ({
      entity: r.entity,
      entity_id: r.entity_id,
      // better-sqlite3 hands back Buffer, node:sqlite Uint8Array — same bytes
      vec: new Float32Array(r.vec.buffer, r.vec.byteOffset, r.vec.byteLength / 4)
    }))
}

export interface RankedHit {
  entity: EmbeddableEntity
  entity_id: string
  score: number
}

/** brute-force top-K by dot product (vectors are L2-normalized upstream, so
 *  dot = cosine). ~5M multiply-adds for 12.7k×384 — around a millisecond. */
export function topK(
  query: Float32Array,
  rows: EmbeddingRow[],
  k: number,
  entities?: EmbeddableEntity[]
): RankedHit[] {
  const allow = entities ? new Set(entities) : null
  const hits: RankedHit[] = []
  for (const r of rows) {
    if (allow && !allow.has(r.entity)) continue
    if (r.vec.length !== query.length) continue
    let dot = 0
    for (let i = 0; i < query.length; i++) dot += query[i] * r.vec[i]
    hits.push({ entity: r.entity, entity_id: r.entity_id, score: dot })
  }
  hits.sort((a, b) => b.score - a.score)
  return hits.slice(0, k)
}

// ---------- hit hydration ----------

export interface HydratedHit extends RankedHit {
  title: string
  snippet: string
  /** where a click should land: view + the id that view understands */
  nav: { view: string; id: string }
}

const one = (s: string | null | undefined, cap = 140): string =>
  (s ?? '').replace(/\s+/g, ' ').trim().slice(0, cap)

export function hydrateHits(db: DbDriver, hits: RankedHit[]): HydratedHit[] {
  const out: HydratedHit[] = []
  for (const h of hits) {
    let row: HydratedHit | null = null
    if (h.entity === 'comms_message') {
      const m = db.get<{ body_text: string; sender_name: string; thread_id: string; title: string }>(
        `SELECT m.body_text, m.sender_name, m.thread_id, t.title
         FROM comms_messages m JOIN comms_threads t ON t.id = m.thread_id WHERE m.id = ?`,
        h.entity_id
      )
      if (m)
        row = {
          ...h,
          title: one(m.title, 60) || one(m.sender_name, 60),
          snippet: one(`${m.sender_name}: ${m.body_text}`),
          nav: { view: 'inbox', id: m.thread_id }
        }
    } else if (h.entity === 'note') {
      const n = db.get<{ title: string; content: string }>(
        'SELECT title, content FROM notes WHERE id = ?',
        h.entity_id
      )
      if (n)
        row = {
          ...h,
          title: one(n.title, 60) || 'untitled note',
          snippet: one(n.content),
          nav: { view: 'notes', id: h.entity_id }
        }
    } else if (h.entity === 'task') {
      const t = db.get<{ title: string }>('SELECT title FROM tasks WHERE id = ?', h.entity_id)
      if (t) row = { ...h, title: one(t.title, 80), snippet: '', nav: { view: 'tasks', id: h.entity_id } }
    } else if (h.entity === 'person') {
      const p = db.get<{ name: string; company: string | null }>(
        'SELECT name, company FROM people WHERE id = ?',
        h.entity_id
      )
      if (p)
        row = {
          ...h,
          title: one(p.name, 60),
          snippet: one(p.company ?? ''),
          nav: { view: 'people', id: h.entity_id }
        }
    } else if (h.entity === 'chat_message') {
      const c = db.get<{ text: string; session_id: string }>(
        'SELECT text, session_id FROM chat_messages WHERE id = ?',
        h.entity_id
      )
      if (c)
        row = {
          ...h,
          title: 'chat',
          snippet: one(c.text),
          nav: { view: 'chat', id: c.session_id }
        }
    } else if (h.entity === 'calendar_event') {
      const e = db.get<{ title: string; start_at: string; location: string | null }>(
        'SELECT title, start_at, location FROM calendar_events WHERE id = ?',
        h.entity_id
      )
      if (e)
        row = {
          ...h,
          title: one(e.title, 60),
          snippet: one(`${e.start_at.slice(0, 16).replace('T', ' ')} ${e.location ?? ''}`),
          nav: { view: 'calendar', id: h.entity_id }
        }
    }
    if (row) out.push(row)
  }
  return out
}

// ---------- the Atlas: map coordinates, clustering, naming ----------

export interface MapPoint {
  entity: EmbeddableEntity
  entity_id: string
  x: number
  y: number
}

export interface MapCluster {
  id: number
  name: string
  x: number
  y: number
  count: number
}

/** rows embedded but not yet placed on the map */
export function listUnprojected(
  db: DbDriver,
  limit: number
): { entity: EmbeddableEntity; entity_id: string; vec: Float32Array }[] {
  return db
    .all<{ entity: EmbeddableEntity; entity_id: string; vec: Buffer | Uint8Array }>(
      'SELECT entity, entity_id, vec FROM embeddings WHERE map_x IS NULL LIMIT ?',
      limit
    )
    .map((r) => ({
      entity: r.entity,
      entity_id: r.entity_id,
      vec: new Float32Array(r.vec.buffer, r.vec.byteOffset, r.vec.byteLength / 4)
    }))
}

export function countProjected(db: DbDriver): { projected: number; total: number } {
  const row = db.get<{ p: number; t: number }>(
    'SELECT COUNT(map_x) AS p, COUNT(*) AS t FROM embeddings'
  )!
  return { projected: row.p, total: row.t }
}

export function setMapCoords(
  db: DbDriver,
  rows: { entity: EmbeddableEntity; entity_id: string; x: number; y: number }[]
): void {
  db.transaction(() => {
    for (const r of rows)
      db.run(
        'UPDATE embeddings SET map_x = ?, map_y = ? WHERE entity = ? AND entity_id = ?',
        r.x,
        r.y,
        r.entity,
        r.entity_id
      )
  })
}

/** every projected point, for the renderer (and clustering) */
export function listMapPoints(db: DbDriver): MapPoint[] {
  return db.all<MapPoint>(
    'SELECT entity, entity_id, map_x AS x, map_y AS y FROM embeddings WHERE map_x IS NOT NULL'
  )
}

/** map position for specific items (search hits fly the camera there) */
export function mapCoordsFor(
  db: DbDriver,
  entity: EmbeddableEntity,
  entityId: string
): { x: number; y: number } | null {
  const r = db.get<{ x: number | null; y: number | null }>(
    'SELECT map_x AS x, map_y AS y FROM embeddings WHERE entity = ? AND entity_id = ?',
    entity,
    entityId
  )
  return r && r.x !== null && r.y !== null ? { x: r.x, y: r.y } : null
}

export function getMeta(db: DbDriver, key: string): string | null {
  return db.get<{ value: string }>('SELECT value FROM semantic_meta WHERE key = ?', key)?.value ?? null
}

export function setMeta(db: DbDriver, key: string, value: string): void {
  db.run(
    'INSERT INTO semantic_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    key,
    value
  )
}

/** scale raw UMAP output into the renderer's [-1, 1] world square */
export function normalizeCoords(coords: Float32Array): Float32Array {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (let i = 0; i < coords.length; i += 2) {
    if (coords[i] < minX) minX = coords[i]
    if (coords[i] > maxX) maxX = coords[i]
    if (coords[i + 1] < minY) minY = coords[i + 1]
    if (coords[i + 1] > maxY) maxY = coords[i + 1]
  }
  const span = Math.max(maxX - minX, maxY - minY) || 1
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2
  const out = new Float32Array(coords.length)
  for (let i = 0; i < coords.length; i += 2) {
    out[i] = ((coords[i] - cx) / span) * 1.9
    out[i + 1] = ((coords[i + 1] - cy) / span) * 1.9
  }
  return out
}

/**
 * Grid-density clustering over projected points: bucket into a coarse grid,
 * keep cells above a density threshold, flood-fill connected components.
 * Deterministic and dependency-free; plenty at ~10k points where clusters
 * are visual regions, not statistical claims.
 */
export function findMapClusters(
  points: { x: number; y: number }[],
  opts: { grid?: number; minShare?: number } = {}
): { x: number; y: number; count: number; memberIndexes: number[] }[] {
  const G = opts.grid ?? 28
  const minCount = Math.max(8, Math.floor(points.length * (opts.minShare ?? 0.01)))
  const cellOf = (p: { x: number; y: number }): [number, number] => [
    Math.max(0, Math.min(G - 1, Math.floor(((p.x + 1) / 2) * G))),
    Math.max(0, Math.min(G - 1, Math.floor(((p.y + 1) / 2) * G)))
  ]
  const counts = new Int32Array(G * G)
  const members: number[][] = Array.from({ length: G * G }, () => [])
  points.forEach((p, i) => {
    const [gx, gy] = cellOf(p)
    counts[gy * G + gx]++
    members[gy * G + gx].push(i)
  })
  // density threshold: a cell matters if it clearly beats the uniform average
  const avg = points.length / (G * G)
  const thresh = Math.max(avg * 3, 3)
  const seen = new Uint8Array(G * G)
  const clusters: { x: number; y: number; count: number; memberIndexes: number[] }[] = []
  for (let start = 0; start < G * G; start++) {
    if (seen[start] || counts[start] < thresh) continue
    // flood fill this dense region
    const queue = [start]
    seen[start] = 1
    let sumX = 0, sumY = 0, total = 0
    const memberIndexes: number[] = []
    while (queue.length) {
      const c = queue.pop()!
      const gx = c % G, gy = Math.floor(c / G)
      for (const i of members[c]) {
        sumX += points[i].x
        sumY += points[i].y
        memberIndexes.push(i)
      }
      total += counts[c]
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = gx + dx, ny = gy + dy
        if (nx < 0 || nx >= G || ny < 0 || ny >= G) continue
        const n = ny * G + nx
        if (!seen[n] && counts[n] >= thresh) {
          seen[n] = 1
          queue.push(n)
        }
      }
    }
    if (total >= minCount)
      clusters.push({ x: sumX / memberIndexes.length, y: sumY / memberIndexes.length, count: total, memberIndexes })
  }
  return clusters.sort((a, b) => b.count - a.count).slice(0, 12)
}

export function replaceClusters(
  db: DbDriver,
  clusters: { name: string; x: number; y: number; count: number; contentKey: string }[],
  now: Date = new Date()
): void {
  db.transaction(() => {
    db.run('DELETE FROM semantic_clusters')
    clusters.forEach((c, i) => {
      db.run(
        'INSERT INTO semantic_clusters (id, name, x, y, count, content_key, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        i + 1,
        c.name,
        c.x,
        c.y,
        c.count,
        c.contentKey,
        nowIso(now)
      )
    })
  })
}

export function listClusters(db: DbDriver): MapCluster[] {
  return db.all<MapCluster>('SELECT id, name, x, y, count FROM semantic_clusters ORDER BY count DESC')
}

/** source text of one item (cluster-naming samples) — '' when gone */
export function sourceTextFor(db: DbDriver, entity: EmbeddableEntity, entityId: string): string {
  const row = db.get<{ text: string | null }>(
    `SELECT s.text FROM (${SOURCE_SQL[entity]}) s WHERE s.id = ?`,
    entityId
  )
  return (row?.text ?? '').slice(0, 200)
}

export function buildClusterNamePrompt(samples: string[][]): string {
  const list = samples
    .map((texts, i) => `${i + 1}.\n${texts.map((t) => `   - ${t.replace(/\s+/g, ' ').slice(0, 120)}`).join('\n')}`)
    .join('\n')
  return [
    'These are groups of related personal items (messages, notes, tasks, events) from one person\'s archive. Give each group a SHORT display name (2-4 words) for a map label, in the dominant language of that group\'s items. Name the topic, not the medium — "Planes con Leo", "Facturas y banco", "Kairos development".',
    list,
    'Return ONLY a JSON object mapping each number to its name, e.g. {"1":"Planes con Leo","2":"Work reports"}. No prose, no code fences.'
  ].join('\n\n')
}

export function parseClusterNames(text: string, count: number): Map<number, string> {
  const out = new Map<number, string>()
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) return out
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(match[0]) as Record<string, unknown>
  } catch {
    return out
  }
  for (let i = 1; i <= count; i++) {
    const raw = parsed[String(i)]
    if (typeof raw === 'string' && raw.trim()) out.set(i - 1, raw.trim().slice(0, 40))
  }
  return out
}

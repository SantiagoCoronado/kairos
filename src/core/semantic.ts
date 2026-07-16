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

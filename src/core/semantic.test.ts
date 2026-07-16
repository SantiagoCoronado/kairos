import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { DbDriver } from './driver'
import { openNodeSqliteDb } from './drivers/node-sqlite'
import { migrate } from './migrations'
import {
  hashText,
  listStale,
  upsertEmbedding,
  purgeOrphans,
  loadAllEmbeddings,
  countEmbeddings,
  countProjected,
  listUnprojected,
  setMapCoords,
  listMapPoints,
  mapCoordsFor,
  topK,
  hydrateHits,
  type EmbeddingRow
} from './semantic'

let db: DbDriver

/** deterministic fake embedding: unit vector whose direction is seeded by the
 *  text hash — identical texts collide, different texts (almost) never do */
function fakeVec(text: string, dims = 8): Float32Array {
  const v = new Float32Array(dims)
  let seed = parseInt(hashText(text), 36)
  for (let i = 0; i < dims; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    v[i] = (seed / 0x7fffffff) * 2 - 1
  }
  const norm = Math.hypot(...v)
  for (let i = 0; i < dims; i++) v[i] /= norm
  return v
}

beforeEach(() => {
  db = openNodeSqliteDb(':memory:')
  migrate(db)
})
afterEach(() => db.close())

const T = '2026-07-16T12:00:00.000Z'

function seedTask(id: string, title: string): void {
  db.run(
    "INSERT INTO tasks (id, title, status, created_at, updated_at) VALUES (?, ?, 'todo', ?, ?)",
    id, title, T, T
  )
}

describe('staleness queue', () => {
  it('queues rows without embeddings, drains on upsert, re-queues on text change', () => {
    seedTask('t1', 'Pay rent')
    seedTask('t2', 'Call the dentist')

    let stale = listStale(db, 'task', 10)
    expect(stale.map((s) => s.id).sort()).toEqual(['t1', 't2'])

    for (const s of stale) upsertEmbedding(db, 'task', s.id, s.text, fakeVec(s.text))
    expect(listStale(db, 'task', 10)).toHaveLength(0)
    expect(countEmbeddings(db)).toBe(2)

    db.run("UPDATE tasks SET title = 'Pay rent AND water bill' WHERE id = 't1'")
    stale = listStale(db, 'task', 10)
    expect(stale.map((s) => s.id)).toEqual(['t1'])
  })

  it('checklist note items are part of the searchable text', () => {
    db.run(
      `INSERT INTO notes (id, title, content, items, note_type, created_at, updated_at)
       VALUES ('n1', 'Groceries', '', '[{"text":"tortillas","done":false},{"text":"café de olla","done":true}]', 'checklist', ?, ?)`,
      T, T
    )
    const [n] = listStale(db, 'note', 10)
    expect(n.text).toContain('tortillas')
    expect(n.text).toContain('café de olla')
  })

  it('skips empty-body messages and respects the limit', () => {
    db.run(
      "INSERT INTO comms_accounts (id, provider, external_id, display_name, created_at, updated_at) VALUES ('a1','whatsapp','x','x',?,?)",
      T, T
    )
    db.run(
      "INSERT INTO comms_threads (id, account_id, provider, external_id, kind, created_at, updated_at) VALUES ('th1','a1','whatsapp','j','dm',?,?)",
      T, T
    )
    const msg = (id: string, body: string): void => {
      db.run(
        `INSERT INTO comms_messages (id, thread_id, account_id, provider, external_id, sender_name, sent_at, body_text, created_at)
         VALUES (?, 'th1', 'a1', 'whatsapp', ?, 'Vero', ?, ?, ?)`,
        id, `e-${id}`, T, body, T
      )
    }
    msg('m1', 'puedes venir mañana?')
    msg('m2', '') // attachment-only
    msg('m3', 'nos vemos a las 7')

    expect(listStale(db, 'comms_message', 10).map((s) => s.id).sort()).toEqual(['m1', 'm3'])
    expect(listStale(db, 'comms_message', 1)).toHaveLength(1)
  })
})

describe('purgeOrphans', () => {
  it('drops embeddings whose source row is gone or archived', () => {
    seedTask('t1', 'Keep me')
    seedTask('t2', 'Delete me')
    for (const s of listStale(db, 'task', 10)) upsertEmbedding(db, 'task', s.id, s.text, fakeVec(s.text))

    db.run("DELETE FROM tasks WHERE id = 't2'")
    expect(purgeOrphans(db)).toBe(1)
    expect(loadAllEmbeddings(db).map((r) => r.entity_id)).toEqual(['t1'])
  })
})

describe('vector roundtrip + topK', () => {
  it('stores and reloads float32 vectors exactly', () => {
    seedTask('t1', 'Pay rent')
    const vec = fakeVec('task text')
    upsertEmbedding(db, 'task', 't1', 'task text', vec)
    const [row] = loadAllEmbeddings(db)
    expect(row.vec.length).toBe(vec.length)
    expect([...row.vec]).toEqual([...vec])
  })

  it('ranks by dot product and honors the entity filter', () => {
    const q = new Float32Array([1, 0, 0])
    const rows: EmbeddingRow[] = [
      { entity: 'task', entity_id: 'far', vec: new Float32Array([0, 1, 0]) },
      { entity: 'task', entity_id: 'near', vec: new Float32Array([0.9, 0.1, 0]) },
      { entity: 'note', entity_id: 'exact', vec: new Float32Array([1, 0, 0]) }
    ]
    const all = topK(q, rows, 3)
    expect(all.map((h) => h.entity_id)).toEqual(['exact', 'near', 'far'])
    const tasksOnly = topK(q, rows, 3, ['task'])
    expect(tasksOnly.map((h) => h.entity_id)).toEqual(['near', 'far'])
  })
})

describe('hydrateHits', () => {
  it('maps hits to titles, snippets and nav targets', () => {
    seedTask('t1', 'Pay rent')
    db.run(
      "INSERT INTO comms_accounts (id, provider, external_id, display_name, created_at, updated_at) VALUES ('a1','whatsapp','x','x',?,?)",
      T, T
    )
    db.run(
      "INSERT INTO comms_threads (id, account_id, provider, external_id, kind, title, created_at, updated_at) VALUES ('th1','a1','whatsapp','j','dm','Vero',?,?)",
      T, T
    )
    db.run(
      `INSERT INTO comms_messages (id, thread_id, account_id, provider, external_id, sender_name, sent_at, body_text, created_at)
       VALUES ('m1', 'th1', 'a1', 'whatsapp', 'e1', 'Vero', ?, 'la cita quedó el martes', ?)`,
      T, T
    )
    const hits = hydrateHits(db, [
      { entity: 'task', entity_id: 't1', score: 0.9 },
      { entity: 'comms_message', entity_id: 'm1', score: 0.8 },
      { entity: 'note', entity_id: 'missing', score: 0.7 } // deleted between rank & hydrate
    ])
    expect(hits).toHaveLength(2)
    expect(hits[0]).toMatchObject({ title: 'Pay rent', nav: { view: 'tasks', id: 't1' } })
    expect(hits[1]).toMatchObject({
      title: 'Vero',
      snippet: 'Vero: la cita quedó el martes',
      nav: { view: 'inbox', id: 'th1' }
    })
  })
})

describe('atlas: map coordinates', () => {
  it('tracks unprojected rows and roundtrips coordinates', () => {
    seedTask('t1', 'Pay rent')
    seedTask('t2', 'Call dentist')
    for (const s of listStale(db, 'task', 10)) upsertEmbedding(db, 'task', s.id, s.text, fakeVec(s.text))
    expect(countProjected(db)).toEqual({ projected: 0, total: 2 })
    expect(listUnprojected(db, 10)).toHaveLength(2)

    setMapCoords(db, [
      { entity: 'task', entity_id: 't1', x: 0.25, y: -0.5 },
      { entity: 'task', entity_id: 't2', x: -0.1, y: 0.9 }
    ])
    expect(countProjected(db)).toEqual({ projected: 2, total: 2 })
    expect(listUnprojected(db, 10)).toHaveLength(0)
    expect(listMapPoints(db)).toHaveLength(2)
    expect(mapCoordsFor(db, 'task', 't1')).toEqual({ x: 0.25, y: -0.5 })
    expect(mapCoordsFor(db, 'task', 'missing')).toBeNull()
  })
})

describe('atlas: normalizeCoords', () => {
  it('centers and scales into the [-1,1] world square preserving aspect', async () => {
    const { normalizeCoords } = await import('./semantic')
    const out = normalizeCoords(new Float32Array([0, 0, 10, 0, 10, 5, 0, 5]))
    // widest axis spans 1.9 world units, centered on 0
    expect(Math.min(...out)).toBeCloseTo(-0.95)
    expect(Math.max(...out)).toBeCloseTo(0.95)
    // y-span (5) keeps its aspect relative to x-span (10)
    expect(out[1]).toBeCloseTo(-0.475)
  })
})

describe('atlas: findMapClusters', () => {
  it('finds dense regions and ignores scatter', async () => {
    const { findMapClusters } = await import('./semantic')
    const pts: { x: number; y: number }[] = []
    let s = 7
    const r = (): number => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
    for (let i = 0; i < 500; i++) pts.push({ x: -0.5 + (r() - 0.5) * 0.2, y: -0.5 + (r() - 0.5) * 0.2 })
    for (let i = 0; i < 400; i++) pts.push({ x: 0.6 + (r() - 0.5) * 0.2, y: 0.4 + (r() - 0.5) * 0.2 })
    for (let i = 0; i < 100; i++) pts.push({ x: (r() - 0.5) * 2, y: (r() - 0.5) * 2 })
    const clusters = findMapClusters(pts)
    expect(clusters.length).toBeGreaterThanOrEqual(2)
    expect(clusters[0].count).toBeGreaterThan(300)
    // centroids land near the seeded centers
    const near = (c: { x: number; y: number }, x: number, y: number): boolean =>
      Math.hypot(c.x - x, c.y - y) < 0.15
    expect(clusters.some((c) => near(c, -0.5, -0.5))).toBe(true)
    expect(clusters.some((c) => near(c, 0.6, 0.4))).toBe(true)
  })
})

describe('atlas: cluster naming prompt/parse', () => {
  it('builds a numbered prompt and parses names back by position', async () => {
    const { buildClusterNamePrompt, parseClusterNames } = await import('./semantic')
    const p = buildClusterNamePrompt([
      ['la cita con el doctor', 'dentista jueves'],
      ['quarterly report', 'reply to Anna']
    ])
    expect(p).toContain('1.')
    expect(p).toContain('- la cita con el doctor')
    expect(p).toContain('Return ONLY a JSON object')

    const names = parseClusterNames('```json\n{"1":"Salud y citas","2":"Work reports"}\n```', 2)
    expect(names.get(0)).toBe('Salud y citas')
    expect(names.get(1)).toBe('Work reports')
    expect(parseClusterNames('garbage', 2).size).toBe(0)
  })
})

describe('atlas: meta + clusters storage', () => {
  it('persists meta and replaces clusters atomically', async () => {
    const { getMeta, setMeta, replaceClusters, listClusters } = await import('./semantic')
    expect(getMeta(db, 'umap_fit_count')).toBeNull()
    setMeta(db, 'umap_fit_count', '123')
    setMeta(db, 'umap_fit_count', '456')
    expect(getMeta(db, 'umap_fit_count')).toBe('456')

    replaceClusters(db, [
      { name: 'Familia', x: -0.5, y: -0.4, count: 900, contentKey: 'k1' },
      { name: '', x: 0.3, y: 0.5, count: 200, contentKey: 'k1' }
    ])
    const list = listClusters(db)
    expect(list).toHaveLength(2)
    expect(list[0]).toMatchObject({ name: 'Familia', count: 900 })
    replaceClusters(db, [])
    expect(listClusters(db)).toHaveLength(0)
  })
})

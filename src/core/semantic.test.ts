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

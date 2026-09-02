import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { DbDriver } from './driver'
import { openNodeSqliteDb } from './drivers/node-sqlite'

let db: DbDriver
const rows = (): number => db.get<{ n: number }>('SELECT COUNT(*) n FROM t')!.n

beforeEach(() => {
  db = openNodeSqliteDb(':memory:')
  db.exec('CREATE TABLE t (v INTEGER)')
})
afterEach(() => db.close())

describe('nested transactions', () => {
  it('a transaction inside a transaction commits with the outer one', () => {
    db.transaction(() => {
      db.run('INSERT INTO t VALUES (1)')
      db.transaction(() => db.run('INSERT INTO t VALUES (2)'))
    })
    expect(rows()).toBe(2)
  })

  it('an inner failure rolls back only the inner work when the outer catches it', () => {
    db.transaction(() => {
      db.run('INSERT INTO t VALUES (1)')
      expect(() =>
        db.transaction(() => {
          db.run('INSERT INTO t VALUES (2)')
          throw new Error('inner')
        })
      ).toThrow('inner')
      db.run('INSERT INTO t VALUES (3)')
    })
    expect(db.all<{ v: number }>('SELECT v FROM t ORDER BY v').map((r) => r.v)).toEqual([1, 3])
  })

  it('an uncaught inner failure rolls back everything', () => {
    expect(() =>
      db.transaction(() => {
        db.run('INSERT INTO t VALUES (1)')
        db.transaction(() => {
          db.run('INSERT INTO t VALUES (2)')
          throw new Error('inner')
        })
      })
    ).toThrow('inner')
    expect(rows()).toBe(0)
  })

  it('the connection is usable again after a rolled-back nest', () => {
    expect(() =>
      db.transaction(() => {
        db.transaction(() => {
          throw new Error('x')
        })
      })
    ).toThrow('x')
    db.transaction(() => db.run('INSERT INTO t VALUES (9)'))
    expect(rows()).toBe(1)
  })
})

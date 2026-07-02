import Database from 'better-sqlite3'
import type { DbDriver, SqlValue, RunResult } from '../driver'
import { OPEN_PRAGMAS, runTransaction } from '../driver'

export function openBetterSqliteDb(path: string): DbDriver {
  const db = new Database(path)
  db.exec(OPEN_PRAGMAS)
  const cache = new Map<string, Database.Statement>()

  const prepare = (sql: string): Database.Statement => {
    let stmt = cache.get(sql)
    if (!stmt) {
      stmt = db.prepare(sql)
      cache.set(sql, stmt)
    }
    return stmt
  }

  return {
    all: <T>(sql: string, ...params: SqlValue[]) => prepare(sql).all(...params) as T[],
    get: <T>(sql: string, ...params: SqlValue[]) =>
      prepare(sql).get(...params) as T | undefined,
    run: (sql: string, ...params: SqlValue[]): RunResult => {
      const r = prepare(sql).run(...params)
      return { changes: Number(r.changes) }
    },
    exec: (sql: string) => db.exec(sql),
    transaction: <T>(fn: () => T) => runTransaction((s) => db.exec(s), fn),
    close: () => db.close()
  }
}

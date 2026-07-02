// node:sqlite adapter — used by the standalone MCP server so it can run on
// plain Node (>=22.5) with zero native-module rebuilds. Do not import from
// Electron code; better-sqlite3 is the adapter there.
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import type { DbDriver, SqlValue, RunResult } from '../driver'
import { OPEN_PRAGMAS, runTransaction } from '../driver'

export function openNodeSqliteDb(path: string): DbDriver {
  const db = new DatabaseSync(path)
  db.exec(OPEN_PRAGMAS)
  const cache = new Map<string, StatementSync>()

  const prepare = (sql: string): StatementSync => {
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

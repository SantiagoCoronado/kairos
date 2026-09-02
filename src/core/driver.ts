// Minimal synchronous SQLite driver abstraction.
// Two adapters exist: better-sqlite3 (Electron main, Electron ABI) and
// node:sqlite (standalone MCP server, plain Node — no native rebuild).
// Keeping this surface tiny is what lets one repo layer serve both processes.

// Uint8Array covers BLOB columns; both adapters bind and return them
// natively (better-sqlite3 as Buffer, a Uint8Array)
export type SqlValue = string | number | null | Uint8Array

export interface RunResult {
  changes: number
}

export interface DbDriver {
  all<T = Record<string, unknown>>(sql: string, ...params: SqlValue[]): T[]
  get<T = Record<string, unknown>>(sql: string, ...params: SqlValue[]): T | undefined
  run(sql: string, ...params: SqlValue[]): RunResult
  exec(sql: string): void
  transaction<T>(fn: () => T): T
  close(): void
}

// Applied by every adapter on open. busy_timeout matters: the app and the
// MCP server can hold the same WAL file open concurrently.
export const OPEN_PRAGMAS = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
PRAGMA synchronous = NORMAL;
`

/**
 * Build a `transaction` for an adapter. Nested calls become savepoints, so a
 * repo primitive that opens its own transaction still composes into a caller's
 * larger one: an inner throw rolls back to its savepoint and rethrows; whether
 * the outer work survives is the outer caller's decision. `db.exec` runs a
 * multi-statement string, which is what the rollback-and-release relies on.
 */
export function makeTransaction(exec: (sql: string) => void): <T>(fn: () => T) => T {
  let depth = 0
  return <T>(fn: () => T): T => {
    const sp = depth > 0 ? `sp${depth}` : null
    exec(sp ? `SAVEPOINT ${sp}` : 'BEGIN IMMEDIATE')
    depth++
    try {
      const result = fn()
      exec(sp ? `RELEASE ${sp}` : 'COMMIT')
      return result
    } catch (err) {
      exec(sp ? `ROLLBACK TO ${sp}; RELEASE ${sp}` : 'ROLLBACK')
      throw err
    } finally {
      depth--
    }
  }
}

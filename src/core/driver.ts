// Minimal synchronous SQLite driver abstraction.
// Two adapters exist: better-sqlite3 (Electron main, Electron ABI) and
// node:sqlite (standalone MCP server, plain Node — no native rebuild).
// Keeping this surface tiny is what lets one repo layer serve both processes.

// Uint8Array covers BLOB columns (semantic-index vectors); both adapters
// bind and return them natively (better-sqlite3 as Buffer, a Uint8Array)
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

export function runTransaction<T>(exec: (sql: string) => void, fn: () => T): T {
  exec('BEGIN IMMEDIATE')
  try {
    const result = fn()
    exec('COMMIT')
    return result
  } catch (err) {
    exec('ROLLBACK')
    throw err
  }
}

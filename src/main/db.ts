import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import type { DbDriver } from '../core/driver'
import { openBetterSqliteDb } from '../core/drivers/better-sqlite3'
import { migrate } from '../core/migrations'
import { scopedLogger } from './logger'

export const DATA_DIR = join(homedir(), 'Kairos')
export const DB_PATH = join(DATA_DIR, 'data.db')

let db: DbDriver | null = null

export function getDb(): DbDriver {
  if (!db) {
    mkdirSync(DATA_DIR, { recursive: true })
    db = openBetterSqliteDb(DB_PATH)
    migrate(db, scopedLogger('db'))
  }
  return db
}

export function closeDb(): void {
  db?.close()
  db = null
}

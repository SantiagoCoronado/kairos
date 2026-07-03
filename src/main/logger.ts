// Persistent app log at ~/Kairos/logs/app.log — the place to look when
// something crashed or misbehaved. Main-process errors, renderer errors
// (via the log:renderer IPC), and lifecycle events all land here.
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { Logger } from '../core/logger'

// mirrors DATA_DIR in db.ts; spelled out here to avoid a circular import
const LOG_DIR = join(homedir(), 'Kairos', 'logs')
const LOG_FILE = join(LOG_DIR, 'app.log')
const MAX_BYTES = 2 * 1024 * 1024 // rotate to app.log.1 past this

export type LogLevel = 'info' | 'warn' | 'error'

let dirReady = false

export function logLine(level: LogLevel, scope: string, message: string): void {
  const line = `${new Date().toISOString()} [${level}] [${scope}] ${message}\n`
  try {
    if (!dirReady) {
      mkdirSync(LOG_DIR, { recursive: true })
      dirReady = true
    }
    try {
      if (statSync(LOG_FILE).size > MAX_BYTES) renameSync(LOG_FILE, `${LOG_FILE}.1`)
    } catch {
      // no file yet
    }
    appendFileSync(LOG_FILE, line)
  } catch {
    // logging must never take the app down
  }
  // mirror to the terminal for dev runs
  if (level === 'error') console.error(line.trimEnd())
  else console.log(line.trimEnd())
}

export function scopedLogger(scope: string): Logger {
  return {
    info: (m) => logLine('info', scope, m),
    warn: (m) => logLine('warn', scope, m),
    error: (m) => logLine('error', scope, m)
  }
}

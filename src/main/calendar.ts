import { app } from 'electron'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { CalendarResult, CalendarEvent } from '../shared/ipc-contract'

function helperPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'calendar-helper')
    : join(app.getAppPath(), 'resources', 'calendar-helper')
}

let cache: { at: number; result: CalendarResult } | null = null
const CACHE_MS = 5 * 60 * 1000

export function invalidateCalendarCache(): void {
  cache = null
}

export async function calendarToday(): Promise<CalendarResult> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.result

  const bin = helperPath()
  if (!existsSync(bin)) return { error: 'helper-missing' }

  const result = await new Promise<CalendarResult>((resolve) => {
    execFile(bin, [], { timeout: 10_000 }, (err, stdout) => {
      if (err) {
        const denied = typeof err.code === 'number' && err.code === 2
        resolve({ error: denied ? 'not-authorized' : 'helper-failed' })
        return
      }
      try {
        resolve({ events: JSON.parse(stdout) as CalendarEvent[] })
      } catch {
        resolve({ error: 'helper-failed' })
      }
    })
  })

  cache = { at: Date.now(), result }
  return result
}

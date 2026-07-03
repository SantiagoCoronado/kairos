// macOS address book via the native contacts-helper (Contacts.framework,
// TCC-gated) — same execFile pattern as calendar.ts.
import { app } from 'electron'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export interface MacContact {
  name: string
  phones: string[]
  emails: string[]
}

export type ContactsResult =
  | { contacts: MacContact[] }
  | { error: 'not-authorized' | 'helper-missing' | 'helper-failed' }

function helperPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'contacts-helper')
    : join(app.getAppPath(), 'resources', 'contacts-helper')
}

let cache: { at: number; result: ContactsResult } | null = null
const CACHE_MS = 30 * 60 * 1000

export async function loadMacContacts(): Promise<ContactsResult> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.result

  const bin = helperPath()
  if (!existsSync(bin)) return { error: 'helper-missing' }

  const result = await new Promise<ContactsResult>((resolve) => {
    execFile(bin, [], { timeout: 35_000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        const denied = typeof err.code === 'number' && err.code === 2
        resolve({ error: denied ? 'not-authorized' : 'helper-failed' })
        return
      }
      try {
        resolve({ contacts: JSON.parse(stdout) as MacContact[] })
      } catch {
        resolve({ error: 'helper-failed' })
      }
    })
  })

  // only cache successes — an error here is usually the TCC prompt still
  // pending (or just answered), and caching it would blind us for 30 minutes
  if ('contacts' in result) cache = { at: Date.now(), result }
  return result
}

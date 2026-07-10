// macOS address book via the native contacts-helper (Contacts.framework,
// TCC-gated) — same execFile pattern as calendar.ts.
import { app } from 'electron'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { MacContact, ContactsResult } from '../shared/ipc-contract'

export type { MacContact, ContactsResult }

function helperPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'contacts-helper')
    : join(app.getAppPath(), 'resources', 'contacts-helper')
}

let cache: { at: number; result: ContactsResult } | null = null
let inflight: Promise<ContactsResult> | null = null
const CACHE_MS = 30 * 60 * 1000

export async function loadMacContacts(): Promise<ContactsResult> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.result
  // concurrent callers (autocomplete keystrokes + comms name sweep) share one
  // helper run instead of each spawning the binary
  if (inflight) return inflight

  const bin = helperPath()
  if (!existsSync(bin)) return { error: 'helper-missing' }

  inflight = new Promise<ContactsResult>((resolve) => {
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
  const result = await inflight
  inflight = null

  // only cache successes — an error here is usually the TCC prompt still
  // pending (or just answered), and caching it would blind us for 30 minutes
  if ('contacts' in result) cache = { at: Date.now(), result }
  return result
}

/** Address-book autocomplete for the People view. Name/email substring match;
 *  phones only when the query itself carries ≥3 digits (else everything hits). */
export async function searchMacContacts(query: string, limit = 8): Promise<ContactsResult> {
  const res = await loadMacContacts()
  if ('error' in res) return res
  const q = query.trim().toLowerCase()
  if (!q) return { contacts: [] }
  const qDigits = q.replace(/\D/g, '')
  const matches = res.contacts.filter(
    (c) =>
      c.name.toLowerCase().includes(q) ||
      c.emails.some((e) => e.toLowerCase().includes(q)) ||
      (qDigits.length >= 3 && c.phones.some((p) => p.replace(/\D/g, '').includes(qDigits)))
  )
  return { contacts: matches.slice(0, limit) }
}

// Provider tokens encrypted at rest with Electron safeStorage (Keychain-backed
// on macOS). The standalone MCP server (plain Node) cannot decrypt these by
// construction — all provider network I/O stays in the Electron main process.
import { safeStorage } from 'electron'
import type { DbDriver } from '../../core/driver'
import { setCredentialCipher, getCredentialCipher } from '../../core/repo/comms'
import {
  setCalendarCredentialCipher,
  getCalendarCredentialCipher
} from '../../core/repo/calendar'

/** which credentials table holds the cipher (comms and calendar accounts
 *  live in separate tables with separate FKs) */
export type CredentialStore = 'comms' | 'calendar'

export function assertEncryptionAvailable(): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      'Secure token storage is unavailable (macOS Keychain not accessible). Refusing to store credentials in plaintext.'
    )
  }
}

export function saveTokens(
  db: DbDriver,
  accountId: string,
  tokens: unknown,
  store: CredentialStore = 'comms'
): void {
  assertEncryptionAvailable()
  const cipher = safeStorage.encryptString(JSON.stringify(tokens)).toString('base64')
  if (store === 'calendar') setCalendarCredentialCipher(db, accountId, cipher)
  else setCredentialCipher(db, accountId, cipher)
}

export function loadTokens<T>(
  db: DbDriver,
  accountId: string,
  store: CredentialStore = 'comms'
): T | null {
  const cipher =
    store === 'calendar'
      ? getCalendarCredentialCipher(db, accountId)
      : getCredentialCipher(db, accountId)
  if (!cipher) return null
  try {
    return JSON.parse(safeStorage.decryptString(Buffer.from(cipher, 'base64'))) as T
  } catch {
    return null
  }
}

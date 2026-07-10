import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { AppSettings } from '../shared/ipc-contract'
import { DATA_DIR } from './db'

export type Settings = AppSettings

const DEFAULTS: Settings = {
  captureHotkey: 'Alt+Space',
  claudePath: null,
  automationsEnabled: true,
  translucency: 0,
  showClaudeUsage: true,
  autoLabel: false,
  notifyInbox: 'important',
  chatProvider: 'claude',
  chatModel: null,
  chatEffort: null,
  googleClientId: null,
  googleClientSecret: null,
  slackClientId: null,
  slackClientSecret: null,
  automationsSeenAt: null,
  remoteAccess: false,
  remoteToken: null,
  remotePort: 4699
}

const FILE = join(DATA_DIR, 'settings.json')

let cached: Settings | null = null

export function getSettings(): Settings {
  if (cached) return cached
  try {
    cached = { ...DEFAULTS, ...(JSON.parse(readFileSync(FILE, 'utf8')) as Partial<Settings>) }
  } catch {
    cached = { ...DEFAULTS }
  }
  return cached
}

export function saveSettings(patch: Partial<Settings>): Settings {
  const next = { ...getSettings(), ...patch }
  next.translucency = Math.min(60, Math.max(0, next.translucency))
  mkdirSync(DATA_DIR, { recursive: true })
  writeFileSync(FILE, JSON.stringify(next, null, 2) + '\n')
  cached = next
  return next
}

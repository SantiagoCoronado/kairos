import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from './db'

export interface Settings {
  captureHotkey: string
  claudePath: string | null
}

const DEFAULTS: Settings = {
  captureHotkey: 'Alt+Space',
  claudePath: null
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
  mkdirSync(DATA_DIR, { recursive: true })
  writeFileSync(FILE, JSON.stringify(next, null, 2) + '\n')
  cached = next
  return next
}

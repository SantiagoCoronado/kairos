import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Persistent agent memory: a single human-editable Markdown file in the data
// dir. Injected into the chat system prompt each turn and exposed to both
// Claude surfaces via the memory_read / memory_save tools. Not a DB table on
// purpose — the user can open and edit it like any note.

const FILE = 'memory.md'

export function memoryPath(dataDir: string): string {
  return join(dataDir, FILE)
}

export function readMemory(dataDir: string): string {
  try {
    return readFileSync(memoryPath(dataDir), 'utf8')
  } catch {
    return ''
  }
}

export function saveMemory(
  dataDir: string,
  content: string,
  mode: 'append' | 'replace'
): { bytes: number } {
  mkdirSync(dataDir, { recursive: true })
  const path = memoryPath(dataDir)
  const next =
    mode === 'append' && existsSync(path)
      ? readMemory(dataDir).replace(/\n*$/, '\n\n') + content.trim() + '\n'
      : content.trim() + '\n'
  const tmp = path + '.tmp'
  writeFileSync(tmp, next)
  renameSync(tmp, path)
  return { bytes: Buffer.byteLength(next) }
}

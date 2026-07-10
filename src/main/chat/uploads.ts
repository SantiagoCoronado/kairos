// Chat attachments: files the user attaches (picker or drag-drop) are staged
// into DATA_DIR/chat-uploads and referenced by path in the prompt — the chat
// agent gets a Read permission scoped to exactly this directory. Staging
// copies (never links) so the conversation survives the original moving.
import { dialog } from 'electron'
import { copyFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { basename, join } from 'node:path'
import { ulid } from 'ulid'
import type { ChatAttachment } from '../../shared/ipc-contract'
import { DATA_DIR } from '../db'
import { logLine } from '../logger'

export const CHAT_UPLOADS_DIR = join(DATA_DIR, 'chat-uploads')

/** staged copies are transient prompt inputs, not documents — a week is plenty */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

function stage(srcPath: string): ChatAttachment {
  mkdirSync(CHAT_UPLOADS_DIR, { recursive: true })
  const name = basename(srcPath)
  // ulid prefix: same-named files never collide, and age is encoded for pruning
  const dest = join(CHAT_UPLOADS_DIR, `${ulid().slice(0, 8).toLowerCase()}-${name}`)
  copyFileSync(srcPath, dest)
  return { name, path: dest, size: statSync(dest).size }
}

/** File-picker entry point (the composer's paperclip button). */
export async function attachViaDialog(): Promise<ChatAttachment[]> {
  const res = await dialog.showOpenDialog({
    title: 'Attach files',
    properties: ['openFile', 'multiSelections']
  })
  if (res.canceled) return []
  return res.filePaths.map(stage)
}

/** Drag-drop entry point: the renderer resolves File → path via webUtils. */
export function attachPaths(paths: string[]): ChatAttachment[] {
  const staged: ChatAttachment[] = []
  for (const p of paths) {
    try {
      staged.push(stage(p))
    } catch (err) {
      // a single unreadable file shouldn't kill the whole drop
      logLine('warn', 'chat', `attach failed for ${p}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return staged
}

/** Drop week-old staged copies on app start. */
export function pruneChatUploads(now = Date.now()): void {
  let files: string[]
  try {
    files = readdirSync(CHAT_UPLOADS_DIR)
  } catch {
    return // dir doesn't exist yet
  }
  let dropped = 0
  for (const f of files) {
    try {
      const full = join(CHAT_UPLOADS_DIR, f)
      if (now - statSync(full).mtimeMs > MAX_AGE_MS) {
        unlinkSync(full)
        dropped++
      }
    } catch {
      // racing another unlink / permissions — skip
    }
  }
  if (dropped > 0) logLine('info', 'chat', `pruned ${dropped} stale chat upload${dropped > 1 ? 's' : ''}`)
}

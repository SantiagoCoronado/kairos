// The on-disk attachment cache (DATA_DIR/attachments). Two jobs: name a
// cache file so same-named attachments never collide and the name fits the
// filesystem, and repair the files a pre-Sep-2026 build wrote under the
// colliding 8-char-prefix scheme.
import { basename, dirname, join } from 'node:path'
import { renameSync, statSync, unlinkSync } from 'node:fs'
import type { DbDriver } from '../../core/driver'
import * as repo from '../../core/repo/comms'

/** Most filesystems cap a name at 255 bytes; leave headroom past the
 *  27-byte `<ulid>-` prefix and any `.download`-style suffix a viewer adds. */
const NAME_BUDGET_BYTES = 200

/** `<full attachment id>-<sanitized filename>`. The FULL id: ids are ULIDs,
 *  so an 8-char prefix is just the timestamp and every photo.jpeg ingested
 *  in the same second used to collide on one path. The name part is
 *  byte-capped (multi-byte safe, extension kept) so a long Gmail filename
 *  can't turn into ENAMETOOLONG. */
export function cacheFileName(id: string, filename: string | null | undefined): string {
  const safe = (filename || 'attachment').replace(/[/\\:]/g, '_')
  return `${id}-${capBytes(safe, NAME_BUDGET_BYTES)}`
}

/** Trim a name to `max` UTF-8 bytes, keeping its extension and never
 *  splitting a code point. Reads the extension only when it's short. */
function capBytes(name: string, max: number): string {
  if (Buffer.byteLength(name) <= max) return name
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : ''
  const stem = ext ? name.slice(0, dot) : name
  const budget = max - Buffer.byteLength(ext)
  let out = ''
  let used = 0
  for (const ch of stem) {
    const n = Buffer.byteLength(ch)
    if (used + n > budget) break
    out += ch
    used += n
  }
  return (out || 'attachment') + ext
}

/** A cache path written by the old scheme — anything not `<full id>-…`. */
export function isLegacyCachePath(id: string, localPath: string): boolean {
  return !basename(localPath).startsWith(`${id}-`)
}

export interface CacheRepairReport {
  /** rows whose file was proven theirs by size and renamed to the new scheme */
  kept: number
  /** rows that forgot a path (file missing, wrong size, or ambiguous) */
  cleared: number
  /** legacy files deleted because no row could claim them */
  removed: number
}

/**
 * One-shot repair of cache files written under the 8-char-prefix scheme.
 * Every row still pointing at a legacy-named file is suspect: the file holds
 * ONE attachment's bytes and the rows sharing it (or the lone survivor of a
 * group whose siblings were deleted) can't tell whose. `size_bytes` can: a
 * row that alone matches the file's size keeps it, renamed to the new
 * scheme; every other row forgets its path and re-downloads on next open;
 * a file nobody can claim is deleted. Idempotent — after one pass no legacy
 * paths remain, so later launches find nothing to do.
 */
export function repairLegacyAttachmentCache(db: DbDriver): CacheRepairReport {
  const report: CacheRepairReport = { kept: 0, cleared: 0, removed: 0 }
  const groups = new Map<string, repo.CachedAttachment[]>()
  for (const a of repo.listCachedAttachments(db)) {
    if (!isLegacyCachePath(a.id, a.local_path)) continue
    const g = groups.get(a.local_path)
    if (g) g.push(a)
    else groups.set(a.local_path, [a])
  }
  for (const [path, rows] of groups) {
    let size: number | null = null
    try {
      size = statSync(path).size
    } catch {
      size = null // file gone: nothing to salvage, every row just forgets it
    }
    const claimants = size === null ? [] : rows.filter((r) => r.size_bytes === size)
    const winner = claimants.length === 1 ? claimants[0] : null
    for (const r of rows) {
      if (r !== winner) {
        repo.setAttachmentLocalPath(db, r.id, null)
        report.cleared++
      }
    }
    if (winner) {
      const dest = join(dirname(path), cacheFileName(winner.id, winner.filename))
      try {
        renameSync(path, dest)
        repo.setAttachmentLocalPath(db, winner.id, dest)
        report.kept++
      } catch {
        // rename refused (permissions, name too long): give up the bytes
        // rather than leave a legacy path that would be re-examined forever
        repo.setAttachmentLocalPath(db, winner.id, null)
        report.cleared++
      }
    } else if (size !== null) {
      try {
        unlinkSync(path)
        report.removed++
      } catch {
        // already gone or unwritable — no row points at it anymore either way
      }
    }
  }
  return report
}

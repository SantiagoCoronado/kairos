// The on-disk attachment cache (DATA_DIR/attachments). Two jobs: name a
// cache file so same-named attachments never collide and the name fits the
// filesystem, and repair the files a pre-Sep-2026 build wrote under the
// colliding 8-char-prefix scheme.
import { basename, dirname, join } from 'node:path'
import { mkdirSync, renameSync, statSync } from 'node:fs'
import type { DbDriver } from '../../core/driver'
import * as repo from '../../core/repo/comms'
import { capFileNameBytes } from '../fs-names'

/** The user-facing part of a cache name: path separators neutralized. */
const sanitize = (filename: string | null | undefined): string =>
  (filename || 'attachment').replace(/[/\\:]/g, '_')

/** `<full attachment id>-<sanitized filename>`. The FULL id: ids are ULIDs,
 *  so an 8-char prefix is just the timestamp and every photo.jpeg ingested
 *  in the same second used to collide on one path. The name part is
 *  byte-capped (multi-byte safe, extension kept) so a long Gmail filename
 *  can't turn into ENAMETOOLONG. */
export function cacheFileName(id: string, filename: string | null | undefined): string {
  return `${id}-${capFileNameBytes(sanitize(filename))}`
}

/** A cache path written by the old scheme — anything not `<full id>-…`. */
export function isLegacyCachePath(id: string, localPath: string): boolean {
  return !basename(localPath).startsWith(`${id}-`)
}

export interface CacheRepairReport {
  /** rows whose file was proven theirs and renamed to the new scheme */
  kept: number
  /** rows that forgot a path (file missing, unproven, or ambiguous) */
  cleared: number
  /** legacy files no row could prove a claim to, moved under UNCLAIMED_DIR */
  unclaimed: number
}

/** Where unclaimed legacy files go: still on disk, and findable. */
export const UNCLAIMED_DIR = 'unclaimed'

/**
 * One-shot repair of cache files written under the 8-char-prefix scheme.
 * Every row still pointing at a legacy-named file is suspect: the file holds
 * ONE attachment's bytes and the rows sharing it (or the lone survivor of a
 * group whose siblings were deleted) can't tell whose. A row proves a claim
 * when it ALONE matches the file's size, every row in the group has a
 * known non-zero size (an unknown-size sibling may be the one that wrote the
 * bytes), and the file was written under its own filename; it keeps the
 * file, renamed to the new scheme. Every other row forgets its path and
 * re-downloads on next open. Unclaimed files are moved to an `unclaimed/`
 * folder beside them, never deleted: they may be the last copy of media
 * whose CDN url has expired. Idempotent — after one pass no legacy paths
 * remain.
 *
 * Order matters: every row update commits in one transaction FIRST, then the
 * filesystem moves. A rename can't roll back, so it must never run ahead of
 * a DB write that might. If a move fails after the commit, the winner row
 * points at a new-scheme path that doesn't exist yet — ensureAttachmentLocal
 * treats that as a cache miss and re-downloads to that very path.
 */
export function repairLegacyAttachmentCache(db: DbDriver): CacheRepairReport {
  const report: CacheRepairReport = { kept: 0, cleared: 0, unclaimed: 0 }
  const groups = new Map<string, repo.CachedAttachment[]>()
  for (const a of repo.listCachedAttachments(db)) {
    if (!isLegacyCachePath(a.id, a.local_path)) continue
    const g = groups.get(a.local_path)
    if (g) g.push(a)
    else groups.set(a.local_path, [a])
  }
  if (groups.size === 0) return report

  const renames: { from: string; to: string }[] = []
  const strays: string[] = []
  db.transaction(() => {
    for (const [path, rows] of groups) {
      let size: number | null = null
      try {
        size = statSync(path).size
      } catch {
        size = null // file gone: nothing to salvage, every row just forgets it
      }
      // the legacy name was `<8 chars>-<sanitized filename>`: a claimant's own
      // filename must be the one the file was written under (rules out a
      // same-sized photo claiming a sticker, or a pdf claiming a photo)
      const writtenAs = basename(path).replace(/^[^-]*-/, '')
      const provable = size !== null && size > 0 && rows.every((r) => r.size_bytes != null)
      const claimants = provable
        ? rows.filter((r) => r.size_bytes === size && sanitize(r.filename) === writtenAs)
        : []
      const winner = claimants.length === 1 ? claimants[0] : null
      for (const r of rows) {
        if (r !== winner) {
          repo.setAttachmentLocalPath(db, r.id, null)
          report.cleared++
        }
      }
      if (winner) {
        const dest = join(dirname(path), cacheFileName(winner.id, winner.filename))
        repo.setAttachmentLocalPath(db, winner.id, dest)
        renames.push({ from: path, to: dest })
        report.kept++
      } else if (size !== null) {
        strays.push(path)
      }
    }
  })

  // filesystem phase — only after the rows are committed
  for (const { from, to } of renames) {
    try {
      renameSync(from, to)
    } catch {
      // the row already points at `to`; a miss there re-downloads into it
    }
  }
  for (const path of strays) {
    const dir = join(dirname(path), UNCLAIMED_DIR)
    try {
      mkdirSync(dir, { recursive: true })
      renameSync(path, join(dir, basename(path)))
      report.unclaimed++
    } catch {
      // unmovable: stays where it is, still on disk
    }
  }
  return report
}

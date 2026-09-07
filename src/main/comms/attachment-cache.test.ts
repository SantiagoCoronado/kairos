import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type { DbDriver } from '../../core/driver'
import { openNodeSqliteDb } from '../../core/drivers/node-sqlite'
import { migrate } from '../../core/migrations'
import * as comms from '../../core/repo/comms'
import { cacheFileName, isLegacyCachePath, repairLegacyAttachmentCache, UNCLAIMED_DIR } from './attachment-cache'

const ID = '01KXHT3AZZZZZZZZZZZZZZZZZZ'

describe('cacheFileName', () => {
  it('prefixes the full id and sanitizes path characters', () => {
    expect(cacheFileName(ID, 'a/b\\c:d.pdf')).toBe(`${ID}-a_b_c_d.pdf`)
    expect(cacheFileName(ID, '')).toBe(`${ID}-attachment`)
    expect(cacheFileName(ID, null)).toBe(`${ID}-attachment`)
  })

  it('caps the name at a byte budget, keeping the extension and whole code points', () => {
    const long = 'x'.repeat(300) + '.jpeg'
    const out = cacheFileName(ID, long)
    expect(out.endsWith('.jpeg')).toBe(true)
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(ID.length + 1 + 200)
    // 3-byte characters: the cut must land between them, never inside one
    const wide = '日'.repeat(300) + '.png'
    const w = cacheFileName(ID, wide)
    expect(w.endsWith('.png')).toBe(true)
    expect(Buffer.byteLength(w)).toBeLessThanOrEqual(ID.length + 1 + 200)
    expect(w.includes('�')).toBe(false)
    expect([...w.slice(ID.length + 1, -4)].every((c) => c === '日')).toBe(true)
    // short names pass through untouched
    expect(cacheFileName(ID, 'photo.jpeg')).toBe(`${ID}-photo.jpeg`)
  })

  it('isLegacyCachePath flags anything not written under the full id', () => {
    expect(isLegacyCachePath(ID, `/k/att/${ID.slice(0, 8)}-photo.jpeg`)).toBe(true)
    expect(isLegacyCachePath(ID, `/k/att/${ID}-photo.jpeg`)).toBe(false)
  })
})

describe('repairLegacyAttachmentCache', () => {
  let db: DbDriver
  let dir: string
  let messageId: string

  beforeEach(() => {
    db = openNodeSqliteDb(':memory:')
    migrate(db)
    dir = mkdtempSync(join(tmpdir(), 'kairos-attcache-'))
    const a = comms.upsertAccount(db, { provider: 'gmail', external_id: 'me@x', display_name: 'me' })
    const t = comms.upsertThread(db, {
      account_id: a.id, provider: 'gmail', external_id: 'thr', kind: 'email', title: 't'
    })
    comms.upsertMessage(db, {
      thread_id: t.id, account_id: a.id, provider: 'gmail', external_id: 'm1',
      sent_at: '2026-09-01T00:00:00.000Z', body_text: 'photos', has_attachments: true
    })
    messageId = comms.getMessageByExternal(db, a.id, 'm1')!.id
  })

  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  /** one attachment row; returns its id */
  const att = (ref: string, size: number | null, filename = 'photo.jpeg'): string => {
    comms.addAttachments(db, messageId, [{ filename, mime_type: 'image/jpeg', size_bytes: size, external_ref: ref }])
    return comms.listThreadAttachments(db, comms.getMessage(db, messageId)!.thread_id)
      .find((x) => x.external_ref === ref)!.id
  }
  const file = (name: string, bytes: number): string => {
    const p = join(dir, name)
    writeFileSync(p, Buffer.alloc(bytes, 1))
    return p
  }
  const pathOf = (id: string): string | null => comms.getAttachment(db, id)!.local_path
  const unclaimed = (legacyName: string): string => join(dir, UNCLAIMED_DIR, legacyName)

  it('keeps the one row whose size matches, renamed; siblings forget the path', () => {
    const shared = file('01KXHT3A-photo.jpeg', 5)
    const a = att('a', 3)
    const b = att('b', 5)
    comms.setAttachmentLocalPath(db, a, shared)
    comms.setAttachmentLocalPath(db, b, shared)

    const r = repairLegacyAttachmentCache(db)
    expect(r).toEqual({ kept: 1, cleared: 1, unclaimed: 0 })
    expect(pathOf(a)).toBeNull()
    expect(pathOf(b)).toBe(join(dir, `${b}-photo.jpeg`))
    expect(existsSync(shared)).toBe(false)
    expect(existsSync(pathOf(b)!)).toBe(true)
  })

  it('an unknown-size sibling makes the whole group ambiguous', () => {
    // A (null size) was the last to download, so the file holds A's bytes;
    // B happens to match the file size — it must NOT win A's photo
    const shared = file('01KXHT3H-photo.jpeg', 5)
    const a = att('a', null)
    const b = att('b', 5)
    comms.setAttachmentLocalPath(db, a, shared)
    comms.setAttachmentLocalPath(db, b, shared)
    expect(repairLegacyAttachmentCache(db)).toEqual({ kept: 0, cleared: 2, unclaimed: 1 })
    expect([a, b].map(pathOf)).toEqual([null, null])
    expect(existsSync(unclaimed('01KXHT3H-photo.jpeg'))).toBe(true)
  })

  it('a size match under a different filename proves nothing', () => {
    // the file was written as a sticker; the only same-sized row is a photo
    const shared = file('01KXHT3F-sticker.webp', 5)
    const photo = att('a', 5, 'photo.jpeg')
    const sticker = att('b', 9, 'sticker.webp')
    comms.setAttachmentLocalPath(db, photo, shared)
    comms.setAttachmentLocalPath(db, sticker, shared)
    expect(repairLegacyAttachmentCache(db)).toEqual({ kept: 0, cleared: 2, unclaimed: 1 })
    expect(existsSync(unclaimed('01KXHT3F-sticker.webp'))).toBe(true)
  })

  it('a zero-size file is never claimed', () => {
    const shared = file('01KXHT3G-photo.jpeg', 0)
    const a = att('a', 0)
    comms.setAttachmentLocalPath(db, a, shared)
    expect(repairLegacyAttachmentCache(db)).toEqual({ kept: 0, cleared: 1, unclaimed: 1 })
  })

  it('a lone survivor of a collision group is checked by size too', () => {
    // sibling row was cascade-deleted; the file holds the sibling's 5 bytes
    const orphaned = file('01KXHT3B-photo.jpeg', 5)
    const a = att('a', 3)
    comms.setAttachmentLocalPath(db, a, orphaned)
    const r = repairLegacyAttachmentCache(db)
    expect(r).toEqual({ kept: 0, cleared: 1, unclaimed: 1 })
    expect(pathOf(a)).toBeNull()
    // the bytes stay, findable: they may be the last copy of expired media
    expect(existsSync(orphaned)).toBe(false)
    expect(existsSync(unclaimed('01KXHT3B-photo.jpeg'))).toBe(true)
  })

  it('ambiguous sizes clear every row and set the file aside', () => {
    const shared = file('01KXHT3C-photo.jpeg', 7)
    const a = att('a', 7)
    const b = att('b', 7)
    const c = att('c', null)
    for (const id of [a, b, c]) comms.setAttachmentLocalPath(db, id, shared)
    const r = repairLegacyAttachmentCache(db)
    expect(r).toEqual({ kept: 0, cleared: 3, unclaimed: 1 })
    expect([a, b, c].map(pathOf)).toEqual([null, null, null])
    expect(readdirSync(dir)).toEqual([UNCLAIMED_DIR])
    expect(readdirSync(join(dir, UNCLAIMED_DIR))).toEqual(['01KXHT3C-photo.jpeg'])
  })

  it('a missing file just clears its rows', () => {
    const a = att('a', 3)
    comms.setAttachmentLocalPath(db, a, join(dir, '01KXHT3D-photo.jpeg'))
    expect(repairLegacyAttachmentCache(db)).toEqual({ kept: 0, cleared: 1, unclaimed: 0 })
    expect(pathOf(a)).toBeNull()
  })

  it('leaves new-scheme rows alone and is idempotent', () => {
    const a = att('a', 4)
    const fresh = file(`${a}-photo.jpeg`, 4)
    comms.setAttachmentLocalPath(db, a, fresh)
    const shared = file('01KXHT3E-photo.jpeg', 5)
    const b = att('b', 5)
    comms.setAttachmentLocalPath(db, b, shared)

    expect(repairLegacyAttachmentCache(db)).toEqual({ kept: 1, cleared: 0, unclaimed: 0 })
    expect(pathOf(a)).toBe(fresh)
    expect(basename(pathOf(b)!)).toBe(`${b}-photo.jpeg`)
    // second pass: nothing legacy left
    expect(repairLegacyAttachmentCache(db)).toEqual({ kept: 0, cleared: 0, unclaimed: 0 })
  })
})

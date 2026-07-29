import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { DbDriver } from '../core/driver'
import { openNodeSqliteDb } from '../core/drivers/node-sqlite'
import { migrate } from '../core/migrations'
import * as meetings from '../core/repo/meetings'
import { MeetingManager, PCM_SAMPLE_RATE, type MeetingFs } from './meetings'
import { resolveDisplayMedia } from './display-media'
import { WAV_HEADER_BYTES } from '../core/audio'

const T0 = new Date('2026-07-28T12:00:00Z')

/** in-memory MeetingFs — byte-accurate, path-keyed */
function makeFakeFs(): MeetingFs & { files: Map<string, Uint8Array>; dirs: Set<string> } {
  const files = new Map<string, Uint8Array>()
  const dirs = new Set<string>()
  const concat = (a: Uint8Array, b: Uint8Array): Uint8Array => {
    const out = new Uint8Array(a.length + b.length)
    out.set(a)
    out.set(b, a.length)
    return out
  }
  return {
    files,
    dirs,
    mkdir: (dir) => void dirs.add(dir),
    append: (path, data) => files.set(path, concat(files.get(path) ?? new Uint8Array(0), data)),
    write: (path, data) => files.set(path, Uint8Array.from(data)),
    writeAt: (path, offset, data) => {
      const cur = files.get(path)
      if (!cur) throw new Error(`writeAt on missing file: ${path}`)
      const out = Uint8Array.from(cur)
      out.set(data, offset)
      files.set(path, out)
    },
    size: (path) => files.get(path)?.length ?? null,
    rmDir: (dir) => {
      dirs.delete(dir)
      for (const p of [...files.keys()]) if (p.startsWith(dir + '/')) files.delete(p)
    }
  }
}

let db: DbDriver
let fs: ReturnType<typeof makeFakeFs>
let onChange: ReturnType<typeof vi.fn<() => void>>
let clock: Date

const mkManager = (): MeetingManager =>
  new MeetingManager(db, '/rec', onChange, fs, () => clock)

beforeEach(() => {
  db = openNodeSqliteDb(':memory:')
  migrate(db)
  fs = makeFakeFs()
  onChange = vi.fn<() => void>()
  clock = T0
})

afterEach(() => db.close())

describe('MeetingManager', () => {
  it('start creates row, dir and WAV placeholders; rejects concurrent starts', () => {
    const mgr = mkManager()
    const m = mgr.start({ title: 'standup' })
    expect(m.status).toBe('recording')
    expect(mgr.activeMeetingId).toBe(m.id)
    expect(fs.dirs.has(`/rec/${m.id}`)).toBe(true)
    expect(fs.size(`/rec/${m.id}/mic.wav`)).toBe(WAV_HEADER_BYTES)
    expect(fs.size(`/rec/${m.id}/system.wav`)).toBe(WAV_HEADER_BYTES)
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(() => mgr.start()).toThrow(/already recording/)
  })

  it('routes chunks per channel and kind; rejects unknown meeting ids', () => {
    const mgr = mkManager()
    const m = mgr.start()
    mgr.appendChunk(m.id, 'mic', 'webm', new Uint8Array([1, 2, 3]))
    mgr.appendChunk(m.id, 'system', 'webm', new Uint8Array([9]))
    mgr.appendChunk(m.id, 'mic', 'pcm', new Uint8Array([0, 1, 0, 1]))
    expect(fs.size(`/rec/${m.id}/mic.webm`)).toBe(3)
    expect(fs.size(`/rec/${m.id}/system.webm`)).toBe(1)
    expect(fs.size(`/rec/${m.id}/mic.wav`)).toBe(WAV_HEADER_BYTES + 4)
    expect(() => mgr.appendChunk('nope', 'mic', 'webm', new Uint8Array([1]))).toThrow(
      /not recording/
    )
  })

  it('stop patches WAV headers, finalizes the row from the clock', () => {
    const mgr = mkManager()
    const m = mgr.start()
    const pcm = new Uint8Array(PCM_SAMPLE_RATE * 2) // 1s of silence
    mgr.appendChunk(m.id, 'mic', 'pcm', pcm)
    mgr.appendChunk(m.id, 'mic', 'webm', new Uint8Array([1, 2]))

    clock = new Date(T0.getTime() + 90_000)
    const stopped = mgr.stop(m.id)

    expect(stopped.status).toBe('ready')
    expect(stopped.ended_at).toBe(clock.toISOString())
    expect(stopped.duration_seconds).toBe(90)
    expect(stopped.mic_path).toBe(`/rec/${m.id}/mic.webm`)
    expect(stopped.system_path).toBeNull() // no system chunks arrived
    expect(mgr.activeMeetingId).toBeNull()

    const wav = fs.files.get(`/rec/${m.id}/mic.wav`)!
    const view = new DataView(wav.buffer, wav.byteOffset)
    expect(view.getUint32(4, true)).toBe(36 + pcm.length)
    expect(view.getUint32(40, true)).toBe(pcm.length)
    expect(() => mgr.stop(m.id)).toThrow(/not recording/)
  })

  it('recoverOrphans finalizes crashed recordings from disk', () => {
    const mgr = mkManager()
    const m = mgr.start()
    mgr.appendChunk(m.id, 'mic', 'pcm', new Uint8Array(PCM_SAMPLE_RATE * 2 * 5)) // 5s
    mgr.appendChunk(m.id, 'mic', 'webm', new Uint8Array([1]))
    // crash: new manager over the same db/fs, row still 'recording'
    clock = new Date(T0.getTime() + 600_000)
    const fresh = mkManager()
    fresh.recoverOrphans()

    const recovered = meetings.getMeeting(db, m.id)!
    expect(recovered.status).toBe('ready')
    expect(recovered.duration_seconds).toBe(5) // from pcm bytes, not wall clock
    expect(recovered.mic_path).toBe(`/rec/${m.id}/mic.webm`)
  })

  it('rejects traversal-shaped ids before any filesystem access', () => {
    const mgr = mkManager()
    const rmDir = vi.spyOn(fs, 'rmDir')
    expect(() => mgr.delete('../../../Users/someone/Documents')).toThrow(/invalid meeting id/)
    expect(() => mgr.delete('..')).toThrow(/invalid meeting id/)
    expect(rmDir).not.toHaveBeenCalled()
  })

  it('rejects unknown channels and kinds on appendChunk', () => {
    const mgr = mkManager()
    const m = mgr.start()
    expect(() =>
      mgr.appendChunk(m.id, '../../evil' as never, 'webm', new Uint8Array([1]))
    ).toThrow(/invalid channel/)
    expect(() => mgr.appendChunk(m.id, 'mic', '../x' as never, new Uint8Array([1]))).toThrow(
      /invalid chunk kind/
    )
    expect(fs.size(`/rec/${m.id}/../../evil.webm`)).toBeNull()
  })

  it('recoverOrphans keeps WAV-only audio (early crash, no webm yet)', () => {
    const mgr = mkManager()
    const m = mgr.start()
    mgr.appendChunk(m.id, 'mic', 'pcm', new Uint8Array(PCM_SAMPLE_RATE * 2 * 2)) // 2s PCM, no webm
    mkManager().recoverOrphans()
    const recovered = meetings.getMeeting(db, m.id)!
    expect(recovered.status).toBe('ready')
    expect(recovered.duration_seconds).toBe(2)
    expect(recovered.mic_path).toBeNull() // no playback archive, but transcribable
  })

  it('recoverOrphans marks fileless recordings as error', () => {
    const m = meetings.createMeeting(db, {}, T0) // row exists, nothing on disk
    mkManager().recoverOrphans()
    const recovered = meetings.getMeeting(db, m.id)!
    expect(recovered.status).toBe('error')
    expect(recovered.error).toMatch(/interrupted/)
  })

  it('delete removes the directory and the row, even mid-recording', () => {
    const mgr = mkManager()
    const m = mgr.start()
    mgr.appendChunk(m.id, 'mic', 'webm', new Uint8Array([1]))
    mgr.delete(m.id)
    expect(meetings.getMeeting(db, m.id)).toBeUndefined()
    expect(fs.size(`/rec/${m.id}/mic.webm`)).toBeNull()
    expect(mgr.activeMeetingId).toBeNull()
  })

  it('shutdown finalizes a live recording', () => {
    const mgr = mkManager()
    const m = mgr.start()
    clock = new Date(T0.getTime() + 10_000)
    mgr.shutdown()
    expect(meetings.getMeeting(db, m.id)!.status).toBe('ready')
  })
})

describe('resolveDisplayMedia', () => {
  const sources = async (): Promise<string[]> => ['screen-1', 'screen-2']

  it('audio-only requests resolve to pure loopback', async () => {
    await expect(
      resolveDisplayMedia({ videoRequested: false, audioRequested: true }, sources)
    ).resolves.toEqual({ audio: 'loopback' })
  })

  it('video requests get the primary screen plus loopback', async () => {
    await expect(
      resolveDisplayMedia({ videoRequested: true, audioRequested: true }, sources)
    ).resolves.toEqual({ video: 'screen-1', audio: 'loopback' })
  })

  it('video without audio omits loopback', async () => {
    await expect(
      resolveDisplayMedia({ videoRequested: true, audioRequested: false }, sources)
    ).resolves.toEqual({ video: 'screen-1' })
  })

  it('no screens available denies the request', async () => {
    await expect(
      resolveDisplayMedia({ videoRequested: true, audioRequested: true }, async () => [])
    ).resolves.toEqual({})
  })
})

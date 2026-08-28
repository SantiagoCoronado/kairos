import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { join } from 'node:path'
import type { DbDriver } from '../core/driver'
import { openNodeSqliteDb } from '../core/drivers/node-sqlite'
import { migrate } from '../core/migrations'
import * as meetings from '../core/repo/meetings'
import { MeetingProcessor, type ProcessorFs, type Transcriber } from './meeting-processor'
import type { MeetingEvent } from '../shared/ipc-contract'
import { WhisperCrashError, type WhisperResult } from './whisper'

const T0 = new Date('2026-07-28T12:00:00Z')
const REC = '/rec'

function fakeFs(): ProcessorFs & { files: Map<string, number> } {
  const files = new Map<string, number>()
  return {
    files,
    size: (p) => files.get(p) ?? null,
    rm: (p) => void files.delete(p)
  }
}

let db: DbDriver
let fs: ReturnType<typeof fakeFs>
let events: MeetingEvent[]
let notifications: string[]
let transcribed: string[]
let result: (path: string) => WhisperResult
let failFor: string | null
/** wav paths containing this crash the (fake) sidecar */
let crashFor: string | null

function mkProcessor(now = (): Date => T0): MeetingProcessor {
  const transcriber: Transcriber = {
    modelName: 'base',
    transcribe: async (wavPath) => {
      if (failFor && wavPath.includes(failFor)) throw new Error('model exploded')
      if (crashFor && wavPath.includes(crashFor)) throw new WhisperCrashError(wavPath)
      transcribed.push(wavPath)
      return result(wavPath)
    }
  }
  return new MeetingProcessor(db, REC, {
    getTranscriber: async () => transcriber,
    fs,
    onEvent: (ev) => void events.push(ev),
    onChange: () => {},
    notify: (title) => void notifications.push(title),
    log: () => {},
    now
  })
}

/** a stopped meeting with both wavs + webms on disk */
function seedMeeting(opts: { system?: boolean } = { system: true }): string {
  const m = meetings.createMeeting(db, { title: 'sync' }, T0)
  meetings.updateMeeting(
    db,
    m.id,
    {
      status: 'ready',
      ended_at: T0.toISOString(),
      duration_seconds: 10,
      mic_path: join(REC, m.id, 'mic.webm'),
      system_path: opts.system ? join(REC, m.id, 'system.webm') : null
    },
    T0
  )
  fs.files.set(join(REC, m.id, 'mic.wav'), 320044)
  fs.files.set(join(REC, m.id, 'mic.webm'), 9000)
  if (opts.system) {
    fs.files.set(join(REC, m.id, 'system.wav'), 320044)
    fs.files.set(join(REC, m.id, 'system.webm'), 9000)
  }
  return m.id
}

beforeEach(() => {
  db = openNodeSqliteDb(':memory:')
  migrate(db)
  fs = fakeFs()
  events = []
  notifications = []
  transcribed = []
  failFor = null
  crashFor = null
  result = (path) => ({
    text: 'x',
    language: 'en',
    segments: path.includes('mic')
      ? [{ t0: 0, t1: 2, text: 'hello from me' }]
      : [{ t0: 2.5, t1: 4, text: 'hello from them' }]
  })
})

afterEach(() => db.close())

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('MeetingProcessor', () => {
  it('transcribes both channels, merges, persists, deletes WAVs, notifies', async () => {
    const id = seedMeeting()
    const p = mkProcessor()
    p.enqueue(id)
    expect(meetings.getMeeting(db, id)!.status).toBe('processing')
    await flush()

    const m = meetings.getMeeting(db, id)!
    expect(m.status).toBe('ready')
    const tr = meetings.getTranscript(db, id)!
    expect(tr.model).toBe('base')
    expect(tr.language).toBe('en')
    expect(tr.segments.map((s) => `${s.channel}:${s.text}`)).toEqual([
      'me:hello from me',
      'them:hello from them'
    ])
    expect(tr.text).toBe('Me: hello from me\nThem: hello from them')
    // WAVs gone, webm archives stay
    expect(fs.size(join(REC, id, 'mic.wav'))).toBeNull()
    expect(fs.size(join(REC, id, 'mic.webm'))).toBe(9000)
    expect(events.map((e) => e.kind)).toEqual(['processing', 'transcribed'])
    expect(notifications).toEqual(['Meeting transcribed'])
  })

  it('handles mic-only meetings (no system channel captured)', async () => {
    const id = seedMeeting({ system: false })
    const p = mkProcessor()
    p.enqueue(id)
    await flush()
    const tr = meetings.getTranscript(db, id)!
    expect(tr.segments).toHaveLength(1)
    expect(tr.segments[0].channel).toBe('me')
    expect(transcribed).toHaveLength(1) // system wav never sent
  })

  it('marks failures as error and keeps draining the queue', async () => {
    const bad = seedMeeting()
    const good = seedMeeting()
    failFor = bad // only the first meeting's wavs explode
    const p = mkProcessor()
    p.enqueue(bad)
    p.enqueue(good)
    await flush()
    await flush()

    expect(meetings.getMeeting(db, bad)!.status).toBe('error')
    expect(meetings.getMeeting(db, bad)!.error).toMatch(/model exploded/)
    expect(meetings.getMeeting(db, good)!.status).toBe('ready')
    expect(events.some((e) => e.kind === 'transcribe-error')).toBe(true)
    // WAVs kept on failure so a retry (sweep) can still transcribe
    expect(fs.size(join(REC, bad, 'mic.wav'))).not.toBeNull()
  })

  it('a sidecar crash on one channel is silence, not a failed meeting', async () => {
    const id = seedMeeting()
    crashFor = 'system.wav' // nobody spoke on the far side → whisper-server aborts
    mkProcessor().enqueue(id)
    await flush()
    await flush()

    const m = meetings.getMeeting(db, id)!
    expect(m.status).toBe('ready')
    expect(m.error).toBeNull()
    const t = meetings.getTranscript(db, id)!
    expect(t.segments.map((s) => s.channel)).toEqual(['me'])
    expect(t.language).toBe('en')
    // both WAVs are consumed — a retry would only crash the same way again
    expect(fs.size(join(REC, id, 'system.wav'))).toBeNull()
    expect(fs.size(join(REC, id, 'mic.wav'))).toBeNull()
  })

  it('every channel crashing still fails loudly — a dead sidecar must not read as an empty meeting', async () => {
    const id = seedMeeting()
    crashFor = id
    mkProcessor().enqueue(id)
    await flush()
    await flush()

    const m = meetings.getMeeting(db, id)!
    expect(m.status).toBe('error')
    expect(m.error).toMatch(/no speech detected/)
    expect(meetings.getTranscript(db, id)).toBeUndefined()
    expect(fs.size(join(REC, id, 'mic.wav'))).not.toBeNull()
  })

  it('retry re-queues an error’d meeting while its WAVs exist and refuses once they are gone', async () => {
    const id = seedMeeting()
    failFor = id
    const p = mkProcessor()
    p.enqueue(id)
    await flush()
    await flush()
    expect(meetings.getMeeting(db, id)!.status).toBe('error')

    failFor = null
    p.retry(id)
    await flush()
    await flush()
    expect(meetings.getMeeting(db, id)!.status).toBe('ready')
    expect(meetings.getTranscript(db, id)!.segments).toHaveLength(2)

    // WAVs were consumed by the successful pass — nothing left to retry
    expect(() => p.retry(id)).toThrow(/gone/)
    meetings.markAudioDeleted(db, id, T0)
    expect(() => p.retry(id)).toThrow(/retention/)
    expect(() => p.retry('nope')).toThrow(/not found/)
  })

  it('sweepIncomplete re-enqueues stuck and never-transcribed meetings', async () => {
    const stuck = seedMeeting()
    meetings.updateMeeting(db, stuck, { status: 'processing' })
    const untranscribed = seedMeeting()
    const done = seedMeeting()
    meetings.setTranscript(db, done, { segments: [{ t0: 0, t1: 1, channel: 'me', text: 'x' }] })

    const p = mkProcessor()
    p.sweepIncomplete()
    await flush()

    expect(meetings.getTranscript(db, stuck)).toBeDefined()
    expect(meetings.getTranscript(db, untranscribed)).toBeDefined()
    // the already-transcribed meeting was not re-processed
    expect(transcribed.filter((w) => w.includes(done))).toHaveLength(0)
  })

  it('pruneAudio deletes old audio, keeps transcripts, honors retention', async () => {
    const old = seedMeeting()
    meetings.setTranscript(db, old, { segments: [{ t0: 0, t1: 1, channel: 'me', text: 'x' }] })
    const recent = seedMeeting()
    meetings.setTranscript(db, recent, { segments: [] })
    meetings.updateMeeting(db, recent, { ended_at: T0.toISOString() })
    // "old" ended 10 days ago, retention 7d
    meetings.updateMeeting(db, old, {
      ended_at: new Date(T0.getTime() - 10 * 24 * 60 * 60_000).toISOString()
    })

    const p = mkProcessor()
    p.pruneAudio(7)

    const prunedRow = meetings.getMeeting(db, old)!
    expect(prunedRow.audio_deleted_at).toBe(T0.toISOString())
    expect(fs.size(join(REC, old, 'mic.webm'))).toBeNull()
    expect(meetings.getTranscript(db, old)!.segments).toHaveLength(1)
    expect(meetings.getMeeting(db, recent)!.audio_deleted_at).toBeNull()
    expect(fs.size(join(REC, recent, 'mic.webm'))).toBe(9000)

    p.pruneAudio(null) // retention off — never deletes
    expect(meetings.getMeeting(db, recent)!.audio_deleted_at).toBeNull()
  })

  it('enqueue is idempotent per meeting', async () => {
    const id = seedMeeting()
    const p = mkProcessor()
    const spy = vi.fn(result)
    result = spy
    p.enqueue(id)
    p.enqueue(id)
    await flush()
    expect(spy.mock.calls.length).toBe(2) // exactly one job: mic + system
    expect(meetings.getTranscript(db, id)!.segments.length).toBeGreaterThan(0)
  })

  it('a re-enqueue while the job is in flight cannot wipe the transcript', async () => {
    const id = seedMeeting()
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const transcriber: Transcriber = {
      modelName: 'base',
      transcribe: async (wavPath) => {
        await gate // hold the job in flight
        transcribed.push(wavPath)
        return result(wavPath)
      }
    }
    const p = new MeetingProcessor(db, REC, {
      getTranscriber: async () => transcriber,
      fs,
      onEvent: (ev) => void events.push(ev),
      onChange: () => {},
      notify: () => {},
      log: () => {},
      now: () => T0
    })

    p.enqueue(id)
    await flush() // job shifted out of the queue, awaiting the gate
    p.enqueue(id) // the in-flight dedup must reject this
    release()
    await flush()
    await flush()

    const tr = meetings.getTranscript(db, id)!
    expect(tr.segments.length).toBeGreaterThan(0) // not wiped by a second pass
    expect(transcribed).toHaveLength(2) // one job's two channels, no re-run
    expect(events.filter((e) => e.kind === 'transcribed')).toHaveLength(1)
  })

  it('pruneAudio also ages out error’d meetings', () => {
    const failed = seedMeeting()
    meetings.updateMeeting(db, failed, {
      status: 'error',
      error: 'boom',
      ended_at: new Date(T0.getTime() - 10 * 24 * 60 * 60_000).toISOString()
    })
    mkProcessor().pruneAudio(7)
    expect(meetings.getMeeting(db, failed)!.audio_deleted_at).toBe(T0.toISOString())
    expect(fs.size(join(REC, failed, 'mic.webm'))).toBeNull()
  })
})

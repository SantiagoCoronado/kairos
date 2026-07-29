import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('./src/lib/api', () => ({
  api: { invoke: vi.fn(), on: vi.fn(() => () => {}), pathForFile: vi.fn() }
}))

import {
  configureMeetingStore,
  startRecording,
  stopRecording,
  dismissError,
  recoverActiveRecording,
  getSnapshot,
  subscribe,
  type CaptureMedia,
  type StreamLike,
  type TrackLike,
  type RecorderLike,
  type TapLike
} from './src/lib/meeting-store'
import type { Meeting } from '../core/types'

const MEETING: Meeting = {
  id: 'm1',
  calendar_event_id: null,
  title: 'standup',
  status: 'recording',
  error: null,
  started_at: '2026-07-28T12:00:00.000Z',
  ended_at: null,
  duration_seconds: null,
  mic_path: null,
  system_path: null,
  audio_deleted_at: null,
  summary_md: null,
  summary: { action_items: [], decisions: [], participants: [] },
  summary_model: null,
  summarized_at: null,
  created_at: '2026-07-28T12:00:00.000Z',
  updated_at: '2026-07-28T12:00:00.000Z'
}

interface FakeTrack extends TrackLike {
  stopped: boolean
}

function makeStream(kinds: string[]): StreamLike & { tracks: FakeTrack[] } {
  const tracks: FakeTrack[] = kinds.map((kind) => {
    const t: FakeTrack = { kind, stopped: false, stop: () => void (t.stopped = true) }
    return t
  })
  return {
    tracks,
    getTracks: () => tracks,
    getAudioTracks: () => tracks.filter((t) => t.kind === 'audio'),
    getVideoTracks: () => tracks.filter((t) => t.kind === 'video')
  }
}

interface FakeRig {
  micStream: ReturnType<typeof makeStream>
  systemStream: ReturnType<typeof makeStream>
  recorders: { stream: StreamLike; onChunk: (b: Uint8Array) => void; started: boolean; stopped: boolean }[]
  taps: { stream: StreamLike; onFrames: (f: Float32Array) => void; stopped: boolean }[]
  media: CaptureMedia
  failSystem?: Error
  failTapOn?: StreamLike
}

function makeFakeMedia(): FakeRig {
  const rig: FakeRig = {
    micStream: makeStream(['audio']),
    systemStream: makeStream(['audio', 'video']),
    recorders: [],
    taps: [],
    media: {
      getMicStream: async () => rig.micStream,
      getSystemStream: async () => {
        if (rig.failSystem) throw rig.failSystem
        return rig.systemStream
      },
      makeRecorder: (stream, onChunk): RecorderLike => {
        const rec = { stream, onChunk, started: false, stopped: false }
        rig.recorders.push(rec)
        return {
          start: () => void (rec.started = true),
          stop: async () => void (rec.stopped = true)
        }
      },
      makeTap: async (stream, onFrames): Promise<TapLike> => {
        if (rig.failTapOn === stream) throw new Error('worklet module failed')
        const tap = { stream, onFrames, stopped: false }
        rig.taps.push(tap)
        return { stop: () => void (tap.stopped = true) }
      }
    }
  }
  return rig
}

let rig: FakeRig
let invoke: ReturnType<typeof vi.fn>

function invokeCalls(channel: string): unknown[][] {
  return invoke.mock.calls.filter((c) => c[0] === channel).map((c) => c.slice(1))
}

beforeEach(() => {
  rig = makeFakeMedia()
  invoke = vi.fn(async (channel: string, ..._args: unknown[]) => {
    if (channel === 'meetings:start') return { ...MEETING }
    if (channel === 'meetings:stop') return { ...MEETING, status: 'ready' }
    if (channel === 'meetings:active') return null
    return undefined
  })
  configureMeetingStore({ media: rig.media, invoke: invoke as never })
})

afterEach(async () => {
  // drive back to idle so module-level state never leaks across tests
  if (getSnapshot().phase === 'recording') await stopRecording()
  dismissError()
  configureMeetingStore(null)
  expect(getSnapshot().phase).toBe('idle')
})

describe('startRecording', () => {
  it('starts the meeting, opens both channels, kills the video track', async () => {
    const notified = vi.fn()
    const unsub = subscribe(notified)
    const before = getSnapshot()

    const m = await startRecording({ title: 'standup' })

    expect(m?.id).toBe('m1')
    expect(invokeCalls('meetings:start')).toEqual([
      [{ calendar_event_id: null, title: 'standup' }]
    ])
    const snap = getSnapshot()
    expect(snap.phase).toBe('recording')
    expect(snap).not.toBe(before) // new snapshot identity for useSyncExternalStore
    expect(notified).toHaveBeenCalled()
    // getDisplayMedia's mandatory video track is stopped immediately
    expect(rig.systemStream.tracks.find((t) => t.kind === 'video')!.stopped).toBe(true)
    expect(rig.systemStream.tracks.find((t) => t.kind === 'audio')!.stopped).toBe(false)
    expect(rig.recorders).toHaveLength(2)
    expect(rig.recorders.every((r) => r.started)).toBe(true)
    expect(rig.taps).toHaveLength(2)
    unsub()
  })

  it('is a no-op while already recording', async () => {
    await startRecording()
    expect(await startRecording()).toBeNull()
    expect(invokeCalls('meetings:start')).toHaveLength(1)
  })

  it('rolls back on system-capture failure: releases the full mic rig, deletes the row', async () => {
    rig.failSystem = new Error('loopback denied')

    const m = await startRecording()

    expect(m).toBeNull()
    const snap = getSnapshot()
    expect(snap.phase).toBe('error')
    if (snap.phase === 'error') expect(snap.message).toMatch(/loopback denied/)
    expect(rig.micStream.tracks.every((t) => t.stopped)).toBe(true)
    // tracks alone aren't enough — the tap's AudioContext and the recorder
    // leak unless explicitly stopped
    expect(rig.taps.every((t) => t.stopped)).toBe(true)
    expect(rig.recorders.every((r) => r.stopped)).toBe(true)
    expect(invokeCalls('meetings:delete')).toEqual([['m1']])
    expect(invokeCalls('meetings:stop')).toHaveLength(0)
  })

  it('releases a stream acquired inside a failing openRig (worklet-CSP shape)', async () => {
    rig.failTapOn = rig.systemStream // mic opens fine; system tap explodes

    const m = await startRecording()

    expect(m).toBeNull()
    expect(rig.systemStream.tracks.every((t) => t.stopped)).toBe(true)
    expect(rig.micStream.tracks.every((t) => t.stopped)).toBe(true)
    expect(rig.taps.every((t) => t.stopped)).toBe(true)
    expect(invokeCalls('meetings:delete')).toEqual([['m1']])
  })
})

describe('chunk forwarding', () => {
  it('webm chunks go out tagged with meeting, channel and kind', async () => {
    await startRecording()
    const micRec = rig.recorders.find((r) => r.stream === rig.micStream)!
    micRec.onChunk(new Uint8Array([1, 2, 3]))

    const calls = invokeCalls('meetings:chunk')
    expect(calls).toHaveLength(1)
    const [id, channel, kind, b64] = calls[0] as [string, string, string, string]
    expect([id, channel, kind]).toEqual(['m1', 'mic', 'webm'])
    expect(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))).toEqual(new Uint8Array([1, 2, 3]))
  })

  it('PCM frames buffer to ~1s then flush as int16 bytes', async () => {
    await startRecording()
    const micTap = rig.taps.find((t) => t.stream === rig.micStream)!

    micTap.onFrames(new Float32Array(8000).fill(0.5)) // below threshold — buffered
    expect(invokeCalls('meetings:chunk')).toHaveLength(0)

    micTap.onFrames(new Float32Array(8000).fill(0.5)) // hits 16000 — flush
    const calls = invokeCalls('meetings:chunk')
    expect(calls).toHaveLength(1)
    const [, channel, kind, b64] = calls[0] as [string, string, string, string]
    expect([channel, kind]).toEqual(['mic', 'pcm'])
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
    expect(bytes.length).toBe(16000 * 2) // int16
    const samples = new Int16Array(bytes.buffer)
    expect(samples[0]).toBe(Math.round(0.5 * 0x7fff))
  })
})

describe('stopRecording', () => {
  it('stops taps/recorders/tracks, flushes tail PCM, finalizes via IPC', async () => {
    await startRecording()
    const micTap = rig.taps.find((t) => t.stream === rig.micStream)!
    micTap.onFrames(new Float32Array(100).fill(0.25)) // sub-threshold tail

    const m = await stopRecording()

    expect(m?.status).toBe('ready')
    expect(getSnapshot().phase).toBe('idle')
    expect(rig.taps.every((t) => t.stopped)).toBe(true)
    expect(rig.recorders.every((r) => r.stopped)).toBe(true)
    expect(rig.micStream.tracks.every((t) => t.stopped)).toBe(true)
    expect(rig.systemStream.tracks.every((t) => t.stopped)).toBe(true)
    // the 100-sample tail went out before meetings:stop
    const pcm = invokeCalls('meetings:chunk').filter((c) => c[2] === 'pcm')
    expect(pcm).toHaveLength(1)
    const stopIdx = invoke.mock.calls.findIndex((c) => c[0] === 'meetings:stop')
    const chunkIdx = invoke.mock.calls.findIndex((c) => c[0] === 'meetings:chunk')
    expect(chunkIdx).toBeLessThan(stopIdx)
    expect(invokeCalls('meetings:stop')).toEqual([['m1']])
  })

  it('is a no-op when idle', async () => {
    expect(await stopRecording()).toBeNull()
    expect(invokeCalls('meetings:stop')).toHaveLength(0)
  })
})

describe('recoverActiveRecording', () => {
  it('finalizes an orphaned live meeting after window reload', async () => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'meetings:active') return 'orphan-1'
      if (channel === 'meetings:stop') return { ...MEETING, id: 'orphan-1', status: 'ready' }
      return undefined
    })
    await recoverActiveRecording()
    expect(invokeCalls('meetings:stop')).toEqual([['orphan-1']])
  })

  it('does nothing when no meeting is live', async () => {
    await recoverActiveRecording()
    expect(invokeCalls('meetings:stop')).toHaveLength(0)
  })
})

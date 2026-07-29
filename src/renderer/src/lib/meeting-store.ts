/** Meeting recording — renderer half of capture. Two channels, never
 *  mixed: mic (getUserMedia, AEC on) and system audio (getDisplayMedia
 *  loopback; the mandatory video track is stopped immediately). Each
 *  channel runs a MediaRecorder (webm playback archive) plus a 16 kHz PCM
 *  tap (transcription input); both stream to main over meetings:chunk.
 *  Module-level store à la toast.ts/undo.ts, subscribed via
 *  useSyncExternalStore. Media + invoke are injectable so the whole
 *  lifecycle is testable headless. */

import { useSyncExternalStore } from 'react'
import { api } from './api'
import { floatTo16BitPcm } from '../../../core/audio'
import type { Meeting } from '../../../core/types'

export type MeetingChannel = 'mic' | 'system'

export type MeetingRecState =
  | { phase: 'idle' }
  | { phase: 'starting' }
  | { phase: 'recording'; meetingId: string; title: string; startedAtMs: number }
  | { phase: 'stopping'; meetingId: string }
  | { phase: 'error'; message: string }

/** ~1s of 16k mono — the PCM flush threshold */
const PCM_FLUSH_SAMPLES = 16000
const WEBM_TIMESLICE_MS = 3000

// ---- injectable media layer -------------------------------------------------

export interface TrackLike {
  kind: string
  stop(): void
}

export interface StreamLike {
  getTracks(): TrackLike[]
  getAudioTracks(): TrackLike[]
  getVideoTracks(): TrackLike[]
}

export interface RecorderLike {
  start(timesliceMs: number): void
  /** resolves after the final chunk was delivered */
  stop(): Promise<void>
}

export interface TapLike {
  stop(): void
}

export interface CaptureMedia {
  getMicStream(): Promise<StreamLike>
  getSystemStream(): Promise<StreamLike>
  makeRecorder(stream: StreamLike, onChunk: (bytes: Uint8Array) => void): RecorderLike
  /** 16 kHz mono Float32 frames from the stream */
  makeTap(stream: StreamLike, onFrames: (frames: Float32Array) => void): Promise<TapLike>
}

type Invoke = typeof api.invoke

interface Deps {
  media: CaptureMedia
  invoke: Invoke
}

let deps: Deps | null = null

/** test seam — production resolves lazily to the real implementations */
export function configureMeetingStore(next: Partial<Deps> | null): void {
  deps = next ? { media: next.media ?? realMedia, invoke: next.invoke ?? api.invoke } : null
}

function getDeps(): Deps {
  if (!deps) deps = { media: realMedia, invoke: api.invoke }
  return deps
}

// ---- store ------------------------------------------------------------------

let state: MeetingRecState = { phase: 'idle' }
const listeners = new Set<() => void>()

function setState(next: MeetingRecState): void {
  state = next
  for (const cb of listeners) cb()
}

export function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function getSnapshot(): MeetingRecState {
  return state
}

export function useMeetingRecording(): MeetingRecState {
  return useSyncExternalStore(subscribe, getSnapshot)
}

interface ChannelRig {
  stream: StreamLike
  recorder: RecorderLike
  tap: TapLike
  pcmPending: Int16Array[]
  pcmPendingSamples: number
}

let rigs: Partial<Record<MeetingChannel, ChannelRig>> = {}
let sends: Promise<unknown>[] = []

function track(p: Promise<unknown>): void {
  sends.push(p.catch(() => {}))
}

function sendChunk(
  invoke: Invoke,
  meetingId: string,
  channel: MeetingChannel,
  kind: 'webm' | 'pcm',
  bytes: Uint8Array
): void {
  if (bytes.length === 0) return
  track(invoke('meetings:chunk', meetingId, channel, kind, bytesToBase64(bytes)))
}

function flushPcm(invoke: Invoke, meetingId: string, channel: MeetingChannel): void {
  const rig = rigs[channel]
  if (!rig || rig.pcmPendingSamples === 0) return
  const merged = new Int16Array(rig.pcmPendingSamples)
  let off = 0
  for (const part of rig.pcmPending) {
    merged.set(part, off)
    off += part.length
  }
  rig.pcmPending = []
  rig.pcmPendingSamples = 0
  sendChunk(invoke, meetingId, channel, 'pcm', new Uint8Array(merged.buffer))
}

function stopTracks(stream: StreamLike): void {
  for (const t of stream.getTracks()) t.stop()
}

async function openRig(
  media: CaptureMedia,
  invoke: Invoke,
  meetingId: string,
  channel: MeetingChannel
): Promise<ChannelRig> {
  const stream = channel === 'mic' ? await media.getMicStream() : await media.getSystemStream()
  // Chromium refuses video:false on getDisplayMedia — take the track, kill it
  if (channel === 'system') for (const t of stream.getVideoTracks()) t.stop()
  const recorder = media.makeRecorder(stream, (bytes) =>
    sendChunk(invoke, meetingId, channel, 'webm', bytes)
  )
  const rig: ChannelRig = { stream, recorder, tap: { stop: () => {} }, pcmPending: [], pcmPendingSamples: 0 }
  rig.tap = await media.makeTap(stream, (frames) => {
    rig.pcmPending.push(floatTo16BitPcm(frames))
    rig.pcmPendingSamples += frames.length
    if (rig.pcmPendingSamples >= PCM_FLUSH_SAMPLES) flushPcm(invoke, meetingId, channel)
  })
  recorder.start(WEBM_TIMESLICE_MS)
  return rig
}

export async function startRecording(opts: {
  calendarEventId?: string | null
  title?: string
} = {}): Promise<Meeting | null> {
  if (state.phase === 'recording' || state.phase === 'starting') return null
  const { media, invoke } = getDeps()
  setState({ phase: 'starting' })

  let meeting: Meeting
  try {
    meeting = await invoke('meetings:start', {
      calendar_event_id: opts.calendarEventId ?? null,
      title: opts.title ?? ''
    })
  } catch (err) {
    setState({ phase: 'error', message: err instanceof Error ? err.message : String(err) })
    return null
  }

  try {
    // sequential, assigning as we go — a system-capture failure must still
    // see (and release) the already-open mic rig
    rigs = {}
    rigs.mic = await openRig(media, invoke, meeting.id, 'mic')
    rigs.system = await openRig(media, invoke, meeting.id, 'system')
  } catch (err) {
    // half-open capture: release anything acquired, drop the started row
    for (const rig of Object.values(rigs)) if (rig) stopTracks(rig.stream)
    rigs = {}
    track(invoke('meetings:delete', meeting.id))
    setState({
      phase: 'error',
      message: `Couldn't start capture: ${err instanceof Error ? err.message : String(err)}`
    })
    return null
  }

  setState({
    phase: 'recording',
    meetingId: meeting.id,
    title: meeting.title,
    startedAtMs: Date.now()
  })
  return meeting
}

export async function stopRecording(): Promise<Meeting | null> {
  if (state.phase !== 'recording') return null
  const { invoke } = getDeps()
  const meetingId = state.meetingId
  setState({ phase: 'stopping', meetingId })

  for (const [channel, rig] of Object.entries(rigs) as [MeetingChannel, ChannelRig][]) {
    rig.tap.stop()
    await rig.recorder.stop() // final webm chunk delivered before we move on
    flushPcm(invoke, meetingId, channel)
    stopTracks(rig.stream)
  }
  rigs = {}
  await Promise.all(sends)
  sends = []

  try {
    const meeting = await invoke('meetings:stop', meetingId)
    setState({ phase: 'idle' })
    return meeting
  } catch (err) {
    setState({ phase: 'error', message: err instanceof Error ? err.message : String(err) })
    return null
  }
}

export function dismissError(): void {
  if (state.phase === 'error') setState({ phase: 'idle' })
}

/** window (re)load: a live row without live streams is unfinishable — the
 *  renderer's MediaRecorders died with the old page. Finalize what landed. */
export async function recoverActiveRecording(): Promise<void> {
  const { invoke } = getDeps()
  try {
    const activeId = await invoke('meetings:active')
    if (activeId && state.phase === 'idle') await invoke('meetings:stop', activeId)
  } catch {
    // recovery is best-effort; the main-process orphan sweep also covers this
  }
}

// ---- real media implementation ---------------------------------------------

/** static worklet asset (public/pcm-tap.worklet.js) — the renderer CSP
 *  blocks blob:-URL modules, and a relative URL works under the dev
 *  server, packaged file://, and remote http alike */
const TAP_WORKLET_URL = 'pcm-tap.worklet.js'

const realMedia: CaptureMedia = {
  getMicStream: () =>
    navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    }),
  // video must be requested (spec) — openRig stops the track on arrival
  getSystemStream: () => navigator.mediaDevices.getDisplayMedia({ audio: true, video: true }),

  makeRecorder: (stream, onChunk) => {
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : undefined
    const rec = new MediaRecorder(stream as MediaStream, mimeType ? { mimeType } : undefined)
    rec.ondataavailable = (e): void => {
      if (e.data.size > 0)
        void e.data.arrayBuffer().then((buf) => onChunk(new Uint8Array(buf)))
    }
    return {
      start: (timesliceMs) => rec.start(timesliceMs),
      stop: () =>
        new Promise<void>((resolve) => {
          // ondataavailable for the tail fires before onstop
          rec.onstop = (): void => resolve()
          if (rec.state === 'inactive') resolve()
          else rec.stop()
        })
    }
  },

  makeTap: async (stream, onFrames) => {
    const ctx = new AudioContext({ sampleRate: 16000 })
    await ctx.audioWorklet.addModule(TAP_WORKLET_URL)
    const source = ctx.createMediaStreamSource(stream as MediaStream)
    const tap = new AudioWorkletNode(ctx, 'kairos-pcm-tap', {
      numberOfInputs: 1,
      numberOfOutputs: 0
    })
    tap.port.onmessage = (e): void => onFrames(e.data as Float32Array)
    source.connect(tap)
    return {
      stop: () => {
        tap.port.onmessage = null
        source.disconnect()
        void ctx.close()
      }
    }
  }
}

// ---- helpers ----------------------------------------------------------------

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const CHUNK = 0x8000 // String.fromCharCode arg-count limit safety
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

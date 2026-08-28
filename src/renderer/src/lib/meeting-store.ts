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
import { noteFrames, resetLevels } from './meeting-levels'
import type { Meeting } from '../../../core/types'

export type MeetingChannel = 'mic' | 'system'

export type MeetingRecState =
  | { phase: 'idle' }
  | { phase: 'starting' }
  | {
      phase: 'recording'
      meetingId: string
      title: string
      startedAtMs: number
      /** paused time banked by earlier pause/resume pairs */
      pausedMs: number
      /** wall-clock start of the current pause, null while capturing */
      pausedAtMs: number | null
    }
  | { phase: 'stopping'; meetingId: string }
  | { phase: 'error'; message: string }

/** ~1s of 16k mono — the PCM flush threshold */
const PCM_FLUSH_SAMPLES = 16000
const WEBM_TIMESLICE_MS = 3000
/** getDisplayMedia is answered synchronously by main's handler, so a
 *  pending request is a bug, not a prompt — bound it. Without this, a
 *  skipped callback once left the mic rig streaming with no indicator and
 *  no Stop for a whole meeting. */
export const SYSTEM_STREAM_TIMEOUT_MS = 15_000
/** getUserMedia legitimately waits on the macOS microphone prompt, so the
 *  bound is generous — but a wedged input device must not park the store
 *  in 'starting' for the rest of the session */
export const MIC_STREAM_TIMEOUT_MS = 60_000
/** macOS gates SCK loopback on the Screen Recording grant, which is pinned
 *  to the app's code signature — every ad-hoc rebuild invalidates it while
 *  System Settings keeps showing the stale row as ON (toggling never
 *  rewrites it). The one thing the user can actually fix, so name both the
 *  grant and the stale-row escape hatch. Must not contain the " — "
 *  separator splitCaptureError keys on. */
export const SYSTEM_AUDIO_HINT =
  'allow Kairos under System Settings → Privacy & Security → Screen & System Audio Recording, then relaunch.' +
  ' Already on? The grant is stale: run `tccutil reset ScreenCapture com.santiago.kairos`, relaunch, and allow again'
export const MIC_HINT =
  'answer the microphone prompt, or allow Kairos under System Settings → Privacy & Security → Microphone'

const CHANNEL_CAPTURE = {
  mic: { label: 'microphone', timeoutMs: MIC_STREAM_TIMEOUT_MS, hint: MIC_HINT },
  system: { label: 'system audio', timeoutMs: SYSTEM_STREAM_TIMEOUT_MS, hint: SYSTEM_AUDIO_HINT }
} as const

/** headline + actionable hint, kept separable so the UI can render the
 *  hint on its own line instead of burying it in a truncated one-liner */
export function splitCaptureError(message: string): { headline: string; hint: string | null } {
  // the hint is always the trailing segment (neither hint contains the
  // separator), so split on the last one — a detail carrying an em dash
  // must not leak raw error text into the guidance slot
  const at = message.lastIndexOf(' — ')
  if (at < 0) return { headline: message, hint: null }
  return { headline: message.slice(0, at), hint: message.slice(at + 3) }
}

/** thrown through the start pipeline when the user cancels a pending
 *  start — rolled back like any failure, but lands on 'idle', not 'error' */
const CANCELLED = new Error('recording start cancelled')

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
  /** hold the archive without closing it — MediaRecorder keeps its
   *  timeline contiguous across a pause, so playback skips the gap */
  pause(): void
  resume(): void
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
  /** frames arriving while paused are dropped so the WAV (and the
   *  transcript cut from it) stays aligned with the paused webm */
  paused: boolean
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

/** drains the rig it's handed, never a lookup — a rig that finished
 *  opening after a cancel lives outside `rigs`, and must not alias the
 *  current recording's buffer */
function flushPcm(invoke: Invoke, meetingId: string, channel: MeetingChannel, rig: ChannelRig): void {
  if (rig.pcmPendingSamples === 0) return
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

/** resolve a channel's stream or fail within its timeout; a stream that
 *  lands after the deadline is released, never leaked */
function acquireStream(media: CaptureMedia, channel: MeetingChannel): Promise<StreamLike> {
  const { label, timeoutMs, hint } = CHANNEL_CAPTURE[channel]
  return new Promise<StreamLike>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      settled = true
      reject(new Error(`${label} capture timed out — ${hint}`))
    }, timeoutMs)
    const pending = channel === 'mic' ? media.getMicStream() : media.getSystemStream()
    pending.then(
      (stream) => {
        if (settled) return stopTracks(stream)
        settled = true
        clearTimeout(timer)
        resolve(stream)
      },
      (err: unknown) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        const detail = err instanceof Error ? err.message : String(err)
        reject(new Error(`${label} capture failed (${detail}) — ${hint}`))
      }
    )
  })
}

function releaseRig(rig: ChannelRig): void {
  rig.tap.stop()
  void rig.recorder.stop().catch(() => {})
  stopTracks(rig.stream)
}

async function openRig(
  media: CaptureMedia,
  invoke: Invoke,
  meetingId: string,
  channel: MeetingChannel
): Promise<ChannelRig> {
  const stream = await acquireStream(media, channel)
  try {
    if (channel === 'system') {
      // Chromium refuses video:false on getDisplayMedia — take the track, kill it
      for (const t of stream.getVideoTracks()) t.stop()
      // a loopback grant that came back video-only would record silence
      // for the whole meeting — fail now, while the user can still act
      if (stream.getAudioTracks().length === 0)
        throw new Error(`system audio unavailable — ${SYSTEM_AUDIO_HINT}`)
    }
    const recorder = media.makeRecorder(stream, (bytes) =>
      sendChunk(invoke, meetingId, channel, 'webm', bytes)
    )
    const rig: ChannelRig = {
      stream,
      recorder,
      tap: { stop: () => {} },
      paused: false,
      pcmPending: [],
      pcmPendingSamples: 0
    }
    rig.tap = await media.makeTap(stream, (frames) => {
      if (rig.paused) return
      noteFrames(channel, frames)
      rig.pcmPending.push(floatTo16BitPcm(frames))
      rig.pcmPendingSamples += frames.length
      if (rig.pcmPendingSamples >= PCM_FLUSH_SAMPLES) flushPcm(invoke, meetingId, channel, rig)
    })
    recorder.start(WEBM_TIMESLICE_MS)
    return rig
  } catch (err) {
    // a stream acquired here but never returned would be invisible to the
    // caller's rollback — this is the exact shape of the worklet-CSP failure
    stopTracks(stream)
    throw err
  }
}

/** rejects when the user cancels the pending start; the capture APIs
 *  themselves can't be aborted, so a rig that finishes opening after the
 *  cancel is released on arrival instead */
let cancelPending: (() => void) | null = null

export function cancelStarting(): void {
  if (state.phase === 'starting') cancelPending?.()
}

async function openRigOrCancel(
  media: CaptureMedia,
  invoke: Invoke,
  meetingId: string,
  channel: MeetingChannel,
  cancelled: Promise<never>
): Promise<ChannelRig> {
  const opening = openRig(media, invoke, meetingId, channel)
  try {
    return await Promise.race([opening, cancelled])
  } catch (err) {
    if (err === CANCELLED) opening.then(releaseRig, () => {})
    throw err
  }
}

export async function startRecording(opts: {
  calendarEventId?: string | null
  title?: string
} = {}): Promise<Meeting | null> {
  if (state.phase === 'recording' || state.phase === 'starting') return null
  const { media, invoke } = getDeps()
  setState({ phase: 'starting' })
  let cancelRequested = false
  const cancelled = new Promise<never>((_, reject) => {
    cancelPending = (): void => {
      cancelRequested = true
      reject(CANCELLED)
    }
  })
  cancelled.catch(() => {}) // observed via race; never unhandled on its own

  let meeting: Meeting
  try {
    meeting = await invoke('meetings:start', {
      calendar_event_id: opts.calendarEventId ?? null,
      title: opts.title ?? ''
    })
  } catch (err) {
    cancelPending = null
    setState({ phase: 'error', message: err instanceof Error ? err.message : String(err) })
    return null
  }

  try {
    if (cancelRequested) throw CANCELLED
    // sequential, assigning as we go — a system-capture failure must still
    // see (and release) the already-open mic rig
    rigs = {}
    rigs.mic = await openRigOrCancel(media, invoke, meeting.id, 'mic', cancelled)
    rigs.system = await openRigOrCancel(media, invoke, meeting.id, 'system', cancelled)
  } catch (err) {
    cancelPending = null
    // half-open capture: release the whole rig (tap's AudioContext and
    // recorder included — tracks alone leak both), drop the started row
    for (const rig of Object.values(rigs)) if (rig) releaseRig(rig)
    rigs = {}
    resetLevels()
    sends = [] // in-flight chunk sends belong to the dead rig
    try {
      await invoke('meetings:delete', meeting.id)
    } catch (deleteErr) {
      // a row stuck in 'recording' gets swept by recoverOrphans on next
      // launch — log so a repeat offender is diagnosable
      void invoke(
        'log:renderer',
        'warn',
        `meetings: rollback delete failed for ${meeting.id}: ${String(deleteErr)}`
      ).catch(() => {})
    }
    if (err === CANCELLED) setState({ phase: 'idle' })
    else
      setState({
        phase: 'error',
        message: `Couldn't start capture: ${err instanceof Error ? err.message : String(err)}`
      })
    return null
  }

  cancelPending = null
  setState({
    phase: 'recording',
    meetingId: meeting.id,
    title: meeting.title,
    startedAtMs: Date.now(),
    pausedMs: 0,
    pausedAtMs: null
  })
  return meeting
}

/** main refused a live-state transition (pause/resume). Usually it no
 *  longer considers this meeting live (deleted from a list, finalized by
 *  an orphan sweep or shutdown) and every chunk from here on is refused
 *  too — but the rejection can also come from after the transition
 *  succeeded, with main still live. Either way: tear the rig down, say
 *  so, and send a best-effort stop — it finalizes the row (audio already
 *  on disk becomes reachable now, not at the next launch's orphan sweep)
 *  and clears main's activeId so the next recording can start; when main
 *  wasn't live it's a harmless refusal. */
async function abandonLive(meetingId: string, what: string, err: unknown): Promise<void> {
  if (state.phase !== 'recording' || state.meetingId !== meetingId) return
  const { invoke } = getDeps()
  for (const rig of Object.values(rigs)) if (rig) releaseRig(rig)
  rigs = {}
  resetLevels()
  sends = []
  const detail = err instanceof Error ? err.message : String(err)
  // say something immediately; the wording is corrected once the stop
  // settles — when it lands, the user has a complete, queued recording of
  // everything up to this moment, and "lost" would send them nowhere
  const provisional = `Recording lost — couldn't ${what}: ${detail}`
  setState({ phase: 'error', message: provisional })
  const saved = await invoke('meetings:stop', meetingId).catch(() => null)
  // re-read: `state` was narrowed to 'recording' above. Correct only OUR
  // banner — the user may have dismissed it, or a newer failure may own
  // the slot, while the stop was in flight
  const current = getSnapshot()
  if (saved && current.phase === 'error' && current.message === provisional)
    setState({
      phase: 'error',
      message: `Capture ended early — couldn't ${what}: ${detail}. The recording up to that point was saved.`
    })
}

/** hold both channels: recorders pause, tap frames drop, and whatever PCM
 *  is buffered lands on disk now (a crash mid-pause must not lose it).
 *  Main banks the paused time so the row's duration matches the archives.
 *  Resolves once main has acknowledged (or the recording was abandoned). */
export async function pauseRecording(): Promise<void> {
  if (state.phase !== 'recording' || state.pausedAtMs !== null) return
  const { invoke } = getDeps()
  const { meetingId } = state
  for (const [channel, rig] of Object.entries(rigs) as [MeetingChannel, ChannelRig][]) {
    rig.paused = true
    rig.recorder.pause()
    flushPcm(invoke, meetingId, channel, rig)
  }
  resetLevels()
  setState({ ...state, pausedAtMs: Date.now() })
  try {
    await invoke('meetings:pause', meetingId)
  } catch (err) {
    await abandonLive(meetingId, 'pause', err)
  }
}

export async function resumeRecording(): Promise<void> {
  if (state.phase !== 'recording' || state.pausedAtMs === null) return
  const { invoke } = getDeps()
  const { meetingId } = state
  for (const rig of Object.values(rigs) as ChannelRig[]) {
    rig.paused = false
    rig.recorder.resume()
  }
  setState({
    ...state,
    pausedMs: state.pausedMs + (Date.now() - state.pausedAtMs),
    pausedAtMs: null
  })
  try {
    await invoke('meetings:resume', meetingId)
  } catch (err) {
    await abandonLive(meetingId, 'resume', err)
  }
}

export async function stopRecording(): Promise<Meeting | null> {
  if (state.phase !== 'recording') return null
  const { invoke } = getDeps()
  const meetingId = state.meetingId
  setState({ phase: 'stopping', meetingId })

  for (const [channel, rig] of Object.entries(rigs) as [MeetingChannel, ChannelRig][]) {
    rig.tap.stop()
    await rig.recorder.stop() // final webm chunk delivered before we move on
    flushPcm(invoke, meetingId, channel, rig)
    stopTracks(rig.stream)
  }
  rigs = {}
  resetLevels()
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
    // blob → bytes is async: the tail chunk's ondataavailable fires before
    // onstop, but its arrayBuffer resolves after — stop() must wait for it
    // or the last timeslice lands after meetings:stop and is refused.
    // Settled reads leave the set, so a long meeting holds only in-flight ones.
    const reads = new Set<Promise<void>>()
    rec.ondataavailable = (e): void => {
      if (e.data.size === 0) return
      const read: Promise<void> = e.data
        .arrayBuffer()
        .then((buf) => onChunk(new Uint8Array(buf)))
        .catch(() => {})
        .finally(() => reads.delete(read))
      reads.add(read)
    }
    return {
      start: (timesliceMs) => rec.start(timesliceMs),
      pause: () => {
        if (rec.state === 'recording') rec.pause()
      },
      resume: () => {
        if (rec.state === 'paused') rec.resume()
      },
      stop: () =>
        new Promise<void>((resolve) => {
          // ondataavailable for the tail fires before onstop
          rec.onstop = (): void => resolve()
          if (rec.state === 'inactive') resolve()
          else rec.stop()
        }).then(() => Promise.all([...reads]).then(() => {}))
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

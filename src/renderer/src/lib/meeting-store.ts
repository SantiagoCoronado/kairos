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
/** getDisplayMedia is answered synchronously by main's handler, so a
 *  pending request is a bug, not a prompt — bound it. Without this, a
 *  skipped callback once left the mic rig streaming with no indicator and
 *  no Stop for a whole meeting. */
export const SYSTEM_STREAM_TIMEOUT_MS = 15_000
/** getUserMedia legitimately waits on the macOS microphone prompt, so the
 *  bound is generous — but a wedged input device must not park the store
 *  in 'starting' for the rest of the session */
export const MIC_STREAM_TIMEOUT_MS = 60_000
/** macOS gates SCK loopback on the Screen Recording grant, which every
 *  ad-hoc rebuild resets — the one thing the user can actually fix */
export const SYSTEM_AUDIO_HINT =
  'allow Kairos under System Settings → Privacy & Security → Screen & System Audio Recording, then relaunch'
export const MIC_HINT =
  'answer the microphone prompt, or allow Kairos under System Settings → Privacy & Security → Microphone'

const CHANNEL_CAPTURE = {
  mic: { label: 'microphone', timeoutMs: MIC_STREAM_TIMEOUT_MS, hint: MIC_HINT },
  system: { label: 'system audio', timeoutMs: SYSTEM_STREAM_TIMEOUT_MS, hint: SYSTEM_AUDIO_HINT }
} as const

/** headline + actionable hint, kept separable so the UI can render the
 *  hint on its own line instead of burying it in a truncated one-liner */
export function splitCaptureError(message: string): { headline: string; hint: string | null } {
  const at = message.indexOf(' — ')
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
    const rig: ChannelRig = { stream, recorder, tap: { stop: () => {} }, pcmPending: [], pcmPendingSamples: 0 }
    rig.tap = await media.makeTap(stream, (frames) => {
      rig.pcmPending.push(floatTo16BitPcm(frames))
      rig.pcmPendingSamples += frames.length
      if (rig.pcmPendingSamples >= PCM_FLUSH_SAMPLES) flushPcm(invoke, meetingId, channel)
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

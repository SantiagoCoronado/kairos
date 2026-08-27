/** Live input levels for the recording bar — the proof that both channels
 *  are actually being heard, not just that a recorder object exists (the
 *  system channel once recorded pure silence for a whole meeting without
 *  any visible symptom). Fed from the PCM tap the store already runs, so
 *  no second AudioContext/AnalyserNode per channel. The rendering pattern
 *  (rAF loop + canvas bars, flat while paused) follows
 *  react-audio-visualize's LiveAudioVisualizer (MIT). */

import type { MeetingChannel } from './meeting-store'

export type Levels = Record<MeetingChannel, number>

/** dB floor mapped to an empty meter; full scale (0 dBFS) fills it */
const FLOOR_DB = -60
/** decay per notification (~125 Hz block rate) — fast attack, ~150 ms fall */
const DECAY = 0.9

/** RMS of a Float32 block → 0..1 meter value on a dB scale */
export function levelFromFrames(frames: Float32Array): number {
  if (frames.length === 0) return 0
  let sum = 0
  for (let i = 0; i < frames.length; i++) sum += frames[i] * frames[i]
  const rms = Math.sqrt(sum / frames.length)
  if (rms <= 0) return 0
  const db = 20 * Math.log10(rms)
  return Math.min(1, Math.max(0, (db - FLOOR_DB) / -FLOOR_DB))
}

/** instant attack, gradual release — a syllable registers, then falls off */
export function envelope(previous: number, next: number): number {
  return next >= previous ? next : Math.max(next, previous * DECAY)
}

/** one identity for the lifetime of the module — reset mutates in place,
 *  so a holder of getLevels() never ends up watching a stale object */
const levels: Levels = { mic: 0, system: 0 }

/** called per tap block (~125 Hz per channel); the meter polls getLevels()
 *  once per animation frame, so there is no listener fan-out to pay */
export function noteFrames(channel: MeetingChannel, frames: Float32Array): void {
  levels[channel] = envelope(levels[channel], levelFromFrames(frames))
}

/** paused / stopped: nothing is being heard, and the meter must say so */
export function resetLevels(): void {
  levels.mic = 0
  levels.system = 0
}

export function getLevels(): Readonly<Levels> {
  return levels
}

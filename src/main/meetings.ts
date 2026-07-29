// MeetingManager: owns recording files and meeting-row lifecycle. The
// renderer captures (MediaRecorder + AudioWorklet taps) and streams chunks
// here over IPC; this side appends them to disk and finalizes rows.
// File layout: ~/Kairos/recordings/<meeting-id>/{mic,system}.{webm,wav}
// (.webm = playback archive, .wav = 16kHz transcription input, deleted
// after phase-2 transcription). Filesystem and clock are injected so the
// whole lifecycle is testable without Electron (see terminal.ts precedent).

import { join, resolve, sep } from 'node:path'
import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync
} from 'node:fs'
import type { DbDriver } from '../core/driver'
import type { Meeting, NewMeeting } from '../core/types'
import * as meetings from '../core/repo/meetings'
import { WAV_HEADER_BYTES, wavHeader } from '../core/audio'

export const PCM_SAMPLE_RATE = 16000
const PCM_BYTES_PER_SECOND = PCM_SAMPLE_RATE * 2 // mono int16

export type MeetingChannel = 'mic' | 'system'
export type ChunkKind = 'webm' | 'pcm'

export interface MeetingFs {
  mkdir(dir: string): void
  append(path: string, data: Uint8Array): void
  write(path: string, data: Uint8Array): void
  /** patch bytes at an offset (WAV header finalize) */
  writeAt(path: string, offset: number, data: Uint8Array): void
  /** byte size, or null when the file is missing */
  size(path: string): number | null
  rmDir(dir: string): void
}

const realFs: MeetingFs = {
  mkdir: (dir) => mkdirSync(dir, { recursive: true }),
  append: (path, data) => appendFileSync(path, data),
  write: (path, data) => writeFileSync(path, data),
  writeAt: (path, offset, data) => {
    const fd = openSync(path, 'r+')
    try {
      writeSync(fd, data, 0, data.length, offset)
    } finally {
      closeSync(fd)
    }
  },
  size: (path) => {
    try {
      return statSync(path).size
    } catch {
      return null
    }
  },
  rmDir: (dir) => rmSync(dir, { recursive: true, force: true })
}

// IPC-facing inputs are untrusted strings (the preload bridge is a raw
// passthrough and remote clients speak the same contract): pin ids to the
// ULID shape and channels/kinds to their literal unions before they touch a
// path — `join(dir, id)` with a '../'-shaped id walks out of recordingsDir.
const ULID_SHAPE = /^[0-9A-Z]{26}$/i

function assertMeetingId(id: string): void {
  if (!ULID_SHAPE.test(id)) throw new Error(`invalid meeting id: ${id}`)
}

function assertChannel(channel: string): asserts channel is MeetingChannel {
  if (channel !== 'mic' && channel !== 'system') throw new Error(`invalid channel: ${channel}`)
}

function assertKind(kind: string): asserts kind is ChunkKind {
  if (kind !== 'webm' && kind !== 'pcm') throw new Error(`invalid chunk kind: ${kind}`)
}

export class MeetingManager {
  private activeId: string | null = null

  constructor(
    private readonly db: DbDriver,
    private readonly recordingsDir: string,
    private readonly onChange: () => void,
    private readonly fs: MeetingFs = realFs,
    private readonly now: () => Date = () => new Date()
  ) {}

  /** rows left in 'recording' by a crash — finalize from whatever's on disk */
  recoverOrphans(): void {
    const orphans = meetings.listMeetings(this.db, { status: 'recording' })
    for (const m of orphans) {
      const { micPath, systemPath, pcmBytes } = this.finalizeFiles(m.id)
      // WAV data counts as audio too: the PCM tap flushes ~every 1s vs the
      // recorder's 3s timeslice, so an early crash can leave transcribable
      // PCM with no webm yet
      const hasAudio = micPath !== null || systemPath !== null || pcmBytes > 0
      meetings.updateMeeting(
        this.db,
        m.id,
        hasAudio
          ? {
              status: 'ready',
              ended_at: this.now().toISOString(),
              // wall-clock is meaningless after a crash — derive from PCM
              // bytes (stop() uses the clock; both land within a flush)
              duration_seconds: Math.round(pcmBytes / PCM_BYTES_PER_SECOND),
              mic_path: micPath,
              system_path: systemPath
            }
          : { status: 'error', error: 'recording interrupted — no audio captured' },
        this.now()
      )
    }
    if (orphans.length) this.onChange()
  }

  start(input: NewMeeting = {}): Meeting {
    if (this.activeId) throw new Error('a meeting is already recording')
    const m = meetings.createMeeting(this.db, input, this.now())
    this.fs.mkdir(this.dirOf(m.id))
    // placeholder headers, patched with real sizes at stop
    for (const channel of ['mic', 'system'] as const) {
      this.fs.write(this.pathOf(m.id, channel, 'wav'), wavHeader(0, PCM_SAMPLE_RATE))
    }
    this.activeId = m.id
    this.onChange()
    return m
  }

  appendChunk(id: string, channel: MeetingChannel, kind: ChunkKind, data: Uint8Array): void {
    if (id !== this.activeId) throw new Error(`meeting not recording: ${id}`)
    assertChannel(channel)
    assertKind(kind)
    this.fs.append(this.pathOf(id, channel, kind === 'webm' ? 'webm' : 'wav'), data)
  }

  stop(id: string): Meeting {
    if (id !== this.activeId) throw new Error(`meeting not recording: ${id}`)
    this.activeId = null
    const m = meetings.getMeeting(this.db, id)!
    const { micPath, systemPath } = this.finalizeFiles(id)
    const endedAt = this.now()
    const durationMs = endedAt.getTime() - new Date(m.started_at).getTime()
    const updated = meetings.updateMeeting(
      this.db,
      id,
      {
        status: 'ready',
        ended_at: endedAt.toISOString(),
        duration_seconds: Math.max(0, Math.round(durationMs / 1000)),
        mic_path: micPath,
        system_path: systemPath
      },
      endedAt
    )
    this.onChange()
    return updated
  }

  delete(id: string): void {
    assertMeetingId(id)
    if (id === this.activeId) this.activeId = null
    this.fs.rmDir(this.dirOf(id))
    meetings.deleteMeeting(this.db, id)
    this.onChange()
  }

  /** app quit with a live recording: finalize what landed on disk */
  shutdown(): void {
    if (this.activeId) this.stop(this.activeId)
  }

  get activeMeetingId(): string | null {
    return this.activeId
  }

  private dirOf(id: string): string {
    assertMeetingId(id)
    const dir = resolve(join(this.recordingsDir, id))
    // defense in depth behind the ULID check — never operate outside the root
    if (!dir.startsWith(resolve(this.recordingsDir) + sep))
      throw new Error(`meeting path escapes recordings dir: ${id}`)
    return dir
  }

  private pathOf(id: string, channel: MeetingChannel, ext: 'webm' | 'wav'): string {
    return join(this.dirOf(id), `${channel}.${ext}`)
  }

  /** patch WAV headers with real data sizes; report webm archive paths */
  private finalizeFiles(id: string): {
    micPath: string | null
    systemPath: string | null
    pcmBytes: number
  } {
    let pcmBytes = 0
    for (const channel of ['mic', 'system'] as const) {
      const wavPath = this.pathOf(id, channel, 'wav')
      const size = this.fs.size(wavPath)
      if (size === null || size < WAV_HEADER_BYTES) continue
      const dataBytes = size - WAV_HEADER_BYTES
      pcmBytes = Math.max(pcmBytes, dataBytes)
      const header = wavHeader(dataBytes, PCM_SAMPLE_RATE)
      this.fs.writeAt(wavPath, 0, header)
    }
    const webmPath = (channel: MeetingChannel): string | null => {
      const p = this.pathOf(id, channel, 'webm')
      return (this.fs.size(p) ?? 0) > 0 ? p : null
    }
    return { micPath: webmPath('mic'), systemPath: webmPath('system'), pcmBytes }
  }
}

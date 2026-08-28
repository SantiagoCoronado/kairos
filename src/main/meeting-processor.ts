// Post-meeting transcription pipeline. One FIFO queue (AgentTaskRunner
// drain pattern): stop → 'processing' → transcribe each channel's 16 kHz
// WAV via the whisper sidecar → merge by timestamp (Me/Them) → persist
// transcript → delete the WAVs (webm archives stay for playback) →
// 'ready'. The transcriber is resolved per job through an injected
// factory so model downloads/config changes apply between jobs, and so
// tests never need the real sidecar.

import { join } from 'node:path'
import type { DbDriver } from '../core/driver'
import type { Meeting } from '../core/types'
import type { MeetingEvent } from '../shared/ipc-contract'
import * as meetings from '../core/repo/meetings'
import { mergeChannelSegments, transcriptText } from '../core/transcript'
import { WhisperCrashError, type WhisperResult } from './whisper'

export interface Transcriber {
  transcribe(wavPath: string): Promise<WhisperResult>
  /** model name recorded on the transcript row */
  modelName: string
}

export interface ProcessorFs {
  size(path: string): number | null
  rm(path: string): void
}

interface Deps {
  getTranscriber(): Promise<Transcriber>
  fs: ProcessorFs
  onEvent(ev: MeetingEvent): void
  onChange(): void
  notify(title: string, body: string, meetingId: string): void
  log(level: 'info' | 'warn' | 'error', message: string): void
  /** post-transcription summarization — failures must not fail the meeting */
  summarize?(meetingId: string): Promise<void>
  now?: () => Date
}

const MAINTENANCE_MS = 60 * 60_000

type ChannelResult = WhisperResult | 'crashed' | null

export class MeetingProcessor {
  private queue: string[] = []
  /** ids shifted out of the queue but still being processed — enqueue must
   *  dedup against these too, or a mid-job re-enqueue runs a second pass
   *  after the WAVs are gone and overwrites the transcript with an empty one */
  private inFlight = new Set<string>()
  private draining = false
  private maintenanceTimer: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly db: DbDriver,
    private readonly recordingsDir: string,
    private readonly deps: Deps
  ) {}

  /** crashed mid-transcribe rows + finished recordings never transcribed */
  sweepIncomplete(): void {
    const stuck = meetings.listMeetings(this.db, { status: 'processing' })
    const untranscribed = meetings
      .listMeetings(this.db, { status: 'ready' })
      .filter(
        (m) =>
          !meetings.getTranscript(this.db, m.id) &&
          !m.audio_deleted_at &&
          this.hasAnyWav(m.id)
      )
    for (const m of [...stuck, ...untranscribed]) this.enqueue(m.id)
  }

  /** manual retry from the UI for an error'd row — only meaningful while
   *  the WAVs still exist (they're kept on failure, deleted on success or
   *  by retention) */
  retry(meetingId: string): void {
    const m = meetings.getMeeting(this.db, meetingId)
    if (!m) throw new Error(`meeting not found: ${meetingId}`)
    if (m.status === 'recording' || m.status === 'processing')
      throw new Error('meeting is still being recorded or transcribed')
    if (!this.hasAnyWav(meetingId))
      throw new Error(
        m.audio_deleted_at
          ? 'audio was pruned by the retention setting — nothing left to transcribe'
          : 'transcription audio is gone (already transcribed, or the recording never produced any)'
      )
    this.enqueue(meetingId)
  }

  enqueue(meetingId: string): void {
    if (this.queue.includes(meetingId) || this.inFlight.has(meetingId)) return
    const m = meetings.getMeeting(this.db, meetingId)
    if (!m) return
    if (m.status !== 'processing')
      meetings.updateMeeting(this.db, meetingId, { status: 'processing', error: null })
    this.deps.onEvent({ kind: 'processing', meetingId })
    this.deps.onChange()
    this.queue.push(meetingId)
    void this.drain()
  }

  private async drain(): Promise<void> {
    if (this.draining) return
    this.draining = true
    try {
      for (;;) {
        const id = this.queue.shift()
        if (!id) return
        this.inFlight.add(id)
        try {
          await this.process(id)
        } finally {
          this.inFlight.delete(id)
        }
      }
    } finally {
      this.draining = false
    }
  }

  private async process(id: string): Promise<void> {
    const meeting = meetings.getMeeting(this.db, id)
    if (!meeting) return
    try {
      const transcriber = await this.deps.getTranscriber()
      const mic = await this.transcribeChannel(id, 'mic', transcriber)
      const system = await this.transcribeChannel(id, 'system', transcriber)
      // one crashed channel is "they never spoke" / "I never spoke" — but
      // every channel crashing is indistinguishable from a broken sidecar,
      // so that still fails loudly instead of quietly producing an empty
      // transcript for an hour-long meeting
      const attempted = [mic, system].filter((r) => r !== null)
      if (attempted.length > 0 && attempted.every((r) => r === 'crashed'))
        throw new Error(
          'no speech detected on any channel (whisper-server rejected the audio) — nothing to transcribe'
        )
      const segs = (r: ChannelResult): WhisperResult | null => (r === 'crashed' ? null : r)
      const micRes = segs(mic)
      const systemRes = segs(system)
      const crashed = (['mic', 'system'] as const).filter(
        (c) => (c === 'mic' ? mic : system) === 'crashed'
      )
      const segments = mergeChannelSegments(micRes?.segments ?? [], systemRes?.segments ?? [])
      meetings.setTranscript(this.db, id, {
        segments,
        text: transcriptText(segments),
        language: micRes?.language ?? systemRes?.language ?? null,
        model: transcriber.modelName
      })
      // WAVs were transcription input only — the webm archives stay. A
      // crashed channel keeps them: the crash is inferred from the sidecar
      // dying mid-request, and "no speech" is only the usual cause, so an
      // hour-long meeting that lost "them" must still be retryable. The
      // row stays 'ready' (the other channel's transcript is real) with the
      // gap named in `error` so the UI can show it and offer Retry.
      if (crashed.length === 0) {
        for (const channel of ['mic', 'system'] as const) {
          const wav = this.wavPath(id, channel)
          if (this.deps.fs.size(wav) !== null) this.deps.fs.rm(wav)
        }
      }
      meetings.updateMeeting(this.db, id, {
        status: 'ready',
        error: crashed.length
          ? `partial: no speech detected on ${crashed.join(' + ')} (whisper-server rejected that audio) — audio kept, Retry re-runs it`
          : null
      })
      this.deps.onEvent({ kind: 'transcribed', meetingId: id })
      this.deps.onChange()
      this.deps.notify(
        'Meeting transcribed',
        meeting.title || 'Transcript is ready to review.',
        id
      )
      this.deps.log(
        'info',
        `meetings: transcribed ${id} (${segments.length} segments${crashed.length ? `, ${crashed.join('+')} crashed → kept WAVs` : ''})`
      )
      if (this.deps.summarize && segments.length > 0) {
        try {
          await this.deps.summarize(id)
        } catch (err) {
          // the transcript is safe either way; summaries can be retried
          this.deps.log(
            'warn',
            `meetings: summarize failed for ${id}: ${err instanceof Error ? err.message : String(err)}`
          )
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      meetings.updateMeeting(this.db, id, { status: 'error', error: message })
      this.deps.onEvent({ kind: 'transcribe-error', meetingId: id, message })
      this.deps.onChange()
      this.deps.log('error', `meetings: transcription failed for ${id}: ${message}`)
    }
  }

  /** null = channel never captured (missing/header-only WAV);
   *  'crashed' = the sidecar died on it, treated as silence upstream */
  private async transcribeChannel(
    id: string,
    channel: 'mic' | 'system',
    transcriber: Transcriber
  ): Promise<ChannelResult> {
    const wav = this.wavPath(id, channel)
    const size = this.deps.fs.size(wav)
    if (size === null || size <= 44) return null // missing or header-only
    try {
      return await transcriber.transcribe(wav)
    } catch (err) {
      if (!(err instanceof WhisperCrashError)) throw err
      this.deps.log(
        'warn',
        `meetings: whisper-server crashed on ${channel} for ${id} — treating the channel as silent`
      )
      return 'crashed'
    }
  }

  /** hourly: honor the audio-retention setting */
  startMaintenance(getRetentionDays: () => number | null): void {
    this.stopMaintenance()
    const run = (): void => this.pruneAudio(getRetentionDays())
    this.maintenanceTimer = setInterval(run, MAINTENANCE_MS)
    run()
  }

  stopMaintenance(): void {
    if (this.maintenanceTimer) {
      clearInterval(this.maintenanceTimer)
      this.maintenanceTimer = null
    }
  }

  pruneAudio(retentionDays: number | null): void {
    if (retentionDays == null) return
    const now = this.deps.now?.() ?? new Date()
    const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60_000).toISOString()
    // error'd meetings age out too — they get retried by every launch's
    // sweep until retention expires, then their audio goes like anyone's
    const old = meetings
      .listMeetings(this.db, { status: ['ready', 'error'] })
      .filter((m) => !m.audio_deleted_at && m.ended_at !== null && m.ended_at < cutoff)
    for (const m of old) {
      this.deleteAudioFiles(m)
      meetings.markAudioDeleted(this.db, m.id, now)
      this.deps.log('info', `meetings: pruned audio for ${m.id} (retention ${retentionDays}d)`)
    }
    if (old.length) this.deps.onChange()
  }

  private deleteAudioFiles(m: Meeting): void {
    for (const path of [
      m.mic_path,
      m.system_path,
      this.wavPath(m.id, 'mic'),
      this.wavPath(m.id, 'system')
    ]) {
      if (path && this.deps.fs.size(path) !== null) this.deps.fs.rm(path)
    }
  }

  private hasAnyWav(id: string): boolean {
    return (['mic', 'system'] as const).some(
      (c) => (this.deps.fs.size(this.wavPath(id, c)) ?? 0) > 44
    )
  }

  private wavPath(id: string, channel: 'mic' | 'system'): string {
    return join(this.recordingsDir, id, `${channel}.wav`)
  }
}

// One-shot meeting summarization over the Claude Agent SDK (smart-capture
// pattern: tool-less, single turn, strict-JSON output, rides the user's
// claude login). Sonnet by default — summaries are the flagship output,
// haiku routing quality isn't enough, the chat model may be overkill.

import { query } from '@anthropic-ai/claude-agent-sdk'
import type { DbDriver } from '../../core/driver'
import type { Meeting } from '../../core/types'
import * as meetings from '../../core/repo/meetings'
import * as calendarRepo from '../../core/repo/calendar'
import * as people from '../../core/repo/people'
import {
  applySummaryFanOut,
  buildSummaryPrompt,
  parseSummaryResponse
} from '../../core/meeting-summary'
import { DATA_DIR } from '../db'
import { logLine } from '../logger'
import { buildChildEnv, resolveClaudeBinary } from './agent'

const SUMMARY_MODEL = 'sonnet'

export type SummarizeResult =
  | { ok: true; meeting: Meeting; taskIds: string[]; interactionCount: number }
  | { ok: false; message: string }

export async function summarizeMeeting(
  db: DbDriver,
  meetingId: string,
  opts: { force?: boolean } = {}
): Promise<SummarizeResult> {
  const meeting = meetings.getMeeting(db, meetingId)
  if (!meeting) return { ok: false, message: `meeting not found: ${meetingId}` }
  if (meeting.summarized_at && !opts.force)
    return { ok: true, meeting, taskIds: [], interactionCount: 0 }
  const transcript = meetings.getTranscript(db, meetingId)
  if (!transcript || !transcript.text.trim())
    return { ok: false, message: 'No transcript to summarize.' }

  const event = meeting.calendar_event_id
    ? calendarRepo.getEvent(db, meeting.calendar_event_id)
    : undefined
  const prompt = buildSummaryPrompt({
    transcriptText: transcript.text,
    title: meeting.title || event?.title || '',
    description: event?.description ?? null,
    attendees: event?.attendees ?? [],
    durationSeconds: meeting.duration_seconds,
    knownPeople: people.listPeople(db, {}).map((p) => p.name)
  })

  let raw: string
  try {
    raw = await runOneShot(prompt)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    logLine('error', 'meetings', `summarize failed for ${meetingId}: ${message}`)
    return { ok: false, message }
  }
  const parsed = parseSummaryResponse(raw)
  if (!parsed) {
    logLine('warn', 'meetings', `summarize: unparseable model output for ${meetingId}`)
    return { ok: false, message: 'Model returned no usable summary.' }
  }

  const { meeting: updated, taskIds, interactionCount } = applySummaryFanOut(
    db,
    meetingId,
    parsed,
    { model: SUMMARY_MODEL, attendees: event?.attendees ?? [] }
  )
  logLine(
    'info',
    'meetings',
    `summarized ${meetingId}: ${taskIds.length} task(s), ${interactionCount} interaction(s)`
  )
  return { ok: true, meeting: updated, taskIds, interactionCount }
}

async function runOneShot(prompt: string): Promise<string> {
  const bin = resolveClaudeBinary()
  if (!bin) throw new Error('Claude Code binary not found — check Settings → Assistant.')
  const q = query({
    prompt,
    options: {
      permissionMode: 'default',
      settingSources: [],
      strictMcpConfig: true,
      systemPrompt: 'You summarize meeting transcripts to JSON. You output only valid JSON.',
      model: SUMMARY_MODEL,
      maxTurns: 1,
      cwd: DATA_DIR,
      env: buildChildEnv() as Record<string, string>,
      pathToClaudeCodeExecutable: bin
    }
  })
  let out = ''
  for await (const msg of q) {
    if (msg.type === 'assistant') {
      for (const block of msg.message.content) {
        if (block.type === 'text') out += block.text
      }
    }
  }
  return out
}

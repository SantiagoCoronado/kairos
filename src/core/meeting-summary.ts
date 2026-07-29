// Meeting summarization: prompt construction and response parsing (pure),
// mirroring the smart-capture split — the LLM call itself lives in
// src/main/chat/meeting-summarizer.ts. The model returns strict JSON so
// the reduce step needs no second parse pass (schema-constrained output,
// per the Anarlog/Meetily research).

import type { CalendarAttendee } from './types'

export interface SummaryInput {
  transcriptText: string
  title: string
  description?: string | null
  attendees: CalendarAttendee[]
  durationSeconds?: number | null
  /** existing Kairos people names — matching hints for action-item owners */
  knownPeople: string[]
}

export interface ParsedSummary {
  summary_md: string
  decisions: string[]
  action_items: { text: string; person: string | null }[]
  participants: string[]
}

/** the model only needs so much; a 1h meeting is ~45k chars */
export const MAX_TRANSCRIPT_CHARS = 60_000
const MAX_PEOPLE_HINTS = 100

export function buildSummaryPrompt(input: SummaryInput): string {
  const attendees = input.attendees
    .map((a) => a.displayName || a.email)
    .filter(Boolean)
    .join(', ')
  const oneOnOne = input.attendees.length > 0 && input.attendees.length <= 2
  const transcript =
    input.transcriptText.length > MAX_TRANSCRIPT_CHARS
      ? `${input.transcriptText.slice(0, MAX_TRANSCRIPT_CHARS)}\n[transcript truncated]`
      : input.transcriptText
  const people = input.knownPeople.slice(0, MAX_PEOPLE_HINTS).join(', ')

  return `Summarize this meeting transcript as JSON. "Me" is the user (the person whose notes these are); "Them" is everyone else on the call.

Meeting: ${JSON.stringify(input.title || 'Untitled meeting')}${
    input.durationSeconds ? ` (${Math.round(input.durationSeconds / 60)} min)` : ''
  }
${attendees ? `Attendees: ${attendees}\n` : ''}${
    input.description ? `Event description: ${JSON.stringify(input.description.slice(0, 500))}\n` : ''
  }${people ? `Known people (for matching action-item owners): ${people}\n` : ''}
Transcript:
"""
${transcript}
"""

Output ONLY a JSON object with these fields:
- "summary_md": markdown summary — ${
    oneOnOne
      ? 'this is a 1:1, so focus on what was discussed and agreed between the two people'
      : 'this is a group meeting, so organize by topic'
  }. 2-6 short paragraphs or bullet groups. No heading for the meeting title.
- "decisions": array of strings — concrete decisions made ("we will X"). Empty array if none.
- "action_items": array of {"text": "the task, phrased as an action", "person": "owner's name or null"} — only real commitments someone made, not vague ideas. Use names from the known-people list when they match. Empty array if none.
- "participants": array of speaker names actually present, best effort from context.

Rules:
- Write in the transcript's language.
- Action items assigned to the user ("I will…" said by Me) get person null.
- Never invent action items or decisions that were not said.`
}

/** tolerant parse of the model's JSON — null when unusable */
export function parseSummaryResponse(raw: string): ParsedSummary | null {
  const match = raw.match(/\{[\s\S]*\}/)
  if (!match) return null
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(match[0]) as Record<string, unknown>
  } catch {
    return null
  }
  const summaryMd = typeof parsed.summary_md === 'string' ? parsed.summary_md.trim() : ''
  if (!summaryMd) return null
  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : []
  const actionItems = Array.isArray(parsed.action_items)
    ? (parsed.action_items as Record<string, unknown>[])
        .filter((it) => it && typeof it === 'object')
        .map((it) => ({
          text: String(it.text ?? '').trim(),
          person: it.person == null ? null : String(it.person).trim() || null
        }))
        .filter((it) => it.text)
    : []
  return {
    summary_md: summaryMd,
    decisions: strings(parsed.decisions),
    action_items: actionItems,
    participants: strings(parsed.participants)
  }
}

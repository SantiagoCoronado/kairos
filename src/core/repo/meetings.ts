import type { DbDriver, SqlValue } from '../driver'
import type {
  Meeting,
  MeetingFilter,
  MeetingPatch,
  MeetingSummaryData,
  MeetingTranscript,
  NewMeeting,
  NewTranscript,
  TranscriptSegment
} from '../types'
import { newId, nowIso } from '../ids'

/** raw row: summary_json is a JSON string in SQLite */
type MeetingRow = Omit<Meeting, 'summary'> & { summary_json: string }
type TranscriptRow = Omit<MeetingTranscript, 'segments'> & { segments: string }

const EMPTY_SUMMARY: MeetingSummaryData = { action_items: [], decisions: [], participants: [] }

function parseRow(row: MeetingRow): Meeting {
  const { summary_json, ...rest } = row
  let summary: MeetingSummaryData = EMPTY_SUMMARY
  try {
    const parsed = JSON.parse(summary_json)
    if (parsed && typeof parsed === 'object')
      summary = {
        action_items: Array.isArray(parsed.action_items)
          ? parsed.action_items.map((it: Record<string, unknown>) => ({
              text: String(it.text ?? ''),
              person_id: it.person_id == null ? null : String(it.person_id),
              task_id: it.task_id == null ? null : String(it.task_id)
            }))
          : [],
        decisions: Array.isArray(parsed.decisions) ? parsed.decisions.map(String) : [],
        participants: Array.isArray(parsed.participants) ? parsed.participants.map(String) : []
      }
  } catch {
    // tolerate bad JSON — treat as empty summary
  }
  return { ...rest, summary }
}

function parseTranscriptRow(row: TranscriptRow): MeetingTranscript {
  let segments: TranscriptSegment[] = []
  try {
    const parsed = JSON.parse(row.segments)
    if (Array.isArray(parsed))
      segments = parsed
        .filter((s) => s && typeof s === 'object')
        .map((s) => ({
          t0: Number(s.t0 ?? 0),
          t1: Number(s.t1 ?? 0),
          channel: s.channel === 'them' ? 'them' : 'me',
          text: String(s.text ?? '')
        }))
  } catch {
    // tolerate bad JSON — treat as empty transcript
  }
  return { ...row, segments }
}

export function getMeeting(db: DbDriver, id: string): Meeting | undefined {
  const row = db.get<MeetingRow>('SELECT * FROM meetings WHERE id = ?', id)
  return row ? parseRow(row) : undefined
}

export function listMeetings(db: DbDriver, f: MeetingFilter = {}): Meeting[] {
  const where: string[] = []
  const params: SqlValue[] = []
  if (f.status) {
    const statuses = Array.isArray(f.status) ? f.status : [f.status]
    where.push(`status IN (${statuses.map(() => '?').join(',')})`)
    params.push(...statuses)
  }
  if (f.calendar_event_id) {
    where.push('calendar_event_id = ?')
    params.push(f.calendar_event_id)
  }
  const sql = `SELECT * FROM meetings
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY started_at DESC${f.limit ? ` LIMIT ${Math.max(1, Math.floor(f.limit))}` : ''}`
  return db.all<MeetingRow>(sql, ...params).map(parseRow)
}

export function createMeeting(db: DbDriver, input: NewMeeting = {}, now: Date = new Date()): Meeting {
  const id = newId()
  const ts = nowIso(now)
  db.run(
    `INSERT INTO meetings (id, calendar_event_id, title, status, started_at, summary_json, created_at, updated_at)
     VALUES (?, ?, ?, 'recording', ?, '{}', ?, ?)`,
    id,
    input.calendar_event_id ?? null,
    input.title ?? '',
    input.started_at ?? ts,
    ts,
    ts
  )
  return getMeeting(db, id)!
}

export function updateMeeting(
  db: DbDriver,
  id: string,
  patch: MeetingPatch,
  now: Date = new Date()
): Meeting {
  const existing = getMeeting(db, id)
  if (!existing) throw new Error(`meeting not found: ${id}`)
  const next = { ...existing, ...stripUndefined(patch) }
  db.run(
    `UPDATE meetings SET calendar_event_id=?, title=?, status=?, error=?, ended_at=?, duration_seconds=?,
       mic_path=?, system_path=?, summary_md=?, summary_json=?, summary_model=?, summarized_at=?, updated_at=?
     WHERE id=?`,
    next.calendar_event_id,
    next.title,
    next.status,
    next.error,
    next.ended_at,
    next.duration_seconds,
    next.mic_path,
    next.system_path,
    next.summary_md,
    JSON.stringify(patch.summary ?? existing.summary),
    next.summary_model,
    next.summarized_at,
    nowIso(now),
    id
  )
  return getMeeting(db, id)!
}

export function deleteMeeting(db: DbDriver, id: string): void {
  db.run('DELETE FROM meetings WHERE id = ?', id)
}

/** audio files were removed from disk; the transcript and summary stay */
export function markAudioDeleted(db: DbDriver, id: string, now: Date = new Date()): Meeting {
  const existing = getMeeting(db, id)
  if (!existing) throw new Error(`meeting not found: ${id}`)
  const ts = nowIso(now)
  db.run('UPDATE meetings SET audio_deleted_at = ?, updated_at = ? WHERE id = ?', ts, ts, id)
  return getMeeting(db, id)!
}

export function getTranscript(db: DbDriver, meetingId: string): MeetingTranscript | undefined {
  const row = db.get<TranscriptRow>(
    'SELECT * FROM meeting_transcripts WHERE meeting_id = ?',
    meetingId
  )
  return row ? parseTranscriptRow(row) : undefined
}

/** one transcript per meeting — a second write replaces the first */
export function setTranscript(
  db: DbDriver,
  meetingId: string,
  input: NewTranscript,
  now: Date = new Date()
): MeetingTranscript {
  if (!getMeeting(db, meetingId)) throw new Error(`meeting not found: ${meetingId}`)
  const text = input.text ?? input.segments.map((s) => s.text).join('\n')
  db.run(
    `INSERT INTO meeting_transcripts (meeting_id, segments, text, language, model, transcribed_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(meeting_id) DO UPDATE SET
       segments=excluded.segments, text=excluded.text, language=excluded.language,
       model=excluded.model, transcribed_at=excluded.transcribed_at`,
    meetingId,
    JSON.stringify(input.segments),
    text,
    input.language ?? null,
    input.model ?? null,
    input.transcribed_at ?? nowIso(now),
    nowIso(now)
  )
  return getTranscript(db, meetingId)!
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>
}

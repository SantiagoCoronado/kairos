import { monotonicFactory } from 'ulid'

/** Monotonic within this process: two ids minted in the same millisecond
 *  still sort in creation order, so `ORDER BY sent_at DESC, id DESC` is a
 *  real tiebreaker for messages whose provider timestamps tie (WhatsApp's
 *  are whole seconds). */
const ulid = monotonicFactory()

export function newId(): string {
  return ulid()
}

export function nowIso(now: Date = new Date()): string {
  return now.toISOString()
}

/** YYYY-MM-DD in the machine's local timezone (due dates are local-day concepts). */
export function localDate(now: Date = new Date()): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

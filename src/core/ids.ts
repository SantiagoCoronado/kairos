import { ulid } from 'ulid'

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

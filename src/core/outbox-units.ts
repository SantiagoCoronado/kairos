// A multi-message send (WhatsApp: text + N files = up to N+1 provider
// messages) is one outbox row. These helpers derive the row's delivery units
// and decide what a resumed attempt still has to send — pure functions over
// the immutable row, so the logic is testable without a provider socket.
//
// Unit keys: "text" iff body_text has content, "att:<i>" for each position in
// the to_json attachments array. to_json never changes after enqueue, so the
// indices are stable across attempts.

import type { OutboxItem } from './comms-types'

export type SendUnit =
  | { key: string; kind: 'text' }
  | { key: string; kind: 'att'; index: number }

/** canonical unit key for the attachment at to_json position `index` */
export const attKey = (index: number): string => `att:${index}`

/** Parse delivered_json defensively — a corrupt or absent map counts as
 *  "nothing delivered" (worst case is a duplicate, never a lost send). */
export function deliveredMap(item: Pick<OutboxItem, 'delivered_json'>): Record<string, string> {
  if (!item.delivered_json) return {}
  try {
    const parsed: unknown = JSON.parse(item.delivered_json)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const map: Record<string, string> = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string') map[key] = value
    }
    return map
  } catch {
    return {}
  }
}

/** Derive the full unit list from the immutable row: text first, then each
 *  attachment in to_json order — matching the provider send order. */
export function sendUnits(item: Pick<OutboxItem, 'body_text' | 'to_json'>): SendUnit[] {
  const units: SendUnit[] = []
  if (item.body_text.trim()) units.push({ key: 'text', kind: 'text' })
  let attachments: unknown
  try {
    attachments = (JSON.parse(item.to_json) as { attachments?: unknown }).attachments
  } catch {
    attachments = undefined
  }
  if (Array.isArray(attachments)) {
    for (let i = 0; i < attachments.length; i++) {
      units.push({ key: attKey(i), kind: 'att', index: i })
    }
  }
  return units
}

/** Units still to send, in order — the resume decision. */
export function pendingUnits(
  item: Pick<OutboxItem, 'body_text' | 'to_json' | 'delivered_json'>
): SendUnit[] {
  const done = deliveredMap(item)
  return sendUnits(item).filter((u) => !(u.key in done))
}

// Email auto-labeling: the fixed taxonomy plus the pure prompt/parse halves
// of the classifier, kept SDK-free so they are unit-testable and importable
// from the renderer (taxonomy for the manual-label menu).

export const COMMS_LABELS = [
  'action-needed',
  'waiting',
  'newsletter',
  'finance',
  'travel',
  'promo',
  'personal',
  'other'
] as const

export type CommsLabel = (typeof COMMS_LABELS)[number]

// ---------- zero-token heuristic pass ----------
// Most mail is mechanically classifiable: Gmail's own category tabs arrive in
// labelIds (already stored in raw_json), and receipts/travel confirmations
// telegraph themselves in the subject line. Only what this can't decide —
// CATEGORY_PERSONAL / CATEGORY_UPDATES / uncategorized — costs model tokens.

const FINANCE_RE =
  /\b(receipt|invoice|payment|statement|charged|order (?:confirm|receipt)|factura|recibo|pago|estado de cuenta)\b/i
const TRAVEL_RE =
  /\b(itinerary|flight|boarding|check[- ]?in|booking|reservation|vuelo|reserva|hospedaje|hotel confirmation)\b/i

/** Labels decidable without a model call, or null = needs the classifier. */
export function heuristicLabels(
  gmailLabelIds: string[],
  subject: string,
  snippet: string
): string[] | null {
  const text = `${subject} ${snippet}`
  // keyword rules outrank gmail categories: a receipt is finance even when
  // gmail filed it under promotions/updates
  if (FINANCE_RE.test(text)) return ['finance']
  if (TRAVEL_RE.test(text)) return ['travel']
  if (gmailLabelIds.includes('CATEGORY_PROMOTIONS')) return ['promo']
  if (gmailLabelIds.includes('CATEGORY_SOCIAL')) return ['other']
  if (gmailLabelIds.includes('CATEGORY_FORUMS')) return ['newsletter']
  return null
}

/** Pull gmail labelIds back out of a stored message's raw_json. */
export function labelIdsFromRawJson(rawJson: string | null): string[] {
  if (!rawJson) return []
  try {
    const parsed = JSON.parse(rawJson) as { labelIds?: unknown }
    return Array.isArray(parsed.labelIds)
      ? parsed.labelIds.filter((l): l is string => typeof l === 'string')
      : []
  } catch {
    return []
  }
}

export interface LabelCandidate {
  /** thread id, echoed back keyed by list position */
  id: string
  sender: string
  subject: string
  snippet: string
}

export function buildLabelPrompt(candidates: LabelCandidate[]): string {
  const list = candidates
    .map((c, i) => `${i + 1}. from: ${c.sender || '(unknown)'} | subject: ${c.subject} | preview: ${c.snippet}`)
    .join('\n')
  return [
    `Classify these email threads. Assign each one 1-2 labels from exactly this set: ${COMMS_LABELS.join(', ')}.`,
    'Meanings: action-needed = the recipient must do or answer something; waiting = the recipient is waiting on someone else; newsletter = periodic editorial content; finance = receipts, invoices, bank/statements; travel = bookings, itineraries, check-ins; promo = marketing/offers; personal = individual human correspondence that fits nothing above; other = none of these fit.',
    list,
    'Return ONLY a JSON object mapping each number to its labels, e.g. {"1":["finance"],"2":["newsletter","promo"]}. No prose, no code fences.'
  ].join('\n\n')
}

// ---------- WhatsApp notification triage ----------
// notifyInbox 'important' must not ping for every WhatsApp message. The
// labeler runs these over fresh unread DM threads: a zero-token pass drops
// pure chatter, the rest goes to Haiku for an important/routine verdict.

export interface MessageTriageCandidate {
  /** thread id, echoed back keyed by list position */
  id: string
  sender: string
  /** recent inbound message bodies, oldest first */
  messages: string[]
}

export type TriageVerdict = 'important' | 'routine'

// short acknowledgments and reactions in the languages Santiago actually
// chats in; trailing punctuation/emoji don't change the verdict ("ok 👍").
// Only ever rules a message ROUTINE — anything with actual content must
// fall through to the model, so additions here stay strictly throwaway.
const ROUTINE_MSG_RE =
  /^(ok(ay)?|vale|dale|s[ií]+|no+|ya|bueno|listo|va|ah+|oh+|jaja\S*|jeje\S*|jiji\S*|haha\S*|hehe\S*|lo+l\S*|lmao\S*|rofl|xd+|wow|omg|aw+|hm+|mm+|gracias|thanks?|thank you|ty|nice|cool|genial|claro|perfecto|de nada|np|yw|bye|adios|adiós|hola|hey|hi|hello|buenas|saludos|buenos d[ií]as|buenas noches|good night|good morning|hasta luego)[\s!.,\p{Extended_Pictographic}\p{Emoji_Component}‍]*$/iu
const EMOJI_ONLY_RE = /^[\p{Extended_Pictographic}\p{Emoji_Component}‍\s]+$/u

/** Portion of a triage queue the remaining daily budget can afford: the
 *  head goes to the model, the overflow is deferred (left unstamped so it
 *  retries while fresh, never notified unfiltered). */
export function splitTriageBudget<T>(
  candidates: T[],
  remaining: number
): { toModel: T[]; deferred: T[] } {
  const n = Math.max(0, Math.min(candidates.length, remaining))
  return { toModel: candidates.slice(0, n), deferred: candidates.slice(n) }
}

/** 'routine' when every recent inbound message is a throwaway ack/emoji —
 *  no model call needed; null = ambiguous, ask the classifier. */
export function heuristicMessageTriage(messages: string[]): TriageVerdict | null {
  if (messages.length === 0) return 'routine'
  const allRoutine = messages.every((m) => {
    const t = m.trim()
    return t.length === 0 || ROUTINE_MSG_RE.test(t) || EMOJI_ONLY_RE.test(t)
  })
  return allRoutine ? 'routine' : null
}

export function buildMessageTriagePrompt(candidates: MessageTriageCandidate[]): string {
  const list = candidates
    .map(
      (c, i) =>
        `${i + 1}. from: ${c.sender || '(unknown)'}\n` +
        c.messages.map((m) => `   > ${m.slice(0, 200)}`).join('\n')
    )
    .join('\n')
  return [
    'These are unread WhatsApp conversations. Decide for each whether it deserves an immediate notification.',
    'important = the sender needs the user to act, answer, or know something soon: direct questions, requests, plans or meetings being arranged, time-sensitive or urgent news, anything emotionally significant.',
    'routine = everything else: casual chatter, greetings, memes or links with no ask, acknowledgments, automated messages, spam.',
    list,
    'Return ONLY a JSON object mapping each number to "important" or "routine", e.g. {"1":"important","2":"routine"}. No prose, no code fences.'
  ].join('\n\n')
}

/** Parse the triage response; candidates the model skipped or garbled are
 *  simply absent (the sweep leaves them unstamped and retries while fresh). */
export function parseTriageResponse(
  text: string,
  candidates: MessageTriageCandidate[]
): Map<string, TriageVerdict> {
  const out = new Map<string, TriageVerdict>()
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) return out
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(match[0]) as Record<string, unknown>
  } catch {
    return out
  }
  candidates.forEach((c, i) => {
    const raw = parsed[String(i + 1)]
    if (typeof raw !== 'string') return
    const v = raw.trim().toLowerCase()
    if (v === 'important' || v === 'routine') out.set(c.id, v)
  })
  return out
}

/**
 * Parse the model's response back into thread-id → labels. Tolerates code
 * fences and stray prose around the JSON; unknown labels are dropped; an
 * entry that ends up empty falls back to 'other' so the thread never
 * re-enters the classify queue.
 */
export function parseLabelResponse(text: string, candidates: LabelCandidate[]): Map<string, string[]> {
  const out = new Map<string, string[]>()
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) return out
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(match[0]) as Record<string, unknown>
  } catch {
    return out
  }
  const valid = new Set<string>(COMMS_LABELS)
  candidates.forEach((c, i) => {
    const raw = parsed[String(i + 1)]
    if (raw === undefined) return
    const labels = (Array.isArray(raw) ? raw : [raw])
      .filter((l): l is string => typeof l === 'string')
      .map((l) => l.trim().toLowerCase())
      .filter((l) => valid.has(l))
      .slice(0, 2)
    out.set(c.id, labels.length > 0 ? labels : ['other'])
  })
  return out
}

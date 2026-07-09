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

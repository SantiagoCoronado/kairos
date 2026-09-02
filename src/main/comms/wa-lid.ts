// WhatsApp addresses one account two ways: the phone-number jid
// (<digits>@s.whatsapp.net) and, since 2025, a privacy lid (<opaque>@lid).
// History sync and older traffic key chats by phone, live traffic by lid, so
// a single chat would otherwise land in two threads that split the day the
// account switched addressing modes. The phone jid is the canonical thread
// key whenever the pairing is known; this book holds the pairings.

export const jidUser = (jid: string): string => jid.split('@')[0].split(':')[0]
export const isGroupJid = (jid: string): boolean => jid.endsWith('@g.us')
export const isLidJid = (jid: string): boolean => jid.endsWith('@lid')
export const isPnJid = (jid: string): boolean => jid.endsWith('@s.whatsapp.net')

/** Drop the per-device suffix (`123:4@lid` → `123@lid`): chats are per account. */
const norm = (jid: string): string => `${jidUser(jid)}@${jid.split('@')[1] ?? ''}`

export class LidBook {
  private lidToPn = new Map<string, string>()
  private pnToLid = new Map<string, string>()

  /**
   * Record a lid/phone pairing from any source — message keys (remoteJid +
   * remoteJidAlt), contact records, history chats, Baileys' mapping store.
   * Either order; device suffixes tolerated. Returns 'new' for a first
   * pairing, 'remap' when a lid already pointed at another phone (numbers get
   * recycled — the caller should log it), false when nothing changed.
   */
  learn(a?: string | null, b?: string | null): false | 'new' | 'remap' {
    if (!a || !b) return false
    const x = norm(a)
    const y = norm(b)
    const lid = isLidJid(x) ? x : isLidJid(y) ? y : null
    const pn = isPnJid(x) ? x : isPnJid(y) ? y : null
    if (!lid || !pn) return false
    const before = this.lidToPn.get(lid)
    if (before === pn) return false
    if (before) this.pnToLid.delete(before)
    const prevLid = this.pnToLid.get(pn)
    if (prevLid && prevLid !== lid) this.lidToPn.delete(prevLid)
    this.lidToPn.set(lid, pn)
    this.pnToLid.set(pn, lid)
    return before ? 'remap' : 'new'
  }

  pnFor(lid: string): string | undefined {
    return this.lidToPn.get(norm(lid))
  }

  /** Whether these digits are a phone user already paired with a lid. */
  isKnownPn(user: string): boolean {
    return this.pnToLid.has(`${user}@s.whatsapp.net`)
  }

  /** The thread key for a chat jid: its phone jid when the lid is known, else itself. */
  canonical(jid: string): string {
    return isLidJid(jid) ? (this.lidToPn.get(norm(jid)) ?? jid) : jid
  }

  /** Every jid naming the same account, canonical first. */
  aliases(jid: string): string[] {
    const out = [this.canonical(jid)]
    const lid = isLidJid(jid) ? norm(jid) : this.pnToLid.get(norm(jid))
    if (lid && !out.includes(lid)) out.push(lid)
    if (!out.includes(jid)) out.push(jid)
    return out
  }

  /** The lids among `jids` with no known phone — what to ask the mapping store for. */
  unresolved(jids: Iterable<string>): string[] {
    const out = new Set<string>()
    for (const j of jids) if (isLidJid(j) && !this.pnFor(j)) out.add(j)
    return [...out]
  }
}

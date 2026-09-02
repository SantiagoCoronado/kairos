import type { CommsAccount } from '../../../core/comms-types'

/** Only Gmail accounts can send a new email; keeps rail order. */
export function gmailAccounts(accounts: readonly CommsAccount[] | undefined): CommsAccount[] {
  return (accounts ?? []).filter((a) => a.provider === 'gmail')
}

/**
 * Which account a new email is sent from when the pane opens: the account
 * selected in the rail if it is Gmail, else the account of the open thread if
 * that is Gmail, else the first Gmail account. `null` when there is none —
 * the caller hides Compose in that case.
 */
export function defaultComposeAccount(
  candidates: readonly CommsAccount[],
  selectedAccountId: string | null,
  threadAccountId: string | null
): CommsAccount | null {
  const byId = (id: string | null): CommsAccount | undefined =>
    id ? candidates.find((a) => a.id === id) : undefined
  return byId(selectedAccountId) ?? byId(threadAccountId) ?? candidates[0] ?? null
}

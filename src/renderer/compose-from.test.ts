import { describe, expect, it } from 'vitest'
import type { CommsAccount } from '../core/comms-types'
import { defaultComposeAccount, gmailAccounts } from './src/lib/compose-from'

function account(id: string, provider: CommsAccount['provider']): CommsAccount {
  return {
    id,
    provider,
    external_id: `${id}@example.com`,
    display_name: id,
    status: 'connected',
    error: null,
    sync_state: '{}',
    last_sync_at: null,
    sort_order: 0,
    created_at: '',
    updated_at: ''
  }
}

const work = account('work', 'gmail')
const personal = account('personal', 'gmail')
const slack = account('slack', 'slack')
const wa = account('wa', 'whatsapp')
const ALL = [slack, work, wa, personal]

describe('gmailAccounts', () => {
  it('keeps only gmail, in rail order', () => {
    expect(gmailAccounts(ALL)).toEqual([work, personal])
  })

  it('is empty before accounts load', () => {
    expect(gmailAccounts(undefined)).toEqual([])
  })
})

describe('defaultComposeAccount', () => {
  const gmail = gmailAccounts(ALL)

  it('prefers the account selected in the rail', () => {
    expect(defaultComposeAccount(gmail, 'personal', 'work')).toBe(personal)
  })

  it('falls back to the open thread account when the rail is on All inboxes', () => {
    expect(defaultComposeAccount(gmail, null, 'personal')).toBe(personal)
  })

  it('ignores a selected non-gmail account and uses the thread account', () => {
    expect(defaultComposeAccount(gmail, 'slack', 'personal')).toBe(personal)
  })

  it('ignores a non-gmail thread and uses the first gmail account', () => {
    expect(defaultComposeAccount(gmail, 'wa', 'wa')).toBe(work)
  })

  it('uses the first gmail account when nothing is selected or open', () => {
    expect(defaultComposeAccount(gmail, null, null)).toBe(work)
  })

  it('is null with no gmail accounts at all', () => {
    expect(defaultComposeAccount([], 'slack', null)).toBeNull()
  })
})

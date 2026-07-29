import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { DbDriver } from '../core/driver'
import type { CommsAccount } from '../core/comms-types'
import { openNodeSqliteDb } from '../core/drivers/node-sqlite'
import { migrate } from '../core/migrations'
import * as comms from '../core/repo/comms'

// gmail.ts reaches Electron (safeStorage for tokens, shell for the OAuth consent
// page) and the app's on-disk settings through its import chain. Ingest touches
// none of it — stub them so the module loads under plain node.
vi.mock('electron', () => ({
  safeStorage: { isEncryptionAvailable: () => false, encryptString: () => Buffer.alloc(0), decryptString: () => '' },
  shell: { openExternal: () => Promise.resolve() }
}))
vi.mock('./settings', () => ({ getSettings: () => ({}) }))

const { ingestGmailMessage } = await import('./comms/gmail')

const T0 = new Date('2026-07-29T13:49:00Z')

let db: DbDriver
let account: CommsAccount

beforeEach(() => {
  db = openNodeSqliteDb(':memory:')
  migrate(db)
  account = comms.upsertAccount(
    db,
    { provider: 'gmail', external_id: 'me@example.com', display_name: 'me@example.com' },
    T0
  )
})

afterEach(() => db.close())

function message(over: Record<string, unknown> = {}) {
  return {
    id: 'msg-1',
    threadId: 'thr-1',
    labelIds: ['SENT'],
    internalDate: String(T0.getTime()),
    payload: {
      headers: [
        { name: 'From', value: 'Santiago <me@example.com>' },
        { name: 'Subject', value: 'Evaluación Santiago Coronado' }
      ],
      mimeType: 'text/plain',
      body: { data: Buffer.from('Hola a todos,').toString('base64url') }
    },
    ...over
  }
}

describe('ingestGmailMessage draft guard', () => {
  it('ingests a sent message', () => {
    expect(ingestGmailMessage(db, account, message())).toBe(true)
    const thread = comms.listThreads(db)[0]
    expect(comms.listMessages(db, thread.id).map((m) => m.body_text)).toEqual(['Hola a todos,'])
  })

  it('skips a draft, and does not even create its thread', () => {
    expect(ingestGmailMessage(db, account, message({ labelIds: ['DRAFT'] }))).toBe(false)
    expect(comms.listMessages(db, 'thr-1')).toEqual([])
    expect(comms.listThreads(db)).toEqual([])
  })

  it('keeps one unsent mail from becoming a stack of autosave revisions', () => {
    // gmail hands every autosave a fresh message id on the same thread — exactly
    // what the history feed reported before the guard existed
    const revisions = ['', 'Hola a todos,', 'Hola a todos,\n\nLes comparto el link']
    revisions.forEach((body, i) => {
      ingestGmailMessage(
        db,
        account,
        message({
          id: `draft-rev-${i}`,
          labelIds: ['DRAFT'],
          payload: {
            headers: [
              { name: 'From', value: 'Santiago <me@example.com>' },
              { name: 'Subject', value: 'Evaluación Santiago Coronado' }
            ],
            mimeType: 'text/plain',
            body: { data: Buffer.from(body).toString('base64url') }
          }
        })
      )
    })
    // ...then the user actually sends it
    expect(ingestGmailMessage(db, account, message({ id: 'msg-sent' }))).toBe(true)

    const thread = comms.listThreads(db)[0]
    expect(comms.listMessages(db, thread.id).map((m) => m.external_id)).toEqual(['msg-sent'])
  })

  it('treats a message with no labelIds as ingestable', () => {
    expect(ingestGmailMessage(db, account, message({ labelIds: undefined }))).toBe(true)
  })
})

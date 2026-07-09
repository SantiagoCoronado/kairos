import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { DbDriver } from './driver'
import type { CommsAccount, CommsThread } from './comms-types'
import { openNodeSqliteDb } from './drivers/node-sqlite'
import { migrate, migrations } from './migrations'
import * as comms from './repo/comms'
import * as people from './repo/people'

const T0 = new Date('2026-07-01T12:00:00Z')
const later = (mins: number): Date => new Date(T0.getTime() + mins * 60 * 1000)

let db: DbDriver

beforeEach(() => {
  db = openNodeSqliteDb(':memory:')
  migrate(db)
})

afterEach(() => db.close())

function gmailAccount() {
  return comms.upsertAccount(db, {
    provider: 'gmail',
    external_id: 'me@example.com',
    display_name: 'me@example.com'
  }, T0)
}

function emailThread(accountId: string, externalId = 'thr-1') {
  return comms.upsertThread(db, {
    account_id: accountId,
    provider: 'gmail',
    external_id: externalId,
    kind: 'email',
    title: 'Quarterly sync'
  }, T0)
}

describe('accounts', () => {
  it('upserts by (provider, external_id) and clears error on reconnect', () => {
    const a = gmailAccount()
    comms.setAccountStatus(db, a.id, 'error', 'boom', T0)
    const again = comms.upsertAccount(db, {
      provider: 'gmail',
      external_id: 'me@example.com',
      display_name: 'Me'
    }, later(1))
    expect(again.id).toBe(a.id)
    expect(again.status).toBe('connected')
    expect(again.error).toBeNull()
    expect(comms.listAccounts(db)).toHaveLength(1)
  })

  it('merges sync_state patches', () => {
    const a = gmailAccount()
    comms.patchSyncState(db, a.id, { historyId: '100' }, T0)
    comms.patchSyncState(db, a.id, { other: true }, later(1))
    const state = JSON.parse(comms.getAccount(db, a.id)!.sync_state)
    expect(state).toEqual({ historyId: '100', other: true })
  })

  it('cascade-deletes threads, messages, credentials', () => {
    const a = gmailAccount()
    const t = emailThread(a.id)
    comms.setCredentialCipher(db, a.id, 'abc')
    comms.upsertMessage(db, {
      thread_id: t.id, account_id: a.id, provider: 'gmail',
      external_id: 'm1', sent_at: T0.toISOString(), body_text: 'hi'
    }, T0)
    comms.deleteAccount(db, a.id)
    expect(db.all('SELECT * FROM comms_threads')).toHaveLength(0)
    expect(db.all('SELECT * FROM comms_messages')).toHaveLength(0)
    expect(db.all('SELECT * FROM comms_credentials')).toHaveLength(0)
  })
})

describe('messages', () => {
  it('is idempotent on (account_id, external_id) and bumps the thread once', () => {
    const a = gmailAccount()
    const t = emailThread(a.id)
    const msg = {
      thread_id: t.id, account_id: a.id, provider: 'gmail' as const,
      external_id: 'm1', sender_handle: 'Anna@Example.com', sender_name: 'Anna',
      sent_at: T0.toISOString(), body_text: '  hello   world  '
    }
    expect(comms.upsertMessage(db, msg, T0)).toBe(true)
    expect(comms.upsertMessage(db, msg, T0)).toBe(false)

    const thread = comms.getThread(db, t.id)!
    expect(thread.unread_count).toBe(1)
    expect(thread.snippet).toBe('hello world')
    expect(thread.last_message_at).toBe(T0.toISOString())
    // handle normalized
    const rows = comms.listMessages(db, t.id)
    expect(rows).toHaveLength(1)
    expect(rows[0].sender_handle).toBe('anna@example.com')
  })

  it('does not count own or already-read messages as unread', () => {
    const a = gmailAccount()
    const t = emailThread(a.id)
    comms.upsertMessage(db, {
      thread_id: t.id, account_id: a.id, provider: 'gmail',
      external_id: 'm1', is_me: true, sent_at: T0.toISOString(), body_text: 'sent by me'
    }, T0)
    comms.upsertMessage(db, {
      thread_id: t.id, account_id: a.id, provider: 'gmail',
      external_id: 'm2', is_read: true, sent_at: later(1).toISOString(), body_text: 'read'
    }, later(1))
    expect(comms.getThread(db, t.id)!.unread_count).toBe(0)
    expect(comms.unreadTotal(db)).toBe(0)
  })

  it('does not regress last_message_at on out-of-order backfill', () => {
    const a = gmailAccount()
    const t = emailThread(a.id)
    comms.upsertMessage(db, {
      thread_id: t.id, account_id: a.id, provider: 'gmail',
      external_id: 'new', sent_at: later(10).toISOString(), body_text: 'newest'
    }, later(10))
    comms.upsertMessage(db, {
      thread_id: t.id, account_id: a.id, provider: 'gmail',
      external_id: 'old', sent_at: T0.toISOString(), body_text: 'older backfill'
    }, later(11))
    const thread = comms.getThread(db, t.id)!
    expect(thread.last_message_at).toBe(later(10).toISOString())
    expect(thread.snippet).toBe('newest')
  })

  it('markThreadRead zeroes unread and flags messages', () => {
    const a = gmailAccount()
    const t = emailThread(a.id)
    comms.upsertMessage(db, {
      thread_id: t.id, account_id: a.id, provider: 'gmail',
      external_id: 'm1', sent_at: T0.toISOString(), body_text: 'x'
    }, T0)
    expect(comms.unreadTotal(db)).toBe(1)
    comms.markThreadRead(db, t.id, later(1))
    expect(comms.unreadTotal(db)).toBe(0)
    expect(comms.listMessages(db, t.id)[0].is_read).toBe(1)
  })
})

describe('person resolution', () => {
  it('auto-links gmail senders by email, case-insensitively', () => {
    const anna = people.upsertPerson(db, { name: 'Anna', email: 'Anna@Example.com' }, T0)
    const a = gmailAccount()
    const t = emailThread(a.id)
    comms.upsertMessage(db, {
      thread_id: t.id, account_id: a.id, provider: 'gmail',
      external_id: 'm1', sender_handle: 'anna@example.com',
      sent_at: T0.toISOString(), body_text: 'hi'
    }, T0)
    expect(comms.listMessages(db, t.id)[0].person_id).toBe(anna.id)
    // identity row was cached
    expect(db.all('SELECT * FROM comms_identities')).toHaveLength(1)
  })

  it('auto-links whatsapp senders by phone digit-suffix', () => {
    const bo = people.upsertPerson(db, { name: 'Bo', phone: '+52 1 55 1234 5678' }, T0)
    const a = comms.upsertAccount(db, {
      provider: 'whatsapp', external_id: '5215512345678@s.whatsapp.net', display_name: '+52 155…'
    }, T0)
    const t = comms.upsertThread(db, {
      account_id: a.id, provider: 'whatsapp', external_id: 'chat-1', kind: 'dm', title: 'Bo'
    }, T0)
    comms.upsertMessage(db, {
      thread_id: t.id, account_id: a.id, provider: 'whatsapp',
      external_id: 'w1', sender_handle: '5215512345678',
      sent_at: T0.toISOString(), body_text: 'hola'
    }, T0)
    expect(comms.listMessages(db, t.id)[0].person_id).toBe(bo.id)
  })

  it('slack senders stay unlinked until linked manually, then backfills', () => {
    const casey = people.upsertPerson(db, { name: 'Casey' }, T0)
    const a = comms.upsertAccount(db, {
      provider: 'slack', external_id: 'T1:U1', display_name: 'Acme'
    }, T0)
    const t = comms.upsertThread(db, {
      account_id: a.id, provider: 'slack', external_id: 'D123', kind: 'dm', title: 'casey'
    }, T0)
    comms.upsertMessage(db, {
      thread_id: t.id, account_id: a.id, provider: 'slack',
      external_id: '1.001', sender_handle: 'U42', sender_name: 'Casey',
      sent_at: T0.toISOString(), body_text: 'yo'
    }, T0)
    expect(comms.listMessages(db, t.id)[0].person_id).toBeNull()

    comms.linkHandleToPerson(db, 'slack', 'u42', casey.id, later(1))
    expect(comms.listMessages(db, t.id)[0].person_id).toBe(casey.id)
  })
})

describe('threads', () => {
  it('filters by unread/account/search and hides sync-disabled threads', () => {
    const a = gmailAccount()
    const t1 = emailThread(a.id, 'thr-1')
    const t2 = comms.upsertThread(db, {
      account_id: a.id, provider: 'gmail', external_id: 'thr-2', kind: 'email', title: 'Newsletter'
    }, T0)
    for (const [t, ext] of [[t1, 'm1'], [t2, 'm2']] as const) {
      comms.upsertMessage(db, {
        thread_id: t.id, account_id: a.id, provider: 'gmail',
        external_id: ext, sent_at: T0.toISOString(), body_text: 'body'
      }, T0)
    }
    comms.markThreadRead(db, t2.id, later(1))
    expect(comms.listThreads(db, {})).toHaveLength(2)
    expect(comms.listThreads(db, { unreadOnly: true })).toHaveLength(1)
    expect(comms.listThreads(db, { search: 'Newslet' })).toHaveLength(1)
    comms.setThreadSyncEnabled(db, t2.id, false, later(1))
    expect(comms.listThreads(db, {})).toHaveLength(1)
    expect(comms.listThreads(db, { includeDisabled: true })).toHaveLength(2)
  })
})

describe('thread title upserts', () => {
  const waAccount = () =>
    comms.upsertAccount(db, {
      provider: 'whatsapp', external_id: '521555@s.whatsapp.net', display_name: '+521555'
    }, T0)
  const upsert = (accountId: string, title: string, at = T0) =>
    comms.upsertThread(db, {
      account_id: accountId, provider: 'whatsapp', external_id: 'abc123@lid', kind: 'dm', title
    }, at)

  it('a real name replaces a placeholder title', () => {
    const a = waAccount()
    upsert(a.id, 'WhatsApp chat')
    expect(upsert(a.id, 'Rodrigo Vega', later(1)).title).toBe('Rodrigo Vega')
  })

  it('a placeholder never clobbers a real name (outbound-message regression)', () => {
    const a = waAccount()
    upsert(a.id, 'Rodrigo Vega')
    // outbound messages compute 'WhatsApp chat' when the name book is cold
    expect(upsert(a.id, 'WhatsApp chat', later(1)).title).toBe('Rodrigo Vega')
    expect(upsert(a.id, '+5215551234', later(2)).title).toBe('Rodrigo Vega')
    expect(upsert(a.id, 'Group', later(3)).title).toBe('Rodrigo Vega')
  })

  it('a real name still replaces another real name (contact renames)', () => {
    const a = waAccount()
    upsert(a.id, 'Rodrigo Vega')
    expect(upsert(a.id, 'Rodrigo Vega (work)', later(1)).title).toBe('Rodrigo Vega (work)')
  })

  it('a placeholder may replace another placeholder', () => {
    const a = waAccount()
    upsert(a.id, 'WhatsApp chat')
    expect(upsert(a.id, '+5215551234', later(1)).title).toBe('+5215551234')
  })
})

describe('contact name matching', () => {
  it('canonicalizes legacy WhatsApp mobile prefixes (MX 521→52, AR 549→54)', () => {
    expect(comms.canonicalPhoneDigits('5215515988976')).toBe('525515988976')
    expect(comms.canonicalPhoneDigits('5491133334444')).toBe('541133334444')
    expect(comms.canonicalPhoneDigits('14155551234')).toBe('14155551234')
  })

  it('names threads from an address book across MX prefix and formatting differences', () => {
    const a = comms.upsertAccount(db, {
      provider: 'whatsapp', external_id: '5215516273510@s.whatsapp.net', display_name: '+52…'
    }, T0)
    const mk = (jid: string, ext: string): ReturnType<typeof comms.upsertThread> => {
      const t = comms.upsertThread(db, {
        account_id: a.id, provider: 'whatsapp', external_id: jid, kind: 'dm'
      }, T0)
      comms.upsertMessage(db, {
        thread_id: t.id, account_id: a.id, provider: 'whatsapp', external_id: ext,
        sender_handle: jid.split('@')[0], sender_name: `+${jid.split('@')[0]}`,
        sent_at: T0.toISOString(), body_text: 'hola'
      }, T0)
      comms.setThreadTitle(db, t.id, `+${jid.split('@')[0]}`, T0)
      return t
    }
    // legacy MX jid (521…) vs contact saved without the mobile '1'
    const vero = mk('5215515988976@s.whatsapp.net', 'w1')
    // US number, straightforward
    const us = mk('14155551234@s.whatsapp.net', 'w2')
    // lid chat — must stay untouched
    const lid = comms.upsertThread(db, {
      account_id: a.id, provider: 'whatsapp', external_id: '123456789@lid', kind: 'dm', title: 'WhatsApp chat'
    }, T0)

    const changed = comms.applyContactNames(db, a.id, [
      { name: 'Veronica Coronado', phones: ['+52 55 1598 8976'] },
      { name: 'Sam US', phones: ['+1 (415) 555-1234'] }
    ], T0)

    expect(changed).toBe(true)
    expect(comms.getThread(db, vero.id)!.title).toBe('Veronica Coronado')
    expect(comms.getThread(db, us.id)!.title).toBe('Sam US')
    expect(comms.getThread(db, lid.id)!.title).toBe('WhatsApp chat')
    // sender names fixed too
    expect(comms.listMessages(db, vero.id)[0].sender_name).toBe('Veronica Coronado')
    // named threads never get overwritten by later sweeps
    comms.applyContactNames(db, a.id, [{ name: 'Wrong Person', phones: ['+52 55 1598 8976'] }], T0)
    expect(comms.getThread(db, vero.id)!.title).toBe('Veronica Coronado')
  })
})

describe('migration 005', () => {
  it('backfills is_inbox from raw_json labelIds and is_archived per thread', () => {
    // simulate a DB that stopped at migration 004 with synced gmail mail
    const old = openNodeSqliteDb(':memory:')
    old.exec(`CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );`)
    for (let i = 0; i < 4; i++) old.exec(migrations[i])
    old.run('INSERT INTO schema_migrations (version) VALUES (1), (2), (3), (4)')
    const ts = T0.toISOString()
    old.run(
      `INSERT INTO comms_accounts (id, provider, external_id, display_name, created_at, updated_at)
       VALUES ('a1', 'gmail', 'me@example.com', 'me', ?, ?)`,
      ts, ts
    )
    const mkThread = (id: string): void => {
      old.run(
        `INSERT INTO comms_threads (id, account_id, provider, external_id, kind, last_message_at, created_at, updated_at)
         VALUES (?, 'a1', 'gmail', ?, 'email', ?, ?, ?)`,
        id, `ext-${id}`, ts, ts, ts
      )
    }
    const mkMsg = (id: string, threadId: string, rawJson: string | null): void => {
      old.run(
        `INSERT INTO comms_messages (id, thread_id, account_id, provider, external_id, sent_at, body_text, raw_json, created_at)
         VALUES (?, ?, 'a1', 'gmail', ?, ?, 'the word INBOX in a body changes nothing', ?, ?)`,
        id, threadId, `ext-${id}`, ts, rawJson, ts
      )
    }
    mkThread('t-in')
    mkThread('t-arch')
    mkMsg('m1', 't-in', JSON.stringify({ headers: {}, labelIds: ['INBOX', 'UNREAD'] }))
    mkMsg('m2', 't-arch', JSON.stringify({ headers: {}, labelIds: [] }))
    mkMsg('m3', 't-arch', 'not json {')
    mkMsg('m4', 't-arch', null)

    migrate(old)

    const inbox = Object.fromEntries(
      old.all<{ id: string; is_inbox: number }>('SELECT id, is_inbox FROM comms_messages')
        .map((r) => [r.id, r.is_inbox])
    )
    expect(inbox).toEqual({ m1: 1, m2: 0, m3: 0, m4: 0 })
    expect(old.get<{ is_archived: number }>("SELECT is_archived FROM comms_threads WHERE id = 't-in'")!.is_archived).toBe(0)
    expect(old.get<{ is_archived: number }>("SELECT is_archived FROM comms_threads WHERE id = 't-arch'")!.is_archived).toBe(1)
    expect(old.get<{ sort_order: number }>('SELECT sort_order FROM comms_accounts')!.sort_order).toBe(1)
    old.close()
  })
})

describe('account ordering', () => {
  const mk = (email: string, at: Date): CommsAccount =>
    comms.upsertAccount(db, { provider: 'gmail', external_id: email, display_name: email }, at)

  it('lists by sort_order and appends new accounts at the end', () => {
    const a = mk('a@x.com', T0)
    const b = mk('b@x.com', later(1))
    const c = mk('c@x.com', later(2))
    expect(comms.listAccounts(db).map((x) => x.id)).toEqual([a.id, b.id, c.id])
  })

  it('moveAccountBefore reorders and throws on unknown ids', () => {
    const a = mk('a@x.com', T0)
    const b = mk('b@x.com', later(1))
    const c = mk('c@x.com', later(2))
    comms.moveAccountBefore(db, c.id, a.id, later(3))
    expect(comms.listAccounts(db).map((x) => x.id)).toEqual([c.id, a.id, b.id])
    comms.moveAccountBefore(db, c.id, null, later(4))
    expect(comms.listAccounts(db).map((x) => x.id)).toEqual([a.id, b.id, c.id])
    expect(() => comms.moveAccountBefore(db, 'nope', null)).toThrow()
    expect(() => comms.moveAccountBefore(db, a.id, 'nope')).toThrow()
  })
})

describe('archive', () => {
  const seed = (): { a: CommsAccount; t: CommsThread } => {
    const a = gmailAccount()
    const t = emailThread(a.id)
    comms.upsertMessage(db, {
      thread_id: t.id, account_id: a.id, provider: 'gmail',
      external_id: 'm1', sent_at: T0.toISOString(), body_text: 'hi'
    }, T0)
    return { a, t }
  }

  it('setThreadArchived flips the thread and mirrors gmail message is_inbox', () => {
    const { t } = seed()
    comms.setThreadArchived(db, t.id, true, later(1))
    expect(comms.getThread(db, t.id)!.is_archived).toBe(1)
    expect(comms.listMessages(db, t.id)[0].is_inbox).toBe(0)
    expect(comms.listThreads(db, {})).toHaveLength(0)
    expect(comms.listThreads(db, { box: 'archived' })).toHaveLength(1)
    expect(comms.listThreads(db, { box: 'all' })).toHaveLength(1)
    comms.setThreadArchived(db, t.id, false, later(2))
    expect(comms.getThread(db, t.id)!.is_archived).toBe(0)
    expect(comms.listMessages(db, t.id)[0].is_inbox).toBe(1)
  })

  it('archived threads do not count toward unreadTotal', () => {
    const { t } = seed()
    expect(comms.unreadTotal(db)).toBe(1)
    comms.setThreadArchived(db, t.id, true, later(1))
    expect(comms.unreadTotal(db)).toBe(0)
  })

  it('new inbox mail resurfaces an archived thread; archived mail does not', () => {
    const { a, t } = seed()
    comms.setThreadArchived(db, t.id, true, later(1))
    comms.upsertMessage(db, {
      thread_id: t.id, account_id: a.id, provider: 'gmail',
      external_id: 'm2', sent_at: later(2).toISOString(), body_text: 'sent copy', is_inbox: false
    }, later(2))
    expect(comms.getThread(db, t.id)!.is_archived).toBe(1)
    comms.upsertMessage(db, {
      thread_id: t.id, account_id: a.id, provider: 'gmail',
      external_id: 'm3', sent_at: later(3).toISOString(), body_text: 'new reply'
    }, later(3))
    expect(comms.getThread(db, t.id)!.is_archived).toBe(0)
  })

  it('applyGmailLabelEvent + recomputeThreadState track remote read/archive', () => {
    const { a, t } = seed()
    // remote read
    expect(comms.applyGmailLabelEvent(db, a.id, 'm1', { read: true })).toBe(t.id)
    comms.recomputeThreadState(db, t.id, later(1))
    expect(comms.getThread(db, t.id)!.unread_count).toBe(0)
    // remote archive
    comms.applyGmailLabelEvent(db, a.id, 'm1', { inbox: false })
    comms.recomputeThreadState(db, t.id, later(2))
    expect(comms.getThread(db, t.id)!.is_archived).toBe(1)
    // remote un-archive
    comms.applyGmailLabelEvent(db, a.id, 'm1', { inbox: true })
    comms.recomputeThreadState(db, t.id, later(3))
    expect(comms.getThread(db, t.id)!.is_archived).toBe(0)
    // unknown message (pre-backfill) is a no-op
    expect(comms.applyGmailLabelEvent(db, a.id, 'ghost', { read: true })).toBeNull()
  })
})

describe('markThreadUnread', () => {
  it('re-flags only the newest inbound message and returns its external id', () => {
    const a = gmailAccount()
    const t = emailThread(a.id)
    for (const [ext, mins] of [['m1', 0], ['m2', 5]] as const) {
      comms.upsertMessage(db, {
        thread_id: t.id, account_id: a.id, provider: 'gmail',
        external_id: ext, sent_at: later(mins).toISOString(), body_text: ext
      }, later(mins))
    }
    comms.markThreadRead(db, t.id, later(10))
    expect(comms.getThread(db, t.id)!.unread_count).toBe(0)

    expect(comms.markThreadUnread(db, t.id, later(11))).toBe('m2')
    expect(comms.getThread(db, t.id)!.unread_count).toBe(1)
    const msgs = comms.listMessages(db, t.id)
    expect(msgs.find((m) => m.external_id === 'm1')!.is_read).toBe(1)
    expect(msgs.find((m) => m.external_id === 'm2')!.is_read).toBe(0)
    // thread with no inbound messages → null
    const empty = comms.upsertThread(db, {
      account_id: a.id, provider: 'gmail', external_id: 'thr-empty', kind: 'email'
    }, T0)
    expect(comms.markThreadUnread(db, empty.id)).toBeNull()
  })
})

describe('deleteThread', () => {
  it('removes the thread and cascades its messages', () => {
    const a = gmailAccount()
    const t = emailThread(a.id)
    comms.upsertMessage(db, {
      thread_id: t.id, account_id: a.id, provider: 'gmail',
      external_id: 'm1', sent_at: T0.toISOString(), body_text: 'bye'
    }, T0)
    comms.deleteThread(db, t.id)
    expect(comms.getThread(db, t.id)).toBeUndefined()
    expect(db.all('SELECT * FROM comms_messages')).toHaveLength(0)
  })
})

describe('fillMessageHtml', () => {
  it('fills missing body_html without touching read state, never overwrites', () => {
    const a = gmailAccount()
    const t = emailThread(a.id)
    comms.upsertMessage(db, {
      thread_id: t.id, account_id: a.id, provider: 'gmail',
      external_id: 'm1', sent_at: T0.toISOString(), body_text: 'plain only'
    }, T0)
    expect(comms.fillMessageHtml(db, a.id, 'm1', '<p>hi</p>')).toBe(true)
    const [msg] = comms.listMessages(db, t.id)
    expect(msg.body_html).toBe('<p>hi</p>')
    expect(comms.getThread(db, t.id)!.unread_count).toBe(1) // unchanged
    // already filled → no overwrite
    expect(comms.fillMessageHtml(db, a.id, 'm1', '<p>other</p>')).toBe(false)
    expect(comms.listMessages(db, t.id)[0].body_html).toBe('<p>hi</p>')
    // unknown message → no-op
    expect(comms.fillMessageHtml(db, a.id, 'ghost', '<p>x</p>')).toBe(false)
  })
})

describe('thread person join', () => {
  it('returns the linked person of the latest inbound sender', () => {
    const anna = people.upsertPerson(db, { name: 'Anna', email: 'anna@example.com' }, T0)
    const a = gmailAccount()
    const t = emailThread(a.id)
    comms.upsertMessage(db, {
      thread_id: t.id, account_id: a.id, provider: 'gmail',
      external_id: 'm1', sender_handle: 'anna@example.com',
      sent_at: T0.toISOString(), body_text: 'hi'
    }, T0)
    // my own reply later must not shadow the inbound sender
    comms.upsertMessage(db, {
      thread_id: t.id, account_id: a.id, provider: 'gmail',
      external_id: 'm2', is_me: true, sent_at: later(1).toISOString(), body_text: 'reply'
    }, later(1))
    const [row] = comms.listThreads(db, {})
    expect(row.person_id).toBe(anna.id)
    expect(row.person_name).toBe('Anna')
  })

  it('returns null person for unlinked threads', () => {
    const a = gmailAccount()
    const t = emailThread(a.id)
    comms.upsertMessage(db, {
      thread_id: t.id, account_id: a.id, provider: 'gmail',
      external_id: 'm1', sender_handle: 'stranger@example.com',
      sent_at: T0.toISOString(), body_text: 'hi'
    }, T0)
    const [row] = comms.listThreads(db, {})
    expect(row.person_id).toBeNull()
    expect(row.person_name).toBeNull()
  })
})

describe('outbox', () => {
  it('claims queued items exactly once', () => {
    const a = gmailAccount()
    comms.enqueueOutbox(db, {
      account_id: a.id, provider: 'gmail',
      to_json: JSON.stringify({ to: ['x@y.z'], subject: 'hi' }), body_text: 'b'
    }, T0)
    const first = comms.claimQueued(db)
    expect(first).toHaveLength(1)
    expect(first[0].status).toBe('sending')
    expect(comms.claimQueued(db)).toHaveLength(0)
  })

  it('finishOutbox records sent/failed, requeueStuckSending resets', () => {
    const a = gmailAccount()
    const item = comms.enqueueOutbox(db, {
      account_id: a.id, provider: 'gmail', to_json: '{}', body_text: 'b', source: 'agent'
    }, T0)
    const [claimed] = comms.claimQueued(db)
    comms.finishOutbox(db, claimed.id, { ok: false, error: 'network' }, later(1))
    expect(comms.getOutboxItem(db, item.id)!.status).toBe('failed')

    const item2 = comms.enqueueOutbox(db, {
      account_id: a.id, provider: 'gmail', to_json: '{}', body_text: 'c'
    }, later(2))
    comms.claimQueued(db)
    expect(comms.requeueStuckSending(db)).toBe(1)
    const [reclaimed] = comms.claimQueued(db)
    comms.finishOutbox(db, reclaimed.id, { ok: true, external_id: 'srv-9' }, later(3))
    const done = comms.getOutboxItem(db, item2.id)!
    expect(done.status).toBe('sent')
    expect(done.external_id).toBe('srv-9')
  })
})

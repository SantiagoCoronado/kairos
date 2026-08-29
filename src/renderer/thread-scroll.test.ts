import { describe, it, expect } from 'vitest'
import { threadScrollTarget, type ThreadScrollKey } from './src/lib/thread-scroll'

const key = (over: Partial<ThreadScrollKey> = {}): ThreadScrollKey => ({
  threadId: 't1',
  newestId: 'm9',
  pendingCount: 0,
  ...over
})

describe('threadScrollTarget', () => {
  it('opens an email thread on the newest message, a chat on the bottom', () => {
    expect(threadScrollTarget(null, key(), 'gmail')).toBe('latest-start')
    expect(threadScrollTarget(null, key(), 'whatsapp')).toBe('bottom')
    expect(threadScrollTarget(null, key(), 'slack')).toBe('bottom')
  })

  it('switching threads is an open, not a new message', () => {
    expect(threadScrollTarget(key({ threadId: 't0' }), key(), 'gmail')).toBe('latest-start')
  })

  it('a refetch with the same newest message does not scroll', () => {
    // mark-read and background syncs both broadcast db:changed → refetch
    expect(threadScrollTarget(key(), key(), 'gmail')).toBeNull()
    expect(threadScrollTarget(key(), key(), 'whatsapp')).toBeNull()
  })

  it('a new message at the end scrolls to the bottom for any provider', () => {
    expect(threadScrollTarget(key(), key({ newestId: 'm10' }), 'gmail')).toBe('bottom')
    expect(threadScrollTarget(key(), key({ newestId: 'm10' }), 'whatsapp')).toBe('bottom')
  })

  it('queuing a send scrolls to the bottom; its state changes do not', () => {
    expect(threadScrollTarget(key(), key({ pendingCount: 1 }), 'gmail')).toBe('bottom')
    // queued → committed → sent re-renders with the same count
    expect(threadScrollTarget(key({ pendingCount: 1 }), key({ pendingCount: 1 }), 'gmail')).toBeNull()
    // the echo retiring (count drops) is not a reason to move either
    expect(threadScrollTarget(key({ pendingCount: 1 }), key(), 'gmail')).toBeNull()
  })
})

import { describe, it, expect, beforeEach } from 'vitest'
import type { BrowserWindow } from 'electron'
import { deliverDeepLink, claimDeepLink } from './deeplink'

// The handshake is the fix for issue #99, so the tests assert on the
// HANDOVER, not on send timing: a stashed link is claimable, a claim
// consumes it, and staleness expires it. (The "close window → click the
// banner" manual test can pass by luck on a fast machine — these can't.)

const T0 = 1_754_000_000_000

function fakeWin(): { win: BrowserWindow; sends: { channel: string; payload: unknown }[] } {
  const sends: { channel: string; payload: unknown }[] = []
  const win = {
    webContents: { send: (channel: string, payload: unknown) => sends.push({ channel, payload }) }
  } as unknown as BrowserWindow
  return { win, sends }
}

describe('notification deep-link handshake', () => {
  // the stash is a one-shot module-level global — drain it so no test
  // depends on what the previous one left behind
  beforeEach(() => void claimDeepLink(Infinity))

  it('stashes on deliver and hands the link to the first claim', () => {
    const { win, sends } = fakeWin()
    deliverDeepLink(win, { view: 'pending', id: 'agent_run:r1' }, T0)
    // the opportunistic send still goes out for an already-mounted window
    expect(sends).toEqual([
      { channel: 'nav:goto', payload: { view: 'pending', id: 'agent_run:r1' } }
    ])
    // cold window: the send was lost, the mount-claim retrieves the link
    expect(claimDeepLink(T0 + 2_000)).toEqual({ view: 'pending', id: 'agent_run:r1' })
  })

  it('claims are one-shot — the second ask gets nothing', () => {
    const { win } = fakeWin()
    deliverDeepLink(win, { view: 'notes', id: 'n1' }, T0)
    expect(claimDeepLink(T0 + 1_000)).toEqual({ view: 'notes', id: 'n1' })
    expect(claimDeepLink(T0 + 1_001)).toBeNull()
  })

  it('a stale link is not claimable — an old unclaimed stash cannot hijack a later launch', () => {
    const { win } = fakeWin()
    deliverDeepLink(win, { view: 'calendar', id: 'm1' }, T0)
    expect(claimDeepLink(T0 + 10 * 60_000)).toBeNull()
    // and the expired link is gone, not resurrectable
    expect(claimDeepLink(T0 + 10 * 60_000 + 1)).toBeNull()
  })

  it('a newer notification replaces an unclaimed older one', () => {
    const { win } = fakeWin()
    deliverDeepLink(win, { view: 'notes', id: 'old' }, T0)
    deliverDeepLink(win, { view: 'pending', id: 'agent_run:new' }, T0 + 5_000)
    expect(claimDeepLink(T0 + 6_000)).toEqual({ view: 'pending', id: 'agent_run:new' })
    expect(claimDeepLink(T0 + 6_001)).toBeNull()
  })

  it('claiming with no stash is a clean null (every ordinary app launch)', () => {
    expect(claimDeepLink(T0)).toBeNull()
  })
})

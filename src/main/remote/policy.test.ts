import { describe, it, expect } from 'vitest'
import { isDeniedChannel } from './policy'

const local = { remoteTerminal: false }
const optedIn = { remoteTerminal: true }

describe('isDeniedChannel', () => {
  it.each([
    'meetings:start',
    'meetings:stop',
    'meetings:pause',
    'meetings:resume',
    'meetings:chunk',
    'meetings:delete',
    'meetings:summarize',
    'meetings:retranscribe',
    'meetings:reveal'
  ])('refuses the live-capture / paid mutation %s regardless of settings', (channel) => {
    expect(isDeniedChannel(channel, local)).toBe(true)
    expect(isDeniedChannel(channel, optedIn)).toBe(true)
  })

  it.each([
    'meetings:list',
    'meetings:get',
    'meetings:active',
    'meetings:audioData',
    'meetings:undoTasks',
    'meetings:rename'
  ])(
    'allows the meeting read / scoped undo %s',
    (channel) => {
      expect(isDeniedChannel(channel, local)).toBe(false)
    }
  )

  it('refuses capture window management but allows the DB-write submits', () => {
    expect(isDeniedChannel('capture:hide', local)).toBe(true)
    expect(isDeniedChannel('capture:show', local)).toBe(true)
    expect(isDeniedChannel('capture:submit', local)).toBe(false)
    expect(isDeniedChannel('capture:smart', local)).toBe(false)
    // prefix tricks don't slip past the anchored alternatives
    expect(isDeniedChannel('capture:submitAll', local)).toBe(true)
  })

  it('gates terminal:* on the remoteTerminal opt-in', () => {
    expect(isDeniedChannel('terminal:write', local)).toBe(true)
    expect(isDeniedChannel('terminal:write', optedIn)).toBe(false)
  })

  it('leaves ordinary channels alone', () => {
    expect(isDeniedChannel('tasks:list', local)).toBe(false)
    expect(isDeniedChannel('settings:get', local)).toBe(false)
  })
})

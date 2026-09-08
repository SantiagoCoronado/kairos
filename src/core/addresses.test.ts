import { describe, it, expect } from 'vitest'
import { recipientEmails, isMailToSelf } from './addresses'

describe('recipientEmails', () => {
  it('handles bare, named, quoted-with-comma and mixed-case forms', () => {
    expect(recipientEmails('me@x.com')).toEqual(['me@x.com'])
    expect(recipientEmails('Me <Me@X.com>')).toEqual(['me@x.com'])
    expect(recipientEmails('"Coronado, Santiago" <s@x.com>, devs@lists.org')).toEqual(['s@x.com', 'devs@lists.org'])
    expect(recipientEmails('')).toEqual([])
  })
})

describe('isMailToSelf', () => {
  const me = 'me@x.com'
  it('is true only when you are the sole recipient', () => {
    expect(isMailToSelf({ to: 'me@x.com' }, me)).toBe(true)
    expect(isMailToSelf({ to: 'Me <ME@x.com>', cc: '' }, me)).toBe(true)
    expect(isMailToSelf({ to: 'me@x.com, me@x.com' }, me)).toBe(true)
  })
  it('is false with a list anywhere on the line, an unknown cc, or nothing to parse', () => {
    expect(isMailToSelf({ to: 'devs@googlegroups.com, me@x.com' }, me)).toBe(false)
    expect(isMailToSelf({ to: 'me@x.com', cc: 'boss@x.com' }, me)).toBe(false)
    expect(isMailToSelf({ to: 'devs@googlegroups.com' }, me)).toBe(false)
    expect(isMailToSelf({ to: '' }, me)).toBe(false)
    expect(isMailToSelf(undefined, me)).toBe(false)
  })
  it('never treats _ or % in the address as wildcards', () => {
    expect(isMailToSelf({ to: 'firstXlast@corp.com' }, 'first_last@corp.com')).toBe(false)
  })
})

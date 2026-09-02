import { describe, expect, it } from 'vitest'
import { cssTimeToMs, escapeExitsWriting, isWritingShortcut, writingActive } from './src/lib/writing-mode'

describe('writingActive', () => {
  it('folds only while a composer is on screen', () => {
    expect(writingActive(true, true, false)).toBe(true)
    expect(writingActive(true, false, false)).toBe(false)
  })

  it('never folds without the preference', () => {
    expect(writingActive(false, true, false)).toBe(false)
  })

  it('never folds on the phone', () => {
    expect(writingActive(true, true, true)).toBe(false)
  })
})

describe('isWritingShortcut', () => {
  const key = (over: Partial<Parameters<typeof isWritingShortcut>[0]>) => ({
    key: 'E',
    metaKey: true,
    ctrlKey: false,
    shiftKey: true,
    altKey: false,
    ...over
  })

  it('matches ⌘⇧E, whichever case the key reports', () => {
    expect(isWritingShortcut(key({}))).toBe(true)
    expect(isWritingShortcut(key({ key: 'e' }))).toBe(true)
  })

  it('accepts Ctrl in place of ⌘', () => {
    expect(isWritingShortcut(key({ metaKey: false, ctrlKey: true }))).toBe(true)
  })

  it('leaves plain ⌘E, ⇧E and ⌥ chords alone', () => {
    expect(isWritingShortcut(key({ shiftKey: false }))).toBe(false)
    expect(isWritingShortcut(key({ metaKey: false }))).toBe(false)
    expect(isWritingShortcut(key({ altKey: true }))).toBe(false)
  })

  it('ignores other letters', () => {
    expect(isWritingShortcut(key({ key: 'B' }))).toBe(false)
  })
})

describe('escapeExitsWriting', () => {
  it('exits from an empty or whitespace-only box', () => {
    expect(escapeExitsWriting(true, '')).toBe(true)
    expect(escapeExitsWriting(true, '  \n')).toBe(true)
  })

  it('keeps the mode while there is a draft', () => {
    expect(escapeExitsWriting(true, 'Hola')).toBe(false)
  })

  it('is a no-op outside the mode', () => {
    expect(escapeExitsWriting(false, '')).toBe(false)
  })
})

describe('cssTimeToMs', () => {
  it('reads the minified seconds form the build emits', () => {
    expect(cssTimeToMs('.35s', 0)).toBe(350)
    expect(cssTimeToMs('0.25s', 0)).toBe(250)
  })

  it('reads milliseconds, with the whitespace getPropertyValue keeps', () => {
    expect(cssTimeToMs(' 350ms', 0)).toBe(350)
  })

  it('falls back when the token is missing or not a time', () => {
    expect(cssTimeToMs('', 350)).toBe(350)
    expect(cssTimeToMs('fast', 350)).toBe(350)
  })
})

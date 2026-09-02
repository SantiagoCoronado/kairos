import { useEffect, useRef, useState } from 'react'
import { motionMs } from './motion'

/**
 * Writing mode folds the Inbox columns (account rail, thread list) and the
 * app sidebar so a long email gets the width, while the thread being
 * answered stays on screen above the composer.
 */

/** Remembered for the session only — a fresh launch starts unfolded. */
export const WRITING_MODE_KEY = 'kairos.inbox.writingMode'

export function readWritingPref(): boolean {
  try {
    return sessionStorage.getItem(WRITING_MODE_KEY) === '1'
  } catch {
    return false
  }
}

export function writeWritingPref(on: boolean): void {
  try {
    if (on) sessionStorage.setItem(WRITING_MODE_KEY, '1')
    else sessionStorage.removeItem(WRITING_MODE_KEY)
  } catch {
    // storage blocked — the mode still works for this mount
  }
}

/**
 * The preference only bites while a composer is on screen: with no thread
 * open and no new email, folded columns would leave nothing to click. Never
 * on the phone, where the pane already is the whole screen.
 */
export function writingActive(pref: boolean, hasComposer: boolean, mobile: boolean): boolean {
  return pref && hasComposer && !mobile
}

/** ⌘⇧E (Ctrl+Shift+E elsewhere) — works inside a text field, unlike the
 *  single-letter Inbox shortcuts, since typing is exactly when it's wanted. */
export function isWritingShortcut(e: {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
}): boolean {
  return (e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'e'
}

/**
 * Whether the mode may enter on its own right now. `armed` is cleared by a
 * manual exit (toggle, chevron, Escape) so the fold never fights the user,
 * and set again once the message is sent or another composer opens.
 */
export function autoEnterWriting(o: {
  enabled: boolean
  armed: boolean
  active: boolean
  hasComposer: boolean
  mobile: boolean
}): boolean {
  return o.enabled && o.armed && !o.active && o.hasComposer && !o.mobile
}

/** Roughly how many lines `body` takes in a box `cols` characters wide. */
export function approxLines(body: string, cols: number): number {
  return body.split('\n').reduce((n, line) => n + Math.max(1, Math.ceil(line.length / cols)), 0)
}

/** The new-email body has no auto-grow to read, so "past two lines" is
 *  estimated from the text at the pane's typical ~90 characters a line. */
export function longEnoughForWriting(body: string): boolean {
  return approxLines(body, 90) > 2
}

/** Escape leaves writing mode only from an empty box — with text in it,
 *  Escape keeps its old job (blur) and the draft keeps its room. */
export function escapeExitsWriting(active: boolean, body: string): boolean {
  return active && body.trim() === ''
}

/**
 * True for one morph's duration after `active` flips, so the composer can
 * tween its height for the mode change and nowhere else — the box also
 * grows with every typed line, and that must stay instant. Set during the
 * same render that carries the new `active`, so the CSS class is in place
 * before the layout effect writes the new height.
 */
export function useMorphing(active: boolean): boolean {
  const prev = useRef(active)
  const [morphing, setMorphing] = useState(false)
  // deliberate setState during render (React's derived-state escape hatch):
  // an effect would land a frame late, after the layout effect has already
  // written the new height with no transition class on the box. The ref
  // guard makes it a one-shot, so StrictMode's double render is harmless.
  if (prev.current !== active) {
    prev.current = active
    setMorphing(true)
  }
  useEffect(() => {
    if (!morphing) return
    // read the duration the CSS uses so a retuned token keeps them in step
    const t = setTimeout(
      () => setMorphing(false),
      motionMs(active ? '--morph-open-dur' : '--morph-close-dur', 350)
    )
    return () => clearTimeout(t)
  }, [morphing, active])
  return morphing
}

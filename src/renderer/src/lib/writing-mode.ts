import { useEffect, useRef, useState } from 'react'

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

/** Escape leaves writing mode only from an empty box — with text in it,
 *  Escape keeps its old job (blur) and the draft keeps its room. */
export function escapeExitsWriting(active: boolean, body: string): boolean {
  return active && body.trim() === ''
}

/**
 * A CSS <time> as milliseconds. The build minifies `350ms` to `.35s`, so
 * a bare parseFloat would read 0.35 and end the morph on the next tick.
 */
export function cssTimeToMs(raw: string, fallback: number): number {
  const m = raw.trim().match(/^(-?\d*\.?\d+)(ms|s)$/i)
  if (!m) return fallback
  const n = Number(m[1])
  return m[2].toLowerCase() === 's' ? n * 1000 : n
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
    const raw = getComputedStyle(document.documentElement).getPropertyValue(
      active ? '--morph-open-dur' : '--morph-close-dur'
    )
    const t = setTimeout(() => setMorphing(false), cssTimeToMs(raw, 350))
    return () => clearTimeout(t)
  }, [morphing, active])
  return morphing
}

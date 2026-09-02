import { useCallback, useLayoutEffect, useState, type RefObject } from 'react'

/** Share of the message pane the reply box may take before it scrolls inside. */
export const COMPOSER_CAP_FRACTION = 0.45

/**
 * The tallest the reply box may grow inside a pane `paneHeight` px tall.
 * Never below `floor` (the box's own min-rows height) so a tiny window still
 * shows the rows it always did rather than a one-line slit.
 */
export function composerCap(paneHeight: number, floor: number): number {
  return Math.max(floor, Math.floor(paneHeight * COMPOSER_CAP_FRACTION))
}

/**
 * Height to set on the box for `contentHeight` px of text (scrollHeight plus
 * borders): the content, but never under the min-rows `floor` nor over `cap`.
 * `overflow` says the text no longer fits and the box must scroll inside.
 */
export function autoGrowHeight(
  contentHeight: number,
  floor: number,
  cap: number
): { height: number; overflow: boolean } {
  const wanted = Math.max(contentHeight, floor)
  return { height: Math.min(wanted, cap), overflow: wanted > cap }
}

/**
 * Grows a textarea with its content, capped at a share of the nearest
 * `[data-pane]` ancestor's height, then scrolls inside. Re-fits whenever
 * `value` changes (typing, dictation, an AI draft, an undo restore) and
 * whenever the pane is resized — the columns yielding, the window shrinking.
 * Returns `grown`: the text has outgrown the rows= floor, i.e. with two
 * rows a third line has begun — what writing mode's auto-entry listens for.
 */
export function useAutoGrow(
  ref: RefObject<HTMLTextAreaElement | null>,
  value: string,
  /** anything else that changes the box's floor — its rows= or padding */
  layoutKey?: unknown
): { grown: boolean } {
  const [grown, setGrown] = useState(false)
  const fit = useCallback((): void => {
    const el = ref.current
    if (!el) return
    const pane = el.closest<HTMLElement>('[data-pane]')
    // what's on screen now — restored below so a height transition has a
    // length to start from
    const from = el.offsetHeight
    // height:auto puts the box back at its rows= size, which is both the
    // floor and the state scrollHeight must be read in
    el.style.height = 'auto'
    const floor = el.offsetHeight
    const borders = el.offsetHeight - el.clientHeight
    const { height, overflow } = autoGrowHeight(
      el.scrollHeight + borders,
      floor,
      composerCap(pane?.clientHeight ?? window.innerHeight, floor)
    )
    setGrown(el.scrollHeight + borders > floor)
    // the measuring read above flushed style with height:auto, and
    // auto → <length> never interpolates: put the previous length back and
    // flush once more so the before-change style is a length again. Only
    // the writing-mode morph transitions height, but this costs nothing.
    el.style.height = `${from}px`
    void el.offsetHeight
    el.style.height = `${height}px`
    el.style.overflowY = overflow ? 'auto' : 'hidden'
  }, [ref])
  // refit on every value change — typing, dictation, an AI draft, an undo
  // restore — and whenever the box's own floor changes
  useLayoutEffect(fit, [fit, value, layoutKey])
  // ...and whenever the pane is resized: the columns yielding, the window
  // shrinking. Observed once, not per keystroke.
  useLayoutEffect(() => {
    const pane = ref.current?.closest<HTMLElement>('[data-pane]')
    if (!pane) return
    const ro = new ResizeObserver(fit)
    ro.observe(pane)
    return () => ro.disconnect()
  }, [ref, fit])
  return { grown }
}

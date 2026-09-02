import { flushSync } from 'react-dom'

type ViewTransitionDocument = Document & {
  startViewTransition?: (update: () => void) => { finished: Promise<void> }
}

/** Animate only when the API exists and the user hasn't asked for less motion. */
export function viewTransitionsWanted(supported: boolean, reducedMotion: boolean): boolean {
  return supported && !reducedMotion
}

/** On <html> while a closing transition runs, so CSS can pick the close ease. */
export const VT_CLOSING_CLASS = 'vt-closing'

/**
 * Run a state update inside a View Transition: elements that carry the same
 * `view-transition-name` before and after morph from the old box to the new
 * one (the Compose button → the new-email pane). Falls back to a plain
 * update where the API is missing or motion is reduced. The update is
 * flushed synchronously so the "after" snapshot sees the new DOM.
 */
export function withViewTransition(update: () => void, opts: { closing?: boolean } = {}): void {
  const doc = document as ViewTransitionDocument
  const wanted = viewTransitionsWanted(
    typeof doc.startViewTransition === 'function',
    matchMedia('(prefers-reduced-motion: reduce)').matches
  )
  if (!wanted) {
    update()
    return
  }
  const root = document.documentElement
  if (opts.closing) root.classList.add(VT_CLOSING_CLASS)
  const transition = doc.startViewTransition!(() => flushSync(update))
  void transition.finished.finally(() => root.classList.remove(VT_CLOSING_CLASS))
}

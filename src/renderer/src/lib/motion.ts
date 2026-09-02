/**
 * Motion tokens live in styles.css (the transitions.dev scale). JS that
 * has to wait out a CSS transition reads the token instead of mirroring
 * the number, so a retuned token keeps both in step.
 */

/**
 * A CSS <time> as milliseconds. The build minifies `350ms` to `.35s`, so
 * a bare parseFloat would read 0.35.
 */
export function cssTimeToMs(raw: string, fallback: number): number {
  const m = raw.trim().match(/^(-?\d*\.?\d+)(ms|s)$/i)
  if (!m) return fallback
  const n = Number(m[1])
  return m[2].toLowerCase() === 's' ? n * 1000 : n
}

/** The value of a `--duration-*` / `--*-dur` token on :root, in ms. */
export function motionMs(token: string, fallback: number): number {
  if (typeof document === 'undefined') return fallback
  return cssTimeToMs(getComputedStyle(document.documentElement).getPropertyValue(token), fallback)
}

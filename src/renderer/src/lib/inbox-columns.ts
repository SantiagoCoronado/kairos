import type { WidthSpec } from '../components/ResizeHandle'

/** The message pane never drops below this while a column can still give. */
export const PANE_MIN = 360

/**
 * A column's max width once the pane's floor and the columns beside it
 * (`taken`) are accounted for. Never below the column's own min — when even
 * the minimums don't fit, the pane takes what is left rather than the
 * columns overflowing the window. `shellW` 0 means not measured yet.
 */
export function fitMax(shellW: number, taken: number, spec: WidthSpec): number {
  if (!shellW) return spec.max
  return Math.min(spec.max, Math.max(spec.min, shellW - taken - PANE_MIN))
}

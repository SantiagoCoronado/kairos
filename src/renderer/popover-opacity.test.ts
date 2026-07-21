import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/** Floating chrome (popovers, menus, dropdowns, toasts) must use the opaque
 *  `bg-overlay` token, never `bg-panel` — bg-panel is a 3.5%-alpha lift for
 *  nested surfaces sitting on an opaque column, so on a floating element the
 *  content underneath bleeds through. This has now bitten three times (People
 *  autocomplete, People snooze menu, Chat history), so it's enforced here.
 *
 *  Legit exception (a `bg-panel` element that is absolutely positioned but
 *  rests on an opaque base)? Append `// popover-opacity-ok` to the line.
 */

const RENDERER_SRC = join(__dirname, 'src')
const FLOATING_BG_PANEL = /\bclass(Name)?\s*=\s*["'{][^\n]*\b(absolute|fixed)\b[^\n]*\bbg-panel\b|\bclass(Name)?\s*=\s*["'{][^\n]*\bbg-panel\b[^\n]*\b(absolute|fixed)\b/

function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) return tsxFiles(full)
    return entry.name.endsWith('.tsx') ? [full] : []
  })
}

describe('popover opacity', () => {
  it('no floating element uses bg-panel (use bg-overlay for floating chrome)', () => {
    const offenders: string[] = []
    for (const file of tsxFiles(RENDERER_SRC)) {
      const lines = readFileSync(file, 'utf8').split('\n')
      lines.forEach((line, i) => {
        if (line.includes('popover-opacity-ok')) return
        if (FLOATING_BG_PANEL.test(line)) offenders.push(`${file}:${i + 1}`)
      })
    }
    expect(offenders, `bg-panel on a positioned element — floating chrome must use bg-overlay (see this test's doc comment):\n${offenders.join('\n')}`).toEqual([])
  })
})

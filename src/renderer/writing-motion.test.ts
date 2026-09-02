import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Source-level guards for the writing-mode motion in styles.css. The traps
 * here are silent in the browser: a transform at rest quietly breaks the
 * settings modal's fixed positioning, and a missing reduced-motion guard
 * fails no test but every accessibility audit.
 */
const css = readFileSync(join(__dirname, 'src/styles.css'), 'utf8')

/** the declarations of the first rule whose selector list equals `selector` */
function rule(selector: string): string {
  const re = new RegExp(`(^|\\n)${selector.replace(/[.[\]*+?^${}()|\\/]/g, '\\$&')}\\s*\\{([^}]*)\\}`)
  const m = css.match(re)
  if (!m) throw new Error(`no rule for ${selector}`)
  return m[2]
}

describe('motion tokens', () => {
  it('ships the transitions.dev scale the recipes read', () => {
    for (const token of [
      '--resize-dur',
      '--resize-ease',
      '--morph-open-dur',
      '--morph-close-dur',
      '--morph-ease',
      '--morph-close-ease',
      '--icon-swap-dur',
      '--distance-medium',
      '--blur-small'
    ]) {
      expect(css, token).toMatch(new RegExp(`${token}:`))
    }
  })
})

describe('column fold', () => {
  it('tweens the outer width on the resize tokens', () => {
    expect(rule('.t-fold')).toMatch(/width var\(--resize-dur\) var\(--resize-ease\)/)
  })

  it('sets no transform, filter or will-change on the inner at rest', () => {
    // any value but `none` would make the inner the containing block for
    // fixed-position descendants — the settings modal lives inside the sidebar
    const rest = rule('.t-fold-inner')
    expect(rest).not.toMatch(/\btransform\s*:/)
    expect(rest).not.toMatch(/\bfilter\s*:/)
    expect(rest).not.toMatch(/will-change/)
  })

  it('fades, slides and blurs the inner out only when folded', () => {
    const folded = rule(".t-fold[data-folded='true'] .t-fold-inner")
    expect(folded).toMatch(/opacity:\s*0/)
    expect(folded).toMatch(/translateX\(calc\(-1 \* var\(--distance-medium\)\)\)/)
    expect(folded).toMatch(/blur\(var\(--blur-small\)\)/)
    expect(folded).toMatch(/pointer-events:\s*none/)
  })
})

describe('composer morph', () => {
  it('tweens height only while morphing, so typing never bounces', () => {
    expect(rule('.t-morph-box')).not.toMatch(/\bheight\b/)
    expect(rule('.t-morph.is-morphing .t-morph-box')).toMatch(/height var\(--_morph-dur\)/)
  })

  it('opens on the bouncy ease and closes on the smooth one', () => {
    expect(rule('.t-morph')).toMatch(/--_morph-ease:\s*var\(--morph-close-ease\)/)
    expect(rule(".t-morph[data-open='true']")).toMatch(/--_morph-ease:\s*var\(--morph-ease\)/)
  })
})

describe('reduced motion', () => {
  const guard = css.slice(css.lastIndexOf('@media (prefers-reduced-motion: reduce)'))

  it('zeroes every writing-mode transition and animation', () => {
    for (const sel of ['.t-fold', '.t-fold-inner', '.t-morph-box', '.t-icon-swap .t-icon']) {
      expect(guard, sel).toContain(sel)
    }
    expect(guard).toMatch(/transition: none !important/)
    expect(guard).toMatch(/\.t-morph\.is-morphing \.t-morph-toolbar\s*\{\s*animation: none !important/)
  })
})

describe('refine', () => {
  it('leaves no raw durations outside the token block', () => {
    // every transition/animation in styles.css reads a token; a new literal
    // is a value transitions refine would flag
    const tokenBlockStart = css.indexOf('/* ── Motion tokens')
    const tokenBlockEnd = css.indexOf('}', tokenBlockStart)
    const outside = css.slice(0, tokenBlockStart) + css.slice(tokenBlockEnd)
    const literals = outside.match(/\b\d+(\.\d+)?m?s\b/g) ?? []
    expect(literals).toEqual([])
  })
})

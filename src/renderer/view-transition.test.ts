import { describe, expect, it } from 'vitest'
import { viewTransitionsWanted } from './src/lib/view-transition'

describe('viewTransitionsWanted', () => {
  it('animates only with the API and no reduced-motion request', () => {
    expect(viewTransitionsWanted(true, false)).toBe(true)
    expect(viewTransitionsWanted(false, false)).toBe(false)
    expect(viewTransitionsWanted(true, true)).toBe(false)
  })
})

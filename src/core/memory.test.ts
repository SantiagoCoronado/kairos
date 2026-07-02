import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { memoryPath, readMemory, saveMemory } from './memory'

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), 'kairos-memory-'))
}

describe('agent memory', () => {
  it('reads empty string when no file exists', () => {
    expect(readMemory(freshDir())).toBe('')
  })

  it('replace writes the file from scratch', () => {
    const dir = freshDir()
    saveMemory(dir, 'Santiago prefers espresso.', 'replace')
    expect(readMemory(dir)).toBe('Santiago prefers espresso.\n')
  })

  it('append adds a separated block', () => {
    const dir = freshDir()
    saveMemory(dir, 'Fact one.', 'replace')
    saveMemory(dir, 'Fact two.', 'append')
    expect(readMemory(dir)).toBe('Fact one.\n\nFact two.\n')
  })

  it('append on a missing file behaves like replace', () => {
    const dir = freshDir()
    saveMemory(dir, 'First ever fact.', 'append')
    expect(readMemory(dir)).toBe('First ever fact.\n')
  })

  it('replace overwrites previous content atomically', () => {
    const dir = freshDir()
    saveMemory(dir, 'Old.', 'replace')
    const { bytes } = saveMemory(dir, 'New.', 'replace')
    expect(readFileSync(memoryPath(dir), 'utf8')).toBe('New.\n')
    expect(bytes).toBe(5)
  })
})

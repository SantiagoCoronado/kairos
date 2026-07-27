import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { pushUndo, undoLast, UNDO_WINDOW_MS } from './src/lib/undo'
import { dismissToast, getToasts } from './src/lib/toast'

describe('undo store', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.runAllTimers() // drain any pending windows so entries don't leak across tests
    getToasts().forEach((t) => dismissToast(t.id))
    vi.useRealTimers()
  })

  it('a deferred commit fires when the window closes un-undone', () => {
    const commit = vi.fn()
    pushUndo({ label: 'Conversation deleted', commit })
    expect(commit).not.toHaveBeenCalled()
    vi.advanceTimersByTime(UNDO_WINDOW_MS)
    expect(commit).toHaveBeenCalledOnce()
  })

  it('undoLast cancels the commit, runs the revert, and dismisses the toast', () => {
    const commit = vi.fn()
    const revert = vi.fn()
    pushUndo({ label: 'Email sent', commit, revert })
    expect(getToasts()).toHaveLength(1)
    expect(undoLast()).toBe(true)
    expect(revert).toHaveBeenCalledOnce()
    expect(getToasts()).toHaveLength(0)
    vi.advanceTimersByTime(UNDO_WINDOW_MS * 2)
    expect(commit).not.toHaveBeenCalled()
  })

  it('undoLast pops newest-first and reports false when empty', () => {
    const order: string[] = []
    pushUndo({ label: 'first', revert: () => order.push('first') })
    pushUndo({ label: 'second', revert: () => order.push('second') })
    expect(undoLast()).toBe(true)
    expect(undoLast()).toBe(true)
    expect(order).toEqual(['second', 'first'])
    expect(undoLast()).toBe(false)
  })

  it('the toast Undo action undoes exactly its own entry', () => {
    const revertA = vi.fn()
    const revertB = vi.fn()
    pushUndo({ label: 'A', revert: revertA })
    pushUndo({ label: 'B', revert: revertB })
    const toastA = getToasts().find((t) => t.text === 'A')!
    toastA.action!.run()
    expect(revertA).toHaveBeenCalledOnce()
    expect(revertB).not.toHaveBeenCalled()
    // B is still pending and remains the ⌘Z target
    expect(undoLast()).toBe(true)
    expect(revertB).toHaveBeenCalledOnce()
  })

  it('an expired entry can no longer be undone', () => {
    const commit = vi.fn()
    const revert = vi.fn()
    pushUndo({ label: 'gone', commit, revert })
    vi.advanceTimersByTime(UNDO_WINDOW_MS)
    expect(undoLast()).toBe(false)
    expect(commit).toHaveBeenCalledOnce()
    expect(revert).not.toHaveBeenCalled()
  })
})

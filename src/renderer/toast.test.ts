import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dismissToast, getToasts, subscribeToasts, toast, updateToast } from './src/lib/toast'

describe('toast store', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    getToasts().forEach((t) => dismissToast(t.id))
    vi.useRealTimers()
  })

  it('success auto-dismisses, working and error stick', () => {
    toast({ variant: 'success', text: 'done' })
    toast({ variant: 'working', text: 'busy' })
    toast({ variant: 'error', text: 'failed' })
    expect(getToasts().map((t) => t.variant)).toEqual(['success', 'working', 'error'])
    vi.advanceTimersByTime(10_000)
    expect(getToasts().map((t) => t.variant)).toEqual(['working', 'error'])
  })

  it('updateToast morphs in place and picks up the new variant timing', () => {
    const id = toast({ variant: 'working', text: 'Working on it…', detail: '“do the thing”' })
    vi.advanceTimersByTime(60_000)
    expect(getToasts()).toHaveLength(1) // working never times out

    updateToast(id, { variant: 'success', text: 'Task created' })
    expect(getToasts()).toEqual([{ id, variant: 'success', text: 'Task created', detail: undefined }])
    vi.advanceTimersByTime(4_000)
    expect(getToasts()).toHaveLength(0) // success timing applies after morph
  })

  it('updateToast after dismissal is a no-op (late resolve of a dismissed toast)', () => {
    const id = toast({ variant: 'working', text: 'busy' })
    dismissToast(id)
    updateToast(id, { variant: 'error', text: 'failed' })
    expect(getToasts()).toHaveLength(0)
  })

  it('notifies subscribers on every change and stops after unsubscribe', () => {
    const seen: number[] = []
    const unsub = subscribeToasts(() => seen.push(getToasts().length))
    const id = toast({ variant: 'error', text: 'boom' })
    dismissToast(id)
    expect(seen).toEqual([1, 0])
    unsub()
    toast({ variant: 'error', text: 'quiet' })
    expect(seen).toEqual([1, 0])
  })
})

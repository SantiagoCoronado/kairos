import { describe, it, expect, vi } from 'vitest'
import { applyCaptureFlags, type CommandLineLike } from './capture-flags'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

function fakeCommandLine(): CommandLineLike & { calls: [string, string][] } {
  const calls: [string, string][] = []
  return { calls, appendSwitch: (k, v) => void calls.push([k, v]) }
}

describe('applyCaptureFlags', () => {
  it("default 'sck' disables the Core Audio tap path (spike: catap = silence)", () => {
    const cl = fakeCommandLine()
    applyCaptureFlags(cl, 'sck', 'darwin')
    expect(cl.calls).toHaveLength(1)
    const [key, value] = cl.calls[0]
    expect(key).toBe('disable-features')
    expect(value).toContain('MacCatapLoopbackAudioForScreenShare')
    expect(value).toContain('GetDisplayMediaIgnoreAudioPermissionFailures')
  })

  it("'catap' opts back into the tap path for re-testing", () => {
    const cl = fakeCommandLine()
    applyCaptureFlags(cl, 'catap', 'darwin')
    expect(cl.calls).toEqual([['enable-features', 'MacCatapLoopbackAudioForScreenShare']])
  })

  it('is a no-op off macOS', () => {
    const cl = fakeCommandLine()
    applyCaptureFlags(cl, 'sck', 'linux')
    applyCaptureFlags(cl, 'catap', 'win32')
    expect(cl.calls).toEqual([])
  })

  it('never throws on a minimal commandLine surface', () => {
    expect(() =>
      applyCaptureFlags({ appendSwitch: vi.fn() }, 'sck', 'darwin')
    ).not.toThrow()
  })
})

// Conformance (popover-opacity spirit): losing a TCC usage string doesn't
// fail a build — it silently breaks permission prompts. Pin both configs.
describe('packaging TCC keys', () => {
  const root = join(__dirname, '..', '..')
  const REQUIRED = ['NSAudioCaptureUsageDescription', 'NSMicrophoneUsageDescription']

  it('electron-builder.yml carries the capture usage strings', () => {
    const yml = readFileSync(join(root, 'electron-builder.yml'), 'utf8')
    for (const key of REQUIRED) expect(yml).toContain(key)
  })

  it('the dev-Electron plist patch carries the capture usage strings', () => {
    const js = readFileSync(join(root, 'scripts', 'patch-dev-electron-plist.js'), 'utf8')
    for (const key of REQUIRED) expect(js).toContain(key)
  })
})

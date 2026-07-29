// Chromium feature flags for system-audio loopback. Spike verdict
// (2026-07-28, Electron 43 / Chrome 150, this Mac): the Core Audio tap
// path captures pure silence — Chromium never triggers the system-audio
// TCC prompt — while the ScreenCaptureKit path works, so 'sck' is the
// shipped default. 'catap' stays as the upgrade path to re-test after
// Electron bumps (or once a native TCC preflight exists, Notion-style).
// Must run before app.whenReady(); pure over an appendSwitch-shaped
// surface so the mapping is testable.

const CATAP_FEATURE = 'MacCatapLoopbackAudioForScreenShare'
// without this second flag the SCK path fails outright when the audio
// permission is missing instead of degrading (electron#49607 workaround)
const SCK_DISABLE = `${CATAP_FEATURE},GetDisplayMediaIgnoreAudioPermissionFailures`

export type CaptureBackend = 'sck' | 'catap'

export interface CommandLineLike {
  appendSwitch(key: string, value: string): void
}

export function applyCaptureFlags(
  commandLine: CommandLineLike,
  backend: CaptureBackend,
  platform: NodeJS.Platform = process.platform
): void {
  if (platform !== 'darwin') return
  if (backend === 'catap') commandLine.appendSwitch('enable-features', CATAP_FEATURE)
  else commandLine.appendSwitch('disable-features', SCK_DISABLE)
}

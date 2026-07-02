import { globalShortcut } from 'electron'
import { toggleCaptureWindow } from './windows/capture-window'
import { getSettings } from './settings'

const FALLBACK = 'CommandOrControl+Shift+Space'

let current: string | null = null

export function registerCaptureHotkey(): void {
  reregisterCaptureHotkey(getSettings().captureHotkey)
}

export function reregisterCaptureHotkey(accelerator: string): void {
  if (current) {
    globalShortcut.unregister(current)
    current = null
  }
  if (tryRegister(accelerator)) return
  // shortcut taken (Raycast/Spotlight remaps are common) — try the fallback
  if (tryRegister(FALLBACK)) {
    console.warn(`[capture] ${accelerator} unavailable; using ${FALLBACK}`)
  } else {
    console.warn(`[capture] no hotkey could be registered`)
  }
}

function tryRegister(accelerator: string): boolean {
  try {
    if (globalShortcut.register(accelerator, toggleCaptureWindow)) {
      current = accelerator
      return true
    }
  } catch {
    // invalid accelerator string
  }
  return false
}

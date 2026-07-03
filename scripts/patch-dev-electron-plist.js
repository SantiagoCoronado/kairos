#!/usr/bin/env node
// Dev-mode TCC workaround: the calendar permission prompt is attributed to
// the responsible .app bundle. Under `electron-vite dev` that is
// node_modules/electron/dist/Electron.app, whose Info.plist lacks the
// calendar usage strings, so macOS silently never shows the prompt.
// This idempotently injects the keys into the dev Electron.app.
// After first run: `tccutil reset Calendar` may be needed to re-trigger.
const { execFileSync } = require('node:child_process')
const { existsSync } = require('node:fs')
const { join } = require('node:path')

const plist = join(
  __dirname,
  '..',
  'node_modules',
  'electron',
  'dist',
  'Electron.app',
  'Contents',
  'Info.plist'
)

if (process.platform !== 'darwin' || !existsSync(plist)) process.exit(0)

const KEYS = {
  NSCalendarsUsageDescription: 'Command Center (dev) shows today’s events on your dashboard.',
  NSCalendarsFullAccessUsageDescription:
    'Command Center (dev) shows today’s events on your dashboard.',
  NSContactsUsageDescription: 'Kairos (dev) names your WhatsApp chats using your address book.'
}

for (const [key, value] of Object.entries(KEYS)) {
  try {
    execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist], { stdio: 'pipe' })
  } catch {
    execFileSync('/usr/libexec/PlistBuddy', ['-c', `Add :${key} string ${value}`, plist], {
      stdio: 'pipe'
    })
    console.log(`[dev-plist] added ${key} to dev Electron.app`)
  }
}

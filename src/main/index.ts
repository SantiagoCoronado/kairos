import { app, globalShortcut } from 'electron'
import { writeFileSync } from 'node:fs'
import { createMainWindow } from './windows/main-window'
import { createCaptureWindow } from './windows/capture-window'
import { registerCaptureHotkey } from './hotkey'
import { registerIpc } from './ipc'
import { closeDb } from './db'

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = createMainWindow()
    if (win.isMinimized()) win.restore()
    win.focus()
  })

  app.whenReady().then(() => {
    registerIpc()
    const win = createMainWindow()

    // dev-only self-screenshot: DEBUG_SHOT=/path.png [DEBUG_VIEW=tasks] npx electron .
    const shotPath = process.env['DEBUG_SHOT']
    if (shotPath && !app.isPackaged) {
      setTimeout(() => {
        void win.webContents.capturePage().then((img) => {
          writeFileSync(shotPath, img.toPNG())
          console.log(`[debug] screenshot written: ${shotPath}`)
        })
      }, 2500)
    }

    // pre-create hidden so first summon is instant
    createCaptureWindow()
    registerCaptureHotkey()

    // createMainWindow() reuses the live window; the hidden capture window
    // would defeat a getAllWindows().length === 0 check
    app.on('activate', () => {
      createMainWindow()
    })
  })

  app.on('will-quit', () => globalShortcut.unregisterAll())

  app.on('window-all-closed', () => {
    // Stay alive in the dock like a proper mac app; quit via Cmd+Q.
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('will-quit', () => closeDb())
}

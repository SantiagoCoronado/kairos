import { app, globalShortcut } from 'electron'
import { writeFileSync } from 'node:fs'
import { createMainWindow } from './windows/main-window'
import { createCaptureWindow } from './windows/capture-window'
import { registerCaptureHotkey } from './hotkey'
import { registerIpc, getCommsManager } from './ipc'
import { closeDb } from './db'
import { logLine } from './logger'

// crash forensics — everything lands in ~/Kairos/logs/app.log
process.on('uncaughtException', (err) => {
  logLine('error', 'main', `uncaughtException: ${err.stack ?? err.message}`)
})
process.on('unhandledRejection', (reason) => {
  logLine('error', 'main', `unhandledRejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`)
})
app.on('render-process-gone', (_e, _wc, details) => {
  logLine('error', 'main', `render-process-gone: ${details.reason} (exitCode ${details.exitCode})`)
})
app.on('child-process-gone', (_e, details) => {
  if (details.reason !== 'clean-exit')
    logLine('warn', 'main', `child-process-gone: ${details.type} ${details.reason}`)
})

// stall watchdog: better-sqlite3 runs synchronously on this thread, so a
// long transaction freezes every IPC reply and the UI looks dead. Log it.
{
  let last = Date.now()
  setInterval(() => {
    const now = Date.now()
    const lag = now - last - 1000
    if (lag > 1000) logLine('warn', 'main', `main thread stalled ~${lag}ms — UI was unresponsive`)
    last = now
  }, 1000)
}

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
    logLine('info', 'main', `app start v${app.getVersion()} (packaged: ${app.isPackaged})`)
    registerIpc()
    getCommsManager()?.start()
    const win = createMainWindow()

    // dev-only self-screenshot: DEBUG_SHOT=/path.png [DEBUG_HIDE_SIDEBAR=1] npx electron .
    const shotPath = process.env['DEBUG_SHOT']
    if (shotPath && !app.isPackaged) {
      setTimeout(() => {
        const prep = process.env['DEBUG_HIDE_SIDEBAR']
          ? win.webContents
              .executeJavaScript(
                `if (document.querySelector('aside'))
                   window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', metaKey: true }))`
              )
              // give React a beat to re-render and the compositor to paint
              .then(() => new Promise((r) => setTimeout(r, 400)))
              .catch((err) => console.error('[debug] sidebar toggle failed:', err))
          : Promise.resolve()
        void prep
          .then(() => win.webContents.capturePage())
          .then((img) => {
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

  app.on('will-quit', () => {
    logLine('info', 'main', 'app quit')
    getCommsManager()?.stop()
    closeDb()
  })
}

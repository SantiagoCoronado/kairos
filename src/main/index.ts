import { app, BrowserWindow } from 'electron'
import { createMainWindow } from './windows/main-window'

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
    createMainWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
    })
  })

  app.on('window-all-closed', () => {
    // Stay alive in the dock like a proper mac app; quit via Cmd+Q.
    if (process.platform !== 'darwin') app.quit()
  })
}

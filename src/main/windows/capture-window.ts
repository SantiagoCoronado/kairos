import { BrowserWindow, app } from 'electron'
import { join } from 'node:path'

let captureWindow: BrowserWindow | null = null

export function createCaptureWindow(): BrowserWindow {
  captureWindow = new BrowserWindow({
    width: 640,
    height: 96,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    show: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  // float above full-screen apps, follow the active space
  captureWindow.setAlwaysOnTop(true, 'screen-saver')
  captureWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  captureWindow.on('blur', () => captureWindow?.hide())
  captureWindow.on('closed', () => {
    captureWindow = null
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void captureWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/capture.html`)
  } else {
    void captureWindow.loadFile(join(__dirname, '../renderer/capture.html'))
  }

  return captureWindow
}

export function toggleCaptureWindow(): void {
  const win = captureWindow ?? createCaptureWindow()
  if (win.isVisible()) {
    win.hide()
    return
  }
  win.center()
  win.show()
  win.focus()
  // when another app is frontmost, macOS needs an explicit steal
  app.focus({ steal: true })
  win.webContents.send('capture:reset', {})
}

export function hideCaptureWindow(): void {
  captureWindow?.hide()
}

import { app, BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { getTerminalManager } from '../ipc'

let mainWindow: BrowserWindow | null = null

export function getMainWindow(): BrowserWindow | null {
  return mainWindow
}

export function createMainWindow(): BrowserWindow {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show()
    // bring the app frontmost — showing a window doesn't guarantee activation
    app.focus({ steal: true })
    return mainWindow
  }

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 600,
    title: 'Kairos',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    // transparent so the renderer can dial window translucency via CSS alpha;
    // at 0% the body paints fully opaque and this is indistinguishable from
    // a solid window. Must be set at creation — it cannot be toggled later.
    transparent: true,
    backgroundColor: '#00000000',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
    // On a cold launch the synchronous startup work in index.ts can stall the
    // main thread past macOS's launch-activation window, so the app comes up
    // without a dock running-dot and outside Cmd+Tab. Explicitly activate it
    // here (as capture/scheduler/task-runner already do for their surfaces).
    app.focus({ steal: true })
  })
  mainWindow.on('closed', () => {
    mainWindow = null
    // the renderer died with the window and can't report visibility anymore;
    // without this a Terminal tab open at close time would leave viewActive
    // stuck true and mute the bell badge until the view is toggled again
    getTerminalManager()?.setViewActive(false)
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return mainWindow
}

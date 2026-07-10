import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { IpcChannel, IpcEventChannel, RendererApi } from '../shared/ipc-contract'

const api: RendererApi = {
  invoke: (channel: IpcChannel, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args),
  on: (channel: IpcEventChannel, cb: (payload: unknown) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, payload: unknown): void => cb(payload)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  },
  // drag-drop: File objects carry no path in the renderer since Electron 32
  pathForFile: (file: File) => webUtils.getPathForFile(file)
  // Widening cast: the per-channel payload types are enforced at the
  // RendererApi boundary; inside the bridge everything is opaque.
} as RendererApi

contextBridge.exposeInMainWorld('api', api)

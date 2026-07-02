import { contextBridge, ipcRenderer } from 'electron'
import type { IpcChannel, IpcEventChannel, RendererApi } from '../shared/ipc-contract'

const api: RendererApi = {
  invoke: (channel: IpcChannel, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args),
  on: (channel: IpcEventChannel, cb: (payload: never) => void) => {
    const listener = (_e: Electron.IpcRendererEvent, payload: never): void => cb(payload)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  }
}

contextBridge.exposeInMainWorld('api', api)

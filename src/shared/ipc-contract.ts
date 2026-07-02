// Single source of truth for everything that crosses the IPC boundary.
// Main implements IpcApi; preload exposes it promisified as window.api.

export type Area = 'personal' | 'work'

export interface IpcApi {
  'app:ping': () => string
}

export interface IpcEvents {
  'db:changed': { entity: 'tasks' | 'people' | 'interactions' | 'objectives' | 'projects' | 'all' }
}

export type IpcChannel = keyof IpcApi
export type IpcEventChannel = keyof IpcEvents

// What the renderer sees: same channels, promisified returns.
export type RendererApi = {
  invoke<K extends IpcChannel>(
    channel: K,
    ...args: Parameters<IpcApi[K]>
  ): Promise<Awaited<ReturnType<IpcApi[K]>>>
  on<K extends IpcEventChannel>(channel: K, cb: (payload: IpcEvents[K]) => void): () => void
}

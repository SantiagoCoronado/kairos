import { useCallback, useEffect, useState } from 'react'
import type {
  IpcApi,
  IpcChannel,
  IpcEvents,
  IpcEventChannel,
  DbEntity,
  RendererApi
} from '../../../shared/ipc-contract'

/**
 * Inside Electron the preload bridge provides window.api (ipcRenderer).
 * In a plain browser (remote access: phone/tablet hitting the Mac's server)
 * the same contract runs over a WebSocket to /ws instead.
 */
export const api: RendererApi = window.api ?? makeRemoteApi()

function makeRemoteApi(): RendererApi {
  // the token arrives once in the URL hash, then persists for future visits
  const fromHash = new URLSearchParams(window.location.hash.slice(1)).get('token')
  if (fromHash) {
    localStorage.setItem('kairos-remote-token', fromHash)
    history.replaceState(null, '', window.location.pathname)
  }
  const token = fromHash ?? localStorage.getItem('kairos-remote-token') ?? ''

  // pasting a #token=… link into an already-open tab is a same-document
  // navigation — this module never re-runs, so pick the token up via reload
  window.addEventListener('hashchange', () => {
    if (new URLSearchParams(window.location.hash.slice(1)).get('token')) window.location.reload()
  })

  const listeners = new Map<string, Set<(payload: unknown) => void>>()
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  const queue: string[] = []
  let ws: WebSocket | null = null
  let seq = 0
  let backoff = 500

  const emit = (channel: string, payload: unknown): void => {
    for (const cb of listeners.get(channel) ?? []) cb(payload)
  }

  const connect = (): void => {
    const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws'
    const socket = new WebSocket(
      `${scheme}://${window.location.host}/ws?token=${encodeURIComponent(token)}`
    )
    socket.onopen = () => {
      ws = socket
      backoff = 500
      while (queue.length > 0) socket.send(queue.shift()!)
      // any db:changed pushed while disconnected is gone — refresh everything
      emit('db:changed', { entity: 'all' } satisfies IpcEvents['db:changed'])
    }
    socket.onmessage = (e) => {
      const msg = JSON.parse(String(e.data)) as
        | { id: number; ok: boolean; result?: unknown; error?: string }
        | { event: string; payload: unknown }
      if ('id' in msg) {
        const p = pending.get(msg.id)
        pending.delete(msg.id)
        if (msg.ok) p?.resolve(msg.result)
        else p?.reject(new Error(msg.error ?? 'remote invoke failed'))
      } else {
        emit(msg.event, msg.payload)
      }
    }
    socket.onclose = () => {
      ws = null
      for (const p of pending.values()) p.reject(new Error('remote connection lost'))
      pending.clear()
      setTimeout(connect, backoff)
      backoff = Math.min(backoff * 2, 15_000)
    }
  }
  connect()

  return {
    invoke: (channel: IpcChannel, ...args: unknown[]) =>
      new Promise((resolve, reject) => {
        const id = ++seq
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
        const frame = JSON.stringify({ id, channel, args })
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(frame)
        else queue.push(frame)
      }),
    on: (channel: IpcEventChannel, cb: (payload: unknown) => void) => {
      let set = listeners.get(channel)
      if (!set) {
        set = new Set()
        listeners.set(channel, set)
      }
      set.add(cb)
      return () => set?.delete(cb)
    },
    // Electron-only affordance (drag-drop file paths); remote uses uploads instead
    pathForFile: () => ''
    // same widening cast as the preload: per-channel types are enforced at the
    // RendererApi boundary; inside the transport everything is opaque
  } as RendererApi
}

type Result<K extends IpcChannel> = Awaited<ReturnType<IpcApi[K]>>

/**
 * Fetch-and-subscribe hook: runs the invoke, re-runs whenever a db:changed
 * event touches one of the watched entities. Poor man's react-query, which
 * is all a single-user local app needs.
 */
export function useInvoke<K extends IpcChannel>(
  channel: K,
  args: Parameters<IpcApi[K]>,
  watch: DbEntity[],
  /** false skips the invoke entirely (e.g. channels denied over remote access) */
  enabled = true
): { data: Result<K> | undefined; reload: () => void } {
  const [data, setData] = useState<Result<K> | undefined>(undefined)
  const argsKey = JSON.stringify(args)
  const watchKey = watch.join(',')

  const reload = useCallback(() => {
    if (!enabled) return
    void api.invoke(channel, ...(JSON.parse(argsKey) as Parameters<IpcApi[K]>)).then(setData)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel, argsKey, enabled])

  useEffect(() => reload(), [reload])

  useEffect(() => {
    // watch: [] opts out of db-driven refresh entirely — those hooks back
    // non-db data (macOS calendar helper, usage logs) that a broadcast
    // entity 'all' (e.g. the MCP-write poll) must not reload
    if (watchKey === '') return undefined
    const entities = watchKey.split(',') as DbEntity[]
    return api.on('db:changed', (p) => {
      if (p.entity === 'all' || entities.includes(p.entity) || entities.includes('all')) reload()
    })
  }, [reload, watchKey])

  return { data, reload }
}

import { useCallback, useEffect, useState } from 'react'
import type { IpcApi, IpcChannel, DbEntity } from '../../../shared/ipc-contract'

export const api = window.api

type Result<K extends IpcChannel> = Awaited<ReturnType<IpcApi[K]>>

/**
 * Fetch-and-subscribe hook: runs the invoke, re-runs whenever a db:changed
 * event touches one of the watched entities. Poor man's react-query, which
 * is all a single-user local app needs.
 */
export function useInvoke<K extends IpcChannel>(
  channel: K,
  args: Parameters<IpcApi[K]>,
  watch: DbEntity[]
): { data: Result<K> | undefined; reload: () => void } {
  const [data, setData] = useState<Result<K> | undefined>(undefined)
  const argsKey = JSON.stringify(args)
  const watchKey = watch.join(',')

  const reload = useCallback(() => {
    void api.invoke(channel, ...(JSON.parse(argsKey) as Parameters<IpcApi[K]>)).then(setData)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel, argsKey])

  useEffect(() => reload(), [reload])

  useEffect(() => {
    const entities = watchKey.split(',') as DbEntity[]
    return api.on('db:changed', (p) => {
      if (p.entity === 'all' || entities.includes(p.entity) || entities.includes('all')) reload()
    })
  }, [reload, watchKey])

  return { data, reload }
}

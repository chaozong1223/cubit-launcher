import { useCallback, useEffect, useRef, useState } from 'react'
import { describeError } from './backend'

export type AsyncStatus = 'loading' | 'ready' | 'not-wired' | 'error'

export interface AsyncState<T> {
  status: AsyncStatus
  data: T | null
  error: unknown
  reload: () => void
}

/**
 * Small data hook used by pages. It never invents data: an unavailable IPC
 * channel becomes the explicit `not-wired` state, not a demo dataset.
 */
export function useAsync<T>(loader: () => Promise<T>, deps: readonly unknown[] = []): AsyncState<T> {
  const loaderRef = useRef(loader)
  loaderRef.current = loader
  const [status, setStatus] = useState<AsyncStatus>('loading')
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<unknown>(null)
  const runToken = useRef(0)

  const reload = useCallback(() => {
    const token = ++runToken.current
    setStatus('loading')
    setError(null)
    void loaderRef.current().then(
      (result) => {
        if (token !== runToken.current) return
        setData(result)
        setStatus('ready')
      },
      (cause: unknown) => {
        if (token !== runToken.current) return
        setData(null)
        setError(cause)
        setStatus(describeError(cause).kind === 'not-wired' ? 'not-wired' : 'error')
      },
    )
  }, [])

  useEffect(() => {
    reload()
    // The caller supplies the semantic dependencies (instance id, etc.).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  return { status, data, error, reload }
}

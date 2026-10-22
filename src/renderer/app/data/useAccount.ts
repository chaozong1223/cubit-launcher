import { useEffect } from 'react'
import { useBackend } from './BackendContext'
import { useAsync } from './useAsync'

/** Current account for the shell chrome; refreshes when auth emits changed. */
export function useCurrentAccount() {
  const backend = useBackend()
  const state = useAsync(() => backend.auth.list(), [])
  useEffect(() => {
    const off = backend.auth.subscribeChanged(() => state.reload())
    return off
  }, [backend, state.reload])
  return state
}

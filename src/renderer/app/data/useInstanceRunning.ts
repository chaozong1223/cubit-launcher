import { useEffect, useState } from 'react'
import { useBackend } from './BackendContext'

/** Tracks the real launch state for one instance; used to disable deletion while running. */
export function useInstanceRunning(instanceId: string | null | undefined): boolean {
  const backend = useBackend()
  const [running, setRunning] = useState(false)

  useEffect(() => {
    if (!instanceId) {
      setRunning(false)
      return
    }
    let alive = true
    const off = backend.launch.subscribeStatus((event) => {
      if (event.instanceId !== instanceId) return
      setRunning(event.state === 'running')
    })
    void backend.launch.status(instanceId).then((status) => {
      if (alive) setRunning(status.state === 'running')
    }).catch(() => {
      if (alive) setRunning(false)
    })
    return () => {
      alive = false
      off()
    }
  }, [backend, instanceId])

  return running
}

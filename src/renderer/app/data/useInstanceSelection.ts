import { useEffect, useState } from 'react'
import type { InstanceSummary } from '@shared/instance'
import { useBackend } from './BackendContext'
import { useAsync, type AsyncState } from './useAsync'

export interface InstanceSelection {
  instances: AsyncState<InstanceSummary[]>
  selectedId: string
  setSelectedId: (id: string) => void
  selected: InstanceSummary | null
}

/** Shared instance selector used by saves/screenshots/logs/trash pages. */
export function useInstanceSelection(): InstanceSelection {
  const backend = useBackend()
  const instances = useAsync(() => backend.instances.list(), [])
  const [selectedId, setSelectedId] = useState('')

  useEffect(() => {
    if (!instances.data || instances.data.length === 0) return
    if (selectedId && instances.data.some((instance) => instance.id === selectedId)) return
    const ready = instances.data.find((instance) => instance.state === 'ready') ?? instances.data[0]
    setSelectedId(ready.id)
  }, [instances.data, selectedId])

  useEffect(() => {
    const refresh = () => instances.reload()
    const off = backend.instances.subscribeChanged(refresh)
    window.addEventListener('mcl:instances-changed', refresh)
    return () => {
      off()
      window.removeEventListener('mcl:instances-changed', refresh)
    }
  }, [backend, instances.reload])

  useEffect(() => {
    if (selectedId) localStorage.setItem('mcl.global.instanceId', selectedId)
  }, [selectedId])

  return {
    instances,
    selectedId,
    setSelectedId,
    selected: instances.data?.find((instance) => instance.id === selectedId) ?? null,
  }
}

import { createContext, useContext, type ReactNode } from 'react'
import type { AppInfo } from '@shared/system'

export interface SecurityFlags {
  nodeRequire: boolean
  nodeProcess: boolean
  blockedChannelRejected: boolean | null
}

export interface SystemValue {
  info: AppInfo | null
  version: string | null
  loading: boolean
  error: unknown
  reload: () => void
  flags: SecurityFlags
}

const SystemContext = createContext<SystemValue | null>(null)

export function SystemProvider({ value, children }: { value: SystemValue; children: ReactNode }) {
  return <SystemContext.Provider value={value}>{children}</SystemContext.Provider>
}

export function useSystem(): SystemValue {
  const value = useContext(SystemContext)
  if (!value) throw new Error('useSystem must be used inside SystemProvider')
  return value
}

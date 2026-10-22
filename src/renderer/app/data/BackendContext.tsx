import { createContext, useContext, type ReactNode } from 'react'
import { ipcBackend, type Backend } from './backend'

const BackendContext = createContext<Backend>(ipcBackend)

export function BackendProvider({ value, children }: { value?: Backend; children: ReactNode }) {
  return <BackendContext.Provider value={value ?? ipcBackend}>{children}</BackendContext.Provider>
}

export function useBackend(): Backend {
  return useContext(BackendContext)
}

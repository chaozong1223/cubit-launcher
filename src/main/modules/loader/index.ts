import { app } from 'electron'
import { moduleIpc, type ModuleHandlers } from '../../kernel/ipc'
import type { ContractDef } from '@shared/kernel'
import type { LoaderHandlers } from './handlers'
import { createRegister, moduleId } from './module'

export { moduleId }

/**
 * Module entry point discovered by `modules/_registry.ts`.
 *
 * The loader module owns its contract + handlers and registers them through the
 * t20 kernel bridge (the kernel sees `moduleIpc.has('loader')` and does not
 * double-install). Progress/log/finished events are emitted by the service and
 * forwarded through `moduleIpc.emit`, which validates the payload, throttles
 * progress to 100 ms and pushes to every live window.
 */
export const register = createRegister({
  appVersion: () => app.getVersion(),
  bindIpc: (contract: ContractDef, handlers: LoaderHandlers) => {
    moduleIpc.handle(contract, handlers as unknown as ModuleHandlers)
  },
  emit: {
    progress: (progress) => void moduleIpc.emit('loader', 'progress', progress),
    log: (event) => void moduleIpc.emit('loader', 'log', event),
    finished: (event) => void moduleIpc.emit('loader', 'finished', event),
  },
})

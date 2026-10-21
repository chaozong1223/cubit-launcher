import { app } from 'electron'
import { registerDownloadIpc } from './ipc'
import { createRegister, moduleId } from './module'

export { moduleId }

/**
 * Module entry point discovered by `modules/_registry.ts` (filesystem as
 * registry). Electron imports live only here and in `ipc.ts`; `module.ts`,
 * `service.ts` and `core/**` stay Node-only so they can be unit-tested.
 */
export const register = createRegister({
  // Electron is ready enough to know its version when modules register.
  appVersion: () => app.getVersion(),
  bindIpc: (service, log) => {
    registerDownloadIpc(service, log)
  },
})

import type { ScopedLogger } from '../../kernel/logger'
import type { ModuleContext } from '../_registry'
import { resolveModuleRoots } from '../_context'
import { publishService } from '../_services'
import { makeHandlers } from './handlers'
import { createDownloadService, type DownloadService } from './service'

/**
 * Electron-free module definition (the scaffold's registry only needs
 * `moduleId` + `register`). `index.ts` adds the IPC binder; tests can call
 * `createRegister` with their own binder and a fake service.
 *
 * Register stays cheap (docs/03 §4.4): build the service, publish it, wire
 * handlers. No network, no scanning, no download.
 */
export const moduleId = 'download'

export type ModuleIpcBinder = (service: DownloadService, log: ScopedLogger) => void | Promise<void>

export interface DownloadRegisterOptions {
  appVersion?: string | (() => string)
  /** Defaults to the Electron IPC binder in `index.ts`. */
  bindIpc?: ModuleIpcBinder
  /** Test seam: inject a pre-built service. */
  service?: DownloadService
}

function resolveVersion(version: DownloadRegisterOptions['appVersion']): string {
  if (typeof version === 'function') {
    try {
      return version()
    } catch {
      return '0.1.0'
    }
  }
  return version ?? '0.1.0'
}

export function createRegister(options: DownloadRegisterOptions = {}) {
  return async function register(ctx: ModuleContext): Promise<void> {
    const roots = resolveModuleRoots(ctx.dataRoot)
    const service =
      options.service ??
      createDownloadService({
        roots,
        log: ctx.log,
        appVersion: resolveVersion(options.appVersion),
      })

    publishService(moduleId, service)
    // Construct now so contract drift breaks at boot, not on click.
    makeHandlers(service)

    if (options.bindIpc) {
      await options.bindIpc(service, ctx.log)
    }

    ctx.log.info('module registered', {
      mcRoot: roots.mcRoot,
      dataRoot: roots.dataRoot,
    })
  }
}

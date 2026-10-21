import { app, shell } from 'electron'
import { catalogContract } from '@shared/catalog'
import type { ModsService } from '@shared/mods'
import type { ModuleContext } from '../_registry'
import { getService, publishService } from '../_services'
import { resolveModuleRoots } from '../_context'
import { moduleIpc, type ModuleHandlers } from '../../kernel/ipc'
import { makeHandlers } from './handlers'
import { createCatalogService } from './service'

export const moduleId = 'catalog'

/**
 * Catalog self-registers through the t20 moduleIpc surface (the frozen kernel
 * contract map predates t41). The mods service is resolved lazily because the
 * registry may load `catalog` before `mods`.
 */
export function register(ctx: ModuleContext): void {
  const service = createCatalogService({
    roots: resolveModuleRoots(ctx.dataRoot),
    log: ctx.log,
    appVersion: app.getVersion(),
    mods: () => getService<ModsService>('mods'),
    openExternal: (url) => shell.openExternal(url),
    emit: (event, payload) => {
      moduleIpc.emit(moduleId, event, payload)
    },
  })
  publishService(moduleId, service)
  moduleIpc.handle(catalogContract, makeHandlers(service) as unknown as ModuleHandlers)
  ctx.log.info('module registered')
}

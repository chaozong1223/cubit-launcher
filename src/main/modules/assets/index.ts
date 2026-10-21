import { app, shell } from 'electron'
import type { ModuleContext } from '../_registry'
import { publishService } from '../_services'
import { resolveModuleRoots } from '../_context'
import { moduleIpc, type ModuleHandlers } from '../../kernel/ipc'
import { assetsContract } from '@shared/assets'
import { makeHandlers } from './handlers'
import { createAssetsService } from './service'

export const moduleId = 'assets'

export function register(ctx: ModuleContext): void {
  const roots = resolveModuleRoots(ctx.dataRoot)
  const service = createAssetsService({
    roots,
    log: ctx.log,
    appVersion: app.getVersion(),
    openPath: (target) => shell.openPath(target),
    showItemInFolder: (target) => shell.showItemInFolder(target),
  })

  publishService(moduleId, service)
  moduleIpc.handle(assetsContract, makeHandlers(service) as unknown as ModuleHandlers)
  service.onEvent('changed', (payload) => {
    moduleIpc.emit(moduleId, 'changed', payload)
  })

  ctx.log.info('module registered', { mcRoot: roots.mcRoot ? 'configured' : 'missing' })
}

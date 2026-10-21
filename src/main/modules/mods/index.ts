import { shell } from 'electron'
import type { ModuleContext } from '../_registry'
import { publishService } from '../_services'
import { resolveModuleRoots } from '../_context'
import { moduleIpc, type ModuleHandlers } from '../../kernel/ipc'
import { modsContract } from '@shared/mods'
import { makeHandlers } from './handlers'
import { createModsService } from './service'

export const moduleId = 'mods'

export function register(ctx: ModuleContext): void {
  const roots = resolveModuleRoots(ctx.dataRoot)
  const service = createModsService({
    roots,
    log: ctx.log,
    openPath: (target) => shell.openPath(target),
  })

  publishService(moduleId, service)
  // Self-register so the frozen kernel can bind this contract at registerIpc().
  moduleIpc.handle(modsContract, makeHandlers(service) as unknown as ModuleHandlers)
  service.onEvent('changed', (payload) => {
    moduleIpc.emit(moduleId, 'changed', payload)
  })

  ctx.log.info('module registered', { mcRoot: roots.mcRoot ? 'configured' : 'missing' })
}

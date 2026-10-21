import { repairContract } from '@shared/repair'
import type { ModuleContext } from '../_registry'
import { publishService } from '../_services'
import { resolveModuleRoots } from '../_context'
import { moduleIpc, type ModuleHandlers } from '../../kernel/ipc'
import { makeHandlers } from './handlers'
import { createRepairService } from './service'

export const moduleId = 'repair'

/**
 * Self-registering module (the frozen kernel's BUILTIN_CONTRACTS predates t31,
 * so repair uses the public `moduleIpc` surface just like the loader module).
 */
export function register(ctx: ModuleContext): void {
  const service = createRepairService(resolveModuleRoots(ctx.dataRoot), ctx.log, {
    emit: (event, payload) => {
      moduleIpc.emit(moduleId, event, payload)
    },
  })
  publishService(moduleId, service)
  moduleIpc.handle(repairContract, makeHandlers(service) as unknown as ModuleHandlers)
  ctx.log.info('module registered')
}

import type { ModuleContext } from '../_registry'
import { publishService } from '../_services'
import { resolveModuleRoots } from '../_context'
import { createJavaService } from './service'
import { makeHandlers } from './handlers'

export const moduleId = 'java'

export function register(ctx: ModuleContext): void {
  const service = createJavaService(resolveModuleRoots(ctx.dataRoot), ctx.log)
  publishService(moduleId, service)
  makeHandlers(service)
  ctx.log.info('module registered')
}

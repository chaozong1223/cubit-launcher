import type { ModuleContext } from '../_registry'
import { publishService } from '../_services'
import { resolveModuleRoots } from '../_context'
import { createLaunchService } from './service'
import { makeHandlers } from './handlers'

export const moduleId = 'launch'
export const dependsOn = ['version', 'instance', 'java'] as const

export function register(ctx: ModuleContext): void {
  const service = createLaunchService(resolveModuleRoots(ctx.dataRoot), ctx.log)
  publishService(moduleId, service)
  makeHandlers(service)
  ctx.log.info('module registered', { deps: dependsOn })
}

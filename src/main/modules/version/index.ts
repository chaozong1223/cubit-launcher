import type { ModuleContext } from '../_registry'
import { publishService } from '../_services'
import { resolveModuleRoots } from '../_context'
import { createVersionService } from './service'
import { makeHandlers } from './handlers'

export const moduleId = 'version'

export function register(ctx: ModuleContext): void {
  const roots = resolveModuleRoots(ctx.dataRoot)
  const service = createVersionService(roots, ctx.log)
  publishService(moduleId, service)
  // Handlers are constructed now so contract drift fails at boot, not on click.
  makeHandlers(service)
  ctx.log.info('module registered', { mcRoot: roots.mcRoot })
}

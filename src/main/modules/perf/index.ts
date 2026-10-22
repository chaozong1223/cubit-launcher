import { app } from 'electron'
import { perfContract } from '@shared/perf'
import type { ModuleContext } from '../_registry'
import { getService, publishService } from '../_services'
import { resolveModuleRoots } from '../_context'
import { moduleIpc, type ModuleHandlers } from '../../kernel/ipc'
import { makeHandlers } from './handlers'
import { createPerfService } from './service'

export const moduleId = 'perf'

/**
 * Performance module. It publishes its own IPC handlers through moduleIpc
 * (like catalog/assets) and only exposes read-only probes plus two explicit
 * mutations: apply memory to one instance and clean whitelisted caches.
 */
export function register(ctx: ModuleContext): void {
  const roots = resolveModuleRoots(ctx.dataRoot)
  const service = createPerfService({
    dataRoot: roots.dataRoot,
    log: ctx.log,
    getMcRoot: () => resolveModuleRoots(ctx.dataRoot).mcRoot,
    isInstanceRunning: (instanceId, dirName) => {
      const launch = getService<{
        status?: (id: string) => { state?: string } | undefined | null
      }>('launch')
      if (!launch?.status) return false
      try {
        for (const id of [instanceId, dirName]) {
          if (launch.status(id)?.state === 'running') return true
        }
      } catch {
        // A launch service without a finished orchestrator is not running.
      }
      return false
    },
  })
  publishService(moduleId, service)
  moduleIpc.handle(perfContract, makeHandlers(service) as unknown as ModuleHandlers)
  ctx.log.info('module registered', { appVersion: app.getVersion() })
}

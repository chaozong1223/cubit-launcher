import type { ModuleContext } from '../_registry'
import { getService, publishService } from '../_services'
import { resolveModuleRoots } from '../_context'
import { moduleIpc } from '../../kernel/ipc'
import { createInstanceService } from './service'
import { makeHandlers } from './handlers'

export const moduleId = 'instance'

interface RootedModule {
  roots?: { mcRoot: string | null }
  options?: { roots?: { mcRoot: string | null } }
  orchestrator?: unknown
}

/**
 * t32 lets the first-run import take effect immediately. Other modules captured
 * ModuleRoots at registration; rather than editing their files (out of scope),
 * refresh the published service objects and drop launch's lazy orchestrator so
 * dry-run/launch rebuilds against the newly imported root. Config is still the
 * durable source of truth; after restart every module reads it normally.
 */
function refreshModuleRoots(mcRoot: string): void {
  for (const id of ['launch', 'download', 'version', 'mods', 'net', 'loader', 'repair']) {
    const service = getService<RootedModule>(id)
    if (!service) continue
    try {
      if (service.roots && typeof service.roots === 'object') service.roots.mcRoot = mcRoot
      if (service.options?.roots) service.options.roots.mcRoot = mcRoot
      if (id === 'launch') service.orchestrator = null
    } catch {
      // Runtime propagation is a convenience; persistence still guarantees the
      // root after restart even if one module object is frozen.
    }
  }
}

export function register(ctx: ModuleContext): void {
  const service = createInstanceService(resolveModuleRoots(ctx.dataRoot), ctx.log, {
    onRootChanged: (mcRoot) => {
      refreshModuleRoots(mcRoot)
      moduleIpc.emit(moduleId, 'changed', { instanceId: null })
    },
    onChanged: (instanceId) => {
      moduleIpc.emit(moduleId, 'changed', { instanceId })
    },
    onCopyProgress: (progress) => {
      moduleIpc.emit(moduleId, 'copyProgress', progress)
    },
    onCopyFinished: (finished) => {
      moduleIpc.emit(moduleId, 'copyFinished', finished)
    },
    onShareExportProgress: (progress) => {
      moduleIpc.emit(moduleId, 'shareExportProgress', progress)
    },
    onShareExportFinished: (finished) => {
      moduleIpc.emit(moduleId, 'shareExportFinished', finished)
    },
    onShareImportProgress: (progress) => {
      moduleIpc.emit(moduleId, 'shareImportProgress', progress)
    },
    onShareImportFinished: (finished) => {
      moduleIpc.emit(moduleId, 'shareImportFinished', finished)
    },
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
  makeHandlers(service)
  ctx.log.info('module registered')
}

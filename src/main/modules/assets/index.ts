import { app, shell } from 'electron'
import { openPathInShell } from '../../core/open-path'
import type { ModuleContext } from '../_registry'
import { getService, publishService } from '../_services'
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
    openPath: (target) => openPathInShell(target),
    showItemInFolder: (target) => shell.showItemInFolder(target),
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
    onCopySaveProgress: (progress) => {
      moduleIpc.emit(moduleId, 'copySaveProgress', progress)
    },
    onCopySaveFinished: (finished) => {
      moduleIpc.emit(moduleId, 'copySaveFinished', finished)
    },
  })

  publishService(moduleId, service)
  moduleIpc.handle(assetsContract, makeHandlers(service) as unknown as ModuleHandlers)
  service.onEvent('changed', (payload) => {
    moduleIpc.emit(moduleId, 'changed', payload)
  })

  ctx.log.info('module registered', { mcRoot: roots.mcRoot ? 'configured' : 'missing' })
}

import { AppError } from '@shared/errors'
import { serverContract } from '@shared/server'
import type { ModuleContext } from '../_registry'
import { getService, publishService } from '../_services'
import { resolveModuleRoots } from '../_context'
import { moduleIpc, type ModuleHandlers } from '../../kernel/ipc'
import { makeHandlers } from './handlers'
import { ServerService } from './service'

export const moduleId = 'server'
export const dependsOn = ['java'] as const

interface JavaLookup {
  choose(input: { requiredMajor?: number | null }): Promise<{
    candidate: { path: string; version: { raw: string } } | null
  }>
}

/**
 * Local vanilla servers. The module only handles versions whose JSON carries
 * `downloads.server`; Forge/Fabric need an installer and are refused by
 * `create` with a readable error rather than half-working.
 */
export function register(ctx: ModuleContext): void {
  const roots = resolveModuleRoots(ctx.dataRoot)
  const service = new ServerService({
    dataRoot: ctx.dataRoot,
    mcRoot: roots.mcRoot,
    log: ctx.log,
    resolveJava: async (requiredMajor) => {
      const java = getService<JavaLookup>('java')
      if (!java) {
        throw new AppError('SERVER.NO_JAVA', 'Java 模块不可用，请先安装 Java')
      }
      const choice = await java.choose({ requiredMajor })
      if (!choice.candidate) {
        throw new AppError('SERVER.NO_JAVA', '没有可用的 Java 运行时，请先安装')
      }
      return { path: choice.candidate.path, version: choice.candidate.version.raw }
    },
  })

  service.onChanged((info) => {
    moduleIpc.emit(moduleId, 'changed', { id: info.id, state: info.state, pid: info.pid })
  })
  publishService(moduleId, service)
  moduleIpc.handle(serverContract, makeHandlers(service) as unknown as ModuleHandlers)
  ctx.log.info('module registered', { mcRoot: roots.mcRoot ? 'configured' : 'missing' })
}

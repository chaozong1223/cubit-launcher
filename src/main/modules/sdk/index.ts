import { shell } from 'electron'
import { sdkContract } from '@shared/sdk'
import type { ModuleContext } from '../_registry'
import { publishService } from '../_services'
import { moduleIpc, type ModuleHandlers } from '../../kernel/ipc'
import { makeHandlers } from './handlers'
import { createSdkService } from './service'

export const moduleId = 'sdk'

/**
 * Third-party multiplayer SDK manifests (validated sidecars). Built-in EasyTier
 * stays the default channel; these entries are only started on explicit user
 * action after every manifest check passes.
 */
export function register(ctx: ModuleContext): void {
  const service = createSdkService({
    dataRoot: ctx.dataRoot,
    log: ctx.log,
    openPath: (target) => shell.openPath(target),
  })
  publishService(moduleId, service)
  moduleIpc.handle(sdkContract, makeHandlers(service) as unknown as ModuleHandlers)
  ctx.log.info('module registered')

  // A sidecar must never outlive the launcher: kill tracked children on exit
  // (same last-resort pattern as the EasyTier sidecar in modules/net).
  process.once('exit', () => {
    service.disposeSync()
  })
}

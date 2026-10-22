import { skinContract } from '@shared/skin'
import type { ModuleContext } from '../_registry'
import { getService, publishService } from '../_services'
import { moduleIpc, type ModuleHandlers } from '../../kernel/ipc'
import { makeHandlers } from './handlers'
import { createSkinService } from './service'

export const moduleId = 'skin'

interface AuthLookup {
  list(): Promise<{ accounts: Array<{ id: string }> }>
  profile(accountId: string): Promise<{ skinUrl: string | null }>
}

/**
 * Local skin cache. It never uploads to Microsoft/authlib; accounts are only
 * used as cache keys, so switching the selected account switches the skin.
 */
export function register(ctx: ModuleContext): void {
  const auth = () => getService<AuthLookup>('auth')
  const service = createSkinService({
    dataRoot: ctx.dataRoot,
    log: ctx.log,
    accountExists: async (accountId) => {
      const service = auth()
      if (!service) return true
      try {
        const list = await service.list()
        return list.accounts.some((account) => account.id === accountId)
      } catch {
        return false
      }
    },
    profileSkinUrl: async (accountId) => {
      const service = auth()
      if (!service) return null
      try {
        return (await service.profile(accountId)).skinUrl
      } catch {
        return null
      }
    },
  })
  publishService(moduleId, service)
  moduleIpc.handle(skinContract, makeHandlers(service) as unknown as ModuleHandlers)
  ctx.log.info('module registered')
}

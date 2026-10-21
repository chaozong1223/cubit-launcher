import { shell } from 'electron'
import type { ModuleContext } from '../_registry'
import { getService, publishService } from '../_services'
import { resolveModuleRoots } from '../_context'
import { moduleIpc, type ModuleHandlers } from '../../kernel/ipc'
import type { AuthlibInjection, LaunchAccount } from '../../core/launch/args'
import { authContract } from '@shared/auth'
import { createSafeStorageCipher } from './cipher'
import { makeHandlers } from './handlers'
import { AuthService } from './service'

export const moduleId = 'auth'

interface LaunchServiceLike {
  setAccountResolver(
    resolver: (accountId: string | null) => Promise<LaunchAccount | null>,
  ): void
  setAuthlibResolver?(
    resolver: (
      instance: unknown,
      account: LaunchAccount,
    ) => Promise<AuthlibInjection | null>,
  ): void
}

/**
 * t11 wires auth into launch. Both resolvers are public service APIs now;
 * no private orchestrator-options mutation is needed.
 */
function wireLaunchBridge(
  service: AuthService,
  log: ModuleContext['log'],
  attempt = 0,
): void {
  const launch = getService<LaunchServiceLike>('launch')
  if (!launch) {
    if (attempt < 60) setTimeout(() => wireLaunchBridge(service, log, attempt + 1), 50)
    return
  }

  try {
    launch.setAccountResolver((accountId) => service.getLaunchAccount(accountId))
  } catch (error) {
    log.warn('auth launch resolver wiring failed', {
      message: error instanceof Error ? error.message : String(error),
      hint: '账户解析不可用；重启后会自动重试。',
    })
    return
  }

  if (typeof launch.setAuthlibResolver !== 'function') {
    log.warn('authlib resolver wiring unavailable', {
      authlib: false,
      hint: 'LaunchModuleService 缺少 setAuthlibResolver；Authlib 注入未接线，请检查版本一致性。',
    })
    return
  }

  try {
    launch.setAuthlibResolver(async (_instance, account) =>
      service.getAuthlibInjectionForLaunchAccount(account),
    )
    log.info('auth launch bridge wired', { authlib: true })
  } catch (error) {
    log.warn('authlib resolver wiring failed', {
      authlib: false,
      message: error instanceof Error ? error.message : String(error),
      hint: 'Authlib 注入未接线；普通离线/微软账户不受影响。',
    })
  }
}

export function register(ctx: ModuleContext): void {
  const roots = resolveModuleRoots(ctx.dataRoot)
  const service = new AuthService({
    dataRoot: roots.dataRoot,
    log: ctx.log,
    cipher: createSafeStorageCipher(),
    openExternal: (url) => shell.openExternal(url),
  })

  publishService(moduleId, service)
  // Self-register the auth contract; t20's kernel binds it once registerIpc runs.
  moduleIpc.handle(
    authContract,
    makeHandlers(service) as unknown as ModuleHandlers,
  )
  service.onEvent('changed', (payload) => {
    moduleIpc.emit(moduleId, 'changed', payload)
  })

  // auth registers before launch (alphabetical module order), so defer wiring.
  setTimeout(() => wireLaunchBridge(service, ctx.log), 0)

  ctx.log.info('module registered', {
    accounts: service.getMicrosoftConfig().configured ? 'ms-configured' : 'ms-unconfigured',
    authlib: AuthService.authlib.version,
  })
}

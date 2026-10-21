import type { ContractDef } from '@shared/kernel'
import {
  loaderContract,
  type LoaderFinished,
  type LoaderLogEvent,
  type LoaderProgress,
} from '@shared/loader'
import type { ModuleContext } from '../_registry'
import { resolveModuleRoots } from '../_context'
import { publishService } from '../_services'
import { makeHandlers, type LoaderHandlers } from './handlers'
import {
  createLoaderService,
  type LoaderService,
  type LoaderServiceOptions,
} from './service'

/**
 * Electron-free module definition. `index.ts` adds the kernel IPC binder and
 * event emitters; tests can pass their own binder/emitter/service.
 *
 * Register stays cheap: build the service, publish it, wire handlers. Nothing
 * is fetched and no Java process is started here.
 */
export const moduleId = 'loader'

export type LoaderIpcBinder = (contract: ContractDef, handlers: LoaderHandlers) => void

export interface LoaderServiceOverrides {
  fs?: LoaderServiceOptions['fs']
  ports?: LoaderServiceOptions['ports']
  http?: LoaderServiceOptions['http']
  endpoints?: LoaderServiceOptions['endpoints']
  download?: LoaderServiceOptions['download']
  installerTimeoutMs?: number
  launcherVersion?: string
  platform?: NodeJS.Platform
  arch?: string
  javaResolver?: LoaderServiceOptions['javaResolver']
  now?: () => number
}

export interface LoaderRegisterOptions extends LoaderServiceOverrides {
  appVersion?: string | (() => string)
  bindIpc?: LoaderIpcBinder
  emit?: {
    progress?: (progress: LoaderProgress) => void
    log?: (event: LoaderLogEvent) => void
    finished?: (event: LoaderFinished) => void
  }
  /** Test seam: use a pre-built service instead of creating one. */
  service?: LoaderService
}

function resolveVersion(version: LoaderRegisterOptions['appVersion']): string {
  if (typeof version === 'function') {
    try {
      return version()
    } catch {
      return '0.1.0'
    }
  }
  return version ?? '0.1.0'
}

export function createRegister(options: LoaderRegisterOptions = {}) {
  return function register(ctx: ModuleContext): void {
    const roots = resolveModuleRoots(ctx.dataRoot)
    const appVersion = resolveVersion(options.appVersion)
    const service =
      options.service ??
      createLoaderService({
        roots,
        log: ctx.log,
        appVersion,
        ...(options.fs ? { fs: options.fs } : {}),
        ...(options.ports ? { ports: options.ports } : {}),
        ...(options.http ? { http: options.http } : {}),
        ...(options.endpoints ? { endpoints: options.endpoints } : {}),
        ...(options.download !== undefined ? { download: options.download } : {}),
        ...(options.installerTimeoutMs ? { installerTimeoutMs: options.installerTimeoutMs } : {}),
        ...(options.launcherVersion ? { launcherVersion: options.launcherVersion } : {}),
        ...(options.platform ? { platform: options.platform } : {}),
        ...(options.arch ? { arch: options.arch } : {}),
        ...(options.javaResolver ? { javaResolver: options.javaResolver } : {}),
        ...(options.now ? { now: options.now } : {}),
        events: {
          onProgress: (progress) => options.emit?.progress?.(progress),
          onLog: (event) => options.emit?.log?.(event),
          onFinished: (event) => options.emit?.finished?.(event),
        },
      })

    publishService(moduleId, service)
    // Construct handlers now so contract drift fails at boot, not on click.
    const handlers = makeHandlers(service)
    options.bindIpc?.(loaderContract, handlers)

    ctx.log.info('module registered', {
      mcRoot: roots.mcRoot,
      dataRoot: roots.dataRoot,
      hasIpc: Boolean(options.bindIpc),
    })
  }
}

export type LoaderRegister = ReturnType<typeof createRegister>

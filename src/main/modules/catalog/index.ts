import { app, shell } from 'electron'
import { spawn } from 'node:child_process'
import { catalogContract } from '@shared/catalog'
import type { ModsService } from '@shared/mods'
import type { ModuleContext } from '../_registry'
import { getService, publishService } from '../_services'
import { resolveModuleRoots } from '../_context'
import { moduleIpc, type ModuleHandlers } from '../../kernel/ipc'
import { configureCurseForgeCipher } from '../../core/curseforge/settings'
import { makeHandlers } from './handlers'
import { createCatalogService } from './service'
import { createSafeStorageCurseForgeCipher } from './secure-storage'

export const moduleId = 'catalog'

/**
 * Catalog self-registers through the t20 moduleIpc surface (the frozen kernel
 * contract map predates t41). The mods service is resolved lazily because the
 * registry may load `catalog` before `mods`.
 */
export function register(ctx: ModuleContext): void {
  // The CurseForge key is encrypted with the OS keychain (DPAPI on Windows).
  // Mods' CurseForge resolver reads the same store, so the cipher is registered
  // process-wide before any import can start.
  configureCurseForgeCipher(createSafeStorageCurseForgeCipher())
  const service = createCatalogService({
    roots: resolveModuleRoots(ctx.dataRoot),
    log: ctx.log,
    appVersion: app.getVersion(),
    mods: () => getService<ModsService>('mods'),
    // `shell.openExternal` resolves successfully but opens nothing on some
    // Windows installs (broken default-browser association / AV hook). Explorer
    // hands the URL to the same shell association and actually launches it, and
    // passing the URL as a spawn argument avoids cmd.exe parsing (& in URLs).
    openExternal: async (url: string) => {
      if (!url.startsWith('https://')) throw new Error('refusing to open non-https url')
      if (process.platform === 'win32') {
        spawn('explorer.exe', [url], { windowsHide: true, detached: true, stdio: 'ignore' }).unref()
        return
      }
      await shell.openExternal(url)
    },
    emit: (event, payload) => {
      moduleIpc.emit(moduleId, event, payload)
    },
  })
  publishService(moduleId, service)
  moduleIpc.handle(catalogContract, makeHandlers(service) as unknown as ModuleHandlers)
  ctx.log.info('module registered')
}

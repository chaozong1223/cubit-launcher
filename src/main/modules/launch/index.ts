import { BrowserWindow } from 'electron'
import type { ModuleContext } from '../_registry'
import { publishService } from '../_services'
import { resolveModuleRoots } from '../_context'
import { createLaunchService } from './service'
import { makeHandlers } from './handlers'
import { focusGameWindow } from './focus'

export const moduleId = 'launch'
export const dependsOn = ['version', 'instance', 'java'] as const

export function register(ctx: ModuleContext): void {
  const service = createLaunchService(resolveModuleRoots(ctx.dataRoot), ctx.log)
  // A window created by the java child process is born *behind* the launcher;
  // minimize ourselves and pull it forward, otherwise a healthy launch looks
  // like nothing happened.
  service.onGameStarted(({ pid }) => {
    for (const window of BrowserWindow.getAllWindows()) {
      try {
        if (!window.isDestroyed()) window.minimize()
      } catch {
        // A closing window is not a launch problem.
      }
    }
    if (pid) focusGameWindow(pid, { log: ctx.log })
  })
  publishService(moduleId, service)
  makeHandlers(service)
  ctx.log.info('module registered', { deps: dependsOn })
}

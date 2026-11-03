import { BrowserWindow } from 'electron'
import type { ModuleContext } from '../_registry'
import { publishService } from '../_services'
import { resolveModuleRoots } from '../_context'
import { createLaunchService } from './service'
import { makeHandlers } from './handlers'
import { focusGameWindow, startGameWindowWatcher } from './focus'

export const moduleId = 'launch'
export const dependsOn = ['version', 'instance', 'java'] as const

export function register(ctx: ModuleContext): void {
  const service = createLaunchService(resolveModuleRoots(ctx.dataRoot), ctx.log)
  // The 1.12.2 client can end up with a live title screen (music playing) and a
  // hidden LWJGL window. One-shot activation after `game started` proved
  // unreliable here, so a detached watcher keeps showing hidden game windows.
  startGameWindowWatcher({ log: ctx.log })
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
  // Bring the launcher back when the session ends, so "minimized for the game"
  // never turns into "where did the launcher go".
  service.onEvent('exited', () => {
    for (const window of BrowserWindow.getAllWindows()) {
      try {
        if (window.isDestroyed()) continue
        if (window.isMinimized()) window.restore()
        window.show()
        window.focus()
      } catch {
        // Same: never let window bookkeeping fail a launch lifecycle.
      }
    }
  })
  publishService(moduleId, service)
  makeHandlers(service)
  ctx.log.info('module registered', { deps: dependsOn })
}

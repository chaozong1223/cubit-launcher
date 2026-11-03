import { app, BrowserWindow, Menu, Tray } from 'electron'
import type { ModuleContext } from '../_registry'

/**
 * Tray icon.
 *
 * The launcher has no tray of its own in the shell, and the window cannot be
 * hidden safely without one (a hidden window with no way back is a trap). This
 * module adds a minimal one: click it to bring the launcher back, right-click
 * for the menu.
 *
 * It lives in a module on purpose: `src/main/index.ts` is in the frozen shell
 * manifest, and a tray does not need to be there.
 */
export const moduleId = 'tray'

function showLauncher(): void {
  const window = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed())
  if (!window) return
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
}

export function register(ctx: ModuleContext): void {
  let tray: Tray | null = null
  let disposed = false

  const create = async (): Promise<void> => {
    try {
      // Reuse the executable's own icon: no extra asset needs to survive asar
      // packing, and there is no path to get wrong.
      const icon = await app.getFileIcon(app.getPath('exe'), { size: 'small' })
      if (disposed || icon.isEmpty()) {
        ctx.log.warn('tray icon is empty; skipping')
        return
      }
      tray = new Tray(icon)
      tray.setToolTip('Cubit Launcher')
      tray.setContextMenu(
        Menu.buildFromTemplate([
          { label: '显示启动器', click: () => showLauncher() },
          { type: 'separator' },
          { label: '退出', click: () => app.quit() },
        ]),
      )
      tray.on('click', () => showLauncher())
      tray.on('double-click', () => showLauncher())
      ctx.log.info('tray icon created')
    } catch (error) {
      // A missing tray must never break the launcher.
      ctx.log.warn('tray icon unavailable', {
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  void create()

  app.once('before-quit', () => {
    disposed = true
    try {
      tray?.destroy()
    } catch {
      // Already torn down.
    }
    tray = null
  })
}

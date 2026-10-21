import { app, BrowserWindow, ipcMain } from 'electron'
import { toHandlerErrorShape } from '../../kernel/error-shape'
import type { ScopedLogger } from '../../kernel/logger'
import { isTrustedUrl } from '../../kernel/security'
import { registerDownloadIpcCore, type DownloadIpcCoreHandle } from './ipc-core'
import type { DownloadService } from './service'

/**
 * Electron adapter for the download module.
 *
 * The t5 kernel IPC is frozen and only knows the bootstrap channels, so this
 * module owns its channels (docs/03 §12.4):
 *   invoke  `mc:download:<method>`               (Result envelope)
 *   events  `mc:download:evt:progress|finished`  (100 ms throttle)
 *
 * t20's preload whitelists `mc:<id>:<method>` / `mc:<id>:evt:<event>` shapes and
 * the t20 kernel skips modules that ship `ipc.ts`, so exactly one handler is
 * registered. Progress pushes go to every live window on `setImmediate`, and
 * `webContents.send` never awaits, so the renderer cannot block downloads
 * (01 R1.16).
 */

export interface DownloadIpcOptions {
  ipc?: Pick<typeof ipcMain, 'handle' | 'removeHandler'>
  broadcast?: (channel: string, payload: unknown) => void
  validateOutput?: boolean
}

export type DownloadIpcHandle = DownloadIpcCoreHandle

function defaultBroadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    const contents = win.webContents
    if (contents.isDestroyed()) continue
    try {
      contents.send(channel, payload)
    } catch {
      /* a closing window must not break the download */
    }
  }
}

export function registerDownloadIpc(
  service: DownloadService,
  log: ScopedLogger,
  options: DownloadIpcOptions = {},
): DownloadIpcHandle {
  return registerDownloadIpcCore({
    ipc: options.ipc ?? ipcMain,
    broadcast: options.broadcast ?? defaultBroadcast,
    service,
    log: {
      info: (message, fields) => log.info(message, fields),
      warn: (message, fields) => log.warn(message, fields),
      error: (message, fields) => log.error(message, fields),
    },
    isTrustedSenderUrl: isTrustedUrl,
    toErrorShape: toHandlerErrorShape,
    // Output self-check in development only; production trusts the handler.
    validateOutput: options.validateOutput ?? !app.isPackaged,
  })
}

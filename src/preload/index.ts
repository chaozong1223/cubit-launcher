import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { McBridge } from '@shared/bridge'
import type { Result } from '@shared/kernel'
import { isAllowedEventChannel, isAllowedInvokeChannel } from '@shared/channels'

/**
 * The bridge exposes only two primitives.
 *
 * There is no per-channel whitelist to edit any more: `isAllowedInvokeChannel`
 * accepts the static kernel channels plus any well-formed `mc:<id>:<method>`
 * module channel. The main process installs handlers only for contracts that a
 * module actually registered, so an invented channel is still rejected. Node
 * primitives (`fs`, `child_process`, `require`, `process`) are never exposed.
 */
const bridge: McBridge = Object.freeze({
  meta: Object.freeze({
    platform: process.platform,
    versions: Object.freeze({
      electron: process.versions?.electron,
      chrome: process.versions?.chrome,
      node: process.versions?.node,
    }),
  }),
  system: Object.freeze({
    /** The File stays in preload/renderer boundary; only the path crosses. */
    getPathForFile(file: unknown): string {
      try {
        return webUtils.getPathForFile(file as Parameters<typeof webUtils.getPathForFile>[0])
      } catch {
        return ''
      }
    },
  }),
  invoke<T = unknown>(channel: string, payload?: unknown): Promise<Result<T>> {
    if (!isAllowedInvokeChannel(channel)) {
      return Promise.reject(new Error(`blocked channel: ${String(channel)}`))
    }
    return ipcRenderer.invoke(channel, payload) as Promise<Result<T>>
  },
  on(channel: string, callback: (payload: unknown) => void): () => void {
    if (!isAllowedEventChannel(channel)) {
      throw new Error(`blocked event channel: ${String(channel)}`)
    }
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  },
})

contextBridge.exposeInMainWorld('mc', bridge)

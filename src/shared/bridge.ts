import type { Result } from './kernel'

export interface BridgeMeta {
  platform: string
  versions: {
    electron?: string
    chrome?: string
    node?: string
  }
}

/**
 * The complete surface exposed by preload via contextBridge. The renderer never
 * sees ipcRenderer, fs, child_process or process.
 */
export interface McBridge {
  readonly meta: Readonly<BridgeMeta>
  /**
   * Electron 44 removed `File.path`. The preload calls
   * `webUtils.getPathForFile(file)` in its own context and returns only the
   * path string; the renderer never receives a Node object.
   */
  readonly system: Readonly<{
    getPathForFile(file: unknown): string
  }>
  invoke<T = unknown>(channel: string, payload?: unknown): Promise<Result<T>>
  on(channel: string, callback: (payload: unknown) => void): () => void
}

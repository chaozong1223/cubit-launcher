import type { McBridge } from '@shared/bridge'
import type { Result } from '@shared/kernel'
import type { AppInfo } from '@shared/system'
import { CHANNELS, type RendererReadyReport } from '@shared/channels'

export class IpcError extends Error {
  readonly code: string
  readonly retryable: boolean
  readonly details?: Record<string, unknown>

  constructor(shape: { code: string; message: string; retryable?: boolean; details?: Record<string, unknown> }) {
    super(shape.message)
    this.name = 'IpcError'
    this.code = shape.code
    this.retryable = shape.retryable ?? false
    this.details = shape.details
  }
}

declare global {
  interface Window {
    mc: McBridge
  }
}

function bridge(): McBridge {
  if (!window.mc) {
    throw new IpcError({
      code: 'IPC.NOT_READY',
      message: 'preload bridge 未加载；请检查 preload 构建与 sandbox 配置',
    })
  }
  return window.mc
}

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new IpcError(result.error)
  return result.data
}

async function invoke<T>(channel: string, payload?: unknown): Promise<T> {
  return unwrap(await bridge().invoke<T>(channel, payload))
}

/** Raw Result access for the adapter layer; blocked channels reject. */
export async function invokeResult<T>(channel: string, payload?: unknown): Promise<Result<T>> {
  return bridge().invoke<T>(channel, payload)
}

/** Subscribe to a typed push event through the whitelisted preload bridge. */
export function onBridge<T>(channel: string, callback: (payload: T) => void): () => void {
  return bridge().on(channel, (payload) => callback(payload as T))
}

export function hasBridge(): boolean {
  return typeof window !== 'undefined' && Boolean(window.mc)
}

export const api = {
  app: {
    info: (): Promise<AppInfo> => invoke<AppInfo>(CHANNELS.systemInfo),
    version: (): Promise<string> => invoke<string>(CHANNELS.appGetVersion),
    openDataDir: (): Promise<{ opened: boolean }> =>
      invoke<{ opened: boolean }>(CHANNELS.systemOpenDataDir),
    reportRendererReady: (report: RendererReadyReport): Promise<{ ack: boolean }> =>
      invoke<{ ack: boolean }>(CHANNELS.appRendererReady, report),
  },
  window: {
    minimize: (): Promise<{ ok: boolean }> => invoke(CHANNELS.windowMinimize),
    maximize: (): Promise<{ ok: boolean; maximized: boolean }> =>
      invoke(CHANNELS.windowMaximize),
    close: (): Promise<{ ok: boolean }> => invoke(CHANNELS.windowClose),
    isMaximized: (): Promise<boolean> => invoke<boolean>(CHANNELS.windowIsMaximized),
  },
  /** Proves that a non-whitelisted channel cannot reach main. */
  probeBlockedChannel: async (): Promise<boolean> => {
    try {
      await bridge().invoke('fs:readFile', { path: 'C:\\smoke-test' })
      return false
    } catch {
      return true
    }
  },
}

export type { McBridge }

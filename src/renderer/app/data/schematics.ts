import { BackendError, NotWiredError } from './backend'
import { hasBridge, invokeResult } from '../../lib/ipc'

/**
 * Renderer-side adapter for the schematic manager (`.litematic` / `.nbt` / `.schem`).
 *
 * t10 deliberately lands this before the backend contract: the page must talk to
 * real IPC channels, and when a channel is not registered yet it has to render an
 * explicit "not wired" state instead of sample rows. `t4` owns the main-process
 * contract; `t6` reconciles these channel names and payload types with
 * `shared/assets.ts` (or the new `schematics` contract) when it lands.
 */
export const SCHEMATIC_CHANNELS = {
  list: 'mc:assets:listSchematics',
  import: 'mc:assets:importSchematic',
} as const

export interface SchematicDimensions {
  x: number
  y: number
  z: number
}

export interface SchematicEntry {
  name: string
  /** `litematic` / `nbt` / `schem` / `unknown` */
  format: string
  /** File size in bytes. */
  size: number
  /** Last modification time (epoch ms). */
  modifiedAt: number
  /** Parsed from the file header; `null` when the header has no size metadata. */
  dimensions: SchematicDimensions | null
}

export interface SchematicListResult {
  /** Absolute `gameDir/schematics` path reported by the main process. */
  gameDir: string
  schematics: SchematicEntry[]
}

export interface SchematicImportResult {
  imported: number
}

/** Mirror of the `invoke` helper in data/backend.ts, kept local to this skeleton module. */
async function invoke<T>(feature: string, channel: string, payload?: unknown): Promise<T> {
  if (!hasBridge()) {
    throw new NotWiredError(feature, 'window.mc', 'preload 桥未加载；无法读取真实数据。')
  }

  let result
  try {
    result = await invokeResult<T>(channel, payload)
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    if (/blocked channel|No handler registered|preload bridge|IPC\.NOT_READY/i.test(message)) {
      throw new NotWiredError(
        feature,
        channel,
        `通道 ${channel} 尚未由主进程注册（或 preload 未运行）。当前保留界面结构，等待 IPC 接线后再加载真实数据。`,
      )
    }
    throw new BackendError('IPC.NOT_READY', message, true)
  }

  if (!result.ok) {
    throw new BackendError(result.error.code, result.error.message, result.error.retryable)
  }
  return result.data
}

export function listSchematics(instanceId: string): Promise<SchematicListResult> {
  return invoke<SchematicListResult>('投影列表', SCHEMATIC_CHANNELS.list, { instanceId })
}

export function importSchematic(instanceId: string, filePath: string): Promise<SchematicImportResult> {
  return invoke<SchematicImportResult>('投影导入', SCHEMATIC_CHANNELS.import, { instanceId, filePath })
}

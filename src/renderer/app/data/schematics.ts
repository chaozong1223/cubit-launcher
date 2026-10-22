import type {
  BatchTrashResult,
  SchematicConflictStrategy,
  SchematicImportResult,
  SchematicListResult,
  SchematicTransferResult,
} from '@shared/assets'
import { BackendError, NotWiredError } from './backend'
import { hasBridge, invokeResult } from '../../lib/ipc'

/**
 * Renderer adapter for the schematic manager (`.litematic` / `.nbt` / `.schem`).
 *
 * The channel names and payloads mirror `shared/assets.ts` (t4). An unregistered
 * channel becomes a `NotWiredError`, so pages render an explicit "not wired"
 * state instead of inventing rows.
 */
export const SCHEMATIC_CHANNELS = {
  list: 'mc:assets:listSchematics',
  import: 'mc:assets:importSchematic',
  remove: 'mc:assets:deleteSchematics',
  transfer: 'mc:assets:copySchematic',
  showInFolder: 'mc:assets:showInFolder',
  openFile: 'mc:assets:openFile',
  openFolder: 'mc:assets:openFolder',
} as const

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

export function importSchematic(instanceId: string, filePath: string, targetName?: string): Promise<SchematicImportResult> {
  return invoke<SchematicImportResult>('投影导入', SCHEMATIC_CHANNELS.import, {
    instanceId,
    filePath,
    ...(targetName ? { targetName } : {}),
  })
}

export function deleteSchematics(instanceId: string, names: string[]): Promise<BatchTrashResult> {
  return invoke<BatchTrashResult>('投影删除', SCHEMATIC_CHANNELS.remove, { instanceId, names })
}

export function copySchematic(input: {
  instanceId: string
  name: string
  targetInstanceId: string
  mode: 'copy' | 'move'
  targetName?: string
  conflict?: SchematicConflictStrategy
}): Promise<SchematicTransferResult> {
  const payload: Record<string, unknown> = {
    instanceId: input.instanceId,
    name: input.name,
    targetInstanceId: input.targetInstanceId,
    mode: input.mode,
  }
  if (input.targetName) payload.targetName = input.targetName
  if (input.conflict) payload.conflict = input.conflict
  return invoke<SchematicTransferResult>('投影跨版本复制', SCHEMATIC_CHANNELS.transfer, payload)
}

export function showSchematicInFolder(instanceId: string, name: string): Promise<{ path: string }> {
  return invoke<{ path: string }>('在文件夹中显示投影', SCHEMATIC_CHANNELS.showInFolder, {
    instanceId,
    kind: 'schematic',
    name,
  })
}

export function openSchematic(instanceId: string, name: string): Promise<{ ok: boolean }> {
  return invoke<{ ok: boolean }>('打开投影文件', SCHEMATIC_CHANNELS.openFile, {
    instanceId,
    kind: 'schematic',
    name,
  })
}

export function openSchematicFolder(instanceId: string): Promise<{ path: string }> {
  return invoke<{ path: string }>('打开投影目录', SCHEMATIC_CHANNELS.openFolder, {
    instanceId,
    area: 'schematics',
  })
}

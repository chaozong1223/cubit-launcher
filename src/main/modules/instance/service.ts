import fsSync from 'node:fs'
import path from 'node:path'
import type {
  DiscoverResult,
  InstancePatch,
  InstanceSettings,
  InstanceSummary,
  Loader,
  RemoveInstanceResult,
  SetGameDirResult,
} from '@shared/instance'
import type { TrashItem } from '@shared/assets'
import type { ScopedLogger } from '../../kernel/logger'
import { loadConfig, saveConfig } from '../../kernel/config'
import type { ModuleRoots } from '../_context'
import { requireMcRoot } from '../_context'
import { CoreError } from '../../core/errors'
import { AppError } from '@shared/errors'
import { nodeFsPort } from '../../core/ports'
import { scanInstances, type ScannedInstance } from '../../core/instance/scan'
import {
  defaultInstanceSettings,
  gameDirectory,
  instanceDirectory,
  readInstanceSettings,
  writeInstanceSettings,
} from '../../core/instance/settings'
import { discoverMinecraftRoots, type DiscoveryOptions } from './discovery'
import { TrashStore } from '../assets/trash'

function toSummary(instance: ScannedInstance): InstanceSummary {
  return {
    id: instance.id,
    dirName: instance.dirName,
    name: instance.name,
    mcVersion: instance.mcVersion,
    loader: instance.loader,
    state: instance.state,
    reason: instance.reason,
    isolation: instance.isolation,
    lastPlayedAt: instance.lastPlayedAt,
    icon: instance.icon,
    javaMajor: instance.javaMajor,
  }
}

export interface InstanceServiceOptions extends DiscoveryOptions {
  now?: () => number
  /** Called after a persisted root change so dependent module services can
   * refresh their own roots without editing their files. */
  onRootChanged?: (mcRoot: string) => void
  /** True while launch reports this instance as running. */
  isInstanceRunning?: (instanceId: string, dirName: string) => boolean
  /** Emit instance.changed after a destructive mutation. */
  onChanged?: (instanceId: string | null) => void
  /** Test seam; defaults to the t39 TrashStore layout under dataRoot/trash. */
  trash?: TrashStore
}

export class InstanceModuleService {
  private readonly fs = nodeFsPort()
  private readonly now: () => number

  constructor(
    private readonly roots: ModuleRoots,
    private readonly log: ScopedLogger,
    private readonly options: InstanceServiceOptions = {},
  ) {
    this.now = options.now ?? Date.now
  }

  private root(): string {
    return requireMcRoot(this.roots)
  }

  async list(): Promise<InstanceSummary[]> {
    // First run has no root yet. Returning [] keeps the onboarding screen alive;
    // it must never throw just because the user has not picked a directory.
    if (!this.roots.mcRoot) return []
    try {
      return scanInstances(this.fs, this.roots.mcRoot).map(toSummary)
    } catch (error) {
      this.log.warn('instance list scan failed', {
        message: error instanceof Error ? error.message : String(error),
      })
      return []
    }
  }

  get(id: string): InstanceSummary {
    const instance = scanInstances(this.fs, this.root()).find(
      (item) => item.id === id || item.dirName === id,
    )
    if (!instance) {
      throw new CoreError('INSTANCE.NOT_FOUND', {
        message: `instance not found: ${id}`,
        details: { instanceId: id },
      })
    }
    return toSummary(instance)
  }

  async scan(input: { mcRoot?: string } = {}): Promise<{ count: number }> {
    const configured = input.mcRoot && input.mcRoot.trim().length > 0 ? input.mcRoot : this.roots.mcRoot
    if (!configured) return { count: 0 }
    const root = input.mcRoot && input.mcRoot.trim().length > 0 ? input.mcRoot : this.root()
    const instances = scanInstances(this.fs, root)
    this.log.info('instances scanned', {
      count: instances.length,
      ready: instances.filter((item) => item.state === 'ready').length,
    })
    return { count: instances.length }
  }

  private guidanceFor(candidates: number, configured: boolean): string[] {
    if (candidates > 0) {
      return [
        `检测到 ${candidates} 个已有 .minecraft 目录；选择一个导入，或选择“新建实例”重新开始。`,
        '导入只切换游戏目录，不会移动或删除原文件。',
      ]
    }
    return [
      configured
        ? '当前游戏目录下没有找到可识别的实例。'
        : '未找到已有 .minecraft 目录，首次使用可以从这里开始：',
      '① 点击“手动选择目录”，选择已有的 .minecraft（通常在 %APPDATA%\\.minecraft）；',
      '② 或新建实例并在版本页安装原版 1.20.1（约 700 MB）；',
      '③ 把现有 .minecraft 放在启动器安装目录旁后重新扫描。',
    ]
  }

  async discover(): Promise<DiscoverResult> {
    let configuredRoot = this.roots.mcRoot
    let firstRun = !configuredRoot
    const errors: string[] = []
    try {
      const loaded = loadConfig(this.roots.dataRoot)
      configuredRoot = configuredRoot ?? loaded.config.paths.minecraftRoot
      firstRun = !configuredRoot
    } catch (error) {
      errors.push(
        `无法读取启动器配置: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    const currentRoot = configuredRoot ? this.resolveExistingPath(configuredRoot) : null
    let scan = { candidates: [] as DiscoverResult['candidates'], errors: [] as string[] }
    try {
      scan = discoverMinecraftRoots({
        ...this.options,
        extraPaths: [...(this.options.extraPaths ?? []), ...(currentRoot ? [currentRoot] : [])],
      })
    } catch (error) {
      // Discovery is best-effort; the onboarding screen must still render.
      scan.errors.push(error instanceof Error ? error.message : String(error))
    }
    const configured = Boolean(configuredRoot)
    const guidance = this.guidanceFor(scan.candidates.length, configured)
    if (configuredRoot && !currentRoot) {
      scan.errors.push(`已配置的游戏目录不可用: ${configuredRoot}`)
    }
    this.log.info('minecraft roots discovered', {
      configured,
      candidates: scan.candidates.length,
      errors: scan.errors.length + errors.length,
    })
    return {
      configured,
      firstRun,
      currentRoot,
      candidates: scan.candidates,
      guidance,
      errors: [...errors, ...scan.errors].slice(0, 8),
      scannedAt: this.now(),
    }
  }

  private expandPath(input: string): string {
    let value = input.trim().replace(/^"(.*)"$/, '$1')
    if (value === '~') value = process.env.USERPROFILE ?? process.env.HOME ?? value
    if (value.startsWith('~/') || value.startsWith('~\\')) {
      value = `${process.env.USERPROFILE ?? process.env.HOME ?? ''}${value.slice(1)}`
    }
    value = value.replace(/%([^%]+)%/g, (all, name: string) => process.env[name] ?? all)
    return path.resolve(value)
  }

  /** Accepts either a .minecraft directory or its parent. */
  private resolveExistingPath(input: string): string | null {
    try {
      const selected = this.expandPath(input)
      if (!this.fs.exists(selected)) return null
      const stat = this.fs.stat(selected)
      if (!stat?.isDirectory()) return null
      const nested = path.join(selected, '.minecraft')
      const base = path.basename(selected).toLowerCase()
      const target =
        base !== '.minecraft' && this.fs.exists(nested) && this.fs.stat(nested)?.isDirectory()
          ? nested
          : selected
      const real = this.fs.realpath(target)
      fsSync.accessSync(real, fsSync.constants.R_OK)
      return real
    } catch {
      return null
    }
  }

  async setGameDir(input: { path: string }): Promise<SetGameDirResult> {
    const root = this.resolveExistingPath(input.path)
    if (!root) {
      throw new AppError('INSTANCE.DIRECTORY_UNAVAILABLE', `无法读取游戏目录: ${input.path}`, {
        details: { path: input.path, hint: '请检查路径是否存在、是否为目录，以及是否有读取权限。' },
      })
    }

    const loaded = loadConfig(this.roots.dataRoot)
    try {
      saveConfig(loaded.file, {
        ...loaded.config,
        paths: { ...loaded.config.paths, minecraftRoot: root },
      })
    } catch (error) {
      throw new AppError(
        'INSTANCE.CONFIG_WRITE_FAILED',
        `无法保存游戏目录: ${error instanceof Error ? error.message : String(error)}`,
        { details: { path: root, hint: '请检查数据目录写入权限。' } },
      )
    }

    this.roots.mcRoot = root
    try {
      this.options.onRootChanged?.(root)
    } catch (error) {
      this.log.warn('root propagation failed', {
        message: error instanceof Error ? error.message : String(error),
      })
    }

    let instanceCount = 0
    try {
      instanceCount = scanInstances(this.fs, root).length
    } catch (error) {
      this.log.warn('imported root scan failed', {
        message: error instanceof Error ? error.message : String(error),
      })
    }
    const hasVersions = this.fs.exists(path.join(root, 'versions'))
    const guidance =
      instanceCount > 0
        ? [`已导入 ${instanceCount} 个实例，可在实例列表中选择启动。`]
        : ['目录已保存，但还没有可启动的版本；请先安装原版或导入整合包。']
    this.log.info('minecraft root imported', {
      path: root,
      instances: instanceCount,
      persistent: true,
    })
    return {
      mcRoot: root,
      instanceCount,
      hasVersions,
      restartRequired: false,
      guidance,
    }
  }

  async importRoot(input: { path: string }): Promise<SetGameDirResult> {
    return this.setGameDir(input)
  }

  async create(input: {
    dirName: string
    name?: string
    mcVersion: string
    loader: Loader
    isolation: 'shared' | 'isolated'
  }): Promise<InstanceSummary> {
    const root = this.root()
    const dir = instanceDirectory(root, input.dirName)
    if (this.fs.exists(dir)) {
      throw new CoreError('INSTANCE.NOT_FOUND', {
        message: `instance directory already exists: ${input.dirName}`,
        userMessage: '同名实例已存在',
      })
    }
    this.fs.mkdirp(dir)
    const settings = defaultInstanceSettings({
      dirName: input.dirName,
      name: input.name,
      mcVersion: input.mcVersion,
      loader: input.loader,
      isolation: input.isolation,
    })
    writeInstanceSettings(this.fs, dir, settings)
    this.log.info('instance created', { dirName: input.dirName, mcVersion: input.mcVersion })
    return this.get(settings.id)
  }

  async update(id: string, patch: InstancePatch): Promise<InstanceSummary> {
    const root = this.root()
    const instance = scanInstances(this.fs, root).find(
      (item) => item.id === id || item.dirName === id,
    )
    if (!instance) {
      throw new CoreError('INSTANCE.NOT_FOUND', {
        message: `instance not found: ${id}`,
        details: { instanceId: id },
      })
    }

    const read = readInstanceSettings(this.fs, instance.dir)
    const current: InstanceSettings =
      read.settings ??
      defaultInstanceSettings({
        dirName: instance.dirName,
        id: instance.id,
        mcVersion: instance.mcVersion,
        loader: instance.loader,
      })

    const next: InstanceSettings = {
      ...current,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.java !== undefined ? { java: patch.java } : {}),
      ...(patch.memory !== undefined
        ? { memory: patch.memory, memoryMode: 'custom' as const }
        : {}),
      ...(patch.window !== undefined ? { window: patch.window } : {}),
      ...(patch.isolation !== undefined ? { isolation: patch.isolation } : {}),
      ...(patch.jvmArgs !== undefined ? { jvmArgs: patch.jvmArgs } : {}),
      ...(patch.autoJoin !== undefined ? { autoJoin: patch.autoJoin } : {}),
      ...(patch.icon !== undefined ? { icon: patch.icon } : {}),
    }

    writeInstanceSettings(this.fs, instance.dir, next)
    this.log.info('instance updated', { instanceId: instance.id, fields: Object.keys(patch) })
    return this.get(instance.id)
  }

  async markPlayed(id: string, playTimeSec: number): Promise<void> {
    const root = this.root()
    const instance = scanInstances(this.fs, root).find(
      (item) => item.id === id || item.dirName === id,
    )
    if (!instance) return
    const read = readInstanceSettings(this.fs, instance.dir)
    const current =
      read.settings ??
      defaultInstanceSettings({
        dirName: instance.dirName,
        id: instance.id,
        mcVersion: instance.mcVersion,
        loader: instance.loader,
      })
    const next: InstanceSettings = {
      ...current,
      lastPlayedAt: Date.now(),
      playTimeSec: current.playTimeSec + Math.max(0, Math.round(playTimeSec)),
    }
    writeInstanceSettings(this.fs, instance.dir, next)
  }

  private trashStore(): TrashStore {
    return (
      this.options.trash ??
      new TrashStore(this.roots.dataRoot, [this.roots.dataRoot, this.root()], {
        fs: this.fs,
        now: this.now,
      })
    )
  }

  private trashIds(): Set<string> {
    try {
      return new Set(fsSync.readdirSync(path.join(this.roots.dataRoot, 'trash')))
    } catch {
      return new Set()
    }
  }

  /** Undo a partially completed TrashStore.delete (manifest/write failure). */
  private rollbackTrash(original: string, before: Set<string>): void {
    const trashRoot = path.join(this.roots.dataRoot, 'trash')
    let entries: string[] = []
    try {
      entries = fsSync.readdirSync(trashRoot).filter((id) => !before.has(id))
    } catch {
      return
    }
    for (const id of entries) {
      const itemDir = path.join(trashRoot, id)
      const manifestFile = path.join(itemDir, 'item.json')
      let recordedOriginal: string | null = null
      try {
        const manifest = JSON.parse(fsSync.readFileSync(manifestFile, 'utf8')) as {
          originalPath?: unknown
        }
        if (typeof manifest.originalPath === 'string') {
          recordedOriginal = path.resolve(manifest.originalPath)
        }
      } catch {
        recordedOriginal = null
      }
      if (recordedOriginal && recordedOriginal !== path.resolve(original)) continue
      const payload = path.join(itemDir, 'payload')
      if (fsSync.existsSync(payload) && !fsSync.existsSync(original)) {
        try {
          fsSync.mkdirSync(path.dirname(original), { recursive: true })
          fsSync.renameSync(payload, original)
        } catch {
          try {
            fsSync.cpSync(payload, original, { recursive: true, force: true })
            fsSync.rmSync(payload, { recursive: true, force: true })
          } catch {
            // Leave the trash entry in place rather than lose the directory.
            continue
          }
        }
      }
      try {
        fsSync.rmSync(itemDir, { recursive: true, force: true })
      } catch {
        // Best effort; the original has already been restored if possible.
      }
    }
  }

  /**
   * Move one version directory into the shared trash. Only versions/<dir> is
   * touched; libraries/assets and the rest of mcRoot stay untouched.
   */
  removeInstance(id: string): RemoveInstanceResult {
    const root = this.root()
    const versionsDir = path.resolve(path.join(root, 'versions'))
    const instance = scanInstances(this.fs, root).find(
      (item) => item.id === id || item.dirName === id,
    )
    if (!instance) {
      throw new CoreError('INSTANCE.NOT_FOUND', {
        message: `instance not found: ${id}`,
        details: { instanceId: id },
      })
    }
    const dir = path.resolve(instance.dir)
    const relative = path.relative(versionsDir, dir)
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new AppError('INSTANCE.REMOVE_DENIED', '拒绝删除 versions 目录之外的路径', {
        details: { instanceId: instance.id, path: dir },
      })
    }
    if (this.options.isInstanceRunning?.(instance.id, instance.dirName)) {
      throw new AppError('INSTANCE.RUNNING', '实例正在运行，无法删除', {
        details: {
          instanceId: instance.id,
          hint: '请先在游戏或启动器里结束该实例，再删除。',
        },
      })
    }

    const before = this.trashIds()
    try {
      const item = this.trashStore().delete({
        kind: 'other',
        name: instance.name || instance.dirName,
        originalPath: dir,
        instanceId: instance.id,
      })
      this.options.onChanged?.(instance.id)
      this.log.info('instance moved to trash', {
        instanceId: instance.id,
        trashId: item.id,
      })
      return {
        trashId: item.id,
        originalPath: item.originalPath,
        size: item.size,
        deletedAt: item.deletedAt,
      }
    } catch (error) {
      this.rollbackTrash(dir, before)
      this.log.error('instance delete failed', {
        instanceId: instance.id,
        message: error instanceof Error ? error.message : String(error),
      })
      throw new AppError(
        'INSTANCE.DELETE_FAILED',
        `删除实例失败: ${error instanceof Error ? error.message : String(error)}`,
        {
          details: {
            instanceId: instance.id,
            path: dir,
            hint: '实例目录未被不可逆删除；请稍后重试或检查回收站。',
          },
        },
      )
    }
  }

  /** Restore a previously removed instance from the shared trash. */
  restoreInstance(trashId: string): TrashItem {
    const result = this.trashStore().restore([trashId])
    if (result.restored.length === 0) {
      throw new AppError('INSTANCE.RESTORE_FAILED', '无法从回收站恢复实例', {
        details: {
          trashId,
          errors: result.failed,
          hint: '原路径可能已被占用，或回收站内容已丢失。',
        },
      })
    }
    const restored = result.restored[0]
    this.options.onChanged?.(restored.instanceId ?? null)
    this.log.info('instance restored from trash', { trashId, path: restored.originalPath })
    return restored
  }

  gameDir(id: string): string {
    const instance = scanInstances(this.fs, this.root()).find(
      (item) => item.id === id || item.dirName === id,
    )
    if (!instance) {
      throw new CoreError('INSTANCE.NOT_FOUND', {
        message: `instance not found: ${id}`,
        details: { instanceId: id },
      })
    }
    return gameDirectory(this.root(), instance.dirName, instance.isolation)
  }

  /** Kept for tests/diagnostics: absolute version directory of an instance. */
  directory(id: string): string {
    return instanceDirectory(this.root(), id)
  }
}

export function createInstanceService(
  roots: ModuleRoots,
  log: ScopedLogger,
  options: InstanceServiceOptions = {},
): InstanceModuleService {
  return new InstanceModuleService(roots, log, options)
}

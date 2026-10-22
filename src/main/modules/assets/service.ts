import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  AssetArea,
  BackupResult,
  BatchTrashResult,
  LogEntry,
  LogLevel,
  LogSource,
  RestoreResult,
  SaveCopyResult,
  SaveEntry,
  SchematicEntry,
  SchematicImportResult,
  SchematicListResult,
  SchematicTransferResult,
  ScreenshotEntry,
  TrashItem,
} from '@shared/assets'
import type { InstanceSettings, InstanceSummary } from '@shared/instance'
import { AppError } from '@shared/errors'
import type { ScopedLogger } from '../../kernel/logger'
import type { ModuleRoots } from '../_context'
import { requireMcRoot } from '../_context'
import { CoreError } from '../../core/errors'
import { nodeFsPort, type FsPort } from '../../core/ports'
import { gameDirectory, readInstanceSettings } from '../../core/instance/settings'
import { scanInstances, type ScannedInstance } from '../../core/instance/scan'
import { RollbackStack } from '../../core/fs/rollback'
import {
  resolvePathConflict,
  sanitizePathName,
  uniqueFileName,
  uniquePathName,
} from '../../core/fs/conflict'
import { copyTree } from '../../core/fs/copy-tree'
import {
  isSchematicFileName,
  readSchematic,
  type ParsedSchematic,
} from '../../core/schematic'
import { TrashStore } from './trash'
import { createStoredZip, type ZipEntryInput } from './zip'
import { levelRank, parseLogText, type ParsedLogLine } from './logparse'

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}
const MAX_PREVIEW_BYTES = 8 * 1024 * 1024
const MAX_LOG_READ_BYTES = 8 * 1024 * 1024
const MAX_EXPORT_FILES = 200
const MAX_SCHEMATIC_BYTES = 128 * 1024 * 1024
const MAX_SCHEMATIC_ENTRIES = 5_000

export interface AssetsServiceOptions {
  roots: ModuleRoots
  log: ScopedLogger
  fs?: FsPort
  openPath?: (target: string) => Promise<string>
  showItemInFolder?: (target: string) => void
  appVersion?: string
  now?: () => number
  /** Rejects copy operations while either instance is running. */
  isInstanceRunning?: (instanceId: string, dirName: string) => boolean
}

interface ResolvedInstance {
  instance: ScannedInstance
  gameDir: string
}

function fail(code: string, message: string, details?: Record<string, unknown>): never {
  throw new AppError(code, message, { details })
}

function assertChild(base: string, name: string): string {
  if (
    !name ||
    name === '.' ||
    name === '..' ||
    name.includes('/') ||
    name.includes('\\') ||
    name.includes('\0')
  ) {
    fail('ASSETS.UNSAFE_NAME', `非法文件名: ${name}`)
  }
  const target = path.resolve(base, name)
  if (target !== path.resolve(base) && !target.startsWith(`${path.resolve(base)}${path.sep}`)) {
    fail('ASSETS.UNSAFE_NAME', `路径越界: ${name}`)
  }
  return target
}

function safeStat(target: string): fs.Stats | null {
  try {
    return fs.statSync(target)
  } catch {
    return null
  }
}

function isSymlink(target: string): boolean {
  try {
    return fs.lstatSync(target).isSymbolicLink()
  } catch {
    return false
  }
}

function treeSize(target: string): number {
  const stat = safeStat(target)
  if (!stat) return 0
  if (stat.isFile()) return stat.size
  if (!stat.isDirectory()) return 0
  let total = 0
  try {
    for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue
      total += treeSize(path.join(target, entry.name))
    }
  } catch {
    return total
  }
  return total
}

function walkFiles(
  root: string,
  relative = '',
  output: Array<{ absolute: string; relative: string }> = [],
  limit = 20_000,
): Array<{ absolute: string; relative: string }> {
  if (output.length >= limit) return output
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return output
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue
    const absolute = path.join(root, entry.name)
    const rel = relative ? `${relative}/${entry.name}` : entry.name
    if (entry.isDirectory()) walkFiles(absolute, rel, output, limit)
    else if (entry.isFile()) output.push({ absolute, relative: rel })
    if (output.length >= limit) break
  }
  return output
}

function readTail(file: string, maxBytes: number): string {
  const stat = safeStat(file)
  if (!stat) return ''
  if (stat.size <= maxBytes) return fs.readFileSync(file, 'utf8')
  const buffer = Buffer.alloc(maxBytes)
  const fd = fs.openSync(file, 'r')
  try {
    fs.readSync(fd, buffer, 0, maxBytes, stat.size - maxBytes)
  } finally {
    fs.closeSync(fd)
  }
  return buffer.toString('utf8')
}

function defaultOut(dataRoot: string, folder: string, name: string): string {
  return path.join(dataRoot, 'backups', folder, `${name}-${Date.now()}.zip`)
}

export class AssetsModuleService {
  private readonly fs: FsPort
  private readonly trash: TrashStore
  private readonly now: () => number
  private readonly listeners = new Set<(payload: { area: AssetArea }) => void>()

  constructor(private readonly options: AssetsServiceOptions) {
    this.fs = options.fs ?? nodeFsPort()
    this.now = options.now ?? Date.now
    const roots = [options.roots.dataRoot, options.roots.mcRoot].filter(
      (entry): entry is string => Boolean(entry),
    )
    this.trash = new TrashStore(options.roots.dataRoot, roots, {
      fs: this.fs,
      now: this.now,
    })
  }

  onEvent(event: string, listener: (payload: { area: AssetArea }) => void): () => void {
    if (event !== 'changed') return () => undefined
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(area: AssetArea): void {
    for (const listener of this.listeners) {
      try {
        listener({ area })
      } catch {
        /* observers cannot fail a completed operation */
      }
    }
  }

  private resolve(instanceId: string): ResolvedInstance {
    const mcRoot = requireMcRoot(this.options.roots)
    const instance = scanInstances(this.fs, mcRoot).find(
      (item) => item.id === instanceId || item.dirName === instanceId,
    )
    if (!instance) fail('ASSETS.INSTANCE_NOT_FOUND', `找不到实例: ${instanceId}`)
    return {
      instance,
      gameDir: gameDirectory(mcRoot, instance.dirName, instance.isolation),
    }
  }

  private gameSubdir(
    instanceId: string,
    name: 'saves' | 'screenshots' | 'schematics' | 'logs',
  ): string {
    return path.join(this.resolve(instanceId).gameDir, name)
  }

  private ensureDir(dir: string): void {
    this.fs.mkdirp(dir)
  }

  async listSaves(input: { instanceId: string }): Promise<{ gameDir: string; saves: SaveEntry[] }> {
    const resolved = this.resolve(input.instanceId)
    const dir = path.join(resolved.gameDir, 'saves')
    const saves: SaveEntry[] = []
    let entries: fs.Dirent[] = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      entries = []
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue
      // Hidden dirs are launcher-internal copy staging/backup folders.
      if (entry.name.startsWith('.')) continue
      const target = path.join(dir, entry.name)
      const stat = safeStat(target)
      if (!stat) continue
      saves.push({
        name: entry.name,
        size: treeSize(target),
        modifiedAt: Math.floor(stat.mtimeMs),
        hasIcon: fs.existsSync(path.join(target, 'icon.png')),
      })
    }
    saves.sort((left, right) => right.modifiedAt - left.modifiedAt)
    return { gameDir: resolved.gameDir, saves }
  }

  async backupSave(input: { instanceId: string; name: string; outPath?: string }): Promise<BackupResult> {
    const savesDir = this.gameSubdir(input.instanceId, 'saves')
    const world = assertChild(savesDir, input.name)
    const stat = safeStat(world)
    if (!stat || !stat.isDirectory() || isSymlink(world)) {
      fail('ASSETS.FILE_NOT_FOUND', `存档不存在: ${input.name}`)
    }
    const files = walkFiles(world)
    if (files.length === 0) {
      fail('ASSETS.SAVE_EMPTY', `存档为空，未生成备份: ${input.name}`)
    }
    const entries: ZipEntryInput[] = files.map((file) => ({
      name: `${input.name}/${file.relative}`,
      data: fs.readFileSync(file.absolute),
    }))
    entries.push({
      name: 'mc-launcher-backup.json',
      data: Buffer.from(
        `${JSON.stringify(
          {
            kind: 'save',
            instanceId: input.instanceId,
            name: input.name,
            createdAt: this.now(),
            files: files.length,
          },
          null,
          2,
        )}\n`,
      ),
    })
    const out = input.outPath
      ? path.resolve(input.outPath)
      : defaultOut(this.options.roots.dataRoot, 'saves', input.name.replace(/[^\w.-]+/g, '-'))
    this.fs.mkdirp(path.dirname(out))
    const buffer = createStoredZip(entries, new Date(this.now()))
    this.fs.writeBytes(out, buffer)
    this.options.log.info('save backed up', { instanceId: input.instanceId, name: input.name, bytes: buffer.length })
    return { path: out, bytes: buffer.length, files: files.length }
  }

  async deleteSaves(input: { instanceId: string; names: string[] }): Promise<BatchTrashResult> {
    const savesDir = this.gameSubdir(input.instanceId, 'saves')
    const result: BatchTrashResult = { items: [], errors: [] }
    for (const name of [...new Set(input.names)]) {
      try {
        const target = assertChild(savesDir, name)
        const item = this.trash.delete({
          kind: 'save',
          name,
          originalPath: target,
          instanceId: input.instanceId,
        })
        result.items.push(item)
      } catch (error) {
        result.errors.push({ name, message: error instanceof Error ? error.message : String(error) })
      }
    }
    if (result.items.length > 0) this.emit('saves')
    return result
  }

  /**
   * Copies one world into another instance's `saves/` directory.
   *
   * Conflicts follow the shared policy: omit `conflict` → return
   * `status:"conflict"` without writing, then overwrite/skip/rename. An
   * overwrite first moves the existing world aside and a failure restores it
   * through `RollbackStack` (never leaves a half-copied world behind).
   */
  async copySave(input: {
    instanceId: string
    name: string
    targetInstanceId: string
    targetName?: string
    conflict?: 'overwrite' | 'skip' | 'rename'
  }): Promise<SaveCopyResult> {
    const source = this.resolve(input.instanceId)
    const target = this.resolve(input.targetInstanceId)
    const sourceSaves = path.join(source.gameDir, 'saves')
    const sourceDir = assertChild(sourceSaves, input.name)
    const sourceStat = safeStat(sourceDir)
    if (!sourceStat?.isDirectory() || isSymlink(sourceDir)) {
      fail('ASSETS.FILE_NOT_FOUND', `存档不存在: ${input.name}`)
    }
    if (this.options.isInstanceRunning?.(source.instance.id, source.instance.dirName)) {
      fail('ASSETS.INSTANCE_RUNNING', '源实例正在运行，请先结束游戏再复制存档')
    }
    if (this.options.isInstanceRunning?.(target.instance.id, target.instance.dirName)) {
      fail('ASSETS.INSTANCE_RUNNING', '目标实例正在运行，请先结束游戏再复制存档')
    }

    const targetSaves = path.join(target.gameDir, 'saves')
    this.fs.mkdirp(targetSaves)
    const requestedName = input.targetName?.trim() || input.name
    const safeBase = sanitizePathName(requestedName, 'save')
    if (safeBase !== requestedName) {
      fail('ASSETS.UNSAFE_NAME', `存档文件夹名包含非法字符: ${requestedName}`)
    }

    const sourceMc = source.instance.mcVersion ?? null
    const targetMc = target.instance.mcVersion ?? null
    const crossVersion = sourceMc !== targetMc
    const sourceLoader = source.instance.loader
    const targetLoader = target.instance.loader
    const loaderChanged =
      sourceLoader.type !== targetLoader.type || sourceLoader.version !== targetLoader.version
    const warnings: string[] = []
    if (crossVersion) {
      warnings.push(
        `跨版本复制：源实例为 Minecraft ${sourceMc ?? '未知'}，目标实例为 ${targetMc ?? '未知'}；模组方块、实体、数据包和区块格式可能不兼容，可能丢失或导致存档损坏，建议先备份目标存档。`,
      )
    }
    if (loaderChanged) {
      warnings.push(
        `加载器不同（${sourceLoader.type} → ${targetLoader.type}）；仅由某一侧模组提供的方块/物品会变成“未知方块”。`,
      )
    }

    const baseTarget = path.join(targetSaves, safeBase)
    const exists = (candidate: string): boolean => this.fs.exists(candidate)
    if (exists(baseTarget) && input.conflict === undefined) {
      return {
        status: 'conflict',
        sourceInstanceId: source.instance.dirName,
        sourceName: input.name,
        targetInstanceId: target.instance.dirName,
        targetName: null,
        files: 0,
        bytes: 0,
        overwritten: false,
        renamed: false,
        crossVersion,
        warnings: [...warnings, `目标实例已存在同名存档「${safeBase}」；请选择覆盖、跳过或改名。`],
      }
    }
    if (exists(baseTarget) && input.conflict === 'skip') {
      return {
        status: 'skipped',
        sourceInstanceId: source.instance.dirName,
        sourceName: input.name,
        targetInstanceId: target.instance.dirName,
        targetName: null,
        files: 0,
        bytes: 0,
        overwritten: false,
        renamed: false,
        crossVersion,
        warnings: [...warnings, `目标实例已存在同名存档「${safeBase}」，已按“跳过”处理。`],
      }
    }

    const resolution = resolvePathConflict({
      target: baseTarget,
      strategy: input.conflict ?? 'rename',
      exists,
      uniqueTarget: () =>
        path.join(targetSaves, uniquePathName(targetSaves, safeBase, exists)),
    })
    const targetName = path.basename(resolution.target)
    const targetDir = resolution.target
    const overwritten = resolution.strategy === 'overwrite' && exists(targetDir)
    const renamed = resolution.renamed
    if (path.resolve(sourceDir) === path.resolve(targetDir)) {
      fail('ASSETS.SAVE_SELF_OVERWRITE', '不能把存档覆盖复制到它自己；请选择改名。')
    }

    const staging = path.join(targetSaves, `.mcl-save-copy-${randomUUID()}`)
    const backup = path.join(targetSaves, `.mcl-save-backup-${randomUUID()}`)
    const rollback = new RollbackStack()
    try {
      rollback.push('删除存档复制暂存目录', () => {
        try {
          this.fs.remove(staging)
        } catch {
          /* best effort */
        }
      })
      this.fs.mkdirp(staging)
      const copied = await copyTree(sourceDir, staging, {
        skip: (relative) => relative.toLowerCase() === 'session.lock',
      })

      if (overwritten && exists(targetDir)) {
        this.fs.rename(targetDir, backup)
        rollback.push('恢复原有存档', () => {
          try {
            if (this.fs.exists(backup)) {
              if (this.fs.exists(targetDir)) this.fs.remove(targetDir)
              this.fs.rename(backup, targetDir)
            }
          } catch {
            /* best effort */
          }
        })
      }
      this.fs.rename(staging, targetDir)
      rollback.push('删除已复制存档', () => {
        try {
          this.fs.remove(targetDir)
        } catch {
          /* best effort */
        }
      })
      rollback.commit()
      if (overwritten && this.fs.exists(backup)) {
        try {
          this.fs.remove(backup)
        } catch {
          warnings.push('旧存档备份未能删除（位于 saves/ 下的隐藏目录）')
        }
      }

      this.emit('saves')
      this.options.log.info('save copied across instances', {
        sourceInstanceId: source.instance.dirName,
        targetInstanceId: target.instance.dirName,
        name: input.name,
        targetName,
        files: copied.files,
        bytes: copied.bytes,
        overwritten,
        renamed,
        crossVersion,
      })
      return {
        status: 'copied',
        sourceInstanceId: source.instance.dirName,
        sourceName: input.name,
        targetInstanceId: target.instance.dirName,
        targetName,
        files: copied.files,
        bytes: copied.bytes,
        overwritten,
        renamed,
        crossVersion,
        warnings,
      }
    } catch (error) {
      const failures = await rollback.rollback()
      if (failures.length > 0) {
        this.options.log.warn('save copy rollback step failed', { failures })
      }
      if (error instanceof AppError) throw error
      throw new AppError(
        'ASSETS.SAVE_COPY_FAILED',
        `复制存档失败: ${error instanceof Error ? error.message : String(error)}`,
        { details: { name: input.name, targetInstanceId: input.targetInstanceId } },
      )
    }
  }

  // -------------------------------------------------------------- schematics

  private schematicsDir(instanceId: string): string {
    return this.gameSubdir(instanceId, 'schematics')
  }

  private instanceRunning(instance: ScannedInstance): boolean {
    return Boolean(this.options.isInstanceRunning?.(instance.id, instance.dirName))
  }

  private schematicEntryFromParsed(
    name: string,
    size: number,
    modifiedAt: number,
    parsed: ParsedSchematic,
  ): SchematicEntry {
    return {
      name,
      format: parsed.format,
      size,
      modifiedAt,
      dimensions: parsed.size,
      volume: parsed.volume,
      regionCount: parsed.regionCount,
      error: null,
    }
  }

  /** Parses one projection; a corrupt file is still listed with a readable error. */
  private schematicEntry(name: string, absolute: string, stat: fs.Stats): SchematicEntry {
    const base: SchematicEntry = {
      name,
      format: 'unknown',
      size: stat.size,
      modifiedAt: Math.floor(stat.mtimeMs),
      dimensions: null,
      volume: null,
      regionCount: null,
      error: null,
    }
    try {
      if (stat.size > MAX_SCHEMATIC_BYTES) {
        throw new CoreError('SCHEMATIC.LIMIT_EXCEEDED', {
          message: `投影超过 ${Math.round(MAX_SCHEMATIC_BYTES / (1024 * 1024))} MB 解析上限`,
        })
      }
      const parsed = readSchematic(this.fs.readBytes(absolute))
      return this.schematicEntryFromParsed(name, stat.size, base.modifiedAt, parsed)
    } catch (error) {
      return {
        ...base,
        error:
          error instanceof CoreError
            ? error.message
            : error instanceof Error
              ? error.message
              : String(error),
      }
    }
  }

  private validatedSchematicName(input: string, fallbackExtension?: string): string {
    const trimmed = input.trim()
    const base = path.basename(trimmed.replaceAll('\\', '/'))
    if (
      !base ||
      base !== trimmed ||
      base === '.' ||
      base === '..' ||
      base.includes('\0') ||
      sanitizePathName(base, 'schematic') !== base
    ) {
      fail('ASSETS.UNSAFE_NAME', `投影文件名不合法: ${input}`)
    }
    if (isSchematicFileName(base)) return base
    if (fallbackExtension && /^\.[a-z]+$/i.test(fallbackExtension)) {
      const withExtension = `${base}${fallbackExtension.toLowerCase()}`
      if (isSchematicFileName(withExtension)) return withExtension
    }
    fail('ASSETS.UNSUPPORTED_FILE', `不支持的投影扩展名: ${base}`)
  }

  async listSchematics(input: { instanceId: string }): Promise<SchematicListResult> {
    const resolved = this.resolve(input.instanceId)
    const dir = path.join(resolved.gameDir, 'schematics')
    const schematics: SchematicEntry[] = []
    let entries: fs.Dirent[] = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      entries = []
    }
    for (const entry of entries) {
      if (!entry.isFile() || entry.isSymbolicLink()) continue
      if (entry.name.startsWith('.')) continue
      if (!isSchematicFileName(entry.name)) continue
      if (schematics.length >= MAX_SCHEMATIC_ENTRIES) break
      const absolute = path.join(dir, entry.name)
      const stat = safeStat(absolute)
      if (!stat) continue
      schematics.push(this.schematicEntry(entry.name, absolute, stat))
    }
    schematics.sort(
      (left, right) => right.modifiedAt - left.modifiedAt || left.name.localeCompare(right.name, 'zh-CN'),
    )
    return { gameDir: dir, schematics }
  }

  async importSchematic(input: {
    instanceId: string
    filePath: string
    targetName?: string
  }): Promise<SchematicImportResult> {
    const source = path.resolve(input.filePath)
    const stat = safeStat(source)
    if (!stat?.isFile() || isSymlink(source)) {
      fail('ASSETS.FILE_NOT_FOUND', `找不到投影文件: ${input.filePath}`)
    }
    if (!isSchematicFileName(source)) {
      fail('ASSETS.UNSUPPORTED_FILE', '只支持 .litematic / .nbt / .schem / .schematic 投影')
    }
    if (stat.size > MAX_SCHEMATIC_BYTES) {
      throw new CoreError('SCHEMATIC.LIMIT_EXCEEDED', {
        message: `投影超过 ${Math.round(MAX_SCHEMATIC_BYTES / (1024 * 1024))} MB 解析上限`,
      })
    }
    // Validate before copying: a corrupt projection must not land in the folder.
    const parsed = readSchematic(this.fs.readBytes(source))
    const dir = this.schematicsDir(input.instanceId)
    this.fs.mkdirp(dir)
    const requested = input.targetName?.trim() || path.basename(source)
    const withExtension = this.validatedSchematicName(requested, path.extname(source))
    const targetName = uniqueFileName(dir, withExtension, (candidate) => this.fs.exists(candidate))
    const target = path.join(dir, targetName)
    try {
      await fsp.copyFile(source, target)
    } catch (error) {
      throw new AppError(
        'ASSETS.SCHEMATIC_IMPORT_FAILED',
        `复制投影失败: ${error instanceof Error ? error.message : String(error)}`,
        { details: { source, target } },
      )
    }
    const copiedStat = safeStat(target) ?? stat
    const entry = this.schematicEntryFromParsed(
      targetName,
      copiedStat.size,
      Math.floor(copiedStat.mtimeMs),
      parsed,
    )
    this.emit('schematics')
    this.options.log.info('schematic imported', {
      instanceId: input.instanceId,
      fileName: targetName,
      format: entry.format,
      dimensions: entry.dimensions,
    })
    return { imported: 1, fileName: targetName, targetPath: target, entry }
  }

  async deleteSchematics(input: {
    instanceId: string
    names: string[]
  }): Promise<BatchTrashResult> {
    const dir = this.schematicsDir(input.instanceId)
    const result: BatchTrashResult = { items: [], errors: [] }
    for (const name of [...new Set(input.names)]) {
      try {
        if (!isSchematicFileName(name)) {
          result.errors.push({ name, message: '只支持 .litematic / .nbt / .schem / .schematic 投影' })
          continue
        }
        const target = assertChild(dir, name)
        const item = this.trash.delete({
          kind: 'schematic',
          name,
          originalPath: target,
          instanceId: input.instanceId,
        })
        result.items.push(item)
      } catch (error) {
        result.errors.push({
          name,
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }
    if (result.items.length > 0) this.emit('schematics')
    return result
  }

  /**
   * Copies or moves one projection into another instance's schematics folder.
   * `move` puts the source into the shared trash only after the copy committed,
   * so a failure never loses the only copy.
   */
  async copySchematic(input: {
    instanceId: string
    name: string
    targetInstanceId: string
    mode?: 'copy' | 'move'
    targetName?: string
    conflict?: 'overwrite' | 'skip' | 'rename'
  }): Promise<SchematicTransferResult> {
    const source = this.resolve(input.instanceId)
    const target = this.resolve(input.targetInstanceId)
    if (source.instance.dirName === target.instance.dirName) {
      fail('ASSETS.SAME_INSTANCE', '源版本和目标版本相同，无需复制')
    }
    const sourceDir = path.join(source.gameDir, 'schematics')
    const sourcePath = assertChild(sourceDir, input.name)
    const stat = safeStat(sourcePath)
    if (!stat?.isFile() || isSymlink(sourcePath)) {
      fail('ASSETS.FILE_NOT_FOUND', `投影不存在: ${input.name}`)
    }
    if (!isSchematicFileName(input.name)) {
      fail('ASSETS.UNSUPPORTED_FILE', '只支持 .litematic / .nbt / .schem / .schematic 投影')
    }
    const mode = input.mode ?? 'copy'
    if (mode === 'move' && (this.instanceRunning(source.instance) || this.instanceRunning(target.instance))) {
      fail('ASSETS.INSTANCE_RUNNING', '移动投影前请先结束正在运行的实例')
    }

    const targetDir = path.join(target.gameDir, 'schematics')
    this.fs.mkdirp(targetDir)
    const requested = input.targetName?.trim() || input.name
    const withExtension = this.validatedSchematicName(requested)
    const baseTarget = path.join(targetDir, withExtension)
    const exists = (candidate: string): boolean => this.fs.exists(candidate)
    const warnings: string[] = []

    if (exists(baseTarget) && input.conflict === undefined) {
      return {
        status: 'conflict',
        sourceInstanceId: source.instance.dirName,
        sourceName: input.name,
        targetInstanceId: target.instance.dirName,
        targetName: null,
        size: stat.size,
        overwritten: false,
        renamed: false,
        warnings: [`目标版本已存在同名投影「${withExtension}」；请选择覆盖、跳过或改名。`],
      }
    }
    if (exists(baseTarget) && input.conflict === 'skip') {
      return {
        status: 'skipped',
        sourceInstanceId: source.instance.dirName,
        sourceName: input.name,
        targetInstanceId: target.instance.dirName,
        targetName: null,
        size: stat.size,
        overwritten: false,
        renamed: false,
        warnings: [`目标版本已存在同名投影「${withExtension}」，已按“跳过”处理。`],
      }
    }

    const resolution = resolvePathConflict({
      target: baseTarget,
      strategy: input.conflict ?? 'rename',
      exists,
      uniqueTarget: () =>
        path.join(targetDir, uniqueFileName(targetDir, withExtension, exists)),
    })
    const targetName = path.basename(resolution.target)
    const targetPath = resolution.target
    const overwritten = resolution.strategy === 'overwrite' && exists(targetPath)
    const staging = path.join(targetDir, `.mcl-schematic-copy-${randomUUID()}`)
    const backup = path.join(targetDir, `.mcl-schematic-backup-${randomUUID()}`)
    const rollback = new RollbackStack()
    try {
      rollback.push('删除投影复制暂存文件', () => {
        try {
          this.fs.remove(staging)
        } catch {
          /* best effort */
        }
      })
      await fsp.copyFile(sourcePath, staging)
      if (overwritten && exists(targetPath)) {
        this.fs.rename(targetPath, backup)
        rollback.push('恢复原有投影', () => {
          try {
            if (this.fs.exists(backup)) {
              if (this.fs.exists(targetPath)) this.fs.remove(targetPath)
              this.fs.rename(backup, targetPath)
            }
          } catch {
            /* best effort */
          }
        })
      }
      this.fs.rename(staging, targetPath)
      rollback.push('删除已复制投影', () => {
        try {
          this.fs.remove(targetPath)
        } catch {
          /* best effort */
        }
      })
      rollback.commit()
      if (overwritten && this.fs.exists(backup)) {
        try {
          this.fs.remove(backup)
        } catch {
          warnings.push('旧投影备份未能删除（位于 schematics/ 下的隐藏文件）')
        }
      }
      if (mode === 'move') {
        try {
          this.trash.delete({
            kind: 'schematic',
            name: input.name,
            originalPath: sourcePath,
            instanceId: source.instance.dirName,
          })
        } catch (error) {
          warnings.push(
            `已复制到目标版本，但源投影移入回收站失败: ${
              error instanceof Error ? error.message : String(error)
            }`,
          )
        }
      }
      this.emit('schematics')
      this.options.log.info('schematic transferred', {
        sourceInstanceId: source.instance.dirName,
        targetInstanceId: target.instance.dirName,
        name: input.name,
        targetName,
        mode,
        overwritten,
        renamed: resolution.renamed,
      })
      return {
        status: mode === 'move' ? 'moved' : 'copied',
        sourceInstanceId: source.instance.dirName,
        sourceName: input.name,
        targetInstanceId: target.instance.dirName,
        targetName,
        size: stat.size,
        overwritten,
        renamed: resolution.renamed,
        warnings,
      }
    } catch (error) {
      const failures = await rollback.rollback()
      if (failures.length > 0) {
        this.options.log.warn('schematic transfer rollback step failed', { failures })
      }
      if (error instanceof AppError) throw error
      throw new AppError(
        'ASSETS.SCHEMATIC_TRANSFER_FAILED',
        `复制投影失败: ${error instanceof Error ? error.message : String(error)}`,
        { details: { name: input.name, targetInstanceId: input.targetInstanceId } },
      )
    }
  }

  async listScreenshots(input: {
    instanceId: string
  }): Promise<{ gameDir: string; screenshots: ScreenshotEntry[] }> {
    const resolved = this.resolve(input.instanceId)
    const dir = path.join(resolved.gameDir, 'screenshots')
    const screenshots: ScreenshotEntry[] = []
    let entries: fs.Dirent[] = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      entries = []
    }
    for (const entry of entries) {
      if (!entry.isFile() || entry.isSymbolicLink()) continue
      const mime = IMAGE_MIME[path.extname(entry.name).toLowerCase()]
      if (!mime) continue
      const target = path.join(dir, entry.name)
      const stat = safeStat(target)
      if (!stat) continue
      screenshots.push({
        name: entry.name,
        size: stat.size,
        modifiedAt: Math.floor(stat.mtimeMs),
        mime,
      })
    }
    screenshots.sort((left, right) => right.modifiedAt - left.modifiedAt)
    return { gameDir: resolved.gameDir, screenshots }
  }

  private screenshotPath(instanceId: string, name: string): { dir: string; target: string; mime: string } {
    const dir = this.gameSubdir(instanceId, 'screenshots')
    const target = assertChild(dir, name)
    const mime = IMAGE_MIME[path.extname(name).toLowerCase()]
    if (!mime) fail('ASSETS.UNSUPPORTED_IMAGE', `不支持的图片类型: ${name}`)
    return { dir, target, mime }
  }

  async previewScreenshot(input: {
    instanceId: string
    name: string
  }): Promise<{ dataUrl: string; mime: string; size: number }> {
    const { target, mime } = this.screenshotPath(input.instanceId, input.name)
    const stat = safeStat(target)
    if (!stat || !stat.isFile() || isSymlink(target)) {
      fail('ASSETS.FILE_NOT_FOUND', `截图不存在: ${input.name}`)
    }
    if (stat.size > MAX_PREVIEW_BYTES) {
      fail('ASSETS.IMAGE_TOO_LARGE', '截图超过 8 MB，无法生成预览')
    }
    const data = fs.readFileSync(target)
    return {
      dataUrl: `data:${mime};base64,${data.toString('base64')}`,
      mime,
      size: data.length,
    }
  }

  async deleteScreenshots(input: {
    instanceId: string
    names: string[]
  }): Promise<BatchTrashResult> {
    const dir = this.gameSubdir(input.instanceId, 'screenshots')
    const result: BatchTrashResult = { items: [], errors: [] }
    for (const name of [...new Set(input.names)]) {
      try {
        const target = assertChild(dir, name)
        const item = this.trash.delete({
          kind: 'screenshot',
          name,
          originalPath: target,
          instanceId: input.instanceId,
        })
        result.items.push(item)
      } catch (error) {
        result.errors.push({ name, message: error instanceof Error ? error.message : String(error) })
      }
    }
    if (result.items.length > 0) this.emit('screenshots')
    return result
  }

  private logDirs(instanceId?: string): Array<{ area: 'launcher' | 'game'; dir: string }> {
    const dirs: Array<{ area: 'launcher' | 'game'; dir: string }> = [
      { area: 'launcher', dir: path.join(this.options.roots.dataRoot, 'logs') },
    ]
    if (instanceId) {
      try {
        dirs.push({ area: 'game', dir: this.gameSubdir(instanceId, 'logs') })
      } catch {
        // Unknown instance: launcher logs remain available.
      }
    }
    return dirs
  }

  private listSources(instanceId?: string): LogSource[] {
    const sources: LogSource[] = []
    for (const { area, dir } of this.logDirs(instanceId)) {
      let entries: fs.Dirent[] = []
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        entries = []
      }
      for (const entry of entries) {
        if (!entry.isFile() || entry.isSymbolicLink()) continue
        if (!/\.(log|jsonl)(\.\d+)?$/i.test(entry.name)) continue
        const stat = safeStat(path.join(dir, entry.name))
        if (!stat) continue
        sources.push({
          id: `${area}:${entry.name}`,
          area,
          fileName: entry.name,
          size: stat.size,
          modifiedAt: Math.floor(stat.mtimeMs),
        })
      }
    }
    return sources.sort((left, right) => {
      if (left.area !== right.area) return left.area === 'game' ? -1 : 1
      return right.modifiedAt - left.modifiedAt
    })
  }

  private readParsed(source: LogSource, instanceId?: string): ParsedLogLine[] {
    let dir: string | undefined
    if (source.area === 'launcher') {
      dir = path.join(this.options.roots.dataRoot, 'logs')
    } else if (instanceId) {
      try {
        dir = this.gameSubdir(instanceId, 'logs')
      } catch {
        dir = undefined
      }
    }
    if (!dir) return []
    let target: string
    try {
      target = assertChild(dir, source.fileName)
    } catch {
      return []
    }
    const stat = safeStat(target)
    if (!stat) return []
    const text = readTail(target, MAX_LOG_READ_BYTES)
    return parseLogText(text, {
      area: source.area,
      source: source.id,
      modifiedAt: stat.mtimeMs,
    })
  }

  async listLogs(input: { instanceId?: string } = {}): Promise<{ sources: LogSource[] }> {
    return { sources: this.listSources(input.instanceId) }
  }

  async queryLogs(input: {
    instanceId?: string
    level?: LogLevel
    minLevel?: LogLevel
    since?: number
    until?: number
    search?: string
    limit?: number
    offset?: number
  }): Promise<{ entries: LogEntry[]; total: number; sources: LogSource[] }> {
    const sources = this.listSources(input.instanceId)
    const entries: LogEntry[] = []
    for (const source of sources) {
      for (const line of this.readParsed(source, input.instanceId)) {
        if (input.level && line.level !== input.level) continue
        if (input.minLevel && levelRank(line.level) < levelRank(input.minLevel)) continue
        if (input.since !== undefined && (line.timestamp === null || line.timestamp < input.since)) continue
        if (input.until !== undefined && (line.timestamp === null || line.timestamp > input.until)) continue
        if (input.search && !line.message.toLowerCase().includes(input.search.toLowerCase())) continue
        entries.push({
          timestamp: line.timestamp,
          level: line.level,
          source: line.source,
          message: line.message,
        })
      }
    }
    entries.sort((left, right) => (left.timestamp ?? 0) - (right.timestamp ?? 0))
    const offset = input.offset ?? 0
    const limit = input.limit ?? 500
    return {
      entries: entries.slice(offset, offset + limit),
      total: entries.length,
      sources,
    }
  }

  private logEntriesForExport(instanceId?: string): ZipEntryInput[] {
    const entries: ZipEntryInput[] = []
    for (const source of this.listSources(instanceId).slice(0, MAX_EXPORT_FILES)) {
      let dir: string | undefined
      if (source.area === 'launcher') dir = path.join(this.options.roots.dataRoot, 'logs')
      else if (instanceId) {
        try {
          dir = this.gameSubdir(instanceId, 'logs')
        } catch {
          dir = undefined
        }
      }
      if (!dir) continue
      try {
        const target = assertChild(dir, source.fileName)
        entries.push({ name: `logs/${source.area}/${source.fileName}`, data: fs.readFileSync(target) })
      } catch {
        /* skip unreadable */
      }
    }
    return entries
  }

  private writeArchive(
    entries: ZipEntryInput[],
    outPath: string | undefined,
    folder: string,
    prefix: string,
  ): BackupResult {
    const out = outPath ? path.resolve(outPath) : defaultOut(this.options.roots.dataRoot, folder, prefix)
    this.fs.mkdirp(path.dirname(out))
    const buffer = createStoredZip(entries, new Date(this.now()))
    this.fs.writeBytes(out, buffer)
    return { path: out, bytes: buffer.length, files: entries.length }
  }

  async exportLogs(input: { instanceId?: string; outPath?: string } = {}): Promise<BackupResult> {
    const logs = this.logEntriesForExport(input.instanceId)
    if (logs.length === 0) fail('ASSETS.NO_LOGS', '没有可导出的日志')
    return this.writeArchive(logs, input.outPath, 'logs', 'logs')
  }

  async exportDiagnostics(input: {
    instanceId?: string
    outPath?: string
  } = {}): Promise<BackupResult> {
    const entries = this.logEntriesForExport(input.instanceId)
    let instance: InstanceSummary | null = null
    let settings: InstanceSettings | null = null
    if (input.instanceId) {
      try {
        const resolved = this.resolve(input.instanceId)
        instance = { ...resolved.instance }
        settings = readInstanceSettings(this.fs, resolved.instance.dir).settings
      } catch {
        instance = null
      }
    }
    const diagnostics = {
      createdAt: this.now(),
      appVersion: this.options.appVersion ?? null,
      platform: process.platform,
      arch: process.arch,
      node: process.versions.node,
      electron: process.versions.electron ?? null,
      dataRoot: this.options.roots.dataRoot,
      mcRoot: this.options.roots.mcRoot,
      instance,
      settings,
      trash: this.trash.list().length,
    }
    entries.push({
      name: 'diagnostics.json',
      data: Buffer.from(`${JSON.stringify(diagnostics, null, 2)}\n`),
    })
    return this.writeArchive(entries, input.outPath, 'diagnostics', 'diagnostics')
  }

  async openFolder(input: { instanceId?: string; area: AssetArea }): Promise<{ path: string }> {
    let dir: string
    if (input.area === 'launcher-logs') dir = path.join(this.options.roots.dataRoot, 'logs')
    else if (input.area === 'game-logs') {
      if (!input.instanceId) fail('ASSETS.INSTANCE_REQUIRED', '查看游戏日志需要实例')
      dir = this.gameSubdir(input.instanceId, 'logs')
    } else {
      if (!input.instanceId) fail('ASSETS.INSTANCE_REQUIRED', '该目录需要实例')
      dir =
        input.area === 'saves'
          ? this.gameSubdir(input.instanceId, 'saves')
          : input.area === 'schematics'
            ? this.gameSubdir(input.instanceId, 'schematics')
            : this.gameSubdir(input.instanceId, 'screenshots')
    }
    this.ensureDir(dir)
    if (!this.options.openPath) fail('ASSETS.OPEN_UNAVAILABLE', '当前环境不支持打开目录')
    const error = await this.options.openPath(dir)
    if (error) fail('ASSETS.OPEN_FAILED', error, { path: dir })
    return { path: dir }
  }

  private assetTarget(
    instanceId: string,
    kind: 'save' | 'screenshot' | 'schematic',
    name: string,
  ): string {
    const dir =
      kind === 'save'
        ? this.gameSubdir(instanceId, 'saves')
        : kind === 'schematic'
          ? this.gameSubdir(instanceId, 'schematics')
          : this.gameSubdir(instanceId, 'screenshots')
    return assertChild(dir, name)
  }

  async showInFolder(input: {
    instanceId: string
    kind: 'save' | 'screenshot' | 'schematic'
    name: string
  }): Promise<{ path: string }> {
    const target = this.assetTarget(input.instanceId, input.kind, input.name)
    if (!fs.existsSync(target)) fail('ASSETS.FILE_NOT_FOUND', `文件不存在: ${input.name}`)
    if (!this.options.showItemInFolder) fail('ASSETS.OPEN_UNAVAILABLE', '当前环境不支持在文件夹中显示')
    this.options.showItemInFolder(target)
    return { path: target }
  }

  async openFile(input: {
    instanceId: string
    kind: 'save' | 'screenshot' | 'schematic'
    name: string
  }): Promise<{ ok: boolean }> {
    const target = this.assetTarget(input.instanceId, input.kind, input.name)
    if (!fs.existsSync(target)) fail('ASSETS.FILE_NOT_FOUND', `文件不存在: ${input.name}`)
    if (!this.options.openPath) fail('ASSETS.OPEN_UNAVAILABLE', '当前环境不支持打开文件')
    const error = await this.options.openPath(target)
    if (error) fail('ASSETS.OPEN_FAILED', error, { path: target })
    return { ok: true }
  }

  async listTrash(): Promise<{ items: TrashItem[] }> {
    return { items: this.trash.list() }
  }

  async restoreTrash(input: { ids?: string[] } = {}): Promise<RestoreResult> {
    const result = this.trash.restore(input.ids)
    if (result.restored.length > 0) {
      const areas = new Set<AssetArea>()
      for (const item of result.restored) {
        if (item.kind === 'save') areas.add('saves')
        else if (item.kind === 'screenshot') areas.add('screenshots')
        else if (item.kind === 'schematic') areas.add('schematics')
        else if (item.kind === 'log') areas.add('game-logs')
      }
      for (const area of areas) this.emit(area)
    }
    return result
  }
}

export function createAssetsService(options: AssetsServiceOptions): AssetsModuleService {
  return new AssetsModuleService(options)
}

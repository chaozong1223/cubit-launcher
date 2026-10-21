import fs from 'node:fs'
import path from 'node:path'
import type {
  AssetArea,
  BackupResult,
  BatchTrashResult,
  LogEntry,
  LogLevel,
  LogSource,
  RestoreResult,
  SaveEntry,
  ScreenshotEntry,
  TrashItem,
} from '@shared/assets'
import type { InstanceSettings, InstanceSummary } from '@shared/instance'
import { AppError } from '@shared/errors'
import type { ScopedLogger } from '../../kernel/logger'
import type { ModuleRoots } from '../_context'
import { requireMcRoot } from '../_context'
import { nodeFsPort, type FsPort } from '../../core/ports'
import { gameDirectory, readInstanceSettings } from '../../core/instance/settings'
import { scanInstances, type ScannedInstance } from '../../core/instance/scan'
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

export interface AssetsServiceOptions {
  roots: ModuleRoots
  log: ScopedLogger
  fs?: FsPort
  openPath?: (target: string) => Promise<string>
  showItemInFolder?: (target: string) => void
  appVersion?: string
  now?: () => number
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

  private gameSubdir(instanceId: string, name: 'saves' | 'screenshots' | 'logs'): string {
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
      dir = input.area === 'saves' ? this.gameSubdir(input.instanceId, 'saves') : this.gameSubdir(input.instanceId, 'screenshots')
    }
    this.ensureDir(dir)
    if (!this.options.openPath) fail('ASSETS.OPEN_UNAVAILABLE', '当前环境不支持打开目录')
    const error = await this.options.openPath(dir)
    if (error) fail('ASSETS.OPEN_FAILED', error, { path: dir })
    return { path: dir }
  }

  private assetTarget(instanceId: string, kind: 'save' | 'screenshot', name: string): string {
    const dir = kind === 'save' ? this.gameSubdir(instanceId, 'saves') : this.gameSubdir(instanceId, 'screenshots')
    return assertChild(dir, name)
  }

  async showInFolder(input: {
    instanceId: string
    kind: 'save' | 'screenshot'
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
    kind: 'save' | 'screenshot'
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
    if (result.restored.length > 0) this.emit('saves')
    return result
  }
}

export function createAssetsService(options: AssetsServiceOptions): AssetsModuleService {
  return new AssetsModuleService(options)
}

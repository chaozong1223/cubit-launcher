import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  BatchOperationResult,
  DependencyIssue,
  InstallLocalFileResult,
  KindFiles,
  ModFile,
  ModKind,
  ModpackExportResult,
  ModpackImportFinished,
  ModpackImportProgress,
  ModpackImportResult,
  ModpackImportStart,
  ModpackFormat,
  ModScanResult,
} from '@shared/mods'
import type { InstanceSettings, Loader } from '@shared/instance'
import { AppError } from '@shared/errors'
import type { FsPort } from '../../core/ports'
import { nodeFsPort } from '../../core/ports'
import { JobContext, JobRegistry, type JobOutcome } from '../../core/job/kernel'
import { copyFileStreaming } from '../../core/fs/stream-copy'
import { defaultInstanceSettings, gameDirectory, readInstanceSettings, writeInstanceSettings } from '../../core/instance/settings'
import { scanInstances, type ScannedInstance } from '../../core/instance/scan'
import { openZipFile, safeEntryPath } from '../../core/zip/reader'
import type { ScopedLogger } from '../../kernel/logger'
import type { ModuleRoots } from '../_context'
import { requireMcRoot } from '../_context'
import { createStoredZip, extractOverrides, readJsonEntry, type ZipWriteEntry } from './archive'
import { readModMetadata, satisfiesRange } from './metadata'
import {
  createFetchDownloader,
  type FileDownloader,
  sha1 as sha1Of,
  sha512 as sha512Of,
} from './downloader'
import {
  createCurseForgeResolver,
  downloadCurseForgeFiles,
  downloadMrpackFiles,
  readPackManifest,
  type CurseForgeResolver,
  type CurseManifest,
  type MrpackIndex,
  type PackDownloadOptions,
  type PackManifest,
} from './modpack'

const KINDS: ModKind[] = ['mods', 'resourcepacks', 'shaderpacks']
const MODS_DIRS: Record<ModKind, string> = {
  mods: 'mods',
  resourcepacks: 'resourcepacks',
  shaderpacks: 'shaderpacks',
}
const MAX_LOCAL_FILE_BYTES = 512 * 1024 * 1024
const MAX_EXPORT_BYTES = 2 * 1024 * 1024 * 1024
const RESERVED_DIR_NAMES = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9',
])

export interface ModsServiceOptions {
  roots: ModuleRoots
  log: ScopedLogger
  fs?: FsPort
  downloader?: FileDownloader
  curseResolver?: CurseForgeResolver
  openPath?: (target: string) => Promise<string>
  now?: () => number
}

interface ResolvedInstance {
  instance: ScannedInstance
  instanceDir: string
  gameDir: string
  settings: InstanceSettings | null
}

function fail(code: string, message: string, details?: Record<string, unknown>): never {
  throw new AppError(code, message, { details })
}

function isDisabled(name: string): boolean {
  return name.endsWith('.disabled')
}

function displayName(name: string): string {
  return isDisabled(name) ? name.slice(0, -'.disabled'.length) : name
}

function allowedFile(kind: ModKind, name: string, directory: boolean): boolean {
  const base = displayName(name)
  const lower = base.toLowerCase()
  if (kind === 'mods') return !directory && lower.endsWith('.jar')
  if (directory) return true
  return lower.endsWith('.zip')
}

function safeBaseName(name: string): string {
  return path.basename(name.replaceAll('\\', '/'))
}

function kindFolderName(kind: ModKind): string {
  return MODS_DIRS[kind]
}

function emptyKindFiles(): KindFiles {
  return { enabled: [], disabled: [] }
}

function addFile(groups: Record<ModKind, KindFiles>, file: ModFile): void {
  ;(file.enabled ? groups[file.kind].enabled : groups[file.kind].disabled).push(file)
}

export class ModsModuleService {
  private readonly fs: FsPort
  private readonly downloader: FileDownloader
  private readonly curseResolver: CurseForgeResolver
  private readonly listeners = new Map<string, Set<(payload: unknown) => void>>()
  private readonly importJobs = new JobRegistry<ModpackImportResult>()
  private readonly now: () => number

  constructor(private readonly options: ModsServiceOptions) {
    this.fs = options.fs ?? nodeFsPort()
    this.downloader = options.downloader ?? createFetchDownloader()
    this.curseResolver = options.curseResolver ?? createCurseForgeResolver()
    this.now = options.now ?? Date.now
    this.wireImportEvents()
  }

  /** Forward job progress/results to the module IPC layer. */
  private wireImportEvents(): void {
    this.importJobs.onProgress((progress, job) => {
      this.emitEvent('importProgress', {
        ...progress,
        instanceId: job.meta.instanceId ?? '',
        format: (job.meta.format as ModpackFormat | undefined) ?? 'modrinth',
      })
    })
    this.importJobs.onFinished((outcome, job) => {
      this.emitEvent('importFinished', {
        jobId: outcome.jobId,
        state: outcome.state,
        ok: outcome.ok,
        error: outcome.error,
        durationMs: outcome.durationMs,
        instanceId: job.meta.instanceId ?? '',
        result: outcome.result,
      })
    })
  }

  onEvent(event: string, listener: (payload: unknown) => void): () => void {
    let listeners = this.listeners.get(event)
    if (!listeners) {
      listeners = new Set()
      this.listeners.set(event, listeners)
    }
    listeners.add(listener)
    return () => {
      listeners?.delete(listener)
    }
  }

  private emitEvent(event: string, payload: unknown): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) {
      try {
        listener(payload)
      } catch {
        // An observer must never fail a completed file operation.
      }
    }
  }

  private emitChanged(instanceId: string): void {
    this.emitEvent('changed', { instanceId })
  }

  private mcRoot(): string {
    return requireMcRoot(this.options.roots)
  }

  private resolve(instanceId: string): ResolvedInstance {
    const instance = scanInstances(this.fs, this.mcRoot()).find(
      (item) => item.id === instanceId || item.dirName === instanceId,
    )
    if (!instance) {
      fail('MODS.INSTANCE_NOT_FOUND', `找不到实例: ${instanceId}`, { instanceId })
    }
    return {
      instance,
      instanceDir: instance.dir,
      gameDir: gameDirectory(this.mcRoot(), instance.dirName, instance.isolation),
      settings: readInstanceSettings(this.fs, instance.dir).settings,
    }
  }

  private kindDir(gameDir: string, kind: ModKind): string {
    return path.join(gameDir, kindFolderName(kind))
  }

  private readKind(gameDir: string, kind: ModKind): ModFile[] {
    const dir = this.kindDir(gameDir, kind)
    const result: ModFile[] = []
    for (const name of this.fs.readDir(dir)) {
      const target = path.join(dir, name)
      const stat = this.fs.stat(target)
      if (!stat) continue
      const directory = stat.isDirectory()
      if (!directory && !stat.isFile()) continue
      if (!allowedFile(kind, name, directory)) continue
      const enabled = !isDisabled(name)
      const meta = kind === 'mods' && !directory ? readModMetadata(this.fs, target) : null
      result.push({
        name: displayName(name),
        fileName: name,
        kind,
        enabled,
        size: directory ? 0 : stat.size,
        modifiedAt: Math.floor(stat.mtimeMs),
        metadata: meta?.metadata ?? null,
        metadataError: meta?.error ?? null,
      })
    }
    return result.sort((a, b) => {
      if (a.enabled !== b.enabled) return a.enabled ? -1 : 1
      return a.name.localeCompare(b.name, 'zh-CN')
    })
  }

  private buildIssues(
    instance: ScannedInstance,
    mods: ModFile[],
    settings: InstanceSettings | null,
  ): DependencyIssue[] {
    const mcVersion = settings?.mcVersion ?? instance.mcVersion
    const loader = settings?.loader ?? instance.loader
    const enabled = mods.filter((file) => file.enabled && file.metadata)
    const installed = new Map(
      enabled.map((file) => [
        file.metadata!.id.toLowerCase(),
        { name: file.metadata!.name ?? file.name, version: file.metadata!.version },
      ]),
    )
    const issues: DependencyIssue[] = []
    const seen = new Set<string>()

    const push = (issue: DependencyIssue) => {
      const key = `${issue.kind}:${issue.modId}:${issue.dependency}`
      if (seen.has(key)) return
      seen.add(key)
      issues.push(issue)
    }

    for (const file of enabled) {
      const meta = file.metadata!
      const modName = meta.name ?? meta.id
      for (const dep of meta.dependencies) {
        if (!dep.mandatory) continue
        const depId = dep.id.toLowerCase()
        if (depId === 'java') continue

        if (depId === 'minecraft') {
          if (mcVersion && !satisfiesRange(mcVersion, dep.versionRange)) {
            push({
              kind: 'mc-mismatch',
              mod: modName,
              modId: meta.id,
              dependency: dep.id,
              requiredRange: dep.versionRange,
              installedVersion: mcVersion,
              message: `${modName} 需要 Minecraft ${dep.versionRange ?? '任意版本'}，当前实例是 ${mcVersion}`,
            })
          }
          continue
        }

        if (
          ['forge', 'neoforge', 'fabricloader', 'fabric-loader', 'quilt_loader', 'quilt-loader'].includes(
            depId,
          )
        ) {
          const current = loader.version
          if (!current || !satisfiesRange(current, dep.versionRange)) {
            push({
              kind: 'loader-mismatch',
              mod: modName,
              modId: meta.id,
              dependency: dep.id,
              requiredRange: dep.versionRange,
              installedVersion: current,
              message: `${modName} 需要 ${dep.id} ${dep.versionRange ?? '任意版本'}，当前加载器版本为 ${current ?? '未安装'}`,
            })
          }
          continue
        }

        const present = installed.get(depId)
        if (!present) {
          push({
            kind: 'missing',
            mod: modName,
            modId: meta.id,
            dependency: dep.id,
            requiredRange: dep.versionRange,
            installedVersion: null,
            message: `${modName} 缺少前置 ${dep.id}${dep.versionRange ? `（需要 ${dep.versionRange}）` : ''}`,
          })
        } else if (
          present.version &&
          dep.versionRange &&
          !satisfiesRange(present.version, dep.versionRange)
        ) {
          push({
            kind: 'version-mismatch',
            mod: modName,
            modId: meta.id,
            dependency: dep.id,
            requiredRange: dep.versionRange,
            installedVersion: present.version,
            message: `${modName} 需要 ${dep.id} ${dep.versionRange}，已安装 ${present.version}`,
          })
        }
      }
    }
    return issues
  }

  async scan(input: { instanceId: string; kind?: ModKind }): Promise<ModScanResult> {
    const resolved = this.resolve(input.instanceId)
    const groups: Record<ModKind, KindFiles> = {
      mods: emptyKindFiles(),
      resourcepacks: emptyKindFiles(),
      shaderpacks: emptyKindFiles(),
    }
    const kinds = input.kind ? [input.kind] : KINDS
    for (const kind of kinds) {
      for (const file of this.readKind(resolved.gameDir, kind)) addFile(groups, file)
    }
    const issues = this.buildIssues(
      resolved.instance,
      groups.mods.enabled.concat(groups.mods.disabled),
      resolved.settings,
    )
    const totals = {
      enabled:
        groups.mods.enabled.length +
        groups.resourcepacks.enabled.length +
        groups.shaderpacks.enabled.length,
      disabled:
        groups.mods.disabled.length +
        groups.resourcepacks.disabled.length +
        groups.shaderpacks.disabled.length,
    }
    this.options.log.info('mods scanned', {
      instanceId: resolved.instance.dirName,
      mods: groups.mods.enabled.length + groups.mods.disabled.length,
      issues: issues.length,
    })
    return {
      instanceId: resolved.instance.dirName,
      gameDir: resolved.gameDir,
      files: groups,
      totals,
      issues,
    }
  }

  async analyzeDependencies(input: { instanceId: string }): Promise<{ issues: DependencyIssue[] }> {
    const resolved = this.resolve(input.instanceId)
    const mods = this.readKind(resolved.gameDir, 'mods')
    return { issues: this.buildIssues(resolved.instance, mods, resolved.settings) }
  }

  private findFile(dir: string, kind: ModKind, name: string): string | null {
    const clean = safeBaseName(name)
    if (!clean || clean === '.' || clean === '..') return null
    const display = displayName(clean)
    const candidates = [
      clean,
      display,
      `${display}.disabled`,
      ...(kind === 'mods' ? [`${display}.jar`, `${display}.jar.disabled`] : []),
      ...(kind === 'mods' ? [] : [`${display}.zip`, `${display}.zip.disabled`]),
    ]
    for (const candidate of [...new Set(candidates)]) {
      const target = path.join(dir, candidate)
      const stat = this.fs.stat(target)
      if (stat && allowedFile(kind, candidate, stat.isDirectory())) return target
    }
    return null
  }

  async setEnabled(input: {
    instanceId: string
    kind: ModKind
    names: string[]
    enabled: boolean
  }): Promise<BatchOperationResult> {
    const resolved = this.resolve(input.instanceId)
    const dir = this.kindDir(resolved.gameDir, input.kind)
    if (!this.fs.exists(dir)) this.fs.mkdirp(dir)
    const result: BatchOperationResult = { changed: [], skipped: [], errors: [] }
    for (const name of [...new Set(input.names)]) {
      const source = this.findFile(dir, input.kind, name)
      if (!source) {
        result.errors.push({ name, message: '文件不存在或类型不匹配' })
        continue
      }
      const base = path.basename(source)
      const currentlyEnabled = !isDisabled(base)
      if (currentlyEnabled === input.enabled) {
        result.skipped.push(displayName(base))
        continue
      }
      const targetName = input.enabled ? displayName(base) : `${displayName(base)}.disabled`
      const target = path.join(dir, targetName)
      if (this.fs.exists(target)) {
        result.errors.push({ name, message: `目标文件已存在: ${targetName}` })
        continue
      }
      try {
        this.fs.rename(source, target)
        result.changed.push(displayName(base))
      } catch (error) {
        result.errors.push({
          name,
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }
    if (result.changed.length > 0) this.emitChanged(resolved.instance.dirName)
    this.options.log.info('mods batch toggle', {
      instanceId: resolved.instance.dirName,
      kind: input.kind,
      enabled: input.enabled,
      changed: result.changed.length,
    })
    return result
  }

  async remove(input: {
    instanceId: string
    kind: ModKind
    names: string[]
  }): Promise<BatchOperationResult> {
    const resolved = this.resolve(input.instanceId)
    const dir = this.kindDir(resolved.gameDir, input.kind)
    const result: BatchOperationResult = { changed: [], skipped: [], errors: [] }
    for (const name of [...new Set(input.names)]) {
      const target = this.findFile(dir, input.kind, name)
      if (!target) {
        result.errors.push({ name, message: '文件不存在或类型不匹配' })
        continue
      }
      try {
        this.fs.remove(target)
        result.changed.push(displayName(path.basename(target)))
      } catch (error) {
        result.errors.push({
          name,
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }
    if (result.changed.length > 0) this.emitChanged(resolved.instance.dirName)
    this.options.log.info('mods batch remove', {
      instanceId: resolved.instance.dirName,
      kind: input.kind,
      removed: result.changed.length,
    })
    return result
  }

  private inferKind(source: string): ModKind {
    const lower = path.basename(source).toLowerCase()
    if (lower.endsWith('.jar') || lower.endsWith('.jar.disabled')) return 'mods'
    if (lower.endsWith('.zip') || lower.endsWith('.zip.disabled')) {
      try {
        const archive = openZipFile(this.fs, source)
        const isShader = archive.entries.some(
          (entry) =>
            entry.name.startsWith('shaders/') ||
            entry.name === 'shaderpack.meta' ||
            entry.name === 'shaderpack.toml',
        )
        return isShader ? 'shaderpacks' : 'resourcepacks'
      } catch {
        fail('MODS.INVALID_FILE', 'ZIP 资源包无法读取', { path: source })
      }
    }
    fail('MODS.UNSUPPORTED_FILE', '只支持 .jar 模组和 .zip 资源包/光影包', { path: source })
  }

  async installLocalFile(input: {
    instanceId: string
    path: string
    kind?: ModKind
  }): Promise<InstallLocalFileResult> {
    const source = path.resolve(input.path)
    const stat = this.fs.stat(source)
    if (!stat || !stat.isFile()) {
      fail('MODS.FILE_NOT_FOUND', `找不到本地文件: ${input.path}`, { path: source })
    }
    if (stat.size > MAX_LOCAL_FILE_BYTES) {
      fail('MODS.FILE_TOO_LARGE', '文件超过 512 MB 上限', { path: source, bytes: stat.size })
    }
    const lower = path.basename(source).toLowerCase()
    if (lower.endsWith('.mrpack')) {
      fail('MODS.USE_IMPORT', '这是整合包，请使用 importModpack 导入', { path: source })
    }
    try {
      const archive = openZipFile(this.fs, source)
      if (archive.has('modrinth.index.json') || archive.has('manifest.json')) {
        fail('MODS.USE_IMPORT', '这是整合包，请使用 importModpack 导入', { path: source })
      }
    } catch (error) {
      if (error instanceof AppError) throw error
    }

    const resolved = this.resolve(input.instanceId)
    const kind = input.kind ?? this.inferKind(source)
    const dir = this.kindDir(resolved.gameDir, kind)
    this.fs.mkdirp(dir)

    const original = safeBaseName(source)
    const disabled = isDisabled(original)
    const stem = displayName(original)
    const extension = path.extname(stem)
    const base = stem.slice(0, Math.max(0, stem.length - extension.length))
    let targetName = original
    let counter = 1
    while (this.fs.exists(path.join(dir, targetName))) {
      targetName = disabled
        ? `${base} (${counter})${extension}.disabled`
        : `${base} (${counter})${extension}`
      counter += 1
      if (counter > 999) fail('MODS.NAME_COLLISION', '同名文件过多')
    }
    const target = path.join(dir, targetName)
    this.fs.copyFile(source, target)
    const meta = kind === 'mods' ? readModMetadata(this.fs, target) : null
    const file: ModFile = {
      name: displayName(targetName),
      fileName: targetName,
      kind,
      enabled: !disabled,
      size: stat.size,
      modifiedAt: this.now(),
      metadata: meta?.metadata ?? null,
      metadataError: meta?.error ?? null,
    }
    this.emitChanged(resolved.instance.dirName)
    this.options.log.info('local file installed', {
      instanceId: resolved.instance.dirName,
      kind,
      fileName: targetName,
    })
    return { kind, targetPath: target, file }
  }

  private uniqueDirName(name: string): string {
    const normalized = name
      .normalize('NFKD')
      .replace(/[^\w.-]+/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '')
      .slice(0, 48)
    const base = normalized.length > 0 ? normalized : 'modpack'
    const safeBase = RESERVED_DIR_NAMES.has(base.toLowerCase()) ? `pack-${base}` : base
    const versions = path.join(this.mcRoot(), 'versions')
    let candidate = safeBase
    let counter = 2
    while (this.fs.exists(path.join(versions, candidate))) {
      candidate = `${safeBase}-${counter}`
      counter += 1
    }
    return candidate
  }

  private loaderMainClassMarker(type: Loader['type']): string[] {
    switch (type) {
      case 'fabric':
        return ['net.fabricmc.loader.impl.launch.knot.KnotClient']
      case 'quilt':
        return ['org.quiltmc.loader.impl.launch.knot.KnotClient']
      case 'forge':
        return ['cpw.mods.bootstraplauncher.BootstrapLauncher', 'net.minecraftforge']
      case 'neoforge':
        return ['cpw.mods.bootstraplauncher.BootstrapLauncher', 'net.neoforged']
      default:
        return []
    }
  }

  /** Find the installed loader profile (versions/<loader>/...json inherits base). */
  private findInstalledLoader(
    mcVersion: string | null,
    loader: Loader,
  ): { dirName: string; jsonPath: string; json: Record<string, unknown> } | null {
    if (!mcVersion || loader.type === 'vanilla') return null
    const markers = this.loaderMainClassMarker(loader.type)
    const versionsDir = path.join(this.mcRoot(), 'versions')
    if (!this.fs.exists(versionsDir)) return null
    const wanted = loader.version?.toLowerCase() ?? ''
    let best: { dirName: string; jsonPath: string; json: Record<string, unknown> } | null = null
    let bestScore = -1
    for (const dirName of this.fs.readDir(versionsDir)) {
      const jsonPath = path.join(versionsDir, dirName, `${dirName}.json`)
      if (!this.fs.exists(jsonPath)) continue
      try {
        const json = JSON.parse(this.fs.readText(jsonPath)) as Record<string, unknown>
        const inherits = typeof json.inheritsFrom === 'string' ? json.inheritsFrom : null
        if (inherits !== mcVersion) continue
        const mainClass = typeof json.mainClass === 'string' ? json.mainClass : ''
        const matchesMarker =
          markers.length === 0 || markers.some((marker) => mainClass.includes(marker))
        if (!matchesMarker) continue
        const nameMatchesVersion =
          wanted.length > 0 &&
          (dirName.toLowerCase().includes(wanted) ||
            (typeof json.id === 'string' && json.id.toLowerCase().includes(wanted)))
        // Prefer the exact loader build for this Minecraft version.
        const score = (nameMatchesVersion ? 2 : 0) + (mainClass ? 1 : 0)
        if (score > bestScore) {
          best = { dirName, jsonPath, json }
          bestScore = score
        }
      } catch {
        // A broken unrelated profile must not make the import fail.
      }
    }
    return best
  }

  private writePackVersion(
    mcVersion: string | null,
    dirName: string,
    loaderProfile: { dirName: string; jsonPath: string; json: Record<string, unknown> } | null,
  ): boolean {
    if (!mcVersion) return false
    const versions = path.join(this.mcRoot(), 'versions')
    const baseJson = path.join(versions, mcVersion, `${mcVersion}.json`)
    if (!this.fs.exists(baseJson)) return false
    try {
      let parsed: Record<string, unknown>
      if (loaderProfile) {
        parsed = { ...loaderProfile.json }
        parsed.id = dirName
        // Keep the loader's mainClass/libraries/arguments and its base link.
        if (typeof parsed.inheritsFrom !== 'string') parsed.inheritsFrom = mcVersion
      } else {
        parsed = JSON.parse(this.fs.readText(baseJson)) as Record<string, unknown>
        parsed.id = dirName
        delete parsed.inheritsFrom
      }
      const target = path.join(versions, dirName, `${dirName}.json`)
      this.fs.writeText(target, `${JSON.stringify(parsed, null, 2)}\n`)
      const baseJar = path.join(versions, mcVersion, `${mcVersion}.jar`)
      if (this.fs.exists(baseJar)) {
        this.fs.copyFile(baseJar, path.join(versions, dirName, `${dirName}.jar`))
      }
      return true
    } catch {
      return false
    }
  }

  /** One import job's on-disk scratch state, captured by the cleanup hook. */
  private importScratch(dirName: string, jobId: string): {
    dirName: string
    instanceDir: string
    tempDir: string
    parts: Set<string>
  } {
    return {
      dirName,
      instanceDir: path.join(this.mcRoot(), 'versions', dirName),
      tempDir: path.join(this.options.roots.dataRoot, 'tmp', 'jobs', `mods-import-${jobId}`),
      parts: new Set<string>(),
    }
  }

  private overridePrefixes(manifest: PackManifest): string[] {
    const prefixes = ['overrides/', 'client-overrides/']
    if (manifest.format === 'curseforge') {
      const overrides = (manifest.index as CurseManifest).overrides
      if (overrides && overrides !== 'overrides') prefixes.unshift(`${overrides}/`)
    }
    return prefixes
  }

  /** Count override entries up-front so progress totals are honest from start. */
  private countOverrides(
    archive: ReturnType<typeof openZipFile>,
    prefixes: string[],
  ): { files: number; bytes: number } {
    let files = 0
    let bytes = 0
    for (const entry of archive.entries) {
      if (entry.isDirectory || entry.isSymlink) continue
      const prefix = prefixes.find((candidate) => entry.name.startsWith(candidate))
      if (!prefix) continue
      const relative = entry.name.slice(prefix.length)
      if (!relative || relative.endsWith('/')) continue
      if (
        relative.toLowerCase() === 'instance.json' ||
        relative.toLowerCase().startsWith('versions/')
      ) {
        continue
      }
      files += 1
      bytes += entry.size
    }
    return { files, bytes }
  }

  /** Recursively move extracted overrides from the job's temp dir into place. */
  private async mergeOverrides(
    source: string,
    destination: string,
    ctx: JobContext,
  ): Promise<void> {
    for (const name of this.fs.readDir(source)) {
      await ctx.checkpoint()
      const from = path.join(source, name)
      const to = path.join(destination, name)
      const stat = this.fs.stat(from)
      if (!stat) continue
      if (stat.isDirectory()) {
        this.fs.mkdirp(to)
        await this.mergeOverrides(from, to, ctx)
        continue
      }
      if (!stat.isFile()) continue
      // Never replace launcher-owned metadata or an earlier file; packs are
      // additive here and extractOverrides already blocked protected paths.
      if (this.fs.exists(to)) continue
      await copyFileStreaming(from, to, {
        signal: ctx.signal,
        onBytes: (delta) => ctx.addBytes(delta),
      })
    }
  }

  private cleanupImport(scratch: {
    instanceDir: string
    tempDir: string
    parts: Set<string>
  }): void {
    for (const part of [...scratch.parts]) {
      try {
        this.fs.remove(part)
      } catch {
        // Best effort; Windows may still hold the file for a moment.
      }
    }
    scratch.parts.clear()
    try {
      this.fs.remove(scratch.tempDir)
    } catch {
      // Leftovers are confined to dataRoot/tmp and cleaned on the next run.
    }
    try {
      this.fs.remove(scratch.instanceDir)
    } catch {
      // Keep the original error; a partial import is not silently reported.
    }
  }

  private async runImport(
    ctx: JobContext,
    plan: {
      archive: ReturnType<typeof openZipFile>
      manifest: PackManifest
      dirName: string
      instanceDir: string
      gameDir: string
      loaderProfile: { dirName: string; jsonPath: string; json: Record<string, unknown> } | null
      settings: InstanceSettings
      prefixes: string[]
      scratch: { tempDir: string; parts: Set<string> }
      warnings: string[]
    },
  ): Promise<ModpackImportResult> {
    const { manifest, archive, dirName, instanceDir, gameDir, loaderProfile, settings, prefixes } =
      plan
    const warnings = plan.warnings

    ctx.setStage('prepare')
    await ctx.checkpoint()
    this.fs.mkdirp(instanceDir)
    this.fs.mkdirp(plan.scratch.tempDir)
    writeInstanceSettings(this.fs, instanceDir, settings)

    const baseReady = this.writePackVersion(manifest.mcVersion, dirName, loaderProfile)
    if (!baseReady) {
      warnings.push(
        `基础版本 ${manifest.mcVersion ?? '未知'} 未安装；导入已完成，但启动前需先安装该版本`,
      )
    }
    if (loaderProfile) {
      this.options.log.info('modpack loader profile merged', {
        instanceId: dirName,
        loader: manifest.loader.type,
        loaderVersion: manifest.loader.version,
        loaderDir: loaderProfile.dirName,
      })
    }

    // Extract overrides into the job's temp directory first. A cancel therefore
    // only has to delete that directory (plus the instance dir) and can never
    // leave half-written pack files inside a version folder.
    ctx.setStage('overrides')
    await ctx.checkpoint()
    const extracted = await extractOverrides(this.fs, archive, plan.scratch.tempDir, prefixes, {
      signal: ctx.signal,
      checkpoint: () => ctx.checkpoint(),
      onEntry: (relative) => {
        ctx.setCurrent(`overrides/${relative}`)
        ctx.addDone(1)
      },
    })
    await ctx.checkpoint()
    await this.mergeOverrides(plan.scratch.tempDir, gameDir, ctx)
    try {
      this.fs.remove(plan.scratch.tempDir)
    } catch {
      // Non-fatal: the temp dir is inside dataRoot/tmp.
    }

    ctx.setStage('download')
    ctx.setCurrent(null)
    const options: PackDownloadOptions = {
      signal: ctx.signal,
      checkpoint: () => ctx.checkpoint(),
      onBytes: (delta) => ctx.addBytes(delta),
      onFileStart: (relative) => ctx.setCurrent(relative),
      onFileDone: () => ctx.addDone(1),
      parts: plan.scratch.parts,
    }

    let downloaded = 0
    let skipped = 0
    if (manifest.format === 'modrinth') {
      const result = await downloadMrpackFiles(
        this.fs,
        gameDir,
        manifest.index as MrpackIndex,
        this.downloader,
        options,
      )
      downloaded += result.downloaded
      skipped += result.skipped
    } else {
      const result = await downloadCurseForgeFiles(
        this.fs,
        gameDir,
        manifest.index as CurseManifest,
        this.downloader,
        this.curseResolver,
        options,
      )
      downloaded += result.downloaded
      skipped += result.skipped
      warnings.push(...result.warnings)
    }

    ctx.setStage('finalize')
    await ctx.checkpoint()
    ctx.setCurrent(null)
    this.emitChanged(dirName)
    this.options.log.info('modpack imported', {
      instanceId: dirName,
      format: manifest.format,
      downloaded,
      overrides: extracted.written,
    })
    return {
      instanceId: dirName,
      dirName,
      name: settings.name,
      format: manifest.format,
      mcVersion: manifest.mcVersion,
      loader: manifest.loader,
      downloaded,
      skipped,
      overrides: extracted.written,
      needsBaseInstall: !baseReady,
      warnings,
    }
  }

  /**
   * Starts a modpack import as a background job and returns immediately with
   * the reserved target directory. Progress arrives as `importProgress`,
   * the final result as `importFinished`; `cancelImport` rolls everything back.
   */
  async importModpack(input: { filePath: string; name?: string }): Promise<ModpackImportStart> {
    const source = path.resolve(input.filePath)
    if (!this.fs.exists(source)) {
      fail('MODS.FILE_NOT_FOUND', `找不到整合包: ${input.filePath}`, { path: source })
    }
    const archive = openZipFile(this.fs, source)
    const manifest = readPackManifest(this.fs, archive)
    const dirName = this.uniqueDirName(input.name ?? manifest.name)
    const instanceDir = path.join(this.mcRoot(), 'versions', dirName)

    // Resolve the installed loader profile before creating anything. A pack
    // that requires Fabric/Forge must never silently become a vanilla launch.
    const loaderProfile =
      manifest.loader.type === 'vanilla'
        ? null
        : this.findInstalledLoader(manifest.mcVersion, manifest.loader)
    if (manifest.loader.type !== 'vanilla') {
      if (!manifest.loader.version) {
        fail(
          'MODS.LOADER_VERSION_UNKNOWN',
          `整合包声明使用 ${manifest.loader.type}，但没有写加载器版本；请先安装加载器后再导入`,
          {
            type: manifest.loader.type,
            mcVersion: manifest.mcVersion,
            hint: '先安装对应版本的加载器（Fabric/Forge/NeoForge），再重新导入整合包。',
          },
        )
      }
      if (!loaderProfile) {
        fail(
          'MODS.LOADER_NOT_INSTALLED',
          `未找到整合包所需的 ${manifest.loader.type} ${manifest.loader.version} 加载器（Minecraft ${manifest.mcVersion ?? '未知'}）；请先安装该加载器后再导入`,
          {
            type: manifest.loader.type,
            version: manifest.loader.version,
            mcVersion: manifest.mcVersion,
            hint: '在“版本/加载器”页安装该加载器；导入不会回退到原版启动。',
          },
        )
      }
    }

    const prefixes = this.overridePrefixes(manifest)
    const overrideStats = this.countOverrides(archive, prefixes)
    const fileCount =
      manifest.format === 'modrinth'
        ? (manifest.index as MrpackIndex).files.length
        : (manifest.index as CurseManifest).files.length
    const bytesTotal =
      overrideStats.bytes +
      (manifest.format === 'modrinth'
        ? (manifest.index as MrpackIndex).files.reduce(
            (total, file) => total + (file.fileSize ?? 0),
            0,
          )
        : 0)
    const totalFiles = overrideStats.files + fileCount
    const settings: InstanceSettings = {
      ...defaultInstanceSettings({
        dirName,
        id: dirName,
        name: input.name ?? manifest.name,
        mcVersion: manifest.mcVersion,
        loader: manifest.loader,
        now: this.now(),
      }),
      source: 'pack',
      createdAt: this.now(),
    }
    const baseJson = manifest.mcVersion
      ? path.join(this.mcRoot(), 'versions', manifest.mcVersion, `${manifest.mcVersion}.json`)
      : null
    const needsBaseInstall = !baseJson || !this.fs.exists(baseJson)
    const jobId = randomUUID()
    const scratch = this.importScratch(dirName, jobId)
    const warnings: string[] = []

    const job = this.importJobs.start(
      {
        id: jobId,
        stage: 'prepare',
        total: totalFiles,
        bytesTotal,
        meta: { instanceId: dirName, format: manifest.format },
      },
      (ctx) =>
        this.runImport(ctx, {
          archive,
          manifest,
          dirName,
          instanceDir,
          gameDir: instanceDir,
          loaderProfile,
          settings,
          prefixes,
          scratch,
          warnings,
        }),
      {
        failureCode: 'MODS.PACK_IMPORT_FAILED',
        cleanup: () => this.cleanupImport(scratch),
        onError: (error) => {
          this.options.log.error('modpack import failed', {
            instanceId: dirName,
            message: error instanceof Error ? error.message : String(error),
          })
        },
      },
    )

    this.options.log.info('modpack import started', {
      jobId: job.id,
      instanceId: dirName,
      format: manifest.format,
      files: totalFiles,
    })
    return {
      jobId: job.id,
      instanceId: dirName,
      dirName,
      name: settings.name,
      format: manifest.format,
      mcVersion: manifest.mcVersion,
      loader: manifest.loader,
      totalFiles,
      needsBaseInstall,
    }
  }

  cancelImport(jobId: string): { cancelled: boolean } {
    const cancelled = this.importJobs.cancel(jobId)
    if (cancelled) this.options.log.info('modpack import cancel requested', { jobId })
    return { cancelled }
  }

  pauseImport(jobId: string): { paused: boolean } {
    return { paused: this.importJobs.pause(jobId) }
  }

  resumeImport(jobId: string): { resumed: boolean } {
    return { resumed: this.importJobs.resume(jobId) }
  }

  importStatus(jobId: string): ModpackImportProgress | null {
    const progress = this.importJobs.status(jobId)
    if (!progress) return null
    const meta = this.importJobs.meta(jobId) ?? {}
    return {
      ...progress,
      instanceId: meta.instanceId ?? '',
      format: (meta.format as ModpackFormat | undefined) ?? 'modrinth',
    }
  }

  importResult(jobId: string): ModpackImportFinished | null {
    const outcome = this.importJobs.outcome(jobId)
    if (!outcome) return null
    const meta = this.importJobs.meta(jobId) ?? {}
    return {
      jobId: outcome.jobId,
      state: outcome.state,
      ok: outcome.ok,
      error: outcome.error,
      durationMs: outcome.durationMs,
      instanceId: meta.instanceId ?? '',
      result: outcome.result,
    }
  }

  /** Test seam: waits for the import job to leave running/paused. */
  waitForImport(
    jobId: string,
    timeoutMs?: number,
  ): Promise<JobOutcome<ModpackImportResult>> {
    return this.importJobs.waitFor(jobId, timeoutMs)
  }

  private collectOverrides(gameDir: string): ZipWriteEntry[] {
    const entries: ZipWriteEntry[] = []
    const seen = new Set<string>()
    const addFile = (absolute: string, relative: string) => {
      const key = relative.replaceAll('\\', '/')
      if (seen.has(key)) return
      const real = this.fs.realpath(absolute)
      const root = this.fs.realpath(gameDir)
      if (real !== root && !real.startsWith(`${root}${path.sep}`)) return
      const data = this.fs.readBytes(absolute)
      entries.push({ name: `overrides/${key}`, data })
      seen.add(key)
    }
    const walk = (absolute: string, relative: string) => {
      for (const name of this.fs.readDir(absolute)) {
        const child = path.join(absolute, name)
        const stat = this.fs.stat(child)
        if (!stat) continue
        const rel = relative ? `${relative}/${name}` : name
        if (stat.isDirectory()) walk(child, rel)
        else if (stat.isFile()) addFile(child, rel)
      }
    }
    for (const dir of ['mods', 'config', 'defaultconfigs', 'resourcepacks', 'shaderpacks']) {
      const absolute = path.join(gameDir, dir)
      if (this.fs.exists(absolute)) walk(absolute, dir)
    }
    const options = path.join(gameDir, 'options.txt')
    if (this.fs.exists(options)) addFile(options, 'options.txt')
    return entries
  }

  async exportModpack(input: {
    instanceId: string
    outPath?: string
  }): Promise<ModpackExportResult> {
    const resolved = this.resolve(input.instanceId)
    const settings = resolved.settings
    const mcVersion = settings?.mcVersion ?? resolved.instance.mcVersion
    const loader = settings?.loader ?? resolved.instance.loader
    const displayName = settings?.name ?? resolved.instance.name
    if (!mcVersion) {
      fail('MODS.EXPORT_UNSUPPORTED', '实例缺少 Minecraft 版本，无法导出 .mrpack')
    }
    const mods = this.readKind(resolved.gameDir, 'mods')
    const files: Array<Record<string, unknown>> = []
    for (const mod of mods) {
      if (!mod.enabled) continue
      const data = this.fs.readBytes(path.join(this.kindDir(resolved.gameDir, 'mods'), mod.fileName))
      files.push({
        path: `mods/${mod.fileName}`,
        hashes: { sha1: sha1Of(data), sha512: sha512Of(data) },
        env: { client: 'required', server: 'required' },
        downloads: [],
        fileSize: data.length,
      })
    }

    const dependencies: Record<string, string> = {
      minecraft: mcVersion,
    }
    const loaderKey: Partial<Record<Loader['type'], string>> = {
      fabric: 'fabric-loader',
      quilt: 'quilt-loader',
      forge: 'forge',
      neoforge: 'neoforge',
    }
    const key = loaderKey[loader.type]
    if (key && loader.version) dependencies[key] = loader.version

    const index = {
      formatVersion: 1,
      game: 'minecraft',
      versionId: '1.0.0',
      name: displayName,
      summary: `${displayName} exported by mc-launcher`,
      files,
      dependencies,
    }
    const overrides = this.collectOverrides(resolved.gameDir)
    const totalBytes = Buffer.byteLength(JSON.stringify(index)) +
      overrides.reduce((sum, entry) => sum + entry.data.length, 0)
    if (totalBytes > MAX_EXPORT_BYTES) {
      fail('MODS.PACK_TOO_LARGE', '导出内容超过 2 GB 上限')
    }
    const buffer = createStoredZip([
      { name: 'modrinth.index.json', data: Buffer.from(`${JSON.stringify(index, null, 2)}\n`) },
      ...overrides,
    ])

    const target =
      input.outPath ??
      path.join(
        this.options.roots.dataRoot,
        'modules',
        'mods',
        'exports',
        `${this.uniqueDirName(resolved.instance.name)}-${this.now()}.mrpack`,
      )
    const finalPath = target.toLowerCase().endsWith('.mrpack') ? target : `${target}.mrpack`
    this.fs.mkdirp(path.dirname(finalPath))
    this.fs.writeBytes(finalPath, buffer)
    this.options.log.info('modpack exported', {
      instanceId: resolved.instance.dirName,
      files: files.length,
      overrides: overrides.length,
      bytes: buffer.length,
    })
    return {
      path: finalPath,
      format: 'mrpack',
      files: files.length + overrides.length,
      bytes: buffer.length,
    }
  }

  async openFolder(input: { instanceId: string; kind: ModKind }): Promise<{ path: string }> {
    const resolved = this.resolve(input.instanceId)
    const dir = this.kindDir(resolved.gameDir, input.kind)
    this.fs.mkdirp(dir)
    if (!this.options.openPath) {
      fail('MODS.OPEN_FOLDER_UNAVAILABLE', '当前环境不支持打开文件夹')
    }
    const result = await this.options.openPath(dir)
    if (result) fail('MODS.OPEN_FOLDER_FAILED', result, { path: dir })
    return { path: dir }
  }
}

export function createModsService(options: ModsServiceOptions): ModsModuleService {
  return new ModsModuleService(options)
}

// Re-exported for focused tests without exposing the archive implementation broadly.
export { safeEntryPath, readJsonEntry }

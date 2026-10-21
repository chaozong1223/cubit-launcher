import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { AppError } from '@shared/errors'
import type {
  CatalogCheckInput,
  CatalogInstallInput,
  CatalogInstallResult,
  CatalogPageInput,
  CatalogPageResult,
  CatalogProject,
  CatalogRisk,
  CatalogSearchInput,
  CatalogSearchResult,
  CatalogUpdateCheck,
  CatalogUpdateInput,
  CatalogUpdateItem,
  CatalogUpdateResult,
  CatalogVersion,
  CatalogVersionFile,
} from '@shared/catalog'
import type { ModFile, ModsService } from '@shared/mods'
import type { ScopedLogger } from '../../kernel/logger'
import type { ModuleRoots } from '../_context'
import { gameDirectory, readInstanceSettings } from '../../core/instance/settings'
import { scanInstances, type ScannedInstance } from '../../core/instance/scan'
import { nodeFsPort, type FsPort } from '../../core/ports'
import {
  ModrinthClient,
  curseForgePageUrl,
  modrinthPageUrl,
  type ModrinthOptions,
} from './core/modrinth'
import { downloadCatalogFile } from './core/download'

export interface CatalogServiceOptions {
  roots: ModuleRoots
  log: ScopedLogger
  fs?: FsPort
  modrinth?: ModrinthClient
  modrinthOptions?: ModrinthOptions
  /** Lazy: catalog may register before the mods module. */
  mods?: () => ModsService | null
  appVersion?: string
  concurrency?: number
  now?: () => number
  emit?: (event: string, payload: unknown) => void
  openExternal?: (url: string) => Promise<void> | void
  allowInsecureHosts?: string[]
}

interface InstanceInfo {
  instance: ScannedInstance
  gameDir: string
  mcVersion: string | null
  loader: string
  loaderVersion: string | null
}

function fail(code: string, message: string, details?: Record<string, unknown>): never {
  throw new AppError(code, message, details ? { details } : {})
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80) || 'instance'
}

function sha1File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha1')
    const stream = fs.createReadStream(file)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

function summarizeChangelog(value: string | null): string | null {
  if (!value) return null
  const cleaned = value
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#*_>`]/g, '')
    .replace(/\r/g, '')
    .replace(/\n{2,}/g, '\n')
    .trim()
  if (!cleaned) return null
  return cleaned.length > 900 ? `${cleaned.slice(0, 900)}…` : cleaned
}

function chooseFile(version: CatalogVersion): CatalogVersionFile | null {
  const primary = version.files.find((file) => file.primary)
  return primary ?? version.files[0] ?? null
}

function normalizeLoader(value: string | null | undefined): string | null {
  if (!value) return null
  const lower = value.toLowerCase()
  if (lower === 'vanilla' || lower === 'unknown') return null
  return lower
}

function isCompatible(version: CatalogVersion, info: InstanceInfo): { ok: boolean; reason: string | null } {
  if (!info.mcVersion) return { ok: false, reason: '实例缺少 Minecraft 版本，无法判断模组兼容性' }
  const gameOk = version.gameVersions.includes(info.mcVersion)
  const loader = normalizeLoader(info.loader)
  const loaderOk = loader ? version.loaders.includes(loader) : false
  if (!gameOk && !loaderOk) return { ok: false, reason: `版本不支持 MC ${info.mcVersion} / ${loader ?? '未知加载器'}` }
  if (!gameOk) return { ok: false, reason: `版本不支持 MC ${info.mcVersion}` }
  if (!loaderOk) return { ok: false, reason: `版本不支持加载器 ${loader ?? '未知'}` }
  return { ok: true, reason: null }
}

async function recycleFile(dataRoot: string, instanceId: string, source: string): Promise<string> {
  const base = path.join(
    dataRoot,
    'trash',
    'catalog',
    safeSegment(instanceId),
    new Date().toISOString().replace(/[:.]/g, '-'),
  )
  await fsp.mkdir(base, { recursive: true })
  let target = path.join(base, path.basename(source))
  let suffix = 1
  while (fs.existsSync(target)) {
    target = path.join(base, `${path.basename(source)}.${suffix}`)
    suffix += 1
  }
  try {
    await fsp.rename(source, target)
  } catch {
    await fsp.copyFile(source, target)
    await fsp.rm(source, { force: true })
  }
  return target
}

/**
 * Catalog service: Modrinth search/detail/install + update check.
 *
 * CurseForge is intentionally limited to `pageUrl`/`openPage` — no API calls.
 */
export class CatalogModuleService {
  private readonly fs: FsPort
  private readonly client: ModrinthClient
  private readonly mods?: () => ModsService | null
  private readonly concurrency: number
  private readonly now: () => number
  private readonly emit?: (event: string, payload: unknown) => void
  private readonly openExternal?: (url: string) => Promise<void> | void
  private readonly allowInsecureHosts: string[]
  private readonly log: ScopedLogger

  constructor(private readonly options: CatalogServiceOptions) {
    this.fs = options.fs ?? nodeFsPort()
    this.log = options.log
    this.client =
      options.modrinth ??
      new ModrinthClient({
        ...(options.modrinthOptions ?? {}),
        ...(options.appVersion ? { version: options.appVersion } : {}),
        ...(options.allowInsecureHosts ? { allowInsecureHosts: options.allowInsecureHosts } : {}),
      })
    this.mods = options.mods
    this.concurrency = Math.max(1, Math.min(8, options.concurrency ?? 4))
    this.now = options.now ?? Date.now
    this.emit = options.emit
    this.openExternal = options.openExternal
    this.allowInsecureHosts = options.allowInsecureHosts ?? []
  }

  private requireMcRoot(): string {
    if (!this.options.roots.mcRoot) fail('CATALOG.NO_MC_ROOT', '还没有选择 Minecraft 目录')
    return this.options.roots.mcRoot
  }

  private requireMods(): ModsService {
    const mods = this.mods?.() ?? null
    if (!mods) fail('CATALOG.MODS_UNAVAILABLE', '模组模块不可用，无法读取/安装模组')
    return mods
  }

  private resolveInstance(instanceId: string): InstanceInfo {
    const mcRoot = this.requireMcRoot()
    const instance = scanInstances(this.fs, mcRoot).find(
      (entry) => entry.id === instanceId || entry.dirName === instanceId,
    )
    if (!instance) fail('CATALOG.INSTANCE_NOT_FOUND', `找不到实例: ${instanceId}`, { instanceId })
    const settings = readInstanceSettings(this.fs, instance.dir).settings
    const isolation = settings?.isolation ?? instance.isolation
    const loader = settings?.loader ?? instance.loader
    return {
      instance,
      gameDir: gameDirectory(mcRoot, instance.dirName, isolation),
      mcVersion: settings?.mcVersion ?? instance.mcVersion ?? null,
      loader: loader.type,
      loaderVersion: loader.version,
    }
  }

  // ---------------------------------------------------------------- Modrinth

  async search(input: CatalogSearchInput): Promise<CatalogSearchResult> {
    return this.client.search(input)
  }

  async project(input: { idOrSlug: string }): Promise<CatalogProject> {
    return this.client.project(input.idOrSlug)
  }

  async versions(input: { projectId: string; gameVersion?: string; loader?: string }): Promise<CatalogVersion[]> {
    return this.client.versions(input)
  }

  private async resolveVersion(
    projectId: string,
    versionId: string | undefined,
    info: InstanceInfo,
  ): Promise<CatalogVersion> {
    if (versionId) return this.client.version(versionId)
    const loader = normalizeLoader(info.loader)
    const versions = await this.client.versions({
      projectId,
      ...(info.mcVersion ? { gameVersion: info.mcVersion } : {}),
      ...(loader ? { loader } : {}),
    })
    const compatible = versions.filter((version) => isCompatible(version, info).ok)
    if (compatible.length === 0) {
      fail('CATALOG.INCOMPATIBLE', '该项目没有与当前实例兼容的版本', {
        projectId,
        gameVersion: info.mcVersion,
        loader,
      })
    }
    compatible.sort((a, b) => (b.datePublished ?? '').localeCompare(a.datePublished ?? ''))
    return compatible[0]
  }

  private assertInstallable(version: CatalogVersion, info: InstanceInfo, allowPrerelease: boolean): string[] {
    const compatibility = isCompatible(version, info)
    if (!compatibility.ok) {
      fail('CATALOG.INCOMPATIBLE', `该版本与实例不兼容：${compatibility.reason ?? '未知原因'}`, {
        versionId: version.id,
        gameVersion: info.mcVersion,
        loader: info.loader,
      })
    }
    if (version.versionType !== 'release' && !allowPrerelease) {
      fail('CATALOG.PRERELEASE', '该版本是测试版（beta/alpha），需要显式确认', {
        versionId: version.id,
        versionType: version.versionType,
      })
    }
    const warnings: string[] = []
    if (version.versionType === 'beta') warnings.push('这是 beta 版本')
    if (version.versionType === 'alpha') warnings.push('这是 alpha 版本')
    return warnings
  }

  private async downloadVersionFile(
    version: CatalogVersion,
    tempDir: string,
    onProgress: (bytes: number, total: number | null) => void,
  ): Promise<{ file: CatalogVersionFile; tempPath: string; bytes: number; sha1: string; sha512: string }> {
    const file = chooseFile(version)
    if (!file) fail('CATALOG.NO_FILE', '该版本没有可下载文件', { versionId: version.id })
    if (!file.sha1 && !file.sha512) {
      fail('CATALOG.NO_HASH', '该文件没有上游哈希，拒绝安装', { versionId: version.id })
    }
    const safeName = path.basename(file.filename)
    if (!safeName || safeName === '.' || safeName === '..') {
      fail('CATALOG.INVALID_FILE', '下载文件名不合法', { filename: file.filename })
    }
    await fsp.mkdir(tempDir, { recursive: true })
    const tempPath = path.join(tempDir, safeName)
    const result = await downloadCatalogFile({
      http: this.client.httpClient,
      url: file.url,
      dest: tempPath,
      sha1: file.sha1,
      sha512: file.sha512,
      size: file.size,
      allowInsecureHosts: this.allowInsecureHosts,
      onProgress,
    })
    return { file, tempPath, ...result }
  }

  async install(input: CatalogInstallInput): Promise<CatalogInstallResult> {
    const info = this.resolveInstance(input.instanceId)
    const version = await this.resolveVersion(input.projectId, input.versionId, info)
    if (version.projectId !== input.projectId) {
      fail('CATALOG.INVALID_VERSION', '版本不属于该项目', {
        projectId: input.projectId,
        versionId: version.id,
      })
    }
    const warnings = this.assertInstallable(version, info, input.allowPrerelease)
    const tempDir = path.join(this.options.roots.dataRoot, 'tmp', `catalog-${randomUUID()}`)
    try {
      this.emit?.('installProgress', {
        projectId: input.projectId,
        versionId: version.id,
        stage: 'resolve',
        percent: 0,
        bytes: 0,
        totalBytes: 0,
      })
      const downloaded = await this.downloadVersionFile(version, tempDir, (bytes, totalBytes) => {
        this.emit?.('installProgress', {
          projectId: input.projectId,
          versionId: version.id,
          stage: 'download',
          percent: totalBytes && totalBytes > 0 ? Math.min(100, (bytes / totalBytes) * 100) : null,
          bytes,
          totalBytes: totalBytes ?? 0,
        })
      })
      this.emit?.('installProgress', {
        projectId: input.projectId,
        versionId: version.id,
        stage: 'install',
        percent: 95,
        bytes: downloaded.bytes,
        totalBytes: downloaded.bytes,
      })
      const mods = this.requireMods()
      const installed = await mods.installLocalFile({
        instanceId: info.instance.dirName,
        path: downloaded.tempPath,
        kind: 'mods',
      })
      this.emit?.('installProgress', {
        projectId: input.projectId,
        versionId: version.id,
        stage: 'done',
        percent: 100,
        bytes: downloaded.bytes,
        totalBytes: downloaded.bytes,
      })
      return {
        instanceId: info.instance.dirName,
        projectId: input.projectId,
        versionId: version.id,
        filename: downloaded.file.filename,
        targetPath: installed.targetPath,
        sha1: downloaded.sha1,
        sha512: downloaded.sha512,
        size: downloaded.bytes,
        versionType: version.versionType,
        warnings,
      }
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  // -------------------------------------------------------------- update check

  async checkUpdates(input: CatalogCheckInput): Promise<CatalogUpdateCheck> {
    const started = this.now()
    const info = this.resolveInstance(input.instanceId)
    const mods = this.requireMods()
    const jobId = randomUUID()
    const scan = await mods.scan({ instanceId: info.instance.dirName })
    const files = [
      ...scan.files.mods.enabled.map((file) => ({ file, enabled: true })),
      ...(input.includeDisabled
        ? scan.files.mods.disabled.map((file) => ({ file, enabled: false }))
        : []),
    ]
    const updates: CatalogUpdateItem[] = []
    const skipped: CatalogUpdateCheck['skipped'] = []
    const errors: CatalogUpdateCheck['errors'] = []
    let matched = 0
    let done = 0

    const emitProgress = (current: string | null, phase: 'scan' | 'hash' | 'lookup' | 'versions' | 'compare'): void => {
      this.emit?.('checkProgress', {
        jobId,
        done,
        total: files.length,
        currentFile: current,
        phase,
      })
    }
    emitProgress(null, 'scan')

    let cursor = 0
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = cursor
        cursor += 1
        if (index >= files.length) return
        const entry = files[index]
        const file = entry.file
        const filePath = path.join(scan.gameDir, 'mods', file.fileName)
        try {
          emitProgress(file.fileName, 'hash')
          const sha1 = await sha1File(filePath)
          emitProgress(file.fileName, 'lookup')
          const current = await this.client.versionByHash(sha1)
          if (!current) {
            skipped.push({ file: file.fileName, reason: 'Modrinth 未收录该文件哈希' })
            continue
          }
          matched += 1
          emitProgress(file.fileName, 'versions')
          const loader = normalizeLoader(info.loader)
          const versions = await this.client.versions({
            projectId: current.projectId,
            ...(info.mcVersion ? { gameVersion: info.mcVersion } : {}),
            ...(loader ? { loader } : {}),
          })
          const compatible = versions
            .filter((version) => isCompatible(version, info).ok)
            .sort((a, b) => (b.datePublished ?? '').localeCompare(a.datePublished ?? ''))
          const allSorted = [...versions].sort((a, b) =>
            (b.datePublished ?? '').localeCompare(a.datePublished ?? ''),
          )
          const latest = compatible[0] ?? allSorted[0] ?? null
          if (!latest) {
            skipped.push({ file: file.fileName, reason: '项目没有可用版本' })
            continue
          }
          if (latest.id === current.id) {
            skipped.push({ file: file.fileName, reason: '已是最新版本' })
            continue
          }
          if (
            latest.datePublished &&
            current.datePublished &&
            latest.datePublished <= current.datePublished
          ) {
            skipped.push({ file: file.fileName, reason: '没有比当前更新的版本' })
            continue
          }
          const latestFile = chooseFile(latest)
          if (!latestFile) {
            skipped.push({ file: file.fileName, reason: '最新版本没有可下载文件' })
            continue
          }
          const compatibility = isCompatible(latest, info)
          const risk: CatalogRisk = compatibility.ok
            ? latest.versionType === 'release'
              ? 'ok'
              : 'warning'
            : 'blocked'
          const warnings: string[] = []
          if (!compatibility.ok) warnings.push(compatibility.reason ?? '不兼容')
          if (latest.versionType !== 'release') warnings.push(`最新版本是 ${latest.versionType}`)
          updates.push({
            projectId: current.projectId,
            slug: current.projectId,
            title: current.name || file.metadata?.name || file.name,
            currentFile: file.fileName,
            currentEnabled: entry.enabled,
            currentVersionId: current.id,
            currentVersion: current.versionNumber,
            latestVersionId: latest.id,
            latestVersion: latest.versionNumber,
            latestVersionType: latest.versionType,
            changelogSummary: summarizeChangelog(latest.changelog),
            downloadUrl: latestFile.url,
            filename: latestFile.filename,
            sha1: latestFile.sha1,
            sha512: latestFile.sha512,
            size: latestFile.size,
            risk,
            warnings,
            reason: compatibility.reason,
          })
        } catch (error) {
          errors.push({
            file: file.fileName,
            message: error instanceof Error ? error.message : String(error),
          })
        } finally {
          done += 1
          emitProgress(file.fileName, 'compare')
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(this.concurrency, Math.max(1, files.length)) }, worker))
    emitProgress(null, 'compare')

    updates.sort((a, b) => {
      const rank = (risk: CatalogRisk): number => (risk === 'blocked' ? 2 : risk === 'warning' ? 1 : 0)
      return rank(b.risk) - rank(a.risk) || a.title.localeCompare(b.title, 'zh-CN')
    })
    return {
      jobId,
      instanceId: info.instance.dirName,
      mcVersion: info.mcVersion,
      loader: normalizeLoader(info.loader),
      checked: files.length,
      matched,
      updates,
      skipped,
      errors,
      durationMs: this.now() - started,
      checkedAt: this.now(),
    }
  }

  // ------------------------------------------------------------------ update

  private async locateCurrentFile(
    info: InstanceInfo,
    currentFile: string | undefined,
    projectId: string,
  ): Promise<{ path: string; fileName: string; enabled: boolean }> {
    if (currentFile) {
      const fileName = path.basename(currentFile)
      const filePath = path.join(info.gameDir, 'mods', fileName)
      if (!this.fs.exists(filePath)) {
        fail('CATALOG.FILE_NOT_FOUND', `找不到旧文件: ${fileName}`, { file: fileName })
      }
      return { path: filePath, fileName, enabled: !fileName.endsWith('.disabled') }
    }

    const mods = this.requireMods()
    const scan = await mods.scan({ instanceId: info.instance.dirName })
    for (const entry of [...scan.files.mods.enabled, ...scan.files.mods.disabled]) {
      const filePath = path.join(scan.gameDir, 'mods', entry.fileName)
      try {
        const sha1 = await sha1File(filePath)
        const version = await this.client.versionByHash(sha1)
        if (version?.projectId === projectId) {
          return { path: filePath, fileName: entry.fileName, enabled: !entry.fileName.endsWith('.disabled') }
        }
      } catch {
        // Skip unreadable/unknown files; the caller can pass currentFile.
      }
    }
    fail('CATALOG.CURRENT_FILE_REQUIRED', '找不到该项目的已装文件，请从更新列表选择', { projectId })
  }

  async update(input: CatalogUpdateInput): Promise<CatalogUpdateResult> {
    const info = this.resolveInstance(input.instanceId)
    const version = await this.client.version(input.versionId)
    if (version.projectId !== input.projectId) {
      fail('CATALOG.INVALID_VERSION', '版本不属于该项目', {
        projectId: input.projectId,
        versionId: input.versionId,
      })
    }
    const warnings = this.assertInstallable(version, info, input.allowPrerelease)
    const current = await this.locateCurrentFile(info, input.currentFile, input.projectId)
    const tempDir = path.join(this.options.roots.dataRoot, 'tmp', `catalog-${randomUUID()}`)
    let installedPath: string | null = null
    try {
      const downloaded = await this.downloadVersionFile(version, tempDir, (bytes, totalBytes) => {
        this.emit?.('installProgress', {
          projectId: input.projectId,
          versionId: version.id,
          stage: 'download',
          percent: totalBytes && totalBytes > 0 ? Math.min(100, (bytes / totalBytes) * 100) : null,
          bytes,
          totalBytes: totalBytes ?? 0,
        })
      })
      const mods = this.requireMods()
      const installed = await mods.installLocalFile({
        instanceId: info.instance.dirName,
        path: downloaded.tempPath,
        kind: 'mods',
      })
      installedPath = installed.targetPath
      if (!current.enabled && !installedPath.endsWith('.disabled')) {
        const disabledPath = `${installedPath}.disabled`
        await fsp.rename(installedPath, disabledPath)
        installedPath = disabledPath
      }
      const recycledPath =
        path.resolve(current.path) === path.resolve(installedPath)
          ? null
          : await recycleFile(this.options.roots.dataRoot, info.instance.dirName, current.path)
      this.emit?.('updated', {
        instanceId: info.instance.dirName,
        projectId: input.projectId,
        versionId: version.id,
        recycledPath,
      })
      this.emit?.('installProgress', {
        projectId: input.projectId,
        versionId: version.id,
        stage: 'done',
        percent: 100,
        bytes: downloaded.bytes,
        totalBytes: downloaded.bytes,
      })
      return {
        instanceId: info.instance.dirName,
        projectId: input.projectId,
        versionId: version.id,
        filename: downloaded.file.filename,
        targetPath: installedPath,
        sha1: downloaded.sha1,
        sha512: downloaded.sha512,
        size: downloaded.bytes,
        versionType: version.versionType,
        warnings,
        recycledPath,
        previousFile: current.fileName,
      }
    } catch (error) {
      if (installedPath) {
        await fsp.rm(installedPath, { force: true }).catch(() => undefined)
        const disabled = `${installedPath}.disabled`
        await fsp.rm(disabled, { force: true }).catch(() => undefined)
      }
      throw error
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  // ------------------------------------------------------------------- pages

  private pageFor(input: CatalogPageInput): string {
    const slug = input.slug.trim()
    if (!slug) fail('CATALOG.INVALID_INPUT', '项目 slug 不能为空')
    if (input.provider === 'curseforge') return curseForgePageUrl(slug)
    return modrinthPageUrl('mod', slug)
  }

  async pageUrl(input: CatalogPageInput): Promise<CatalogPageResult> {
    return { provider: input.provider, url: this.pageFor(input), opened: false }
  }

  async openPage(input: CatalogPageInput): Promise<CatalogPageResult> {
    const url = this.pageFor(input)
    if (!this.openExternal) {
      return { provider: input.provider, url, opened: false }
    }
    await this.openExternal(url)
    return { provider: input.provider, url, opened: true }
  }
}

export function createCatalogService(options: CatalogServiceOptions): CatalogModuleService {
  return new CatalogModuleService(options)
}

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
  CurseForgeConfigPatch,
  CurseForgeConfigView,
  LinkDownloadState,
  LinkImportFinished,
  LinkImportInput,
  LinkImportJobStart,
  LinkImportProgress,
  LinkImportStart,
  PackLinkPlan,
} from '@shared/catalog'
import type { ModFile, ModsService } from '@shared/mods'
import type { ScopedLogger } from '../../kernel/logger'
import type { ModuleRoots } from '../_context'
import { gameDirectory, readInstanceSettings } from '../../core/instance/settings'
import { scanInstances, type ScannedInstance } from '../../core/instance/scan'
import { nodeFsPort, type FsPort } from '../../core/ports'
import { JobRegistry, type JobOutcome } from '../../core/job/kernel'
import {
  CurseForgeClient,
  chooseLatestPackFile,
  type CfFile,
  type CfProject,
} from '../../core/curseforge/client'
import {
  loadCurseForgeConfig,
  loadStoredCurseForgeConfig,
  maskCurseForgeConfig,
  normalizeMirrorBase,
  saveCurseForgeConfig,
  type CurseForgeConfig,
} from '../../core/curseforge/settings'
import { buildUserAgent } from '../download/core/sources'
import {
  ModrinthClient,
  curseForgePageUrl,
  modrinthPageUrl,
  type ModrinthOptions,
} from './core/modrinth'
import { downloadCatalogFile } from './core/download'
import { parsePackLink, type ParsedPackLink } from './core/link'

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
  userAgent?: string
  /** Test seam: build the CurseForge client for a config snapshot. */
  curseForgeClientFactory?: (config: CurseForgeConfig) => CurseForgeClient
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

/** Newest release wins; prereleases are only used when no release exists. */
function chooseModrinthVersion(versions: CatalogVersion[]): CatalogVersion | null {
  if (versions.length === 0) return null
  const releases = versions.filter((version) => version.versionType === 'release')
  const pool = releases.length > 0 ? releases : versions
  return (
    [...pool].sort((left, right) =>
      (right.datePublished ?? '').localeCompare(left.datePublished ?? ''),
    )[0] ?? null
  )
}

function safePackFileName(input: string): string {
  const base = path.basename(input.replaceAll('\\', '/'))
  const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120)
  return cleaned || 'modpack.zip'
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

const LINK_PLAN_TTL_MS = 10 * 60 * 1000
const MAX_PACK_ARCHIVE_BYTES = 1024 * 1024 * 1024
const MODRINTH_DOWNLOAD_HOSTS = ['cdn.modrinth.com', '*.modrinth.com']
const CURSEFORGE_DOWNLOAD_HOSTS = [
  '*.forgecdn.net',
  'edge.forgecdn.net',
  'mediafilez.forgecdn.net',
  '*.curseforge.com',
]

/** In-memory only (no CurseForge metadata cache on disk, docs/02 API-12/19). */
interface StoredLinkPlan {
  plan: PackLinkPlan
  downloadUrl: string | null
  fileName: string
  size: number | null
  sha1: string | null
  sha256: string | null
  sha512: string | null
  allowedHosts: string[]
  createdAt: number
}

/**
 * Catalog service: Modrinth search/detail/install + update check + link import.
 *
 * CurseForge API access is user-keyed (docs/02 API-07..22): the key is read from
 * the main-process settings file, sent only as a header, and the official API
 * is preferred over an optional user mirror.
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
  private readonly userAgent: string
  private readonly linkPlans = new Map<string, StoredLinkPlan>()
  private readonly linkJobs = new JobRegistry<LinkImportStart>()

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
    this.userAgent =
      options.userAgent ?? buildUserAgent({ version: options.appVersion ?? '0.1.0' })
    this.linkJobs.onProgress((progress, job) => {
      const stage = progress.stage
      const state: LinkDownloadState =
        job.state === 'cancelled'
          ? 'cancelled'
          : job.state === 'done'
            ? 'done'
            : stage === 'verifying' || stage === 'importing'
              ? stage
              : 'downloading'
      this.emit?.('linkDownloadProgress', {
        ...progress,
        phase: progress.stage,
        files: progress.done,
        totalFiles: progress.total,
        bytes: progress.bytesDone,
        totalBytes: progress.bytesTotal,
        planId: job.meta.planId ?? '',
        provider: (job.meta.provider === 'curseforge' ? 'curseforge' : 'modrinth') as
          | 'modrinth'
          | 'curseforge',
        state,
      })
    })
    this.linkJobs.onFinished((outcome, job) => {
      const progress = job.progress()
      const finalState: LinkDownloadState =
        outcome.state === 'cancelled'
          ? 'cancelled'
          : outcome.state === 'done'
            ? 'done'
            : progress.stage === 'verifying' || progress.stage === 'importing'
              ? progress.stage
              : 'downloading'
      this.emit?.('linkDownloadProgress', {
        ...progress,
        phase: progress.stage,
        files: progress.done,
        totalFiles: progress.total,
        bytes: progress.bytesDone,
        totalBytes: progress.bytesTotal,
        planId: job.meta.planId ?? '',
        provider: (job.meta.provider === 'curseforge' ? 'curseforge' : 'modrinth') as
          | 'modrinth'
          | 'curseforge',
        state: finalState,
      })
      this.emit?.('linkImportFinished', {
        jobId: outcome.jobId,
        state: outcome.state,
        ok: outcome.ok,
        error: outcome.error,
        durationMs: outcome.durationMs,
        planId: job.meta.planId ?? '',
        provider: (job.meta.provider === 'curseforge' ? 'curseforge' : 'modrinth') as
          | 'modrinth'
          | 'curseforge',
        result: outcome.result,
      })
    })
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
      // Route the file into the folder that matches the project type; the mods
      // module already supports all three kinds, only this call was hardcoded.
      const project = await this.client.project(version.projectId)
      if (project.projectType === 'modpack') {
        // Modpacks are a whole game profile, not one file: hand the archive to
        // the importer, which creates a new instance (PCL/HMCL behave the same).
        const started = await mods.importModpack({ filePath: downloaded.tempPath })
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
          targetPath: '',
          sha1: downloaded.sha1,
          sha512: downloaded.sha512,
          size: downloaded.bytes,
          versionType: version.versionType,
          warnings,
          modpackImport: {
            jobId: started.jobId,
            instanceId: started.instanceId,
            name: started.name,
            totalFiles: started.totalFiles,
            needsBaseInstall: started.needsBaseInstall,
          },
        }
      }
      const kind: 'mods' | 'resourcepacks' | 'shaderpacks' | 'datapacks' =
        project.projectType === 'resourcepack'
          ? 'resourcepacks'
          : project.projectType === 'shader'
            ? 'shaderpacks'
            : project.projectType === 'datapack'
              ? 'datapacks'
              : 'mods'
      const installed = await mods.installLocalFile({
        instanceId: info.instance.dirName,
        path: downloaded.tempPath,
        kind,
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

  /**
   * MC百科 lookup. The host is fixed here, so a project name can never make the
   * launcher open an arbitrary URL.
   */
  async openWiki(input: { query: string }): Promise<{ url: string; opened: boolean }> {
    const query = input.query.trim()
    if (!query) fail('CATALOG.INVALID_INPUT', '搜索词不能为空')
    const url = `https://www.mcmod.cn/s?key=${encodeURIComponent(query)}`
    if (!this.openExternal) {
      this.log.warn('openWiki: no external opener wired', { url })
      return { url, opened: false }
    }
    try {
      await this.openExternal(url)
      this.log.info('openWiki: external open requested', { url })
      return { url, opened: true }
    } catch (error) {
      this.log.error('openWiki: external open failed', {
        url,
        message: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
  }

  async openPage(input: CatalogPageInput): Promise<CatalogPageResult> {
    const url = this.pageFor(input)
    if (!this.openExternal) {
      this.log.warn('openPage: no external opener wired', { url })
      return { provider: input.provider, url, opened: false }
    }
    try {
      await this.openExternal(url)
      this.log.info('openPage: external open requested', { provider: input.provider, url })
      return { provider: input.provider, url, opened: true }
    } catch (error) {
      // shell.openExternal rejects when the OS has no handler for the scheme.
      this.log.error('openPage: external open failed', {
        url,
        message: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
  }

  // ------------------------------------------------------- CurseForge config

  private curseForgeStoreOptions(): {
    log: { info: (message: string, fields?: Record<string, unknown>) => void; warn: (message: string, fields?: Record<string, unknown>) => void }
  } {
    return {
      log: {
        info: (message, fields) => this.log.info(message, fields),
        warn: (message, fields) => this.log.warn(message, fields),
      },
    }
  }

  async getCurseForgeConfig(): Promise<CurseForgeConfigView> {
    // The key itself never leaves the main process. Loading may migrate a
    // legacy plaintext key to safeStorage (logged without the value).
    const state = await loadCurseForgeConfig(
      this.options.roots.dataRoot,
      this.curseForgeStoreOptions(),
    )
    return maskCurseForgeConfig(state)
  }

  async updateCurseForgeConfig(patch: CurseForgeConfigPatch): Promise<CurseForgeConfigView> {
    const current = await loadStoredCurseForgeConfig(
      this.options.roots.dataRoot,
      this.curseForgeStoreOptions(),
    )
    let apiKey = current.apiKey
    if (patch.clearApiKey === true) {
      apiKey = null
    } else if (patch.apiKey !== undefined) {
      apiKey = patch.apiKey === null ? null : patch.apiKey.trim() || null
    }
    if (apiKey && (apiKey.length > 512 || /\s/.test(apiKey))) {
      fail('CATALOG.CF_KEY_INVALID', 'CurseForge API key 格式不正确', {
        hint: '请粘贴官方 API key，不要包含空白字符。',
      })
    }
    let mirrorBase = current.mirrorBase
    if (patch.mirrorBase !== undefined) {
      mirrorBase = normalizeMirrorBase(patch.mirrorBase, {
        allowInsecureHosts: this.allowInsecureHosts,
      })
    }
    const state = await saveCurseForgeConfig(
      this.options.roots.dataRoot,
      { apiKey, mirrorBase },
      {
        ...this.curseForgeStoreOptions(),
        preserveEncryptedKey:
          patch.apiKey === undefined &&
          patch.clearApiKey !== true &&
          current.apiKey === null &&
          current.encryptedOnDisk,
      },
    )
    this.log.info('curseforge config updated', {
      hasApiKey: Boolean(apiKey),
      mirrorConfigured: Boolean(mirrorBase),
      apiKeyChanged: patch.apiKey !== undefined || patch.clearApiKey === true,
      secureStorageAvailable: state.secureStorageAvailable,
      persisted: state.persisted,
    })
    return maskCurseForgeConfig(state)
  }

  // ------------------------------------------------------------- link import

  private curseForgeClient(config: CurseForgeConfig): CurseForgeClient {
    const factory = this.options.curseForgeClientFactory
    if (factory) return factory(config)
    return new CurseForgeClient({
      config,
      userAgent: this.userAgent,
      allowInsecureHosts: this.allowInsecureHosts,
      log: {
        debug: (message, fields) => this.log.debug(message, fields),
        warn: (message, fields) => this.log.warn(message, fields),
      },
    })
  }

  private pruneLinkPlans(): void {
    const cutoff = this.now() - LINK_PLAN_TTL_MS
    for (const [planId, record] of this.linkPlans) {
      if (record.createdAt < cutoff) this.linkPlans.delete(planId)
    }
  }

  private async prunePackDownloads(dir: string): Promise<void> {
    const cutoff = this.now() - 7 * 24 * 60 * 60 * 1000
    try {
      for (const name of await fsp.readdir(dir)) {
        const target = path.join(dir, name)
        try {
          const stat = await fsp.stat(target)
          if (stat.isFile() && stat.mtimeMs < cutoff) await fsp.rm(target, { force: true })
        } catch {
          /* a file removed concurrently is fine */
        }
      }
    } catch {
      /* missing packs dir is fine */
    }
  }

  /** Resolves the link without downloading anything (confirmation step). */
  async planLinkImport(input: { link: string }): Promise<PackLinkPlan> {
    this.pruneLinkPlans()
    const parsed = parsePackLink(input.link)
    return parsed.provider === 'modrinth'
      ? this.planModrinthLink(parsed)
      : this.planCurseForgeLink(parsed)
  }

  private async planModrinthLink(parsed: ParsedPackLink): Promise<PackLinkPlan> {
    const project = await this.client.project(parsed.slug)
    if (project.projectType !== 'modpack') {
      fail('CATALOG.LINK_UNSUPPORTED', '这个 Modrinth 项目不是整合包', {
        projectType: project.projectType,
      })
    }
    let version: CatalogVersion | null = null
    const warnings: string[] = []
    if (parsed.versionId) {
      version = await this.client.version(parsed.versionId)
      if (version.projectId !== project.id) {
        fail('CATALOG.LINK_INVALID', '链接中的版本不属于该整合包', {
          versionId: parsed.versionId,
          projectId: project.id,
        })
      }
    } else {
      version = chooseModrinthVersion(await this.client.versions({ projectId: project.id }))
      if (!version) fail('CATALOG.LINK_NOT_FOUND', '该整合包没有可导入的版本')
    }
    if (version.versionType !== 'release') {
      warnings.push(`所选版本是 ${version.versionType} 测试版，可能不稳定。`)
    }
    const file = version.files.find((entry) => entry.primary) ?? version.files[0]
    if (!file?.url) fail('CATALOG.LINK_NO_FILE', '该版本没有可下载的整合包文件')
    const planId = randomUUID()
    const pageUrl = project.pageUrl || `https://modrinth.com/modpack/${parsed.slug}`
    let canProceed = true
    let reason: string | null = null
    let downloadHost: string | null = null
    try {
      const url = new URL(file.url)
      downloadHost = url.hostname
      if (url.protocol !== 'https:' && !this.allowInsecureHosts.includes(url.hostname)) {
        canProceed = false
        reason = 'CATALOG.UNSAFE_URL'
      }
    } catch {
      canProceed = false
      reason = 'CATALOG.UNSAFE_URL'
    }
    const plan: PackLinkPlan = {
      planId,
      provider: 'modrinth',
      slug: parsed.slug,
      projectTitle: project.title,
      pageUrl,
      versionId: version.id,
      versionName: version.name,
      fileId: null,
      fileName: file.filename,
      fileSize: file.size,
      downloadHost,
      requiresApiKey: false,
      apiKeyConfigured: false,
      mirrorConfigured: false,
      apiSourceHost: null,
      canProceed,
      reason,
      warnings,
    }
    if (canProceed) {
      this.linkPlans.set(planId, {
        plan,
        downloadUrl: file.url,
        fileName: file.filename,
        size: file.size > 0 ? file.size : null,
        sha1: file.sha1,
        sha256: null,
        sha512: file.sha512,
        allowedHosts: [...MODRINTH_DOWNLOAD_HOSTS, ...this.allowInsecureHosts],
        createdAt: this.now(),
      })
    } else {
      this.linkPlans.set(planId, {
        plan,
        downloadUrl: null,
        fileName: file.filename,
        size: file.size > 0 ? file.size : null,
        sha1: file.sha1,
        sha256: null,
        sha512: file.sha512,
        allowedHosts: [...MODRINTH_DOWNLOAD_HOSTS, ...this.allowInsecureHosts],
        createdAt: this.now(),
      })
    }
    return plan
  }

  private async planCurseForgeLink(parsed: ParsedPackLink): Promise<PackLinkPlan> {
    const config = await loadCurseForgeConfig(
      this.options.roots.dataRoot,
      this.curseForgeStoreOptions(),
    )
    const planId = randomUUID()
    const base: PackLinkPlan = {
      planId,
      provider: 'curseforge',
      slug: parsed.slug,
      projectTitle: parsed.slug,
      pageUrl: parsed.pageUrl,
      versionId: null,
      versionName: null,
      fileId: null,
      fileName: null,
      fileSize: null,
      downloadHost: null,
      requiresApiKey: true,
      apiKeyConfigured: Boolean(config.apiKey),
      mirrorConfigured: Boolean(config.mirrorBase),
      apiSourceHost: null,
      canProceed: false,
      reason: null,
      warnings: [],
    }
    if (!config.apiKey) {
      const plan: PackLinkPlan = {
        ...base,
        reason: 'CATALOG.CF_KEY_MISSING',
        warnings: [
          'CurseForge 导入需要自备 CurseForge API key：请到设置页填入后重试。key 只保存在本机主进程，仅作为请求头发送给 API 域名，不会写入日志、URL 或分享包。',
        ],
      }
      this.linkPlans.set(planId, {
        plan,
        downloadUrl: null,
        fileName: base.slug,
        size: null,
        sha1: null,
        sha256: null,
        sha512: null,
        allowedHosts: [...CURSEFORGE_DOWNLOAD_HOSTS, ...this.allowInsecureHosts],
        createdAt: this.now(),
      })
      return plan
    }

    const client = this.curseForgeClient(config)
    const project = await client.searchModpacks(parsed.slug)
    if (!project) {
      fail('CATALOG.LINK_NOT_FOUND', `CurseForge 上找不到整合包「${parsed.slug}」`)
    }
    let file: CfFile | null
    if (parsed.fileId !== null) {
      file = await client.file(project.id, parsed.fileId)
      if (file.modId !== project.id) {
        fail('CATALOG.LINK_INVALID', '链接中的文件不属于该整合包', {
          projectId: project.id,
          fileId: parsed.fileId,
        })
      }
    } else {
      file = chooseLatestPackFile(await client.files(project.id))
    }
    if (!file) fail('CATALOG.LINK_NOT_FOUND', '该整合包没有可导入的文件')
    const pageUrl = project.websiteUrl ?? parsed.pageUrl
    const warnings: string[] = []
    let canProceed = true
    let reason: string | null = null
    let downloadHost: string | null = null
    if (!file.downloadUrl) {
      canProceed = false
      reason = 'CATALOG.CF_DISTRIBUTION_DISABLED'
      warnings.push(
        `作者关闭了第三方分发（downloadUrl 为 null），无法直接下载。请打开项目页手动下载后再本地导入：${pageUrl}`,
      )
    } else {
      try {
        const url = new URL(file.downloadUrl)
        downloadHost = url.hostname
        if (url.protocol !== 'https:' && !this.allowInsecureHosts.includes(url.hostname)) {
          canProceed = false
          reason = 'CATALOG.UNSAFE_URL'
        }
      } catch {
        canProceed = false
        reason = 'CATALOG.UNSAFE_URL'
      }
      // docs/02 API-11: third-party downloads do not count towards author revenue.
      warnings.push('CurseForge 第三方下载不计入作者收益，建议支持作者。')
    }
    const plan: PackLinkPlan = {
      ...base,
      projectTitle: project.name,
      pageUrl,
      versionName: file.displayName,
      fileId: file.id,
      fileName: file.fileName,
      fileSize: file.fileLength,
      downloadHost,
      apiSourceHost: client.lastSourceHost,
      canProceed,
      reason,
      warnings,
    }
    this.linkPlans.set(planId, {
      plan,
      downloadUrl: file.downloadUrl ?? null,
      fileName: file.fileName,
      size:
        canProceed && file.fileLength && file.fileLength > 0 ? file.fileLength : null,
      sha1: file.hashes.sha1 ?? null,
      sha256: file.hashes.sha256 ?? null,
      sha512: null,
      allowedHosts: [
        ...CURSEFORGE_DOWNLOAD_HOSTS,
        ...this.allowInsecureHosts,
        ...(config.mirrorBase
          ? (() => {
              try {
                return [new URL(config.mirrorBase).hostname]
              } catch {
                return []
              }
            })()
          : []),
      ],
      createdAt: this.now(),
    })
    return plan
  }

  /**
   * Starts the confirmed download + mods handoff as a cancellable catalog job.
   * Progress follows t11's FileJobProgress shape; cancel deletes `.part` files
   * and any downloaded archive that was never handed off or whose import was
   * cancelled.
   */
  startLinkImport(input: LinkImportInput): LinkImportJobStart {
    if (!input.confirm) {
      fail('CATALOG.CONFIRMATION_REQUIRED', '下载整合包前需要用户确认', {
        hint: '先展示 planLinkImport 的结果，用户确认后再调用 startLinkImport。',
      })
    }
    this.pruneLinkPlans()
    const record = this.linkPlans.get(input.planId)
    if (!record) fail('CATALOG.PLAN_EXPIRED', '导入计划已过期，请重新解析链接')
    this.linkPlans.delete(input.planId)
    if (!record.plan.canProceed) {
      fail(record.plan.reason ?? 'CATALOG.LINK_NOT_IMPORTABLE', record.plan.warnings[0] ?? '该链接无法直接导入')
    }
    if (!record.downloadUrl) {
      fail('CATALOG.LINK_NOT_IMPORTABLE', '该链接没有可下载的整合包文件')
    }
    const downloadUrl = record.downloadUrl
    const mods = this.requireMods()
    const planId = record.plan.planId
    const provider = record.plan.provider
    const packsDir = path.join(this.options.roots.dataRoot, 'modules', 'catalog', 'packs')
    const fileName = safePackFileName(record.fileName)
    const jobId = randomUUID()
    let destPath: string | null = null
    let modsJobId: string | null = null
    this.linkJobs.start(
      {
        id: jobId,
        stage: 'downloading',
        total: 1,
        bytesTotal: record.size ?? 0,
        meta: { planId, provider },
      },
      async (job) => {
        await fsp.mkdir(packsDir, { recursive: true })
        await this.prunePackDownloads(packsDir)
        destPath = path.join(packsDir, `${planId}-${fileName}`)
        try {
          const downloaded = await downloadCatalogFile({
            http: this.client.httpClient,
            url: downloadUrl,
            dest: destPath,
            ...(record.sha1 ? { sha1: record.sha1 } : {}),
            ...(record.sha256 ? { sha256: record.sha256 } : {}),
            ...(record.sha512 ? { sha512: record.sha512 } : {}),
            ...(record.size !== null ? { size: record.size } : {}),
            maxBytes: MAX_PACK_ARCHIVE_BYTES,
            allowedHosts: record.allowedHosts,
            allowInsecureHosts: this.allowInsecureHosts,
            signal: job.signal,
            onProgress: (bytes, totalBytes) => {
              job.update({
                stage: 'downloading',
                done: 0,
                total: 1,
                bytesDone: bytes,
                bytesTotal: totalBytes ?? record.size ?? 0,
                currentFile: fileName,
              })
            },
          })
          job.throwIfCancelled()
          job.update({
            stage: 'verifying',
            done: 1,
            total: 1,
            bytesDone: downloaded.bytes,
            bytesTotal: downloaded.bytes,
            currentFile: fileName,
          })
          job.throwIfCancelled()
          job.update({
            stage: 'importing',
            done: 1,
            total: 1,
            bytesDone: downloaded.bytes,
            bytesTotal: downloaded.bytes,
            currentFile: fileName,
          })
          const start = await mods.importModpack({ filePath: destPath })
          modsJobId = start.jobId
          job.throwIfCancelled()
          this.log.info('pack link imported', {
            provider,
            slug: record.plan.slug,
            versionId: record.plan.versionId,
            fileId: record.plan.fileId,
            bytes: downloaded.bytes,
            jobId: start.jobId,
          })
          return {
            provider,
            planId,
            packPath: destPath,
            downloadBytes: downloaded.bytes,
            import: start,
          }
        } catch (error) {
          if (modsJobId) {
            await mods.cancelImport(modsJobId).catch(() => undefined)
          }
          throw error
        }
      },
      {
        failureCode: 'CATALOG.LINK_IMPORT_FAILED',
        cleanup: async () => {
          if (modsJobId) {
            await mods.cancelImport(modsJobId).catch(() => undefined)
          }
          if (!destPath) return
          await fsp.rm(destPath, { force: true }).catch(() => undefined)
          await fsp.rm(`${destPath}.part`, { force: true }).catch(() => undefined)
        },
      },
    )
    return { jobId, planId, provider }
  }

  cancelLinkImport(jobId: string): { cancelled: boolean } {
    return { cancelled: this.linkJobs.cancel(jobId) }
  }

  linkImportStatus(jobId: string): LinkImportProgress | null {
    const progress = this.linkJobs.status(jobId)
    if (!progress) return null
    const meta = this.linkJobs.meta(jobId) ?? {}
    return {
      ...progress,
      phase: progress.stage,
      files: progress.done,
      totalFiles: progress.total,
      bytes: progress.bytesDone,
      totalBytes: progress.bytesTotal,
      planId: meta.planId ?? '',
      provider: (meta.provider === 'curseforge' ? 'curseforge' : 'modrinth') as
        | 'modrinth'
        | 'curseforge',
    }
  }

  linkImportResult(jobId: string): LinkImportFinished | null {
    const outcome = this.linkJobs.outcome(jobId)
    if (!outcome) return null
    const meta = this.linkJobs.meta(jobId) ?? {}
    return {
      jobId: outcome.jobId,
      state: outcome.state,
      ok: outcome.ok,
      error: outcome.error,
      durationMs: outcome.durationMs,
      planId: meta.planId ?? '',
      provider: (meta.provider === 'curseforge' ? 'curseforge' : 'modrinth') as
        | 'modrinth'
        | 'curseforge',
      result: outcome.result,
    }
  }

  /** Test seam: waits for a link job to finish. */
  waitForLinkImport(jobId: string, timeoutMs?: number): Promise<JobOutcome<LinkImportStart>> {
    return this.linkJobs.waitFor(jobId, timeoutMs)
  }
}

export function createCatalogService(options: CatalogServiceOptions): CatalogModuleService {
  return new CatalogModuleService(options)
}

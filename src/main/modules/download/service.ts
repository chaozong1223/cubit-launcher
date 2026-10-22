import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type {
  DownloadFinished,
  DownloadProgress,
  DownloadSettings,
  DownloadSettingsPatch,
  DownloadSourcesResult,
  DownloadStage,
  DownloadTask,
  InstallPlanSummary,
  InstallResult,
  ManifestResult,
  ModProviderInfo,
  ProviderId,
  RepairResult,
} from '@shared/download'
import type { ScopedLogger } from '../../kernel/logger'
import type { ModuleRoots } from '../_context'
import { DownloadError, asDownloadError } from './core/errors'
import {
  acquireJobLock,
  freeSpaceBytes,
  readTextFile,
  statOrNull,
  writeTextAtomic,
  type JobLockHandle,
} from './core/fs-atomic'
import { HttpClient, type HttpLogger } from './core/http'
import {
  DownloadEventBus,
  DownloadJob,
  JobProgressEmitter,
  type FinishedListener,
  type ProgressListener,
} from './core/job'
import {
  fetchAssetIndex,
  fetchVersionJson,
  findManifestVersion,
  loadManifest,
  parseAssetIndex,
  parseVersionJsonText,
  type AssetIndexJson,
  type ManifestEntry,
  type ManifestJson,
} from './core/manifest'
import {
  buildInstallPlan,
  type PlannedTask,
  type PlanBuildResult,
  type TaskLabel,
} from './core/plan'
import { runTasks, type QueueLogger } from './core/queue'
import {
  createSourceRegistry,
  type SourceRegistry,
} from './core/sources'
import {
  loadDownloadSettings,
  mergeDownloadSettings,
  moduleCacheDirectory,
  moduleLockFile,
  saveDownloadSettings,
} from './core/settings'
import { createModProviderRegistry, type ModProviderRegistry } from './providers/registry'
import type { VersionJson } from '../../core/version/types'

/**
 * `DownloadService` — the install chain's façade (docs/03 §6.3, §12.4).
 *
 * No Electron import: the IPC adapter lives in `ipc.ts`, so this file (and the
 * whole core) can be unit-tested in plain Node. Long jobs are started in the
 * background; callers get a `jobId` and progress through the event bus.
 */

export const MIN_FREE_DISK_BYTES = 1.5 * 1024 * 1024 * 1024

const STAGE_BY_LABEL: Record<TaskLabel, DownloadStage> = {
  'version-json': 'version-json',
  'asset-index': 'assets-index',
  client: 'client',
  library: 'libraries',
  logging: 'logging',
  asset: 'assets',
}

interface JobHandle {
  job: DownloadJob
  controller: AbortController
  paused: boolean
  emitter: JobProgressEmitter
  finished: Promise<void>
  resolveFinished: () => void
  mode: 'install' | 'repair' | 'batch'
  lock: JobLockHandle | null
}

export interface DownloadServiceOptions {
  roots: ModuleRoots
  log: ScopedLogger
  appVersion: string
  now?: () => number
  http?: HttpClient
  sources?: SourceRegistry
  /** Test seam: local manifest endpoints for the integration test. */
  manifestUrls?: { official: string; mirror: string }
  /** Test seam / self-hosted assets; defaults to Mojang's asset CDN. */
  assetBaseUrl?: string
  /** Test seam: let tests fake the amount of free disk. */
  freeSpace?: (dir: string) => Promise<number | null>
}

export interface DownloadServiceInternals {
  /** Waits for a job to leave `queued/running/paused` (tests + t11 wiring). */
  waitForJob(jobId: string, timeoutMs?: number): Promise<DownloadProgress>
}

function httpLogger(log: ScopedLogger): HttpLogger {
  return {
    debug: (message, fields) => log.debug(message, fields),
    warn: (message, fields) => log.warn(message, fields),
  }
}

function queueLogger(log: ScopedLogger): QueueLogger {
  return {
    debug: (message, fields) => log.debug(message, fields),
    info: (message, fields) => log.info(message, fields),
    warn: (message, fields) => log.warn(message, fields),
    error: (message, fields) => log.error(message, fields),
  }
}

function sumSizes(tasks: DownloadTask[]): number {
  return tasks.reduce((total, task) => total + (task.size ?? 0), 0)
}

/** H6: one entry per destination, so loader batches cannot duplicate a file. */
function dedupeDownloadTasks(tasks: DownloadTask[]): DownloadTask[] {
  const seen = new Set<string>()
  const unique: DownloadTask[] = []
  for (const task of tasks) {
    const key = task.destRel.replace(/\\/g, '/').toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(task)
  }
  return unique
}

export class DownloadService {
  private settings: DownloadSettings
  private http: HttpClient
  private sources: SourceRegistry
  private providers: ModProviderRegistry
  private readonly jobs = new Map<string, JobHandle>()
  private readonly bus = new DownloadEventBus()
  private readonly log: ScopedLogger
  private lastManifestWarnings: string[] = []
  private readonly now: () => number
  private readonly freeSpace: (dir: string) => Promise<number | null>

  /**
   * Fetch an arbitrary HTTPS file into a user-chosen directory ("download custom
   * file"). HTTPS only, streamed to disk through a .part file, no in-memory copy.
   */
  async downloadCustomFile(input: { url: string; saveDir: string; fileName?: string }) {
    let parsed: URL
    try {
      parsed = new URL(input.url)
    } catch {
      throw new DownloadError('DOWNLOAD.INSECURE_URL', { message: `下载地址无效：${input.url}` })
    }
    if (parsed.protocol !== 'https:') {
      throw new DownloadError('DOWNLOAD.INSECURE_URL', { message: '只支持 https 下载地址' })
    }
    const saveDir = path.resolve(input.saveDir)
    await fs.promises.mkdir(saveDir, { recursive: true })
    const baseName = input.fileName?.trim() || decodeURIComponent(parsed.pathname.split('/').pop() ?? '')
    const fileName = (baseName || `download-${Date.now()}`)
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
      .slice(0, 180)
    const target = path.join(saveDir, fileName)
    const part = `${target}.part`
    let response: Response
    try {
      response = await fetch(parsed, { redirect: 'follow' })
    } catch (cause) {
      throw new DownloadError('DOWNLOAD.NETWORK_UNREACHABLE', {
        message: `连接失败：${cause instanceof Error ? cause.message : String(cause)}`,
      })
    }
    if (!response.ok || !response.body) {
      throw new DownloadError('DOWNLOAD.HTTP_ERROR', { message: `下载失败 HTTP ${response.status}` })
    }
    try {
      await pipeline(Readable.fromWeb(response.body as never), fs.createWriteStream(part))
      const stat = await fs.promises.stat(part)
      await fs.promises.rename(part, target)
      this.log.info('custom file downloaded', { host: parsed.host, bytes: stat.size })
      return { path: target, bytes: stat.size, fileName }
    } catch (cause) {
      await fs.promises.rm(part, { force: true }).catch(() => undefined)
      throw new DownloadError('DOWNLOAD.HTTP_ERROR', {
        message: `写入失败：${cause instanceof Error ? cause.message : String(cause)}`,
      })
    }
  }

  constructor(private readonly options: DownloadServiceOptions) {
    this.log = options.log
    this.now = options.now ?? Date.now
    this.freeSpace = options.freeSpace ?? freeSpaceBytes
    this.settings = loadDownloadSettings(options.roots.dataRoot, {
      version: options.appVersion,
      log: options.log,
    })
    this.http = options.http ?? this.buildHttpClient()
    this.sources =
      options.sources ??
      createSourceRegistry({
        preference: this.settings.sourcePreference,
        mirrorEnabled: this.settings.mirrorEnabled,
        extraRedirectHosts: this.settings.extraRedirectHosts,
      })
    this.providers = createModProviderRegistry({ http: this.http, log: httpLogger(options.log) })
  }

  // ---------------------------------------------------------------- settings

  private buildHttpClient(): HttpClient {
    return new HttpClient({
      userAgent: this.settings.userAgent,
      log: httpLogger(this.log),
    })
  }

  private rebuildWiring(): void {
    this.http = this.options.http ?? this.buildHttpClient()
    this.sources =
      this.options.sources ??
      createSourceRegistry({
        preference: this.settings.sourcePreference,
        mirrorEnabled: this.settings.mirrorEnabled,
        extraRedirectHosts: this.settings.extraRedirectHosts,
      })
    this.providers = createModProviderRegistry({ http: this.http, log: httpLogger(this.log) })
  }

  getSettings(): DownloadSettings {
    return { ...this.settings }
  }

  async updateSettings(patch: DownloadSettingsPatch): Promise<DownloadSettings> {
    const merged = mergeDownloadSettings(this.settings, patch, this.options.appVersion)
    this.settings = merged
    await saveDownloadSettings(this.options.roots.dataRoot, merged)
    this.rebuildWiring()
    this.log.info('settings updated', {
      concurrency: merged.concurrency,
      perHostConcurrency: merged.perHostConcurrency,
      sourcePreference: merged.sourcePreference,
      mirrorEnabled: merged.mirrorEnabled,
      downloadEnabled: merged.downloadEnabled,
    })
    return { ...merged }
  }

  listSources(): DownloadSourcesResult {
    return {
      preference: this.settings.sourcePreference,
      mirrorEnabled: this.settings.mirrorEnabled,
      downloadEnabled: this.settings.downloadEnabled,
      activeSource: this.sources.activeSource(),
      sources: this.sources.info(),
      userAgent: this.settings.userAgent,
    }
  }

  // ------------------------------------------------------------------ events

  onProgress(listener: ProgressListener): () => void {
    return this.bus.onProgress(listener)
  }

  onFinished(listener: FinishedListener): () => void {
    return this.bus.onFinished(listener)
  }

  listProviders(): ModProviderInfo[] {
    return this.providers.list()
  }

  async projectPage(input: { provider: ProviderId; project: string }): Promise<{ url: string }> {
    const provider = this.providers.get(input.provider)
    const url = provider.projectPage(input.project)
    let host: string
    try {
      host = new URL(url).hostname.toLowerCase()
    } catch {
      throw new DownloadError('DOWNLOAD.INVALID_TASK', { message: `invalid project page: ${url}` })
    }
    const allowed =
      host === 'modrinth.com' ||
      host.endsWith('.modrinth.com') ||
      host === 'curseforge.com' ||
      host.endsWith('.curseforge.com')
    if (!allowed) {
      throw new DownloadError('DOWNLOAD.HOST_NOT_ALLOWED', {
        message: `project page host not allowed: ${host}`,
        details: { url },
      })
    }
    return { url }
  }

  // ------------------------------------------------------------------ roots

  private requireRoot(): string {
    const root = this.options.roots.mcRoot
    if (!root) {
      throw new DownloadError('DOWNLOAD.MC_ROOT_MISSING', {
        message: 'module roots have no mcRoot; start with --mc-dir',
      })
    }
    return root
  }

  private requireEnabled(): void {
    if (!this.settings.downloadEnabled) {
      throw new DownloadError('DOWNLOAD.DISABLED', {
        message: 'download disabled by settings (MC-19 compliance mode)',
      })
    }
  }

  private manifestDeps() {
    return {
      http: this.http,
      sources: this.sources,
      cacheDir: moduleCacheDirectory(this.options.roots.dataRoot),
      now: this.now,
      log: httpLogger(this.log),
      ...(this.options.manifestUrls ? { urls: this.options.manifestUrls } : {}),
    }
  }

  // -------------------------------------------------------------- manifest

  async fetchManifest(input: { force?: boolean } = {}): Promise<ManifestResult> {
    const loaded = await loadManifest({ ...this.manifestDeps(), force: Boolean(input.force) })
    this.log.info('manifest fetched', {
      source: loaded.result.source,
      cached: loaded.result.cached,
      versions: loaded.result.versions.length,
      warnings: loaded.result.warnings ?? [],
    })
    return loaded.result
  }

  private async loadManifestOrThrow(force = false): Promise<ManifestJson> {
    const loaded = await loadManifest({ ...this.manifestDeps(), force })
    this.lastManifestWarnings = loaded.result.warnings ?? []
    if (this.lastManifestWarnings.length > 0) {
      this.log.warn('manifest metadata trust warning', {
        source: loaded.result.source,
        cached: loaded.result.cached,
        warnings: this.lastManifestWarnings,
      })
    }
    return loaded.raw
  }

  private async versionJsonFor(
    root: string,
    versionId: string,
    entry: ManifestEntry,
  ): Promise<{ version: VersionJson; text: string | null; warnings: string[] }> {
    const file = path.join(root, 'versions', versionId, `${versionId}.json`)
    const stat = await statOrNull(file)
    if (stat?.isFile) {
      try {
        const text = await readTextFile(file)
        const json = parseVersionJsonText(text, file)
        return { version: json as VersionJson, text: null, warnings: [] }
      } catch (error) {
        this.log.warn('installed version JSON is unreadable; refetching', {
          file,
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }
    const fetched = await fetchVersionJson(entry, {
      http: this.http,
      sources: this.sources,
      log: httpLogger(this.log),
    })
    return { version: fetched.json as VersionJson, text: fetched.text, warnings: fetched.warnings }
  }

  private async assetIndexFor(
    root: string,
    version: VersionJson,
  ): Promise<{ index: AssetIndexJson | null; text: string | null; id: string | null; warnings: string[] }> {
    const descriptor = version.assetIndex
    if (!descriptor?.id) return { index: null, text: null, id: null, warnings: [] }
    const file = path.join(root, 'assets', 'indexes', `${descriptor.id}.json`)
    const stat = await statOrNull(file)
    if (stat?.isFile) {
      try {
        const text = await readTextFile(file)
        return { index: parseAssetIndex(text, file), text: null, id: descriptor.id, warnings: [] }
      } catch {
        this.log.warn('asset index on disk is unreadable; refetching', { file })
      }
    }
    const fetched = await fetchAssetIndex(
      {
        id: descriptor.id,
        url: descriptor.url,
        sha1: descriptor.sha1 ?? null,
        size: descriptor.size ?? null,
      },
      { http: this.http, sources: this.sources, log: httpLogger(this.log) },
    )
    return {
      index: fetched.index,
      text: fetched.text,
      id: descriptor.id,
      warnings: fetched.warnings,
    }
  }

  // ------------------------------------------------------------------- plan

  async plan(input: { versionId: string; verifyExisting?: boolean }): Promise<InstallPlanSummary> {
    const root = this.requireRoot()
    const plan = await this.computePlan(root, input.versionId, Boolean(input.verifyExisting))
    this.log.info('install plan', {
      versionId: input.versionId,
      files: plan.summary.files,
      missing: plan.summary.missingFiles,
      bytes: plan.summary.bytes,
    })
    return plan.summary
  }

  private async computePlan(
    root: string,
    versionId: string,
    verifyExisting: boolean,
  ): Promise<PlanBuildResult> {
    const manifest = await this.loadManifestOrThrow()
    const entry = findManifestVersion(manifest, versionId)
    if (!entry) {
      throw new DownloadError('DOWNLOAD.VERSION_NOT_FOUND', {
        message: `version manifest has no entry for "${versionId}"`,
        details: { versionId },
      })
    }

    const { version, warnings: versionWarnings } = await this.versionJsonFor(
      root,
      versionId,
      entry,
    )
    const { index, warnings: indexWarnings } = await this.assetIndexFor(root, version)

    const built = await buildInstallPlan({
      versionId,
      mcRoot: root,
      version,
      assetIndex: index,
      mirrorBase: this.sources.mirrorBase,
      ...(this.options.assetBaseUrl ? { assetBaseUrl: this.options.assetBaseUrl } : {}),
      stat: async (absolute) => {
        const stat = await statOrNull(absolute)
        return stat?.isFile ? { size: stat.size } : null
      },
    })
    built.summary.warnings = [
      ...new Set([
        ...this.lastManifestWarnings,
        ...versionWarnings,
        ...indexWarnings,
        ...built.warnings,
      ]),
    ]
    return built
  }

  // ---------------------------------------------------------------- install

  async install(input: {
    versionId: string
    verifyExisting?: 'size' | 'hash'
  }): Promise<InstallResult> {
    return this.startInstall(input.versionId, input.verifyExisting ?? 'size', 'install')
  }

  async repair(input: {
    versionId: string
    verifyExisting?: 'size' | 'hash'
  }): Promise<RepairResult> {
    const result = await this.startInstall(input.versionId, input.verifyExisting ?? 'size', 'repair')
    return {
      jobId: result.jobId,
      versionId: result.versionId,
      missingFiles: result.plan.missingFiles,
      missingBytes: result.plan.missingBytes,
    }
  }

  private async startInstall(
    versionId: string,
    verifyExisting: 'size' | 'hash',
    mode: 'install' | 'repair',
  ): Promise<InstallResult> {
    this.requireEnabled()
    const root = this.requireRoot()

    if (!/^[A-Za-z0-9._+-]{1,128}$/.test(versionId)) {
      throw new DownloadError('DOWNLOAD.VERSION_NOT_FOUND', {
        message: `unsafe version id: ${versionId}`,
        details: { versionId },
      })
    }

    // Manifest lookup happens before any directory is created, so a typo
    // ("1.20.1-does-not-exist") leaves no empty version folder (01 A1.11).
    const manifest = await this.loadManifestOrThrow()
    const metadataWarnings = [...this.lastManifestWarnings]
    const entry = findManifestVersion(manifest, versionId)
    if (!entry) {
      throw new DownloadError('DOWNLOAD.VERSION_NOT_FOUND', {
        message: `version manifest has no entry for "${versionId}"`,
        details: { versionId },
      })
    }

    const handle = this.createJob(mode === 'install' ? 'install' : 'install', versionId, mode)
    try {
      handle.job.setStage('manifest')
      this.publish(handle, true)

      const versionFile = path.join(root, 'versions', versionId, `${versionId}.json`)
      const versionStat = await statOrNull(versionFile)

      let version: VersionJson
      let versionBytes = 0
      let versionWarnings: string[] = []
      if (versionStat?.isFile) {
        version = parseVersionJsonText(await readTextFile(versionFile), versionFile) as VersionJson
      } else {
        handle.job.setStage('version-json')
        this.publish(handle, true)
        const fetched = await fetchVersionJson(entry, {
          http: this.http,
          sources: this.sources,
          log: httpLogger(this.log),
        })
        await writeTextAtomic(versionFile, fetched.text)
        versionBytes = Buffer.byteLength(fetched.text, 'utf8')
        version = fetched.json as VersionJson
        versionWarnings = fetched.warnings
      }

      let indexBytes = 0
      let indexWarnings: string[] = []
      const indexDescriptor = version.assetIndex
      let assetIndex: AssetIndexJson | null = null
      if (indexDescriptor?.id) {
        const indexFile = path.join(root, 'assets', 'indexes', `${indexDescriptor.id}.json`)
        const indexStat = await statOrNull(indexFile)
        if (indexStat?.isFile) {
          try {
            assetIndex = parseAssetIndex(await readTextFile(indexFile), indexFile)
          } catch {
            assetIndex = null
          }
        }
        if (!assetIndex) {
          handle.job.setStage('assets-index')
          this.publish(handle, true)
          const fetched = await fetchAssetIndex(
            {
              id: indexDescriptor.id,
              url: indexDescriptor.url,
              sha1: indexDescriptor.sha1 ?? null,
              size: indexDescriptor.size ?? null,
            },
            { http: this.http, sources: this.sources, log: httpLogger(this.log) },
          )
          await writeTextAtomic(indexFile, fetched.text)
          indexBytes = Buffer.byteLength(fetched.text, 'utf8')
          assetIndex = fetched.index
          indexWarnings = fetched.warnings
        }
      }

      const plan = await buildInstallPlan({
        versionId,
        mcRoot: root,
        version,
        assetIndex,
        mirrorBase: this.sources.mirrorBase,
        ...(this.options.assetBaseUrl ? { assetBaseUrl: this.options.assetBaseUrl } : {}),
        stat: async (absolute) => {
          const stat = await statOrNull(absolute)
          return stat?.isFile ? { size: stat.size } : null
        },
      })

      // The version JSON / index are part of the install but not part of the
      // task list; account for them in the progress bar.
      const extraFiles = (versionBytes > 0 ? 1 : 0) + (indexBytes > 0 ? 1 : 0)
      const extraBytes = versionBytes + indexBytes
      plan.summary.warnings = [
        ...new Set([...metadataWarnings, ...versionWarnings, ...indexWarnings, ...plan.warnings]),
      ]
      handle.job.setTotals(plan.tasks.length + extraFiles, plan.summary.bytes + extraBytes)
      handle.job.done += extraFiles
      handle.job.bytesDone += extraBytes

      if (mode === 'repair' && plan.summary.missingFiles === 0) {
        this.log.info('repair found nothing to do', { versionId })
        handle.job.setStage('done')
        handle.job.setState('done', null)
        this.finishJob(handle)
        return {
          jobId: handle.job.id,
          versionId,
          plan: plan.summary,
        }
      }

      const free = await this.freeSpace(root)
      const required = Math.max(MIN_FREE_DISK_BYTES, Math.round(plan.summary.missingBytes * 1.1))
      if (free !== null && free < required) {
        throw new DownloadError('DOWNLOAD.NO_SPACE', {
          message: `free ${free} < required ${required}`,
          details: { free, required, root },
        })
      }

      handle.job.setState('running', null)
      handle.job.setStage(this.firstStage(plan.tasks))
      this.publish(handle, true)
      this.log.info('install started', {
        jobId: handle.job.id,
        versionId,
        mode,
        files: plan.tasks.length,
        missingFiles: plan.summary.missingFiles,
        bytes: plan.summary.bytes,
      })

      // Background: the caller gets the plan immediately and can render it.
      void this.runQueue(handle, plan.tasks, verifyExisting)

      return { jobId: handle.job.id, versionId, plan: plan.summary }
    } catch (error) {
      const downloadError = asDownloadError(error)
      handle.job.setState('failed', downloadError.userMessage)
      this.finishJob(handle)
      this.log.error('install failed before download', {
        versionId,
        code: downloadError.code,
        message: downloadError.message,
      })
      throw downloadError
    }
  }

  private firstStage(tasks: PlannedTask[]): DownloadStage {
    if (tasks.length === 0) return 'done'
    return STAGE_BY_LABEL[tasks[0].label] ?? 'files'
  }

  // ---------------------------------------------------------------- enqueue

  async enqueue(tasks: DownloadTask[]): Promise<{ jobId: string; total: number }> {
    this.requireEnabled()
    const root = this.requireRoot()
    if (!Array.isArray(tasks) || tasks.length === 0) {
      throw new DownloadError('DOWNLOAD.INVALID_TASK', { message: 'empty task list' })
    }
    for (const task of tasks) {
      if (!task || typeof task.destRel !== 'string' || typeof task.url !== 'string') {
        throw new DownloadError('DOWNLOAD.INVALID_TASK', { message: 'task missing url/destRel' })
      }
    }
    const unique = dedupeDownloadTasks(tasks)
    if (unique.length !== tasks.length) {
      this.log.warn('batch deduplicated', { submitted: tasks.length, unique: unique.length })
    }

    const handle = this.createJob('batch', null, 'batch')
    handle.job.setTotals(unique.length, sumSizes(unique))
    handle.job.setState('running', null)
    handle.job.setStage('files')
    this.publish(handle, true)
    this.log.info('batch enqueued', {
      jobId: handle.job.id,
      files: unique.length,
      bytes: sumSizes(unique),
    })
    void this.runQueue(handle, unique as PlannedTask[], 'size', root)
    return { jobId: handle.job.id, total: unique.length }
  }

  // ---------------------------------------------------------------- controls

  async cancel(jobId: string): Promise<{ cancelled: boolean }> {
    const handle = this.jobs.get(jobId)
    if (!handle) return { cancelled: false }
    handle.controller.abort()
    this.log.info('job cancel requested', { jobId })
    return { cancelled: true }
  }

  async pause(jobId: string): Promise<{ paused: boolean }> {
    const handle = this.jobs.get(jobId)
    if (!handle) return { paused: false }
    handle.paused = true
    handle.job.setMessage('已暂停')
    this.publish(handle, true)
    return { paused: true }
  }

  async resume(jobId: string): Promise<{ resumed: boolean }> {
    const handle = this.jobs.get(jobId)
    if (!handle) return { resumed: false }
    handle.paused = false
    handle.job.setMessage(null)
    this.publish(handle, true)
    return { resumed: true }
  }

  list(): DownloadProgress[] {
    return [...this.jobs.values()]
      .sort((a, b) => b.job.startedAt - a.job.startedAt)
      .slice(0, 20)
      .map((handle) => handle.job.progress())
  }

  status(jobId: string): DownloadProgress | null {
    const handle = this.jobs.get(jobId)
    return handle ? handle.job.progress() : null
  }

  async waitForJob(jobId: string, timeoutMs = 120_000): Promise<DownloadProgress> {
    const handle = this.jobs.get(jobId)
    if (!handle) {
      throw new DownloadError('DOWNLOAD.INVALID_TASK', { message: `unknown job ${jobId}` })
    }
    if (['done', 'failed', 'cancelled'].includes(handle.job.state)) return handle.job.progress()
    let timer: NodeJS.Timeout | null = null
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(
          new DownloadError('DOWNLOAD.TIMEOUT', {
            message: `job ${jobId} did not finish within ${timeoutMs} ms`,
          }),
        )
      }, timeoutMs)
      if (typeof timer.unref === 'function') timer.unref()
    })
    try {
      await Promise.race([handle.finished, timeout])
    } finally {
      if (timer) clearTimeout(timer)
    }
    return handle.job.progress()
  }

  // -------------------------------------------------------------- internals

  private createJob(
    kind: 'install' | 'batch',
    versionId: string | null,
    mode: 'install' | 'repair' | 'batch',
  ): JobHandle {
    const job = new DownloadJob({
      id: randomUUID(),
      kind,
      versionId,
      total: 0,
      bytesTotal: 0,
      now: this.now,
    })
    let resolveFinished: () => void = () => undefined
    const finished = new Promise<void>((resolve) => {
      resolveFinished = resolve
    })
    const emitter = new JobProgressEmitter((progress) => {
      this.bus.publishProgress(progress)
    }, 100, this.now)
    const handle: JobHandle = {
      job,
      controller: new AbortController(),
      paused: false,
      emitter,
      finished,
      resolveFinished,
      mode,
      lock: null,
    }
    this.jobs.set(job.id, handle)
    this.pruneJobs()
    return handle
  }

  private pruneJobs(): void {
    const finishedJobs = [...this.jobs.values()]
      .filter((handle) => ['done', 'failed', 'cancelled'].includes(handle.job.state))
      .sort((a, b) => a.job.startedAt - b.job.startedAt)
    while (this.jobs.size > 20 && finishedJobs.length > 0) {
      const oldest = finishedJobs.shift()
      if (oldest) {
        oldest.emitter.dispose()
        this.jobs.delete(oldest.job.id)
      }
    }
  }

  private publish(handle: JobHandle, force = false): void {
    handle.emitter.push(handle.job.progress(), force)
  }

  private finishJob(handle: JobHandle): void {
    handle.emitter.push(handle.job.progress(), true)
    handle.emitter.dispose()
    this.bus.publishFinished(handle.job.finished())
    if (handle.lock) {
      void handle.lock.release()
      handle.lock = null
    }
    handle.resolveFinished()
  }

  private async runQueue(
    handle: JobHandle,
    tasks: PlannedTask[],
    verifyExisting: 'size' | 'hash',
    rootOverride?: string,
  ): Promise<void> {
    const root = rootOverride ?? this.requireRoot()
    let lock: JobLockHandle | null = null
    try {
      // H6: batch (loader library) jobs use the same per-root install lock as
      // installs, so they cannot race an install writing the same maven files.
      lock = await acquireJobLock(moduleLockFile(this.options.roots.dataRoot, root), {
        now: this.now,
      })
      handle.lock = lock

      const result = await runTasks(tasks, {
        root,
        http: this.http,
        sources: this.sources,
        concurrency: this.settings.concurrency,
        perHostConcurrency: this.settings.perHostConcurrency,
        maxRetries: this.settings.maxRetries,
        verifyExisting,
        speedLimitBytesPerSec: this.settings.speedLimitBytesPerSec,
        signal: handle.controller.signal,
        isPaused: () => handle.paused,
        cleanPartOnCancel: true,
        log: queueLogger(this.log),
        now: this.now,
        onTaskStart: (task, destRel, source) => {
          const label = (task as PlannedTask).label
          if (label && STAGE_BY_LABEL[label]) handle.job.setStage(STAGE_BY_LABEL[label])
          handle.job.setCurrent(destRel, source)
          this.publish(handle)
        },
        onBytes: (delta) => {
          handle.job.addBytes(delta)
          this.publish(handle)
        },
        onTaskDone: (task, destRel, skipped, bytes) => {
          handle.job.completeTask({
            size: typeof task.size === 'number' ? task.size : bytes,
            skipped,
          })
          // Only the file that is actually shown may clear the current file;
          // another worker finishing must not blank it.
          if (handle.job.currentFile === destRel) handle.job.setCurrent(null, null)
          this.publish(handle)
        },
        onTaskFailed: (failure) => {
          handle.job.failTask(failure)
          this.publish(handle)
        },
      })

      if (handle.controller.signal.aborted) {
        handle.job.setStage('idle')
        handle.job.setState('cancelled', '下载已取消')
      } else if (result.failures.length > 0) {
        handle.job.setState('failed', `${result.failures.length} 个文件下载失败`)
      } else {
        handle.job.setStage('done')
        handle.job.setState('done', null)
      }

      this.log.info('job finished', {
        jobId: handle.job.id,
        mode: handle.mode,
        state: handle.job.state,
        downloaded: result.downloaded,
        skipped: result.skipped,
        failed: result.failures.length,
        bytes: result.bytes,
        durationMs: result.durationMs,
      })
    } catch (error) {
      const downloadError = asDownloadError(error)
      const cancelled = handle.controller.signal.aborted || downloadError.code === 'DOWNLOAD.CANCELLED'
      handle.job.setState(
        cancelled ? 'cancelled' : 'failed',
        cancelled ? '下载已取消' : downloadError.userMessage,
      )
      if (!cancelled) {
        this.log.error('job failed', {
          jobId: handle.job.id,
          code: downloadError.code,
          message: downloadError.message,
        })
      }
    } finally {
      if (lock) {
        await lock.release().catch(() => undefined)
        handle.lock = null
      }
      this.finishJob(handle)
    }
  }

  /** Test/service hook: release everything (not needed by the app lifecycle). */
  dispose(): void {
    for (const handle of this.jobs.values()) {
      handle.controller.abort()
      handle.emitter.dispose()
    }
    this.jobs.clear()
  }
}

export function createDownloadService(options: DownloadServiceOptions): DownloadService {
  return new DownloadService(options)
}

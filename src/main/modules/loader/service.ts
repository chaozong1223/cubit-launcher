import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { DownloadProgress, DownloadTask } from '@shared/download'
import type {
  LoaderDryRunResult,
  LoaderFinished,
  LoaderInstallResult,
  LoaderListResult,
  LoaderLogEvent,
  LoaderPlan,
  LoaderProgress,
  LoaderType,
  LoaderVerifyResult,
} from '@shared/loader'
import type { AppErrorShape } from '@shared/kernel'
import type { ScopedLogger } from '../../kernel/logger'
import type { ModuleRoots } from '../_context'
import { getService } from '../_services'
import { nodeFsPort, nodeProcessPort, type FsPort, type ProcessPort } from '../../core/ports'
import { detectJava } from '../../core/java/detect'
import { chooseJava } from '../../core/java/select'
import { probeJavaExecutable } from '../../core/java/probe'
import { LoaderError, asLoaderError } from './core/errors'
import { LoaderHttp, sha1File } from './core/http'
import { LoaderJob } from './core/job'
import { detectInstalledVersion, formatInstallerFailure, runInstaller } from './core/installer'
import { buildLoaderPlan, type LoaderPlanResult } from './core/plan'
import {
  defaultEndpoints,
  listLoaderVersions,
  type LoaderEndpoints,
  type MetaDeps,
} from './core/meta'
import { profileLibraryTasks } from './core/profile'
import {
  ensureLauncherProfiles,
  rollbackLoaderInstall,
  snapshotMcRoot,
  type McRootSnapshot,
} from './core/rollback'
import { dryRunInstalledVersion, verifyInstalledVersion } from './core/verify'

/**
 * `LoaderService` — Forge/NeoForge/Fabric/Quilt installation (t17).
 *
 * No Electron import: IPC wiring lives in `index.ts` through the t20 kernel
 * `moduleIpc`. Long installs run in the background; the caller gets a job id and
 * progress/log events.
 */

export interface LoaderLibraryDownloader {
  enqueue(tasks: DownloadTask[]): Promise<{ jobId: string; total: number }>
  status(jobId: string): DownloadProgress | null
  waitForJob?(jobId: string): Promise<DownloadProgress>
}

export interface LoaderJavaResolution {
  path: string
  major: number
  warnings: string[]
}

export interface LoaderServiceEvents {
  onProgress?(progress: LoaderProgress): void
  onLog?(event: LoaderLogEvent): void
  onFinished?(event: LoaderFinished): void
}

export interface LoaderServiceOptions {
  roots: ModuleRoots
  log: ScopedLogger
  appVersion: string
  now?: () => number
  fs?: FsPort
  ports?: ProcessPort
  http?: LoaderHttp
  endpoints?: LoaderEndpoints
  download?: LoaderLibraryDownloader | null
  events?: LoaderServiceEvents
  installerTimeoutMs?: number
  launcherVersion?: string
  platform?: NodeJS.Platform
  arch?: string
  /** Test seam: replace Java auto-detection. */
  javaResolver?: (requiredMajor: number | null) => Promise<LoaderJavaResolution>
}

interface JobHandle {
  job: LoaderJob
  controller: AbortController
  promise: Promise<void>
}

const MAX_JOBS = 20
const LIBRARY_JOB_TIMEOUT_MS = 10 * 60 * 1000

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new LoaderError('LOADER.CANCELLED', { message: 'aborted' }))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new LoaderError('LOADER.CANCELLED', { message: 'aborted' }))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
}

function buildUserAgent(appVersion: string): string {
  return `mc-launcher/${appVersion} (+https://github.com/mc-launcher; contact: mc-launcher-maintainers@users.noreply.github.com)`
}

export class LoaderService {
  private readonly fs: FsPort
  private readonly ports: ProcessPort
  private readonly http: LoaderHttp
  private readonly metaDeps: MetaDeps
  private readonly jobs = new Map<string, JobHandle>()
  private readonly activeRoots = new Set<string>()
  private readonly now: () => number
  private readonly log: ScopedLogger
  private installerTimeoutMs: number

  constructor(private readonly options: LoaderServiceOptions) {
    this.fs = options.fs ?? nodeFsPort()
    this.ports = options.ports ?? nodeProcessPort()
    this.log = options.log
    this.now = options.now ?? Date.now
    this.installerTimeoutMs = options.installerTimeoutMs ?? 15 * 60 * 1000
    this.http =
      options.http ??
      new LoaderHttp({
        userAgent: buildUserAgent(options.appVersion),
        log: {
          debug: (message, fields) => this.log.debug(message, fields),
          warn: (message, fields) => this.log.warn(message, fields),
        },
      })
    this.metaDeps = {
      http: this.http,
      endpoints: options.endpoints ?? defaultEndpoints(),
      cacheDir: path.join(options.roots.dataRoot, 'modules', 'loader', 'cache'),
      now: this.now,
      log: {
        debug: (message, fields) => this.log.debug(message, fields),
        warn: (message, fields) => this.log.warn(message, fields),
      },
    }
  }

  // -------------------------------------------------------------------- meta

  async list(input: { type: LoaderType; mcVersion: string; force?: boolean }): Promise<LoaderListResult> {
    const result = await listLoaderVersions(this.metaDeps, input.type, input.mcVersion, {
      force: Boolean(input.force),
    })
    return {
      type: result.type,
      mcVersion: result.mcVersion,
      fetchedAt: result.fetchedAt,
      source: result.source,
      versions: result.versions.map((entry) => ({
        type: result.type,
        mcVersion: result.mcVersion,
        version: entry.version,
        rawVersion: entry.rawVersion,
        stable: entry.stable,
        recommended: entry.recommended,
        installer: entry.installer,
      })),
      warnings: result.warnings,
    }
  }

  async plan(input: {
    type: LoaderType
    mcVersion: string
    loaderVersion?: string
  }): Promise<LoaderPlan> {
    const root = this.requireRoot()
    const result = await buildLoaderPlan(this.metaDeps, this.fs, root, input)
    return result.plan
  }

  // ----------------------------------------------------------------- install

  async install(input: {
    type: LoaderType
    mcVersion: string
    loaderVersion?: string
    javaPath?: string
    confirmSha1?: string | null
    allowUnverifiedInstaller?: boolean
  }): Promise<LoaderInstallResult> {
    const root = this.requireRoot()
    const planResult = await buildLoaderPlan(this.metaDeps, this.fs, root, input)
    const plan = planResult.plan

    if (!plan.parentInstalled) {
      throw new LoaderError('LOADER.PARENT_MISSING', {
        message: `parent version ${plan.mcVersion} is not installed`,
        details: { mcVersion: plan.mcVersion },
      })
    }

    if (plan.method === 'installer') {
      if (!plan.installer) {
        throw new LoaderError('LOADER.PRODUCT_MISSING', {
          message: 'installer info is missing from the plan',
        })
      }
      if (plan.installer.sha1) {
        const confirmed = (input.confirmSha1 ?? '').toLowerCase()
        if (confirmed !== plan.installer.sha1.toLowerCase()) {
          throw new LoaderError('LOADER.CONFIRMATION_MISMATCH', {
            message: 'confirmSha1 must echo the installer sha1 shown in the plan',
            details: { expected: plan.installer.sha1, confirmed: input.confirmSha1 ?? null },
          })
        }
      } else if (!input.allowUnverifiedInstaller) {
        throw new LoaderError('LOADER.INSTALLER_HASH_UNAVAILABLE', {
          message: 'installer has no upstream sha1; pass allowUnverifiedInstaller=true after user confirmation',
          details: { installer: plan.installer.url },
        })
      }
    }

    const java = await this.resolveJavaForInstall(plan, input.javaPath)

    const lockKey = `${root}::${plan.type}::${plan.mcVersion}`
    if (this.activeRoots.has(lockKey)) {
      throw new LoaderError('LOADER.LOCKED', {
        message: `another loader job is already running for ${lockKey}`,
        details: { root, type: plan.type, mcVersion: plan.mcVersion },
      })
    }
    this.activeRoots.add(lockKey)

    const handle = this.createJob(plan)
    handle.promise = this.runJob(handle, planResult, java, lockKey)
    void handle.promise
    return {
      jobId: handle.job.id,
      type: plan.type,
      mcVersion: plan.mcVersion,
      loaderVersion: plan.loaderVersion,
      versionId: plan.versionId,
      plan,
    }
  }

  async cancel(jobId: string): Promise<{ cancelled: boolean }> {
    const handle = this.jobs.get(jobId)
    if (!handle) return { cancelled: false }
    handle.controller.abort()
    this.log.info('loader job cancel requested', { jobId })
    return { cancelled: true }
  }

  status(jobId: string): LoaderProgress | null {
    return this.jobs.get(jobId)?.job.progress() ?? null
  }

  listJobs(): LoaderProgress[] {
    return [...this.jobs.values()]
      .sort((a, b) => b.job.startedAt - a.job.startedAt)
      .slice(0, MAX_JOBS)
      .map((handle) => handle.job.progress())
  }

  async verify(input: { versionId: string }): Promise<LoaderVerifyResult> {
    const root = this.requireRoot()
    return verifyInstalledVersion(this.fs, root, input.versionId)
  }

  async dryRun(input: { versionId: string; javaPath?: string }): Promise<LoaderDryRunResult> {
    const root = this.requireRoot()
    return dryRunInstalledVersion(this.fs, root, input.versionId, {
      ...(input.javaPath ? { javaPath: input.javaPath } : {}),
      ...(this.options.launcherVersion ? { launcherVersion: this.options.launcherVersion } : {}),
      ...(this.options.platform ? { platform: this.options.platform } : {}),
      ...(this.options.arch ? { arch: this.options.arch } : {}),
    })
  }

  /** Test hook: wait for a job to finish without polling. */
  async waitForJob(jobId: string, timeoutMs = 120_000): Promise<LoaderProgress> {
    const handle = this.jobs.get(jobId)
    if (!handle) {
      throw new LoaderError('LOADER.INVALID_INPUT', { message: `unknown job ${jobId}` })
    }
    let timer: NodeJS.Timeout | null = null
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new LoaderError('LOADER.INSTALLER_TIMEOUT', { message: `job ${jobId} timeout` }))
      }, timeoutMs)
      if (typeof timer.unref === 'function') timer.unref()
    })
    try {
      await Promise.race([handle.promise, timeout])
    } finally {
      if (timer) clearTimeout(timer)
    }
    return handle.job.progress()
  }

  dispose(): void {
    for (const handle of this.jobs.values()) {
      handle.controller.abort()
      handle.job.dispose()
    }
    this.jobs.clear()
  }

  // --------------------------------------------------------------- internals

  private requireRoot(): string {
    const root = this.options.roots.mcRoot
    if (!root) {
      throw new LoaderError('LOADER.MC_ROOT_MISSING', { message: 'module roots have no mcRoot' })
    }
    return root
  }

  private downloader(): LoaderLibraryDownloader | null {
    if (this.options.download !== undefined) return this.options.download
    const service = getService<LoaderLibraryDownloader>('download')
    if (!service || typeof service.enqueue !== 'function' || typeof service.status !== 'function') {
      return null
    }
    return service
  }

  private createJob(plan: LoaderPlan): JobHandle {
    const events = this.options.events ?? {}
    const job = new LoaderJob(
      {
        id: randomUUID(),
        type: plan.type,
        mcVersion: plan.mcVersion,
        loaderVersion: plan.loaderVersion,
        now: this.now,
      },
      {
        onProgress: (progress) => {
          try {
            events.onProgress?.(progress)
          } catch {
            /* ignore consumer */
          }
        },
        onLog: (event) => {
          try {
            events.onLog?.(event)
          } catch {
            /* ignore consumer */
          }
        },
        onFinished: (event) => {
          try {
            events.onFinished?.(event)
          } catch {
            /* ignore consumer */
          }
        },
      },
    )
    const controller = new AbortController()
    const handle: JobHandle = {
      job,
      controller,
      promise: Promise.resolve(),
    }
    this.jobs.set(job.id, handle)
    this.pruneJobs()
    return handle
  }

  private pruneJobs(): void {
    const finished = [...this.jobs.values()]
      .filter((handle) => ['done', 'failed', 'cancelled'].includes(handle.job.state))
      .sort((a, b) => a.job.startedAt - b.job.startedAt)
    while (this.jobs.size > MAX_JOBS && finished.length > 0) {
      const oldest = finished.shift()
      if (oldest) {
        oldest.job.dispose()
        this.jobs.delete(oldest.job.id)
      }
    }
  }

  private async resolveJavaForInstall(
    plan: LoaderPlan,
    javaPath: string | undefined,
  ): Promise<LoaderJavaResolution | null> {
    if (plan.method !== 'installer') return null
    const required = plan.requiredJavaMajor
    const resolution = await this.resolveJava(javaPath, required)
    if (required !== null && resolution.major < required) {
      throw new LoaderError('LOADER.JAVA_TOO_OLD', {
        message: `Java ${resolution.major} < required ${required} (${resolution.path})`,
        details: { javaPath: resolution.path, major: resolution.major, required },
      })
    }
    if (required !== null && resolution.major > required) {
      resolution.warnings.push(
        `安装器将使用 Java ${resolution.major}（该游戏版本推荐 Java ${required}）`,
      )
    }
    return resolution
  }

  private async resolveJava(
    javaPath: string | undefined,
    requiredMajor: number | null,
  ): Promise<LoaderJavaResolution> {
    if (this.options.javaResolver) return this.options.javaResolver(requiredMajor)
    const root = this.options.roots.mcRoot ?? undefined
    if (javaPath) {
      const probe = await probeJavaExecutable(this.ports, javaPath)
      if (!probe.ok) {
        throw new LoaderError('LOADER.JAVA_PROBE_FAILED', {
          message: `cannot probe ${javaPath}: ${probe.reason}`,
          details: { javaPath, reason: probe.reason },
        })
      }
      return {
        path: javaPath,
        major: probe.version.major,
        warnings: [],
      }
    }

    const detected = await detectJava({
      fs: this.fs,
      ports: this.ports,
      dataRoot: this.options.roots.dataRoot,
      ...(root ? { mcRoot: root } : {}),
      ...(this.options.platform ? { platform: this.options.platform } : {}),
      ...(this.options.arch ? { arch: this.options.arch } : {}),
    })
    if (detected.candidates.length === 0) {
      throw new LoaderError('LOADER.JAVA_NOT_FOUND', { message: 'no Java runtime detected' })
    }
    const choice = chooseJava({ candidates: detected.candidates, requiredMajor })
    return {
      path: choice.candidate.path,
      major: choice.candidate.version.major,
      warnings: [...choice.warnings],
    }
  }

  private async runJob(
    handle: JobHandle,
    planResult: LoaderPlanResult,
    java: LoaderJavaResolution | null,
    lockKey: string,
  ): Promise<void> {
    const job = handle.job
    const root = this.requireRoot()
    try {
      job.setState('preparing')
      job.setStage('prepare', '准备安装信息')
      if (planResult.plan.method === 'meta-json') {
        await this.installProfile(handle, planResult)
      } else {
        await this.installWithInstaller(handle, planResult, java)
      }
      job.setStage('done')
      job.setState('done', null)
      job.setPercent(100)
      job.finish(null)
      this.log.info('loader install done', {
        jobId: job.id,
        type: job.type,
        versionId: job.versionId,
      })
    } catch (error) {
      const loaderError = asLoaderError(error)
      const cancelled = handle.controller.signal.aborted || loaderError.code === 'LOADER.CANCELLED'
      job.setState(cancelled ? 'cancelled' : 'failed', loaderError.userMessage)
      const shape: AppErrorShape = cancelled
        ? { code: 'LOADER.CANCELLED', message: '加载器安装已取消', retryable: false }
        : loaderError.toShape()
      job.finish(shape)
      this.log.error('loader install failed', {
        jobId: job.id,
        type: job.type,
        code: shape.code,
        message: loaderError.message,
        mcRoot: root,
      })
    } finally {
      this.activeRoots.delete(lockKey)
      job.dispose()
    }
  }

  private async installProfile(handle: JobHandle, planResult: LoaderPlanResult): Promise<void> {
    const root = this.requireRoot()
    const job = handle.job
    const plan = planResult.plan
    const profile = planResult.profile
    if (!profile) {
      throw new LoaderError('LOADER.PROFILE_INVALID', { message: 'profile JSON missing from plan' })
    }

    const warnings: string[] = []
    const libraryTasks = profileLibraryTasks(profile)
    warnings.push(...libraryTasks.warnings)

    if (libraryTasks.tasks.length > 0) {
      job.setStage('download', `下载 ${libraryTasks.tasks.length} 个加载器库`)
      const downloader = this.downloader()
      if (!downloader) {
        warnings.push('下载服务不可用：加载器库尚未下载，首次启动前需要修复/下载')
        job.setMessage('下载服务不可用，加载器库待下载')
      } else {
        this.log.info('loader libraries enqueue', {
          jobId: job.id,
          count: libraryTasks.tasks.length,
        })
        const { jobId } = await downloader.enqueue(libraryTasks.tasks)
        await this.waitForLibraryJob(handle, jobId, downloader)
      }
    }

    job.setStage('install', '写入版本配置')
    const versionId = plan.versionId
    const dir = path.join(root, 'versions', versionId)
    const jsonPath = path.join(dir, `${versionId}.json`)
    const dirExisted = this.fs.exists(dir)
    if (this.fs.exists(jsonPath)) {
      warnings.push(`版本 ${versionId} 已存在，保留现有版本配置`)
    } else {
      this.fs.mkdirp(dir)
      this.fs.writeTextAtomic(jsonPath, `${JSON.stringify(profile, null, 2)}\n`)
    }
    job.setVersionId(versionId)

    job.setStage('verify', '校验安装结果')
    try {
      const verified = verifyInstalledVersion(this.fs, root, versionId)
      warnings.push(...verified.warnings)
    } catch (error) {
      if (!dirExisted) {
        try {
          this.fs.remove(dir)
        } catch {
          /* best effort */
        }
      }
      throw error
    }

    if (warnings.length > 0) job.setMessage(warnings[warnings.length - 1])
    this.log.info('loader profile installed', {
      jobId: job.id,
      versionId,
      libraries: libraryTasks.tasks.length,
      warnings: warnings.length,
    })
  }

  private async waitForLibraryJob(
    handle: JobHandle,
    downloadJobId: string,
    downloader: LoaderLibraryDownloader,
  ): Promise<void> {
    const job = handle.job
    const startedAt = this.now()
    for (;;) {
      if (handle.controller.signal.aborted) {
        throw new LoaderError('LOADER.CANCELLED', { message: 'cancelled while downloading libraries' })
      }
      const status = downloader.status(downloadJobId)
      if (status) {
        job.setPercent(status.total > 0 ? (status.done / status.total) * 100 : null)
        job.setTask(status.currentFile ?? `下载加载器库 ${status.done}/${status.total}`)
        if (status.state === 'done') return
        if (status.state === 'failed') {
          throw new LoaderError('LOADER.LIBRARIES_FAILED', {
            message: status.message ?? 'library download failed',
            details: { downloadJobId, failed: status.failed },
          })
        }
        if (status.state === 'cancelled') {
          throw new LoaderError('LOADER.CANCELLED', { message: 'library download cancelled' })
        }
      }
      if (this.now() - startedAt > LIBRARY_JOB_TIMEOUT_MS) {
        throw new LoaderError('LOADER.LIBRARIES_FAILED', {
          message: 'library download timed out',
          details: { downloadJobId },
        })
      }
      await sleep(150, handle.controller.signal)
    }
  }

  private installerCachePath(installer: NonNullable<LoaderPlan['installer']>): string {
    return path.join(
      this.options.roots.dataRoot,
      'modules',
      'loader',
      'cache',
      'installers',
      installer.fileName,
    )
  }

  private async ensureInstaller(
    handle: JobHandle,
    plan: LoaderPlan,
  ): Promise<{ file: string; sha1: string | null }> {
    const installer = plan.installer
    if (!installer) {
      throw new LoaderError('LOADER.PRODUCT_MISSING', { message: 'installer info missing' })
    }
    const job = handle.job
    const cacheFile = this.installerCachePath(installer)

    if (this.fs.exists(cacheFile) && installer.sha1) {
      const actual = await sha1File(cacheFile)
      if (actual.toLowerCase() === installer.sha1.toLowerCase()) {
        this.log.info('installer cache hit', { file: cacheFile })
        return { file: cacheFile, sha1: actual }
      }
      this.log.warn('installer cache hash mismatch; re-downloading', {
        file: cacheFile,
        expected: installer.sha1,
        actual,
      })
      this.fs.remove(cacheFile)
    } else if (this.fs.exists(cacheFile) && !installer.sha1) {
      this.log.warn('installer cache present but unverifiable; re-downloading', {
        file: cacheFile,
      })
      this.fs.remove(cacheFile)
    }

    const sources = [
      ...(installer.mirrorUrl ? [{ url: installer.mirrorUrl, source: 'mirror' as const }] : []),
      { url: installer.url, source: 'official' as const },
    ]
    job.setStage('download', `下载安装器 ${installer.fileName}`)
    job.setTask(`下载安装器 ${installer.fileName}`)
    this.log.info('installer download start', {
      jobId: job.id,
      sources: sources.map((entry) => entry.source),
      sha1: installer.sha1,
    })
    let downloaded = 0
    const result = await this.http.download(sources, {
      dest: cacheFile,
      sha1: installer.sha1,
      size: installer.size,
      signal: handle.controller.signal,
      hashPinned: Boolean(installer.sha1),
      retries: 2,
      onBytes: (delta) => {
        downloaded += delta
        job.setMessage(`已下载 ${formatBytes(downloaded)}（安装器）`)
      },
    })
    this.log.info('installer downloaded', {
      jobId: job.id,
      bytes: result.bytes,
      source: result.source,
      sha1: result.sha1,
    })
    return { file: result.file, sha1: result.sha1 }
  }

  private async installWithInstaller(
    handle: JobHandle,
    planResult: LoaderPlanResult,
    java: LoaderJavaResolution | null,
  ): Promise<void> {
    const root = this.requireRoot()
    const job = handle.job
    const plan = planResult.plan
    if (!java) {
      throw new LoaderError('LOADER.JAVA_NOT_FOUND', { message: 'installer needs a Java runtime' })
    }

    const installer = await this.ensureInstaller(handle, plan)

    job.setState('installing')
    job.setStage('install', '运行加载器安装器')
    job.setTask(`启动安装器（Java ${java.major}）`)

    const snapshot: McRootSnapshot = snapshotMcRoot(this.fs, root)
    const profilesCreated = ensureLauncherProfiles(this.fs, root)
    const workDir = path.join(this.options.roots.dataRoot, 'tmp', `loader-${job.id}`)
    this.fs.remove(workDir)
    this.fs.mkdirp(workDir)

    let installedVersionId: string | null = null
    try {
      const run = await runInstaller({
        ports: this.ports,
        javaPath: java.path,
        jarPath: installer.file,
        mcRoot: root,
        workDir,
        timeoutMs: this.installerTimeoutMs,
        signal: handle.controller.signal,
        onLine: (line, stream) => job.log(stream, line),
        onParsed: (parsed) => {
          if (parsed.currentTask) job.setTask(parsed.currentTask)
          if (parsed.percent !== null) job.setPercent(parsed.percent)
        },
      })

      if (run.cancelled || handle.controller.signal.aborted) {
        throw new LoaderError('LOADER.CANCELLED', { message: 'installer cancelled' })
      }
      if (run.timedOut) {
        throw new LoaderError('LOADER.INSTALLER_TIMEOUT', {
          message: formatInstallerFailure(run),
          details: { lines: run.lines.slice(-20) },
        })
      }
      if (run.exitCode !== 0) {
        throw new LoaderError('LOADER.INSTALLER_FAILED', {
          message: formatInstallerFailure(run),
          details: {
            exitCode: run.exitCode,
            signal: run.signal,
            errorLines: run.errorLines.slice(-10),
            stderrTail: run.stderrTail.slice(-10),
          },
        })
      }

      const detected = detectInstalledVersion(
        this.fs,
        root,
        snapshot.versionDirs,
        plan.versionId,
        plan.mcVersion,
      )
      if (!detected) {
        throw new LoaderError('LOADER.PRODUCT_MISSING', {
          message: 'installer exited 0 but no new version JSON was found',
          details: { expected: plan.versionId, lines: run.lines.slice(-20) },
        })
      }
      installedVersionId = detected.versionId
      job.setVersionId(detected.versionId)

      job.setStage('verify', '校验安装结果')
      verifyInstalledVersion(this.fs, root, detected.versionId)
      this.log.info('installer finished', {
        jobId: job.id,
        versionId: detected.versionId,
        durationMs: run.durationMs,
        exitCode: run.exitCode,
        java: java.major,
      })
    } catch (error) {
      const rollback = rollbackLoaderInstall(this.fs, root, snapshot, {
        workDir,
      })
      job.setStage('rollback', '已清理未完成的安装')
      this.log.warn('loader install rollback', {
        jobId: job.id,
        removed: rollback.removedVersionDirs,
        profilesRestored: rollback.restoredProfiles,
        workDirRemoved: rollback.removedWorkDir,
        profilesCreated,
        errors: rollback.errors,
      })
      if (rollback.errors.length > 0) {
        const original = asLoaderError(error)
        throw new LoaderError('LOADER.ROLLBACK_FAILED', {
          message: `${original.message}; cleanup errors: ${rollback.errors.join('; ')}`,
          details: {
            original: original.code,
            removed: rollback.removedVersionDirs,
            errors: rollback.errors,
          },
          cause: error,
        })
      }
      throw error
    } finally {
      try {
        this.fs.remove(workDir)
      } catch {
        /* best effort */
      }
    }
  }
}

export function createLoaderService(options: LoaderServiceOptions): LoaderService {
  return new LoaderService(options)
}

export type { DownloadTask }

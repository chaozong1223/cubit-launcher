import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  JavaCandidate,
  JavaChoice,
  JavaDetectResult,
  JavaInstallFinished,
  JavaInstallJob,
  JavaInstallProgress,
  JavaManaged,
  JavaMatch,
  JavaProviderId,
  JavaProviderInfo,
  JavaRequirement,
  JavaSettings,
  JavaSettingsPatch,
} from '@shared/java'
import type { AppErrorShape } from '@shared/kernel'
import type { ScopedLogger } from '../../kernel/logger'
import type { ModuleRoots } from '../_context'
import { CoreError } from '../../core/errors'
import { nodeFsPort, nodeProcessPort, type FsPort, type ProcessPort } from '../../core/ports'
import { detectJava, JavaDetectionCache } from '../../core/java/detect'
import { chooseJava } from '../../core/java/select'
import { JavaError, asJavaError } from './core/errors'
import { JavaHttp } from './core/http'
import { JavaInstallJob as InstallJob } from './core/job'
import { installJavaPackage } from './core/install'
import { createJavaProviders, type JavaProviderConfig, type JavaProviders } from './core/providers'
import { matchJava, readJavaRequirement } from './core/requirement'
import {
  ensureManagedRoot,
  loadJavaSettings,
  managedJavaRoot,
  mergeJavaSettings,
  saveJavaSettings,
} from './core/settings'

export interface JavaServiceInput {
  requiredMajor?: number | null
  forcedPath?: string | null
  forcedMajor?: number | null
}

export interface JavaServiceOptions {
  fs?: FsPort
  ports?: ProcessPort
  http?: JavaHttp
  providers?: JavaProviders
  providerConfig?: JavaProviderConfig
  appVersion?: string
  platform?: NodeJS.Platform
  arch?: string
  now?: () => number
  /** Test seam: replace the real detection scan. */
  detectImpl?: (input: { force?: boolean }) => Promise<JavaDetectResult>
}

interface JobHandle {
  job: InstallJob
  controller: AbortController
  promise: Promise<void>
}

interface JavaServiceEventMap {
  detectProgress: { done: number; total: number }
  installProgress: JavaInstallProgress
  installFinished: JavaInstallFinished
}

const MAX_JOBS = 10

function buildUserAgent(appVersion: string): string {
  return `mc-launcher/${appVersion} (+https://github.com/mc-launcher; contact: mc-launcher-maintainers@users.noreply.github.com)`
}

/**
 * Java adapter: detection (t6), requirement analysis, instance/global overrides,
 * managed runtime downloads and progress events.
 */
export class JavaModuleService {
  private readonly fs: FsPort
  private readonly ports: ProcessPort
  private readonly cache = new JavaDetectionCache()
  private readonly http: JavaHttp
  private readonly providerRegistry: JavaProviders
  private readonly platform: NodeJS.Platform
  private readonly arch: string
  private readonly now: () => number
  private readonly jobs = new Map<string, JobHandle>()
  private readonly listeners = new Map<string, Set<(payload: unknown) => void>>()
  private config: JavaSettings

  constructor(
    private readonly roots: ModuleRoots,
    private readonly log: ScopedLogger,
    private readonly options: JavaServiceOptions = {},
  ) {
    this.fs = options.fs ?? nodeFsPort()
    this.ports = options.ports ?? nodeProcessPort()
    this.platform = options.platform ?? process.platform
    this.arch = options.arch ?? process.arch
    this.now = options.now ?? Date.now
    this.http =
      options.http ??
      new JavaHttp({
        userAgent: buildUserAgent(options.appVersion ?? '0.1.0'),
        log: {
          debug: (message, fields) => this.log.debug(message, fields),
          warn: (message, fields) => this.log.warn(message, fields),
        },
      })
    this.providerRegistry = options.providers ?? createJavaProviders(this.http, options.providerConfig)
    this.config = loadJavaSettings(this.roots.dataRoot, {
      warn: (message, fields) => this.log.warn(message, fields),
    })
  }

  // ------------------------------------------------------------- detection

  async detect(input: { force?: boolean } = {}): Promise<JavaDetectResult> {
    const result = this.options.detectImpl
      ? await this.options.detectImpl({ force: Boolean(input.force) })
      : await detectJava({
          ports: this.ports,
          fs: this.fs,
          dataRoot: this.roots.dataRoot,
          mcRoot: this.roots.mcRoot,
          exeDir: path.dirname(process.execPath),
          platform: this.platform,
          arch: this.arch,
          cache: this.cache,
          force: Boolean(input.force),
        })
    this.log.info('java detected', {
      candidates: result.candidates.map((candidate) => ({
        path: candidate.path,
        version: candidate.version.raw,
        source: candidate.source,
      })),
      rejected: result.rejected.length,
      cached: result.cached,
      durationMs: result.durationMs,
    })
    this.emitEvent('detectProgress', {
      done: result.candidates.length,
      total: result.candidates.length,
    })
    return result
  }

  async candidates(): Promise<JavaCandidate[]> {
    return (await this.detect()).candidates
  }

  async choose(input: JavaServiceInput = {}): Promise<JavaChoice> {
    const detection = await this.detect()
    const candidates = [...detection.candidates]

    if (input.forcedPath) {
      const forced = input.forcedPath.toLowerCase()
      if (!candidates.some((candidate) => candidate.path.toLowerCase() === forced)) {
        throw new CoreError('JAVA.INVALID', {
          message: `forced Java path is not a usable runtime: ${input.forcedPath}`,
          details: { path: input.forcedPath },
        })
      }
    }

    return chooseJava({
      candidates,
      requiredMajor: input.requiredMajor ?? null,
      forcedPath: input.forcedPath ?? null,
      forcedMajor: input.forcedMajor ?? null,
    })
  }

  invalidate(): void {
    this.cache.clear()
  }

  // ------------------------------------------------------------ requirement

  private requireRoot(): string {
    const root = this.roots.mcRoot
    if (!root) {
      throw new JavaError('JAVA.MC_ROOT_MISSING', { message: 'module roots have no mcRoot' })
    }
    return root
  }

  async requirement(input: { versionId: string }): Promise<JavaRequirement> {
    return readJavaRequirement(
      {
        fs: this.fs,
        mcRoot: this.requireRoot(),
        globalSettings: this.config,
      },
      input.versionId,
    )
  }

  async match(input: { versionId: string }): Promise<JavaMatch> {
    const requirement = await this.requirement(input)
    const detection = await this.detect()
    const providerIds = this.providerRegistry
      .list(this.platform, this.arch)
      .filter((provider) => provider.available)
      .map((provider) => provider.id)
    return matchJava(requirement, detection.candidates, {
      fs: this.fs,
      ports: this.ports,
      platform: this.platform,
      arch: this.arch,
      now: this.now,
      providerIds,
    })
  }

  // --------------------------------------------------------------- settings

  settings(): JavaSettings {
    return {
      ...this.config,
      defaultJava: { ...this.config.defaultJava },
    }
  }

  async updateSettings(patch: JavaSettingsPatch): Promise<JavaSettings> {
    const merged = mergeJavaSettings(this.config, patch)
    this.config = saveJavaSettings(this.roots.dataRoot, merged)
    this.log.info('java settings updated', {
      defaultJava: this.config.defaultJava,
      preferredSource: this.config.preferredSource,
      autoDownload: this.config.autoDownload,
    })
    return this.settings()
  }

  providers(): JavaProviderInfo[] {
    return this.providerRegistry.list(this.platform, this.arch)
  }

  // ---------------------------------------------------------------- managed

  async managed(): Promise<JavaManaged[]> {
    const root = managedJavaRoot(this.roots.dataRoot)
    const detection = await this.detect()
    const managed: JavaManaged[] = []
    for (const candidate of detection.candidates) {
      const relative = path.relative(root, candidate.path)
      if (relative.length === 0 || relative.startsWith('..') || path.isAbsolute(relative)) continue
      const managedDir = relative.split(path.sep)[0] ?? ''
      managed.push({
        path: candidate.path,
        home: candidate.home,
        major: candidate.version.major,
        version: candidate.version.raw,
        vendor: candidate.vendor,
        managedDir,
      })
    }
    return managed.sort((a, b) => a.major - b.major || a.managedDir.localeCompare(b.managedDir))
  }

  // --------------------------------------------------------------- download

  async download(input: { major: number; source: 'auto' | JavaProviderId; force?: boolean }): Promise<JavaInstallJob> {
    if (!Number.isInteger(input.major) || input.major < 8 || input.major > 30) {
      throw new JavaError('JAVA.INVALID_INPUT', {
        message: `invalid Java major: ${String(input.major)}`,
        details: { major: input.major },
      })
    }
    if (!this.config.autoDownload) {
      throw new JavaError('JAVA.DOWNLOAD_DISABLED', { message: 'autoDownload is disabled in Java settings' })
    }
    ensureManagedRoot(this.roots.dataRoot)

    const detection = await this.detect()
    const existing = detection.candidates.find((candidate) => candidate.version.major === input.major)
    if (existing && !input.force) {
      throw new JavaError('JAVA.ALREADY_INSTALLED', {
        message: `Java ${input.major} is already available at ${existing.path}`,
        details: { major: input.major, path: existing.path },
      })
    }

    const requestedSource = input.source === 'auto' ? this.config.preferredSource : input.source
    const pkg = await this.providerRegistry.resolve({
      major: input.major,
      source: input.source,
      preferred: this.config.preferredSource,
      platform: this.platform,
      arch: this.arch,
    })
    this.log.info('java download resolved', {
      major: pkg.major,
      source: pkg.source,
      version: pkg.version,
      size: pkg.size,
      sha256: pkg.sha256,
    })

    const jobId = randomUUID()
    const controller = new AbortController()
    const job = new InstallJob(
      { jobId, major: pkg.major, source: pkg.source, now: this.now },
      {
        onProgress: (progress) => this.emitEvent('installProgress', progress),
        onFinished: (finished) => this.emitEvent('installFinished', finished),
      },
    )
    const handle: JobHandle = { job, controller, promise: Promise.resolve() }
    this.jobs.set(jobId, handle)
    this.pruneJobs()
    handle.promise = this.runDownloadJob(handle, pkg, requestedSource)
    void handle.promise
    return { jobId, major: pkg.major, source: pkg.source }
  }

  private async runDownloadJob(
    handle: JobHandle,
    pkg: Awaited<ReturnType<JavaProviders['resolve']>>,
    requestedSource: JavaProviderId,
  ): Promise<void> {
    const job = handle.job
    try {
      job.setState('downloading')
      job.setStage('download', `从 ${pkg.source === 'adoptium' ? 'Adoptium' : 'Microsoft'} 下载 Java ${pkg.major}`)
      const installed = await installJavaPackage({
        fs: this.fs,
        ports: this.ports,
        http: this.http,
        dataRoot: this.roots.dataRoot,
        pkg,
        platform: this.platform,
        signal: handle.controller.signal,
        onProgress: (delta) => {
          job.update({
            stage: delta.stage,
            ...(delta.percent !== undefined ? { percent: delta.percent } : {}),
            ...(delta.downloadedBytes !== undefined ? { downloadedBytes: delta.downloadedBytes } : {}),
            ...(delta.totalBytes !== undefined ? { totalBytes: delta.totalBytes } : {}),
            ...(delta.entriesDone !== undefined ? { entriesDone: delta.entriesDone } : {}),
            ...(delta.entriesTotal !== undefined ? { entriesTotal: delta.entriesTotal } : {}),
            ...(delta.currentFile !== undefined ? { currentFile: delta.currentFile } : {}),
            ...(delta.message !== undefined ? { message: delta.message } : {}),
          })
          if (delta.stage === 'extract') job.setState('extracting')
          if (delta.stage === 'validate') job.setState('validating')
          if (delta.stage === 'verify') job.setState('verifying')
        },
      })

      this.invalidate()
      const detection = await this.detect({ force: true })
      const detected = detection.candidates.find(
        (candidate) => candidate.path.toLowerCase() === installed.path.toLowerCase(),
      )
      if (!detected) {
        this.log.warn('managed Java installed but not detected', {
          path: installed.path,
          candidates: detection.candidates.map((candidate) => candidate.path),
        })
      } else {
        this.log.info('managed Java detected', {
          path: detected.path,
          major: detected.version.major,
          source: detected.source,
        })
      }

      job.setStage('done')
      job.setState('done', null)
      job.update({ percent: 100, currentFile: installed.path })
      job.finish(null, installed.path, installed.version)
      this.log.info('java install finished', {
        jobId: job.jobId,
        major: installed.major,
        version: installed.version,
        source: requestedSource,
        path: installed.path,
        bytes: installed.bytes,
      })
    } catch (error) {
      const javaError = asJavaError(error)
      const cancelled = handle.controller.signal.aborted || javaError.code === 'JAVA.CANCELLED'
      const state = cancelled ? 'cancelled' : 'failed'
      job.setState(state, javaError.userMessage)
      const shape: AppErrorShape = cancelled
        ? { code: 'JAVA.CANCELLED', message: 'Java 下载已取消', retryable: false }
        : javaError.toShape()
      job.finish(shape, null, null)
      this.log.error('java install failed', {
        jobId: job.jobId,
        major: pkg.major,
        source: pkg.source,
        code: shape.code,
        message: javaError.message,
      })
    }
  }

  downloadStatus(jobId: string): JavaInstallProgress | null {
    return this.jobs.get(jobId)?.job.progress() ?? null
  }

  async cancelDownload(jobId: string): Promise<{ cancelled: boolean }> {
    const handle = this.jobs.get(jobId)
    if (!handle) return { cancelled: false }
    handle.controller.abort()
    this.log.info('java download cancel requested', { jobId })
    return { cancelled: true }
  }

  private pruneJobs(): void {
    const finished = [...this.jobs.values()]
      .filter((handle) => ['done', 'failed', 'cancelled'].includes(handle.job.state))
      .sort((a, b) => a.job.startedAt - b.job.startedAt)
    while (this.jobs.size > MAX_JOBS && finished.length > 0) {
      const oldest = finished.shift()
      if (oldest) this.jobs.delete(oldest.job.jobId)
    }
  }

  /** Wait for a download job (tests + UI fallback). */
  async waitForDownload(jobId: string, timeoutMs = 600_000): Promise<JavaInstallProgress> {
    const handle = this.jobs.get(jobId)
    if (!handle) throw new JavaError('JAVA.INVALID_INPUT', { message: `unknown job ${jobId}` })
    let timer: NodeJS.Timeout | null = null
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new JavaError('JAVA.DOWNLOAD_FAILED', { message: `job ${jobId} timeout` }))
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

  // ----------------------------------------------------------------- events

  onEvent(event: string, listener: (payload: unknown) => void): () => void {
    let set = this.listeners.get(event)
    if (!set) {
      set = new Set()
      this.listeners.set(event, set)
    }
    set.add(listener)
    return () => set?.delete(listener)
  }

  private emitEvent<K extends keyof JavaServiceEventMap>(
    event: K,
    payload: JavaServiceEventMap[K],
  ): void {
    const set = this.listeners.get(event)
    if (!set) return
    for (const listener of [...set]) {
      try {
        listener(payload)
      } catch {
        /* consumer failure must not break downloads */
      }
    }
  }

  dispose(): void {
    for (const handle of this.jobs.values()) {
      handle.controller.abort()
    }
    this.jobs.clear()
    this.listeners.clear()
  }
}

export function createJavaService(
  roots: ModuleRoots,
  log: ScopedLogger,
  options: JavaServiceOptions = {},
): JavaModuleService {
  return new JavaModuleService(roots, log, options)
}

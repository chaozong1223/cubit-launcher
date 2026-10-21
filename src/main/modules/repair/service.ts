import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type {
  RepairErrorShape,
  RepairJobKind,
  RepairProgress,
  RepairReport,
  RepairScanInput,
  RepairStartInput,
} from '@shared/repair'
import type { DownloadProgress, DownloadTask } from '@shared/download'
import type { FsPort } from '../../core/ports'
import { nodeFsPort } from '../../core/ports'
import type { ScopedLogger } from '../../kernel/logger'
import type { ModuleRoots } from '../_context'
import { RepairError, asRepairError } from './core/errors'
import { runDownloadBatch, resolveDownloader, type RepairDownloader } from './core/downloader'
import { RepairJob } from './core/job'
import { scanVersion, type ScanInternal } from './core/scan'

export interface RepairServiceOptions {
  fs?: FsPort
  downloader?: RepairDownloader | null
  platform?: NodeJS.Platform
  arch?: string
  features?: Record<string, boolean>
  mirrorBase?: string
  now?: () => number
  emit?: (event: RepairEventName, payload: unknown) => void
}

export type RepairEventName =
  | 'scanProgress'
  | 'scanFinished'
  | 'repairProgress'
  | 'repairFinished'

interface JobHandle {
  job: RepairJob
  controller: AbortController
  promise: Promise<void>
  report: RepairReport | null
}

const MAX_JOBS = 20

function eventShape(error: RepairError): RepairErrorShape {
  return error.toShape()
}

/**
 * Scan/repair service.
 *
 * Repair downloads only the missing/corrupt tasks produced by the scanner via
 * the t8 download service; extras are reported but never enqueued or deleted.
 * `mods/`, `saves/`, `config/` are never enumerated or written.
 */
export class RepairModuleService {
  private readonly fs: FsPort
  private readonly injectedDownloader: RepairDownloader | null | undefined
  private readonly platform: NodeJS.Platform
  private readonly arch: string
  private readonly now: () => number
  private readonly emit?: (event: RepairEventName, payload: unknown) => void
  private readonly jobs = new Map<string, JobHandle>()

  constructor(
    private readonly roots: ModuleRoots,
    private readonly log: ScopedLogger,
    private readonly options: RepairServiceOptions = {},
  ) {
    this.fs = options.fs ?? nodeFsPort()
    // Keep `undefined` lazy: if the download module registers after repair in
    // the registry glob order, the first repair still finds it.
    this.injectedDownloader = options.downloader
    this.platform = options.platform ?? process.platform
    this.arch = options.arch ?? process.arch
    this.now = options.now ?? Date.now
    this.emit = options.emit
  }

  // --------------------------------------------------------------- public API

  async scan(input: RepairScanInput): Promise<{ jobId: string }> {
    this.validateInput(input.versionId)
    const handle = this.createJob('scan', input.versionId)
    handle.promise = this.runScan(handle, input.verify ?? 'hash')
    void handle.promise
    return { jobId: handle.job.jobId }
  }

  async repair(input: RepairStartInput): Promise<{ jobId: string }> {
    this.validateInput(input.versionId)
    const handle = this.createJob('repair', input.versionId)
    handle.promise = this.runRepair(handle, input.verify ?? 'hash')
    void handle.promise
    return { jobId: handle.job.jobId }
  }

  status(jobId: string): RepairProgress | null {
    return this.jobs.get(jobId)?.job.progress() ?? null
  }

  report(jobId: string): RepairReport | null {
    return this.jobs.get(jobId)?.report ?? null
  }

  listJobs(): RepairProgress[] {
    return [...this.jobs.values()]
      .map((handle) => handle.job.progress())
      .sort((a, b) => a.updatedAt - b.updatedAt)
  }

  async cancel(jobId: string): Promise<{ cancelled: boolean }> {
    const handle = this.jobs.get(jobId)
    if (!handle) return { cancelled: false }
    handle.controller.abort()
    this.log.info('repair cancel requested', { jobId })
    return { cancelled: true }
  }

  async waitForJob(jobId: string, timeoutMs = 120_000): Promise<RepairProgress> {
    const handle = this.jobs.get(jobId)
    if (!handle) {
      throw new RepairError('REPAIR.JOB_NOT_FOUND', { message: `unknown job ${jobId}` })
    }
    let timer: NodeJS.Timeout | null = null
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new RepairError('REPAIR.SCAN_FAILED', { message: `job ${jobId} timeout` }))
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
    for (const handle of this.jobs.values()) handle.controller.abort()
    this.jobs.clear()
  }

  // ------------------------------------------------------------------- jobs

  private createJob(kind: RepairJobKind, versionId: string): JobHandle {
    const jobId = randomUUID()
    const controller = new AbortController()
    const job = new RepairJob(
      { jobId, kind, versionId, now: this.now },
      {
        onProgress: (progress: RepairProgress) => {
          this.emit?.(kind === 'scan' ? 'scanProgress' : 'repairProgress', progress)
        },
        onFinished: (finished) => {
          this.emit?.(kind === 'scan' ? 'scanFinished' : 'repairFinished', finished)
        },
      },
    )
    const handle: JobHandle = { job, controller, promise: Promise.resolve(), report: null }
    this.jobs.set(jobId, handle)
    this.pruneJobs()
    return handle
  }

  private pruneJobs(): void {
    if (this.jobs.size <= MAX_JOBS) return
    const done = [...this.jobs.values()]
      .filter((handle) => ['done', 'failed', 'cancelled'].includes(handle.job.state))
      .sort((a, b) => a.job.startedAt - b.job.startedAt)
    while (this.jobs.size > MAX_JOBS && done.length > 0) {
      const oldest = done.shift()
      if (oldest) this.jobs.delete(oldest.job.jobId)
    }
  }

  private validateInput(versionId: string): void {
    if (!versionId || typeof versionId !== 'string' || versionId.trim().length === 0) {
      throw new RepairError('REPAIR.INVALID_INPUT', { message: 'versionId is required' })
    }
    if (!this.roots.mcRoot) {
      throw new RepairError('REPAIR.MC_ROOT_MISSING', { message: 'module roots have no mcRoot' })
    }
  }

  // ------------------------------------------------------------------- scan

  private async runScan(handle: JobHandle, verify: 'hash' | 'size'): Promise<void> {
    const job = handle.job
    try {
      job.update({ state: 'scanning', stage: 'scan', percent: 0, done: 0, total: 0 })
      const internal = await scanVersion({
        fs: this.fs,
        mcRoot: this.roots.mcRoot!,
        versionId: job.versionId,
        verify,
        platform: this.platform,
        arch: this.arch,
        ...(this.options.features ? { features: this.options.features } : {}),
        ...(this.options.mirrorBase ? { mirrorBase: this.options.mirrorBase } : {}),
        signal: handle.controller.signal,
        onProgress: (done, total, currentFile) => {
          job.update({
            stage: 'scan',
            percent: total > 0 ? (done / total) * 100 : 0,
            done,
            total,
            currentFile,
            message: '校验实例文件',
          })
        },
      })
      handle.report = internal.report
      job.update({
        state: 'done',
        stage: 'done',
        percent: 100,
        done: internal.tasks.length,
        total: internal.tasks.length,
        currentFile: null,
        message: internal.report.ok
          ? '校验完成，文件完整'
          : `发现 ${internal.report.counts.missing} 个缺失、${internal.report.counts.corrupt} 个损坏文件`,
      })
      job.finish({ state: 'done', report: internal.report, error: null })
      this.log.info('repair scan done', {
        jobId: job.jobId,
        versionId: job.versionId,
        ok: internal.report.ok,
        counts: internal.report.counts,
      })
    } catch (error) {
      this.finishWithError(handle, error, 'scan')
    }
  }

  // ------------------------------------------------------------------ repair

  private async runRepair(handle: JobHandle, verify: 'hash' | 'size'): Promise<void> {
    const job = handle.job
    try {
      job.update({ state: 'scanning', stage: 'scan', percent: 0, done: 0, total: 0 })
      let internal = await this.scanPhase(handle, verify, 0, 10)
      handle.report = internal.report
      if (internal.report.ok) {
        this.finishRepair(handle, internal.report, null)
        return
      }

      let badTasks = internal.badTasks
      let percent = 10

      // If the asset index was unusable, download it first, then rescan so the
      // assets list can be enumerated from the freshly downloaded index.
      if (!internal.assetIndexUsable) {
        const primary = badTasks.filter((task) => task.label !== 'asset')
        await this.downloadPhase(
          handle,
          primary,
          percent,
          55,
          internal.report.dirName,
          new Set(internal.corruptTasks.map((task) => task.destRel)),
        )
        percent = 55
        internal = await this.scanPhase(handle, verify, 55, 65)
        badTasks = internal.badTasks
        handle.report = internal.report
      }

      const primary = badTasks.filter((task) => task.label !== 'asset')
      if (primary.length > 0) {
        await this.downloadPhase(
          handle,
          primary,
          percent,
          Math.max(percent, 55),
          internal.report.dirName,
          new Set(internal.corruptTasks.map((task) => task.destRel)),
        )
        percent = Math.max(percent, 55)
      }
      const assets = badTasks.filter((task) => task.label === 'asset')
      if (assets.length > 0) {
        await this.downloadPhase(
          handle,
          assets,
          Math.max(percent, 55),
          85,
          internal.report.dirName,
          new Set(internal.corruptTasks.map((task) => task.destRel)),
        )
      }

      job.update({ state: 'verifying', stage: 'verify', percent: 85, message: '修复后再次校验' })
      const finalScan = await this.scanPhase(handle, verify, 85, 100, 'verify')
      handle.report = finalScan.report
      if (finalScan.report.ok) {
        this.finishRepair(handle, finalScan.report, null)
      } else {
        const error = new RepairError('REPAIR.DOWNLOAD_FAILED', {
          message: '修复后仍有缺失或损坏文件',
          details: {
            missing: finalScan.report.counts.missing,
            corrupt: finalScan.report.counts.corrupt,
          },
        })
        this.finishRepair(handle, finalScan.report, error)
      }
    } catch (error) {
      this.finishWithError(handle, error, 'repair')
    }
  }

  private async scanPhase(
    handle: JobHandle,
    verify: 'hash' | 'size',
    startPercent: number,
    endPercent: number,
    phaseStage: 'scan' | 'verify' = 'scan',
  ): Promise<ScanInternal> {
    const job = handle.job
    job.update({ state: 'scanning', stage: phaseStage, percent: startPercent })
    return scanVersion({
      fs: this.fs,
      mcRoot: this.roots.mcRoot!,
      versionId: job.versionId,
      verify,
      platform: this.platform,
      arch: this.arch,
      ...(this.options.features ? { features: this.options.features } : {}),
      ...(this.options.mirrorBase ? { mirrorBase: this.options.mirrorBase } : {}),
      signal: handle.controller.signal,
      onProgress: (done, total, currentFile) => {
        const ratio = total > 0 ? done / total : 0
        job.update({
          stage: phaseStage,
          percent: startPercent + (endPercent - startPercent) * ratio,
          done,
          total,
          currentFile,
          message: '校验实例文件',
        })
      },
    })
  }

  private getDownloader(): RepairDownloader | null {
    return this.injectedDownloader === undefined
      ? resolveDownloader()
      : this.injectedDownloader
  }

  private async downloadPhase(
    handle: JobHandle,
    tasks: ScanInternal['badTasks'],
    startPercent: number,
    endPercent: number,
    dirName: string,
    corruptDests: Set<string>,
  ): Promise<void> {
    if (tasks.length === 0) return
    const downloader = this.getDownloader()
    if (!downloader) {
      throw new RepairError('REPAIR.DOWNLOADER_UNAVAILABLE', {
        message: 'download module is not registered',
        details: { files: tasks.length },
      })
    }
    for (const task of tasks) {
      if (!isAllowedTarget(task, dirName)) {
        throw new RepairError('REPAIR.UNSAFE_TARGET', {
          message: `refusing to repair unexpected target: ${task.destRel}`,
          details: { destRel: task.destRel },
        })
      }
    }

    // t8's batch enqueue verifies existing files by size only. A same-size
    // corrupt file would therefore be "skipped"; remove exactly the corrupt
    // targets (never extras/user data) so the downloader rewrites them.
    for (const task of tasks) {
      if (!corruptDests.has(task.destRel)) continue
      const absolute = path.resolve(this.roots.mcRoot!, ...task.destRel.split('/'))
      const relative = path.relative(this.roots.mcRoot!, absolute)
      if (relative.length === 0 || relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new RepairError('REPAIR.UNSAFE_TARGET', {
          message: `corrupt target escapes mcRoot: ${task.destRel}`,
          details: { destRel: task.destRel },
        })
      }
      try {
        fs.rmSync(absolute, { force: true })
      } catch (error) {
        throw new RepairError('REPAIR.SCAN_FAILED', {
          message: `cannot remove corrupt file ${task.destRel}`,
          details: { destRel: task.destRel },
          cause: error,
        })
      }
    }

    const job = handle.job
    job.update({
      state: 'downloading',
      stage: 'download',
      percent: startPercent,
      done: 0,
      total: tasks.length,
      message: `修复 ${tasks.length} 个文件`,
    })
    const result = await runDownloadBatch(downloader, tasks as DownloadTask[], {
      signal: handle.controller.signal,
      onProgress: (progress: DownloadProgress) => {
        const ratio =
          progress.bytesTotal > 0
            ? progress.bytesDone / progress.bytesTotal
            : progress.total > 0
              ? progress.done / progress.total
              : 0
        job.update({
          state: 'downloading',
          stage: 'download',
          percent: startPercent + (endPercent - startPercent) * Math.min(1, ratio),
          done: progress.done,
          total: progress.total || tasks.length,
          currentFile: progress.currentFile,
          bytesDone: progress.bytesDone,
          bytesTotal: progress.bytesTotal,
          message: `修复文件 ${progress.done}/${progress.total || tasks.length}`,
        })
      },
    })
    this.log.info('repair download batch done', {
      jobId: job.jobId,
      job: result.jobId,
      files: tasks.length,
      downloaded: result.downloaded,
    })
  }

  private finishRepair(handle: JobHandle, report: RepairReport, error: RepairError | null): void {
    const job = handle.job
    job.update({
      state: error ? 'failed' : 'done',
      stage: error ? 'verify' : 'done',
      percent: error ? 100 : 100,
      currentFile: null,
      message: error
        ? error.userMessage
        : report.ok
          ? `修复完成，${report.counts.extra} 个共享缓存多余文件未删除`
          : '修复完成但仍有问题',
    })
    job.finish({ state: error ? 'failed' : 'done', report, error: error?.toShape() ?? null })
    this.log.info('repair finished', {
      jobId: job.jobId,
      ok: report.ok,
      counts: report.counts,
      error: error?.code ?? null,
    })
  }

  private finishWithError(
    handle: JobHandle,
    error: unknown,
    kind: 'scan' | 'repair',
  ): void {
    const repairError = asRepairError(error, 'REPAIR.SCAN_FAILED')
    const cancelled = handle.controller.signal.aborted || repairError.code === 'REPAIR.CANCELLED'
    const state = cancelled ? 'cancelled' : 'failed'
    const shape: RepairErrorShape = cancelled
      ? { code: 'REPAIR.CANCELLED', message: '已取消', retryable: false }
      : eventShape(repairError)
    handle.job.finish({ state, report: handle.report, error: shape })
    this.log.warn('repair job failed', {
      jobId: handle.job.jobId,
      kind,
      code: shape.code,
      message: repairError.message,
    })
  }
}

function isAllowedTarget(task: { destRel: string; label?: string }, dirName: string): boolean {
  const rel = task.destRel
  if (rel.length === 0 || rel.startsWith('/') || rel.split('/').includes('..')) return false
  if (rel.startsWith('libraries/') || rel.startsWith('assets/indexes/') || rel.startsWith('assets/objects/')) {
    return true
  }
  if (task.label === 'client') {
    return rel === `versions/${dirName}/${dirName}.jar`
  }
  return false
}

export function createRepairService(
  roots: ModuleRoots,
  log: ScopedLogger,
  options: RepairServiceOptions = {},
): RepairModuleService {
  return new RepairModuleService(roots, log, options)
}

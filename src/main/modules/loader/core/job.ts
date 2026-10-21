import type {
  LoaderFinished,
  LoaderJobState,
  LoaderLogEvent,
  LoaderProgress,
  LoaderStage,
  LoaderType,
} from '@shared/loader'
import type { AppErrorShape } from '@shared/kernel'

/**
 * Job bookkeeping + 100 ms log batching for the loader installer.
 *
 * Progress is emitted at most every 100 ms (the kernel also throttles the IPC
 * event); installer output is batched into arrays so a chatty installer cannot
 * flood the renderer one line per IPC message.
 */

export const PROGRESS_THROTTLE_MS = 100
export const LOG_BATCH_MS = 100
export const MAX_LOG_BATCH = 200

export interface LoaderJobCallbacks {
  onProgress?(progress: LoaderProgress): void
  onLog?(event: LoaderLogEvent): void
  onFinished?(event: LoaderFinished): void
}

export interface LoaderJobInit {
  id: string
  type: LoaderType
  mcVersion: string
  loaderVersion: string
  now?: () => number
}

export class LoaderJob {
  readonly id: string
  readonly type: LoaderType
  readonly mcVersion: string
  readonly loaderVersion: string
  readonly startedAt: number

  state: LoaderJobState = 'queued'
  stage: LoaderStage = 'plan'
  percent: number | null = null
  currentTask: string | null = null
  message: string | null = null
  versionId: string | null = null

  private updatedAt: number
  private lastProgressAt = 0
  private readonly now: () => number
  private readonly stdout: string[] = []
  private readonly stderr: string[] = []
  private logTimer: NodeJS.Timeout | null = null
  private readonly callbacks: LoaderJobCallbacks

  constructor(init: LoaderJobInit, callbacks: LoaderJobCallbacks = {}) {
    this.id = init.id
    this.type = init.type
    this.mcVersion = init.mcVersion
    this.loaderVersion = init.loaderVersion
    this.now = init.now ?? Date.now
    this.startedAt = this.now()
    this.updatedAt = this.startedAt
    this.callbacks = callbacks
  }

  private touch(): void {
    this.updatedAt = this.now()
  }

  setState(state: LoaderJobState, message?: string | null): void {
    this.state = state
    if (message !== undefined) this.message = message
    this.touch()
    this.emitProgress(true)
  }

  setStage(stage: LoaderStage, message?: string | null): void {
    this.stage = stage
    if (message !== undefined) this.message = message
    this.touch()
    this.emitProgress(true)
  }

  setPercent(percent: number | null): void {
    this.percent = percent === null ? null : Math.max(0, Math.min(100, Math.round(percent)))
    this.touch()
    this.emitProgress(false)
  }

  setTask(task: string | null): void {
    this.currentTask = task
    this.touch()
    this.emitProgress(false)
  }

  setMessage(message: string | null): void {
    this.message = message
    this.touch()
  }

  setVersionId(versionId: string | null): void {
    this.versionId = versionId
    this.touch()
    this.emitProgress(true)
  }

  progress(): LoaderProgress {
    return {
      jobId: this.id,
      type: this.type,
      mcVersion: this.mcVersion,
      loaderVersion: this.loaderVersion,
      state: this.state,
      stage: this.stage,
      percent: this.percent,
      currentTask: this.currentTask,
      message: this.message,
      startedAt: this.startedAt,
      updatedAt: this.updatedAt,
      versionId: this.versionId,
    }
  }

  private emitProgress(force: boolean): void {
    if (!this.callbacks.onProgress) return
    const now = this.now()
    if (!force && now - this.lastProgressAt < PROGRESS_THROTTLE_MS) return
    this.lastProgressAt = now
    try {
      this.callbacks.onProgress(this.progress())
    } catch {
      /* a consumer must never break the install */
    }
  }

  /** Buffers one installer line; flushed every 100 ms (or on finish). */
  log(stream: 'stdout' | 'stderr', line: string): void {
    const target = stream === 'stdout' ? this.stdout : this.stderr
    target.push(line)
    if (target.length > MAX_LOG_BATCH * 4) target.splice(0, target.length - MAX_LOG_BATCH * 4)
    if (this.logTimer) return
    this.logTimer = setTimeout(() => {
      this.logTimer = null
      this.flushLogs()
    }, LOG_BATCH_MS)
    if (typeof this.logTimer.unref === 'function') this.logTimer.unref()
  }

  flushLogs(): void {
    this.flushStream('stdout', this.stdout)
    this.flushStream('stderr', this.stderr)
  }

  private flushStream(stream: 'stdout' | 'stderr', buffer: string[]): void {
    if (buffer.length === 0 || !this.callbacks.onLog) return
    while (buffer.length > 0) {
      const lines = buffer.splice(0, MAX_LOG_BATCH)
      try {
        this.callbacks.onLog({ jobId: this.id, stream, lines })
      } catch {
        /* ignore consumer failures */
      }
    }
  }

  finish(error: AppErrorShape | null): LoaderFinished {
    this.flushLogs()
    if (this.logTimer) {
      clearTimeout(this.logTimer)
      this.logTimer = null
    }
    const event: LoaderFinished = {
      jobId: this.id,
      ok: error === null && this.state === 'done',
      state: this.state,
      versionId: this.versionId,
      error,
    }
    this.emitProgress(true)
    try {
      this.callbacks.onFinished?.(event)
    } catch {
      /* ignore */
    }
    return event
  }

  dispose(): void {
    if (this.logTimer) clearTimeout(this.logTimer)
    this.logTimer = null
  }
}

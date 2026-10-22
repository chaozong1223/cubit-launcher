import { toErrorShape } from '@shared/errors'
import type { JobError, JobFinished, JobProgress, JobState } from '@shared/job'

/**
 * Small cancellable-job kernel shared by modules that run long file work on the
 * main process (modpack import, instance copy, ...).
 *
 * It mirrors the AbortSignal pattern the download module already uses:
 *   - one `AbortController` per job; `cancel()` aborts it and every blocking
 *     primitive (fetch, stream pipeline) receives the signal;
 *   - cooperative checkpoints between files / archive entries (`checkpoint()`
 *     also waits while the job is paused);
 *   - progress events throttled to 100 ms with a trailing flush, and terminal
 *     events always forced;
 *   - one `cleanup(reason)` hook that runs on cancel/failure, so `.part` files,
 *     temporary extraction directories and half-created instances can be
 *     rolled back in one place.
 *
 * No Electron import: plain Node types only, unit-testable without a window.
 */

export class JobCancelledError extends Error {
  readonly code = 'JOB.CANCELLED'

  constructor(message = '任务已取消') {
    super(message)
    this.name = 'JobCancelledError'
  }
}

/** AbortError from fetch/stream internals counts as cancellation too. */
export function isJobCancelled(error: unknown): boolean {
  if (error instanceof JobCancelledError) return true
  return error instanceof Error && error.name === 'AbortError'
}

const TERMINAL_STATES: readonly JobState[] = ['done', 'failed', 'cancelled']

export function isTerminalState(state: JobState): boolean {
  return TERMINAL_STATES.includes(state)
}

export interface JobInit {
  id: string
  /** Initial progress stage; callers may update it as the job advances. */
  stage?: string
  total?: number
  bytesTotal?: number
  /** Opaque per-job identity (target instance, pack format, ...) for events. */
  meta?: Record<string, string>
  now?: () => number
}

export interface JobUpdate {
  state?: JobState
  stage?: string
  done?: number
  total?: number
  bytesDone?: number
  bytesTotal?: number
  currentFile?: string | null
  message?: string | null
}

export type JobPublisher = (force: boolean) => void

export class JobContext {
  readonly id: string
  readonly meta: Record<string, string>
  readonly startedAt: number
  readonly signal: AbortSignal

  state: JobState = 'queued'
  stage: string
  done = 0
  total: number
  bytesDone = 0
  bytesTotal: number
  currentFile: string | null = null
  message: string | null = null

  private readonly controller = new AbortController()
  private paused = false
  private resumeWaiters: Array<() => void> = []
  private publisher: JobPublisher = () => undefined
  private updatedAtValue: number
  private readonly now: () => number

  constructor(init: JobInit) {
    this.id = init.id
    this.meta = { ...(init.meta ?? {}) }
    this.stage = init.stage ?? 'queued'
    this.total = Math.max(0, init.total ?? 0)
    this.bytesTotal = Math.max(0, init.bytesTotal ?? 0)
    this.now = init.now ?? Date.now
    this.startedAt = this.now()
    this.updatedAtValue = this.startedAt
    this.signal = this.controller.signal
  }

  get updatedAt(): number {
    return this.updatedAtValue
  }

  get isPaused(): boolean {
    return this.paused
  }

  /** Registry hook; never called by task code. */
  setPublisher(publisher: JobPublisher): void {
    this.publisher = publisher
  }

  progress(): JobProgress {
    return {
      jobId: this.id,
      state: this.state,
      stage: this.stage,
      done: Math.max(0, this.done),
      total: Math.max(0, this.total),
      bytesDone:
        this.bytesTotal > 0
          ? Math.min(Math.max(0, this.bytesDone), this.bytesTotal)
          : Math.max(0, this.bytesDone),
      bytesTotal: Math.max(0, this.bytesTotal),
      currentFile: this.currentFile,
      message: this.message,
      startedAt: this.startedAt,
      updatedAt: this.updatedAtValue,
    }
  }

  update(patch: JobUpdate): void {
    let force = false
    if (patch.state !== undefined && patch.state !== this.state) {
      this.state = patch.state
      force = true
    }
    if (patch.stage !== undefined && patch.stage !== this.stage) {
      this.stage = patch.stage
      force = true
    }
    if (patch.done !== undefined) this.done = Math.max(0, patch.done)
    if (patch.total !== undefined) this.total = Math.max(0, patch.total)
    if (patch.bytesDone !== undefined) this.bytesDone = Math.max(0, patch.bytesDone)
    if (patch.bytesTotal !== undefined) this.bytesTotal = Math.max(0, patch.bytesTotal)
    if (patch.currentFile !== undefined) this.currentFile = patch.currentFile
    if (patch.message !== undefined && patch.message !== this.message) {
      this.message = patch.message
      force = true
    }
    this.touch()
    this.publisher(force)
  }

  setStage(stage: string): void {
    this.update({ stage })
  }

  setTotals(total: number, bytesTotal: number): void {
    this.update({ total, bytesTotal })
  }

  addDone(count = 1): void {
    this.done = Math.max(0, this.done + count)
    this.touch()
    this.publisher(false)
  }

  addBytes(delta: number): void {
    if (!Number.isFinite(delta) || delta === 0) return
    this.bytesDone = Math.max(0, this.bytesDone + Math.max(0, delta))
    this.touch()
    this.publisher(false)
  }

  setCurrent(file: string | null): void {
    this.update({ currentFile: file })
  }

  setMessage(message: string | null): void {
    this.update({ message })
  }

  throwIfCancelled(): void {
    if (this.signal.aborted) throw new JobCancelledError()
  }

  /**
   * Cancellation + pause gate. Call between files/entries; long primitives get
   * `signal` directly. While paused the promise resolves on `resume()` and
   * rejects on `cancel()`.
   */
  async checkpoint(): Promise<void> {
    this.throwIfCancelled()
    if (!this.paused) return
    await new Promise<void>((resolve, reject) => {
      const settle = (): void => {
        this.signal.removeEventListener('abort', onAbort)
        const index = this.resumeWaiters.indexOf(onResume)
        if (index >= 0) this.resumeWaiters.splice(index, 1)
      }
      const onResume = (): void => {
        settle()
        resolve()
      }
      const onAbort = (): void => {
        settle()
        reject(new JobCancelledError())
      }
      this.signal.addEventListener('abort', onAbort, { once: true })
      this.resumeWaiters.push(onResume)
    })
  }

  // ------------------------------------------------------------- owner hooks

  internalStart(): void {
    if (isTerminalState(this.state)) return
    this.state = 'running'
    this.touch()
    this.publisher(true)
  }

  internalPause(): boolean {
    if (isTerminalState(this.state) || this.paused) return false
    this.paused = true
    this.state = 'paused'
    this.message = '已暂停'
    this.touch()
    this.publisher(true)
    return true
  }

  internalResume(): boolean {
    if (!this.paused) return false
    this.paused = false
    this.state = 'running'
    this.message = null
    this.touch()
    for (const waiter of this.resumeWaiters.splice(0)) waiter()
    this.publisher(true)
    return true
  }

  internalCancel(): boolean {
    if (isTerminalState(this.state) || this.signal.aborted) return false
    this.paused = false
    this.resumeWaiters.splice(0)
    this.controller.abort()
    this.touch()
    this.publisher(true)
    return true
  }

  internalFinish(state: JobState, message: string | null): void {
    this.state = state
    this.message = message
    this.paused = false
    this.touch()
    this.publisher(true)
  }

  private touch(): void {
    this.updatedAtValue = this.now()
  }
}

export interface JobOutcome<T> extends JobFinished {
  result: T | null
}

export type JobProgressListener = (progress: JobProgress, job: JobContext) => void
export type JobFinishedListener<T> = (outcome: JobOutcome<T>, job: JobContext) => void

export interface JobRunOptions {
  /** Roll back partial work on cancel/failure (`.part`, temp dirs, new dir). */
  cleanup?: (reason: 'cancelled' | 'failed') => void | Promise<void>
  /** Fallback error code when the thrown value is not an AppError. */
  failureCode?: string
  onError?: (error: unknown) => void
}

interface Entry<T> {
  job: JobContext
  finished: Promise<JobOutcome<T>>
  resolve: (outcome: JobOutcome<T>) => void
  lastEmit: number
  timer: NodeJS.Timeout | null
  pending: JobProgress | null
}

export interface JobRegistryOptions {
  now?: () => number
  /** Progress coalescing window; terminal/stage/state events are forced. */
  throttleMs?: number
  maxFinishedJobs?: number
}

/**
 * Owns the job table + the throttled event bus for one service.
 *
 * `start()` returns immediately (the caller hands `jobId` back over IPC) and
 * the task runs in the background. Listener failures never break the task.
 */
export class JobRegistry<T> {
  private readonly entries = new Map<string, Entry<T>>()
  private readonly outcomes = new Map<string, JobOutcome<T>>()
  private readonly progressListeners = new Set<JobProgressListener>()
  private readonly finishedListeners = new Set<JobFinishedListener<T>>()
  private readonly now: () => number
  private readonly throttleMs: number
  private readonly maxFinishedJobs: number

  constructor(options: JobRegistryOptions = {}) {
    this.now = options.now ?? Date.now
    this.throttleMs = Math.max(0, options.throttleMs ?? 100)
    this.maxFinishedJobs = Math.max(1, options.maxFinishedJobs ?? 20)
  }

  onProgress(listener: JobProgressListener): () => void {
    this.progressListeners.add(listener)
    return () => this.progressListeners.delete(listener)
  }

  onFinished(listener: JobFinishedListener<T>): () => void {
    this.finishedListeners.add(listener)
    return () => this.finishedListeners.delete(listener)
  }

  start(
    init: JobInit,
    task: (job: JobContext) => Promise<T>,
    options: JobRunOptions = {},
  ): JobContext {
    if (this.entries.has(init.id)) {
      throw new Error(`duplicate job id: ${init.id}`)
    }
    const job = new JobContext({ ...init, now: init.now ?? this.now })
    let resolveOutcome: (outcome: JobOutcome<T>) => void = () => undefined
    const finished = new Promise<JobOutcome<T>>((resolve) => {
      resolveOutcome = resolve
    })
    const entry: Entry<T> = {
      job,
      finished,
      resolve: resolveOutcome,
      lastEmit: 0,
      timer: null,
      pending: null,
    }
    job.setPublisher((force) => this.publish(entry, force))
    this.entries.set(job.id, entry)
    this.prune()
    job.internalStart()
    void this.execute(entry, task, options)
    return job
  }

  cancel(jobId: string): boolean {
    const entry = this.entries.get(jobId)
    if (!entry) return false
    return entry.job.internalCancel()
  }

  pause(jobId: string): boolean {
    const entry = this.entries.get(jobId)
    if (!entry) return false
    return entry.job.internalPause()
  }

  resume(jobId: string): boolean {
    const entry = this.entries.get(jobId)
    if (!entry) return false
    return entry.job.internalResume()
  }

  status(jobId: string): JobProgress | null {
    return this.entries.get(jobId)?.job.progress() ?? null
  }

  /** Per-job identity set at `start()` (instance id, stage-specific fields). */
  meta(jobId: string): Record<string, string> | null {
    const job = this.entries.get(jobId)?.job
    return job ? { ...job.meta } : null
  }

  /** The terminal outcome, or null while the job is still running. */
  outcome(jobId: string): JobOutcome<T> | null {
    const job = this.entries.get(jobId)?.job
    if (!job || !isTerminalState(job.state)) return null
    // Entry promise already settled for terminal jobs; the result is stored on
    // the resolved value by execute().
    return this.outcomes.get(jobId) ?? null
  }

  list(): JobProgress[] {
    return [...this.entries.values()]
      .sort((a, b) => b.job.startedAt - a.job.startedAt)
      .slice(0, this.maxFinishedJobs)
      .map((entry) => entry.job.progress())
  }

  async waitFor(jobId: string, timeoutMs = 120_000): Promise<JobOutcome<T>> {
    const entry = this.entries.get(jobId)
    if (!entry) throw new Error(`unknown job: ${jobId}`)
    if (isTerminalState(entry.job.state) && this.outcomes.has(jobId)) {
      return this.outcomes.get(jobId) as JobOutcome<T>
    }
    let timer: NodeJS.Timeout | null = null
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`job ${jobId} did not finish within ${timeoutMs} ms`))
      }, timeoutMs)
      timer.unref?.()
    })
    try {
      return await Promise.race([entry.finished, timeout])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  dispose(): void {
    for (const entry of this.entries.values()) {
      entry.job.internalCancel()
      this.disposeEntry(entry)
    }
    this.entries.clear()
    this.outcomes.clear()
    this.progressListeners.clear()
    this.finishedListeners.clear()
  }

  // -------------------------------------------------------------- internals

  private async execute(
    entry: Entry<T>,
    task: (job: JobContext) => Promise<T>,
    options: JobRunOptions,
  ): Promise<void> {
    const job = entry.job
    let result: T | null = null
    let error: JobError | null = null
    let state: JobState = 'done'
    try {
      result = await task(job)
      if (job.signal.aborted) {
        // Cancelled during the (synchronous) finalize step: roll back rather
        // than reporting a "success" the user explicitly cancelled.
        state = 'cancelled'
        result = null
        await this.runCleanup(options, 'cancelled')
        job.internalFinish('cancelled', '任务已取消')
      } else {
        job.internalFinish('done', null)
      }
    } catch (caught) {
      const cancelled = job.signal.aborted || isJobCancelled(caught)
      if (cancelled) {
        state = 'cancelled'
        await this.runCleanup(options, 'cancelled')
        job.internalFinish('cancelled', '任务已取消')
      } else {
        state = 'failed'
        const shape = toErrorShape(caught, options.failureCode ?? 'JOB.FAILED')
        error = { code: shape.code, message: shape.message, retryable: shape.retryable }
        await this.runCleanup(options, 'failed')
        job.internalFinish('failed', error.message)
        try {
          options.onError?.(caught)
        } catch {
          /* a logging hook must never break the registry */
        }
      }
    }

    const outcome: JobOutcome<T> = {
      jobId: job.id,
      state,
      ok: state === 'done' && error === null,
      error,
      durationMs: Math.max(0, job.updatedAt - job.startedAt),
      result: state === 'done' ? result : null,
    }
    this.outcomes.set(job.id, outcome)
    // internalFinish() already published the terminal progress; clear any open
    // throttle timer and fan the outcome out to finished listeners.
    this.disposeEntry(entry)
    for (const listener of [...this.finishedListeners]) {
      try {
        listener(outcome, job)
      } catch {
        /* ignore consumer failures */
      }
    }
    entry.resolve(outcome)
  }

  private async runCleanup(
    options: JobRunOptions,
    reason: 'cancelled' | 'failed',
  ): Promise<void> {
    try {
      await options.cleanup?.(reason)
    } catch {
      /* best effort: never mask the original job failure */
    }
  }

  private publish(entry: Entry<T>, force = false): void {
    const progress = entry.job.progress()
    const at = this.now()
    if (force || at - entry.lastEmit >= this.throttleMs) {
      this.flush(entry, progress, at)
      return
    }
    entry.pending = progress
    if (entry.timer) return
    const delay = Math.max(0, this.throttleMs - (at - entry.lastEmit))
    entry.timer = setTimeout(() => {
      entry.timer = null
      const next = entry.pending
      entry.pending = null
      if (next) this.flush(entry, next, this.now())
    }, delay)
    entry.timer.unref?.()
  }

  private flush(entry: Entry<T>, progress: JobProgress, at: number): void {
    entry.lastEmit = at
    for (const listener of [...this.progressListeners]) {
      try {
        listener(progress, entry.job)
      } catch {
        /* a slow/broken consumer must never stall the job */
      }
    }
  }

  private disposeEntry(entry: Entry<T>): void {
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = null
    entry.pending = null
  }

  private prune(): void {
    if (this.entries.size <= this.maxFinishedJobs) return
    const finished = [...this.entries.values()]
      .filter((entry) => isTerminalState(entry.job.state))
      .sort((a, b) => a.job.startedAt - b.job.startedAt)
    for (const entry of finished) {
      if (this.entries.size <= this.maxFinishedJobs) break
      this.disposeEntry(entry)
      this.entries.delete(entry.job.id)
      this.outcomes.delete(entry.job.id)
    }
  }
}

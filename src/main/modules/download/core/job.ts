import type {
  DownloadFailure,
  DownloadFinished,
  DownloadJobKind,
  DownloadJobState,
  DownloadProgress,
  DownloadSourceId,
  DownloadStage,
} from '@shared/download'

/**
 * Job bookkeeping + the throttled event bus used by the IPC layer.
 *
 * The queue never awaits a listener: `DownloadEventBus.emit` hands the payload
 * to `setImmediate`, so a slow renderer/IPC consumer cannot stall downloads
 * (01 R1.16 "不阻塞主进程"). Progress is throttled per job to 100 ms
 * (docs/03 §6.3) with a trailing flush so the last state always arrives.
 */

export interface JobInit {
  id: string
  kind: DownloadJobKind
  versionId?: string | null
  total: number
  bytesTotal: number
  now?: () => number
}

interface Sample {
  at: number
  bytes: number
}

export class DownloadJob {
  readonly id: string
  readonly kind: DownloadJobKind
  readonly versionId: string | null
  readonly startedAt: number

  state: DownloadJobState = 'queued'
  stage: DownloadStage = 'idle'
  total: number
  bytesTotal: number
  done = 0
  failedCount = 0
  bytesDone = 0
  currentFile: string | null = null
  source: DownloadSourceId | null = null
  message: string | null = null
  failures: DownloadFailure[] = []

  downloadedFiles = 0
  skippedFiles = 0
  bytesTransferred = 0

  private updatedAt: number
  private readonly samples: Sample[] = []
  private readonly now: () => number

  constructor(init: JobInit) {
    this.id = init.id
    this.kind = init.kind
    this.versionId = init.versionId ?? null
    this.total = init.total
    this.bytesTotal = init.bytesTotal
    this.now = init.now ?? Date.now
    this.startedAt = this.now()
    this.updatedAt = this.startedAt
    this.samples.push({ at: this.startedAt, bytes: 0 })
  }

  touch(): void {
    this.updatedAt = this.now()
  }

  setState(state: DownloadJobState, message?: string | null): void {
    this.state = state
    if (message !== undefined) this.message = message
    this.touch()
  }

  setStage(stage: DownloadStage): void {
    this.stage = stage
    this.touch()
  }

  setTotals(total: number, bytesTotal: number): void {
    this.total = total
    this.bytesTotal = bytesTotal
    this.touch()
  }

  setCurrent(file: string | null, source: DownloadSourceId | null): void {
    this.currentFile = file
    this.source = source
    this.touch()
  }

  setMessage(message: string | null): void {
    this.message = message
    this.touch()
  }

  addBytes(delta: number): void {
    this.bytesDone += Math.max(0, delta)
    this.bytesTransferred += Math.max(0, delta)
    this.sample()
    this.touch()
  }

  completeTask(options: { size: number | null; skipped: boolean }): void {
    this.done += 1
    if (options.skipped) {
      this.skippedFiles += 1
      // Existing files count towards the byte bar even though no traffic moved.
      this.bytesDone += options.size ?? 0
    } else {
      this.downloadedFiles += 1
    }
    this.sample()
    this.touch()
  }

  failTask(failure: DownloadFailure): void {
    this.failedCount += 1
    this.failures.push(failure)
    this.touch()
  }

  private sample(): void {
    const at = this.now()
    this.samples.push({ at, bytes: this.bytesTransferred })
    while (this.samples.length > 32) this.samples.shift()
    // Drop samples outside the 2 s sliding window, keep at least two points.
    while (this.samples.length > 2 && at - this.samples[0].at > 2000) this.samples.shift()
  }

  /** Bytes per second over the last ~2 s of transferred data. */
  bytesPerSec(): number {
    if (this.samples.length < 2) return 0
    const first = this.samples[0]
    const last = this.samples[this.samples.length - 1]
    const elapsed = last.at - first.at
    if (elapsed <= 0) return 0
    return Math.max(0, Math.round(((last.bytes - first.bytes) * 1000) / elapsed))
  }

  progress(): DownloadProgress {
    return {
      jobId: this.id,
      kind: this.kind,
      state: this.state,
      stage: this.stage,
      done: this.done,
      failed: this.failedCount,
      total: this.total,
      // Retries can transfer more bytes than the plan; the UI bar stays at 100 %.
      bytesDone: this.bytesTotal > 0 ? Math.min(this.bytesDone, this.bytesTotal) : this.bytesDone,
      bytesTotal: this.bytesTotal,
      currentFile: this.currentFile,
      bytesPerSec: this.bytesPerSec(),
      source: this.source,
      versionId: this.versionId,
      startedAt: this.startedAt,
      updatedAt: this.updatedAt,
      message: this.message,
    }
  }

  finished(): DownloadFinished {
    return {
      jobId: this.id,
      ok: this.state === 'done' && this.failedCount === 0,
      state: this.state,
      downloaded: this.downloadedFiles,
      skipped: this.skippedFiles,
      failed: [...this.failures],
      bytes: this.bytesTransferred,
      durationMs: Math.max(0, this.updatedAt - this.startedAt),
    }
  }
}

export type ProgressListener = (progress: DownloadProgress) => void
export type FinishedListener = (finished: DownloadFinished) => void

/**
 * Progress throttling per job: first event is immediate, later ones are
 * coalesced into a trailing emission every `throttleMs`. Terminal states are
 * always flushed synchronously by the service.
 */
export class JobProgressEmitter {
  private lastEmit = 0
  private timer: NodeJS.Timeout | null = null
  private pending: DownloadProgress | null = null

  constructor(
    private readonly listener: ProgressListener,
    private readonly throttleMs = 100,
    private readonly now: () => number = Date.now,
  ) {}

  push(progress: DownloadProgress, force = false): void {
    const at = this.now()
    if (force || at - this.lastEmit >= this.throttleMs) {
      this.flushNow(progress)
      return
    }
    this.pending = progress
    if (this.timer) return
    const delay = Math.max(0, this.throttleMs - (at - this.lastEmit))
    this.timer = setTimeout(() => {
      this.timer = null
      const next = this.pending
      this.pending = null
      if (next) this.flushNow(next)
    }, delay)
    if (typeof this.timer.unref === 'function') this.timer.unref()
  }

  private flushNow(progress: DownloadProgress): void {
    this.lastEmit = this.now()
    try {
      this.listener(progress)
    } catch {
      /* a consumer error must never break the download */
    }
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.pending = null
  }
}

/**
 * Fan-out bus for finished jobs / raw progress, decoupled from Electron.
 * `publish` is fire-and-forget on `setImmediate`.
 */
export class DownloadEventBus {
  private readonly progressListeners = new Set<ProgressListener>()
  private readonly finishedListeners = new Set<FinishedListener>()

  onProgress(listener: ProgressListener): () => void {
    this.progressListeners.add(listener)
    return () => this.progressListeners.delete(listener)
  }

  onFinished(listener: FinishedListener): () => void {
    this.finishedListeners.add(listener)
    return () => this.finishedListeners.delete(listener)
  }

  publishProgress(progress: DownloadProgress): void {
    for (const listener of [...this.progressListeners]) {
      setImmediate(() => {
        try {
          listener(progress)
        } catch {
          /* ignore consumer failures */
        }
      })
    }
  }

  publishFinished(finished: DownloadFinished): void {
    for (const listener of [...this.finishedListeners]) {
      setImmediate(() => {
        try {
          listener(finished)
        } catch {
          /* ignore consumer failures */
        }
      })
    }
  }

  listenerCount(): number {
    return this.progressListeners.size + this.finishedListeners.size
  }
}

import type {
  JavaInstallFinished,
  JavaInstallProgress,
  JavaInstallStage,
  JavaInstallState,
  JavaProviderId,
} from '@shared/java'
import type { AppErrorShape } from '@shared/kernel'

/** Progress bookkeeping for a managed-JDK download. */
export interface JavaJobEvents {
  onProgress?(progress: JavaInstallProgress): void
  onFinished?(finished: JavaInstallFinished): void
}

export interface JavaJobInit {
  jobId: string
  major: number
  source: JavaProviderId
  now?: () => number
}

const THROTTLE_MS = 100

export class JavaInstallJob {
  readonly jobId: string
  readonly major: number
  readonly source: JavaProviderId
  readonly startedAt: number

  state: JavaInstallState = 'queued'
  stage: JavaInstallStage = 'resolve'
  percent: number | null = null
  downloadedBytes = 0
  totalBytes = 0
  entriesDone = 0
  entriesTotal = 0
  currentFile: string | null = null
  message: string | null = null

  private updatedAt: number
  private lastEmit = 0
  private readonly now: () => number
  private readonly events: JavaJobEvents

  constructor(init: JavaJobInit, events: JavaJobEvents = {}) {
    this.jobId = init.jobId
    this.major = init.major
    this.source = init.source
    this.now = init.now ?? Date.now
    this.startedAt = this.now()
    this.updatedAt = this.startedAt
    this.events = events
  }

  progress(): JavaInstallProgress {
    return {
      jobId: this.jobId,
      major: this.major,
      source: this.source,
      state: this.state,
      stage: this.stage,
      percent: this.percent,
      downloadedBytes: this.downloadedBytes,
      totalBytes: this.totalBytes,
      entriesDone: this.entriesDone,
      entriesTotal: this.entriesTotal,
      currentFile: this.currentFile,
      message: this.message,
      updatedAt: this.updatedAt,
    }
  }

  setState(state: JavaInstallState, message?: string | null): void {
    this.state = state
    if (message !== undefined) this.message = message
    this.touch()
    this.emit(true)
  }

  setStage(stage: JavaInstallStage, message?: string | null): void {
    this.stage = stage
    if (message !== undefined) this.message = message
    this.touch()
    this.emit(true)
  }

  update(delta: {
    stage?: JavaInstallStage
    percent?: number | null
    downloadedBytes?: number
    totalBytes?: number
    entriesDone?: number
    entriesTotal?: number
    currentFile?: string | null
    message?: string | null
  }): void {
    if (delta.stage) this.stage = delta.stage
    if (delta.percent !== undefined) {
      this.percent = delta.percent === null ? null : Math.max(0, Math.min(100, Math.round(delta.percent)))
    }
    if (delta.downloadedBytes !== undefined) this.downloadedBytes = delta.downloadedBytes
    if (delta.totalBytes !== undefined) this.totalBytes = delta.totalBytes
    if (delta.entriesDone !== undefined) this.entriesDone = delta.entriesDone
    if (delta.entriesTotal !== undefined) this.entriesTotal = delta.entriesTotal
    if (delta.currentFile !== undefined) this.currentFile = delta.currentFile
    if (delta.message !== undefined) this.message = delta.message
    this.touch()
    this.emit(false)
  }

  finish(error: AppErrorShape | null, path: string | null, version: string | null): JavaInstallFinished {
    const finished: JavaInstallFinished = {
      jobId: this.jobId,
      ok: error === null && this.state === 'done',
      major: this.major,
      path,
      version,
      error,
    }
    this.touch()
    this.emit(true)
    try {
      this.events.onFinished?.(finished)
    } catch {
      /* ignore consumer */
    }
    return finished
  }

  private touch(): void {
    this.updatedAt = this.now()
  }

  private emit(force: boolean): void {
    if (!this.events.onProgress) return
    const now = this.now()
    if (!force && now - this.lastEmit < THROTTLE_MS) return
    this.lastEmit = now
    try {
      this.events.onProgress(this.progress())
    } catch {
      /* ignore consumer */
    }
  }
}

import type {
  RepairErrorShape,
  RepairJobKind,
  RepairJobState,
  RepairProgress,
  RepairReport,
} from '@shared/repair'

export interface RepairJobEvents {
  onProgress?(progress: RepairProgress): void
  onFinished?(finished: {
    jobId: string
    kind: RepairJobKind
    ok: boolean
    report: RepairReport | null
    error: RepairErrorShape | null
  }): void
}

export interface RepairJobInit {
  jobId: string
  kind: RepairJobKind
  versionId: string
  now?: () => number
}

const THROTTLE_MS = 100

/** Progress/state bookkeeping with 100 ms event throttling. */
export class RepairJob {
  readonly jobId: string
  readonly kind: RepairJobKind
  readonly versionId: string
  readonly startedAt: number

  state: RepairJobState = 'queued'
  stage: RepairProgress['stage'] = 'scan'
  percent: number | null = 0
  done = 0
  total = 0
  currentFile: string | null = null
  message: string | null = null
  bytesDone = 0
  bytesTotal = 0

  private updatedAt: number
  private lastEmit = 0
  private readonly now: () => number
  private readonly events: RepairJobEvents

  constructor(init: RepairJobInit, events: RepairJobEvents = {}) {
    this.jobId = init.jobId
    this.kind = init.kind
    this.versionId = init.versionId
    this.now = init.now ?? Date.now
    this.startedAt = this.now()
    this.updatedAt = this.startedAt
    this.events = events
  }

  progress(): RepairProgress {
    return {
      jobId: this.jobId,
      kind: this.kind,
      versionId: this.versionId,
      state: this.state,
      stage: this.stage,
      percent: this.percent,
      done: this.done,
      total: this.total,
      currentFile: this.currentFile,
      message: this.message,
      bytesDone: this.bytesDone,
      bytesTotal: this.bytesTotal,
      updatedAt: this.updatedAt,
    }
  }

  update(delta: {
    state?: RepairJobState
    stage?: RepairProgress['stage']
    percent?: number | null
    done?: number
    total?: number
    currentFile?: string | null
    message?: string | null
    bytesDone?: number
    bytesTotal?: number
  }): void {
    const stageChanged = delta.stage !== undefined && delta.stage !== this.stage
    const stateChanged = delta.state !== undefined && delta.state !== this.state
    if (delta.state) this.state = delta.state
    if (delta.stage) this.stage = delta.stage
    if (delta.percent !== undefined) {
      this.percent =
        delta.percent === null ? null : Math.max(0, Math.min(100, Math.round(delta.percent)))
    }
    if (delta.done !== undefined) this.done = delta.done
    if (delta.total !== undefined) this.total = delta.total
    if (delta.currentFile !== undefined) this.currentFile = delta.currentFile
    if (delta.message !== undefined) this.message = delta.message
    if (delta.bytesDone !== undefined) this.bytesDone = delta.bytesDone
    if (delta.bytesTotal !== undefined) this.bytesTotal = delta.bytesTotal
    this.touch()
    this.emit(stageChanged || stateChanged)
  }

  finish(input: {
    state: RepairJobState
    report: RepairReport | null
    error: RepairErrorShape | null
    message?: string | null
  }): void {
    this.state = input.state
    if (input.message !== undefined) this.message = input.message
    this.percent = input.state === 'done' ? 100 : this.percent
    this.touch()
    this.emit(true)
    try {
      this.events.onFinished?.({
        jobId: this.jobId,
        kind: this.kind,
        ok: input.state === 'done' && input.error === null,
        report: input.report,
        error: input.error,
      })
    } catch {
      /* consumer failure must not break repair */
    }
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

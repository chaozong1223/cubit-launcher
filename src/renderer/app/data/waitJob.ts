import { BackendError } from './backend'

/** Minimal shape shared by every job-finished event (`mods`, `instance`, ...). */
export interface JobFinishedEvent {
  jobId: string
  ok: boolean
  state: 'queued' | 'running' | 'paused' | 'done' | 'failed' | 'cancelled'
  error: { code: string; message: string } | null
  durationMs: number
}

export interface WaitForJobOptions<T extends JobFinishedEvent> {
  jobId: string
  /** Subscribe BEFORE querying the result so a fast job cannot slip through. */
  subscribe(callback: (event: T) => void): () => void
  /** Fetch the terminal outcome if it already happened (`xxxResult` RPC). */
  fetchResult(): Promise<T | null>
  timeoutMs?: number
}

/**
 * Resolves with the finished event of one job. Long file jobs (modpack import,
 * instance copy) run in the background; a caller that wants the composed
 * result either receives the pushed event or discovers it already completed.
 */
export async function waitForJob<T extends JobFinishedEvent>(
  options: WaitForJobOptions<T>,
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 30 * 60_000
  let unsubscribe: (() => void) | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  const eventPromise = new Promise<T>((resolve) => {
    unsubscribe = options.subscribe((event) => {
      if (event.jobId === options.jobId) resolve(event)
    })
  })

  try {
    const current = await options.fetchResult()
    if (current && current.jobId === options.jobId) return current
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new BackendError('JOB.TIMEOUT', '后台任务等待超时，请稍后刷新查看结果。', true)),
        timeoutMs,
      )
    })
    return await Promise.race([eventPromise, timeoutPromise])
  } finally {
    const stop = unsubscribe as (() => void) | null
    if (stop) stop()
    if (timer) clearTimeout(timer)
  }
}

/** Throws a renderer `BackendError` when a finished job did not succeed. */
export function assertJobSucceeded(event: JobFinishedEvent, fallbackMessage: string): void {
  if (event.ok) return
  if (event.state === 'cancelled') {
    throw new BackendError('JOB.CANCELLED', '任务已取消。', true)
  }
  throw new BackendError(
    event.error?.code ?? 'JOB.FAILED',
    event.error?.message ?? fallbackMessage,
    false,
  )
}

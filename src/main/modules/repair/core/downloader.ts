import type {
  DownloadFailure,
  DownloadFinished,
  DownloadProgress,
  DownloadTask,
} from '@shared/download'
import { getService } from '../../_services'
import { RepairError } from './errors'

/**
 * Adapter over the t8 download service.
 *
 * Repair enqueues only the missing/corrupt files through the public
 * `mc:download:enqueue` surface; hashing, mirror fallback, retries, `.part`
 * resume and atomic rename stay in the install chain.
 */

export interface RepairDownloader {
  enqueue(tasks: DownloadTask[]): Promise<{ jobId: string; total: number }>
  onProgress?(listener: (progress: DownloadProgress) => void): () => void
  onFinished?(listener: (finished: DownloadFinished) => void): () => void
  cancel?(jobId: string): Promise<{ cancelled: boolean }>
  status?(jobId: string): DownloadProgress | null
}

export interface DownloadBatchOptions {
  signal?: AbortSignal
  onProgress?: (progress: DownloadProgress) => void
}

export interface DownloadBatchResult {
  jobId: string
  ok: boolean
  downloaded: number
  skipped: number
  failed: DownloadFailure[]
}

type DownloadModuleService = {
  enqueue(tasks: DownloadTask[]): Promise<{ jobId: string; total: number }>
  onProgress?: (listener: (progress: DownloadProgress) => void) => () => void
  onFinished?: (listener: (finished: DownloadFinished) => void) => () => void
  cancel?: (jobId: string) => Promise<{ cancelled: boolean }>
  status?: (jobId: string) => DownloadProgress | null
}

/** Resolves the live download module; returns null when it failed to register. */
export function resolveDownloader(): RepairDownloader | null {
  const service = getService<DownloadModuleService>('download')
  if (!service || typeof service.enqueue !== 'function') return null
  return {
    enqueue: (tasks) => service.enqueue(tasks),
    ...(typeof service.onProgress === 'function'
      ? { onProgress: (listener) => service.onProgress!(listener) }
      : {}),
    ...(typeof service.onFinished === 'function'
      ? { onFinished: (listener) => service.onFinished!(listener) }
      : {}),
    ...(typeof service.cancel === 'function'
      ? { cancel: (jobId) => service.cancel!(jobId) }
      : {}),
    ...(typeof service.status === 'function' ? { status: (jobId) => service.status!(jobId) } : {}),
  }
}

export async function runDownloadBatch(
  downloader: RepairDownloader,
  tasks: DownloadTask[],
  options: DownloadBatchOptions = {},
): Promise<DownloadBatchResult> {
  if (tasks.length === 0) {
    return { jobId: '', ok: true, downloaded: 0, skipped: 0, failed: [] }
  }

  let jobId: string
  try {
    const queued = await downloader.enqueue(tasks)
    jobId = queued.jobId
  } catch (error) {
    throw new RepairError('REPAIR.DOWNLOAD_FAILED', {
      message: error instanceof Error ? error.message : String(error),
      cause: error,
    })
  }

  let abortListener: (() => void) | null = null
  let pollingTimer: NodeJS.Timeout | null = null
  const unsubscribers: Array<() => void> = []

  try {
    if (options.signal?.aborted) {
      await downloader.cancel?.(jobId)
      throw new RepairError('REPAIR.CANCELLED', { message: 'cancelled before download' })
    }
    if (options.signal) {
      abortListener = () => {
        void downloader.cancel?.(jobId)
      }
      options.signal.addEventListener('abort', abortListener, { once: true })
    }

    const finished = await new Promise<DownloadFinished>((resolve, reject) => {
      const fail = (error: unknown): void => {
        reject(
          error instanceof RepairError
            ? error
            : new RepairError('REPAIR.DOWNLOAD_FAILED', {
                message: error instanceof Error ? error.message : String(error),
                cause: error,
              }),
        )
      }

      if (downloader.onFinished) {
        unsubscribers.push(
          downloader.onFinished((event) => {
            if (event.jobId !== jobId) return
            resolve(event)
          }),
        )
      }
      if (downloader.onProgress && options.onProgress) {
        unsubscribers.push(
          downloader.onProgress((event) => {
            if (event.jobId !== jobId) return
            options.onProgress?.(event)
          }),
        )
      }

      if (!downloader.onFinished) {
        const poll = (): void => {
          try {
            const status = downloader.status?.(jobId) ?? null
            if (!status) return
            options.onProgress?.(status)
            if (status.state === 'done') {
              resolve({
                jobId,
                ok: true,
                state: 'done',
                downloaded: status.done,
                skipped: 0,
                failed: [],
                bytes: status.bytesDone,
                durationMs: 0,
              })
            } else if (status.state === 'failed' || status.state === 'cancelled') {
              reject(
                new RepairError(
                  status.state === 'cancelled' ? 'REPAIR.CANCELLED' : 'REPAIR.DOWNLOAD_FAILED',
                  { message: status.message ?? status.state },
                ),
              )
            }
          } catch (error) {
            fail(error)
          }
        }
        pollingTimer = setInterval(poll, 150)
        if (typeof pollingTimer.unref === 'function') pollingTimer.unref()
        poll()
      }

      if (options.signal) {
        options.signal.addEventListener(
          'abort',
          () => fail(new RepairError('REPAIR.CANCELLED', { message: 'cancelled' })),
          { once: true },
        )
      }
    })

    if (!finished.ok) {
      throw new RepairError('REPAIR.DOWNLOAD_FAILED', {
        message: `download finished with ${finished.failed.length} failed file(s)`,
        details: { failed: finished.failed.slice(0, 10) },
      })
    }
    return {
      jobId,
      ok: true,
      downloaded: finished.downloaded,
      skipped: finished.skipped,
      failed: finished.failed,
    }
  } finally {
    if (abortListener) options.signal?.removeEventListener('abort', abortListener)
    if (pollingTimer) clearInterval(pollingTimer)
    for (const unsubscribe of unsubscribers) unsubscribe()
  }
}

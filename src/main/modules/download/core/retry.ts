import { DownloadError, isDownloadError } from './errors'

/**
 * Retry/backoff shared by metadata fetches and the download queue.
 *
 * docs/03 §6.5: 429/5xx use exponential backoff with jitter and honour
 * `Retry-After`; every source gets 3 retries (R1.3). Cancellations are never
 * retried.
 */

export interface RetryOptions {
  retries: number
  baseDelayMs?: number
  maxDelayMs?: number
  signal?: AbortSignal
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void
}

export interface RetryOutcome<T> {
  value: T
  attempts: number
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export function isRetryable(error: unknown): boolean {
  if (isDownloadError(error)) {
    return error.retryable
  }
  return true
}

/** 300 ms, 600 ms, 1200 ms … capped, ±20 % jitter. */
export function backoffDelay(attempt: number, baseDelayMs = 300, maxDelayMs = 5000): number {
  const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, attempt))
  const jitter = exponential * 0.2 * (Math.random() * 2 - 1)
  return Math.max(50, Math.round(exponential + jitter))
}

export function parseRetryAfter(value: string | null, now: number = Date.now()): number | null {
  if (!value) return null
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(30_000, seconds * 1000)
  const date = Date.parse(value)
  if (Number.isFinite(date)) return Math.max(0, Math.min(30_000, date - now))
  return null
}

export async function withRetries<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions,
): Promise<RetryOutcome<T>> {
  const sleep = options.sleep ?? defaultSleep
  const retries = Math.max(0, options.retries)
  let lastError: unknown = null

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (options.signal?.aborted) {
      throw new DownloadError('DOWNLOAD.CANCELLED', { message: 'aborted before attempt' })
    }
    try {
      const value = await operation(attempt)
      return { value, attempts: attempt + 1 }
    } catch (error) {
      lastError = error
      if (!isRetryable(error)) throw error
      if (attempt >= retries) break
      const delayMs = backoffDelay(attempt, options.baseDelayMs, options.maxDelayMs)
      options.onRetry?.({ attempt: attempt + 1, delayMs, error })
      await sleep(delayMs)
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new DownloadError('DOWNLOAD.HTTP_ERROR', { message: String(lastError) })
}

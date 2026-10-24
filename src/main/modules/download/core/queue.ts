import fs from 'node:fs'
import path from 'node:path'
import { once } from 'node:events'
import { pipeline } from 'node:stream/promises'
import type { DownloadFailure, DownloadSourceId, DownloadTask } from '@shared/download'
import {
  DownloadError,
  asDownloadError,
  isNetworkTransportError,
  isTerminalDownloadError,
} from './errors'
import {
  checkExistingFile,
  cleanStalePart,
  ensureDir,
  partMetaPath,
  partPath,
  readTextFile,
  renameAtomic,
  removeQuietly,
  resolveInside,
  statOrNull,
  writeTextAtomic,
} from './fs-atomic'
import { checkDigest, createHasherSet, hashFile, resolveExpectedHash } from './hash'
import { contentLength, headerValue, type StreamResponse } from './http'
import { backoffDelay } from './retry'
import { describeCandidates, type SourceRegistry } from './sources'

/**
 * Concurrent download queue (docs/03 §6.3, 01 R1.2–R1.5).
 *
 * Order of operations for every file:
 *   1. skip when the destination already has the expected size (and, when
 *      asked, the expected hash);
 *   2. write into `<dest>.part`; resume with `Range` when a part file exists;
 *   3. a `200` reply to a Range request restarts from zero (server has no
 *      range support — SEC-DL-03), a `416` deletes the part and retries;
 *   4. after the last byte the *whole* file is size- and hash-checked; a
 *      mismatch deletes the part and downloads again (SEC-DL-01);
 *   5. only then is the file renamed into place (SEC-DL-02).
 *
 * Retries are per source (default 3, R1.3); when every candidate fails the task
 * fails with `DOWNLOAD.NO_SOURCE` and the list of attempted URLs.
 */

export interface QueueLogger {
  debug(message: string, fields?: Record<string, unknown>): void
  info(message: string, fields?: Record<string, unknown>): void
  warn(message: string, fields?: Record<string, unknown>): void
  error(message: string, fields?: Record<string, unknown>): void
}

export interface QueueHooks {
  onTaskStart?(task: DownloadTask, destRel: string, source: DownloadSourceId): void
  onBytes?(delta: number, destRel: string, source: DownloadSourceId): void
  onTaskDone?(task: DownloadTask, destRel: string, skipped: boolean, bytes: number): void
  onTaskFailed?(failure: DownloadFailure): void
}

export interface QueueOptions extends QueueHooks {
  /** Game root; every `destRel` is resolved strictly inside it. */
  root: string
  http: import('./http').HttpClient
  sources: SourceRegistry
  concurrency: number
  perHostConcurrency: number
  maxRetries: number
  verifyExisting: 'size' | 'hash'
  speedLimitBytesPerSec?: number
  signal?: AbortSignal
  isPaused?: () => boolean
  /** Delete the `.part` file when the user cancels (R1.5). */
  cleanPartOnCancel?: boolean
  log?: QueueLogger
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

export interface TaskOutcome {
  destRel: string
  status: 'downloaded' | 'skipped' | 'failed'
  bytes: number
  source: DownloadSourceId | null
  attempts: number
  skipped: boolean
  code: string | null
  message: string | null
}

export interface QueueResult {
  outcomes: TaskOutcome[]
  failures: DownloadFailure[]
  downloaded: number
  skipped: number
  bytes: number
  cancelled: boolean
  paused: boolean
  durationMs: number
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function sleepWithAbort(
  ms: number,
  signal?: AbortSignal,
  sleep: (ms: number) => Promise<void> = defaultSleep,
): Promise<void> {
  if (!signal) return sleep(ms)
  if (signal.aborted) return Promise.reject(cancelledError())
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(cancelledError())
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function cancelledError(): DownloadError {
  return new DownloadError('DOWNLOAD.CANCELLED', { message: 'download cancelled' })
}

interface PartValidators {
  etag: string | null
  lastModified: string | null
}

async function readPartValidators(destination: string): Promise<PartValidators | null> {
  try {
    const text = await readTextFile(partMetaPath(destination))
    const parsed = JSON.parse(text) as { etag?: unknown; lastModified?: unknown }
    const etag = typeof parsed.etag === 'string' ? parsed.etag : null
    const lastModified = typeof parsed.lastModified === 'string' ? parsed.lastModified : null
    return etag || lastModified ? { etag, lastModified } : null
  } catch {
    return null
  }
}

async function writePartValidators(destination: string, response: StreamResponse): Promise<void> {
  const etag = headerValue(response.headers, 'etag')
  const lastModified = headerValue(response.headers, 'last-modified')
  if (!etag && !lastModified) {
    await removeQuietly(partMetaPath(destination))
    return
  }
  try {
    await writeTextAtomic(
      partMetaPath(destination),
      `${JSON.stringify({ etag, lastModified }, null, 2)}\n`,
    )
  } catch {
    // Validators are an optimization for resumption, not a download blocker.
  }
}

async function removePart(destination: string): Promise<void> {
  await removeQuietly(partPath(destination))
  await removeQuietly(partMetaPath(destination))
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw cancelledError()
}

class HostLimiter {
  private readonly state = new Map<string, { active: number; queue: Array<() => void> }>()

  constructor(private readonly limit: number) {}

  private entry(host: string): { active: number; queue: Array<() => void> } {
    let value = this.state.get(host)
    if (!value) {
      value = { active: 0, queue: [] }
      this.state.set(host, value)
    }
    return value
  }

  async acquire(host: string): Promise<() => void> {
    const state = this.entry(host)
    if (state.active < this.limit) {
      state.active += 1
    } else {
      await new Promise<void>((resolve) => state.queue.push(resolve))
      // The releasing call already handed its slot to us (see release below);
      // incrementing here as well would let a fast new caller overshoot.
    }
    let released = false
    return () => {
      if (released) return
      released = true
      state.active = Math.max(0, state.active - 1)
      const next = state.queue.shift()
      if (next) {
        // Transfer the slot atomically: no window for a new acquire() to race.
        state.active += 1
        next()
      }
    }
  }
}

class RateLimiter {
  private startedAt = 0
  private bytes = 0

  constructor(
    private readonly bytesPerSec: number,
    private readonly now: () => number = Date.now,
  ) {}

  async consume(bytes: number, signal?: AbortSignal, sleep = defaultSleep): Promise<void> {
    if (this.bytesPerSec <= 0) return
    if (this.startedAt === 0) this.startedAt = this.now()
    this.bytes += bytes
    const expectedMs = (this.bytes / this.bytesPerSec) * 1000
    const elapsed = this.now() - this.startedAt
    const wait = expectedMs - elapsed
    if (wait > 1) await sleepWithAbort(Math.min(wait, 1000), signal, sleep)
  }
}

interface Candidate {
  source: DownloadSourceId
  url: string
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return 'invalid'
  }
}

async function writeStreamToFile(
  response: StreamResponse,
  part: string,
  options: {
    resumeFrom: number
    expectedSize: number | null
    algorithms: ReturnType<typeof resolveExpectedHash>
    signal?: AbortSignal
    onBytes?: (delta: number) => void
    rateLimiter?: RateLimiter
    sleep?: (ms: number) => Promise<void>
  },
): Promise<{ written: number; digest: Partial<Record<'sha1' | 'sha256' | 'sha512', string>> }> {
  const algorithms = options.algorithms ? [options.algorithms.algorithm] : []
  const hasher = options.resumeFrom === 0 && algorithms.length > 0 ? createHasherSet(algorithms) : null

  // The destination directory may not exist yet (fresh `libraries/…` tree).
  await ensureDir(path.dirname(part))

  const stream = fs.createWriteStream(part, {
    flags: options.resumeFrom > 0 ? 'a' : 'w',
  })
  let streamError: Error | null = null
  stream.on('error', (error) => {
    streamError = error instanceof Error ? error : new Error(String(error))
  })

  const waitForDrainOrClose = async (): Promise<void> => {
    await Promise.race([
      once(stream, 'drain').then(() => undefined),
      new Promise<void>((resolve) => stream.once('close', () => resolve())),
    ])
  }

  let written = 0

  try {
    for await (const chunk of response.stream) {
      throwIfAborted(options.signal)
      if (streamError) throw streamError
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
      if (!stream.write(buffer)) {
        await waitForDrainOrClose()
        if (streamError) throw streamError
      }
      written += buffer.length
      hasher?.update(buffer)
      options.onBytes?.(buffer.length)
      if (options.rateLimiter) {
        await options.rateLimiter.consume(buffer.length, options.signal, options.sleep)
      }
    }

    await new Promise<void>((resolve, reject) => {
      stream.end(() => {
        if (streamError) reject(streamError)
        else resolve()
      })
    })
  } catch (error) {
    stream.destroy()
    throw error
  }

  const size = (await statOrNull(part))?.size ?? 0
  if (options.expectedSize !== null && size !== options.expectedSize) {
    throw new DownloadError('DOWNLOAD.SIZE_MISMATCH', {
      message: `size ${size} != metadata ${options.expectedSize} (${part})`,
      details: { expected: options.expectedSize, actual: size },
    })
  }

  const digest = hasher?.digest() ?? (algorithms.length > 0 ? await hashFile(part, algorithms) : {})
  return { written, digest }
}

/** Files at least this big are fetched as parallel byte ranges. */
const CHUNK_THRESHOLD_BYTES = 4 * 1024 * 1024
/** Smallest range worth a separate connection (handshake cost). */
const MIN_CHUNK_BYTES = 2 * 1024 * 1024
const MAX_CHUNKS = 6

interface ChunkRange {
  start: number
  end: number
}

export function planChunkRanges(size: number): ChunkRange[] {
  if (size < CHUNK_THRESHOLD_BYTES) return [{ start: 0, end: Math.max(0, size - 1) }]
  const count = Math.max(1, Math.min(MAX_CHUNKS, Math.floor(size / MIN_CHUNK_BYTES)))
  const base = Math.floor(size / count)
  const ranges: ChunkRange[] = []
  let start = 0
  for (let index = 0; index < count; index += 1) {
    const end = index === count - 1 ? size - 1 : start + base - 1
    ranges.push({ start, end })
    start = end + 1
  }
  return ranges
}

/**
 * Splits one large file across several Range requests and concatenates the
 * pieces. Minecraft installs contain a handful of big artifacts (client jar,
 * some assets) where a single connection is capped well below the link speed;
 * parallel ranges bring those up to the same throughput as the many small files.
 *
 * Returns the number of bytes written on success, or `null` when the server does
 * not honour byte ranges (the caller then falls back to a single request).
 */
async function transferChunked(
  task: DownloadTask,
  candidate: Candidate,
  dest: string,
  options: QueueOptions,
  hooks: QueueHooks,
  hostLimiter: HostLimiter,
  rateLimiter: RateLimiter,
  size: number,
): Promise<number | null> {
  const part = partPath(dest)
  const ranges = planChunkRanges(size)
  if (ranges.length <= 1) return null

  const pieces: string[] = ranges.map((_, index) => `${part}.c${index}`)
  const cleanup = async (): Promise<void> => {
    for (const piece of pieces) await removeQuietly(piece)
  }

  try {
    let written = 0
    await Promise.all(
      ranges.map(async (range, index) => {
        const release = await hostLimiter.acquire(hostOf(candidate.url))
        try {
          const response = await options.http.openStream(candidate.url, {
            headers: { range: `bytes=${range.start}-${range.end}` },
            signal: options.signal,
            idleTimeoutMs: 30_000,
            isRedirectAllowed: (from, to) =>
              options.sources.isRedirectAllowed(candidate.source, from, to, {
                hashPinned: Boolean(resolveExpectedHash(task)),
              }),
          })
          if (response.status !== 206) {
            response.stream.resume()
            throw new ChunkUnsupported()
          }
          const contentRange = headerValue(response.headers, 'content-range')
          const match = contentRange ? /^bytes (\d+)-(\d+)\/(\d+|\*)$/i.exec(contentRange) : null
          if (!match || Number(match[1]) !== range.start || Number(match[2]) !== range.end) {
            response.stream.destroy()
            throw new ChunkUnsupported()
          }
          const result = await writeStreamToFile(response, pieces[index], {
            resumeFrom: 0,
            expectedSize: range.end - range.start + 1,
            algorithms: null,
            signal: options.signal,
            ...(options.sleep ? { sleep: options.sleep } : {}),
            rateLimiter,
            onBytes: (delta) => hooks.onBytes?.(delta, task.destRel, candidate.source),
          })
          written += result.written
        } finally {
          release()
        }
      }),
    )

    await ensureDir(path.dirname(part))
    const sink = fs.createWriteStream(part, { flags: 'w' })
    try {
      for (const piece of pieces) {
        await pipeline(fs.createReadStream(piece), sink, { end: false })
      }
    } finally {
      await new Promise<void>((resolve) => sink.end(() => resolve()))
    }

    const onDisk = (await statOrNull(part))?.size ?? 0
    if (onDisk !== size) {
      await removeQuietly(part)
      throw new DownloadError('DOWNLOAD.SIZE_MISMATCH', {
        message: `chunked size ${onDisk} != metadata ${size} (${part})`,
        details: { expected: size, actual: onDisk },
      })
    }
    return written
  } catch (error) {
    await cleanup()
    if (error instanceof ChunkUnsupported) return null
    throw error
  } finally {
    await cleanup()
  }
}

/** Internal signal: the server did not honour the Range request. */
class ChunkUnsupported extends Error {}

async function transfer(
  task: DownloadTask,
  candidate: Candidate,
  dest: string,
  options: QueueOptions,
  hooks: QueueHooks,
  hostLimiter: HostLimiter,
  rateLimiter: RateLimiter,
): Promise<number> {
  const expectedHash = resolveExpectedHash(task)
  if (!expectedHash && candidate.source !== 'official') {
    // SEC-DL-04: no hash + third-party source = refuse.
    throw new DownloadError('DOWNLOAD.HASH_REQUIRED', {
      message: `no trusted hash for ${task.destRel} from ${candidate.source}`,
      details: { destRel: task.destRel, source: candidate.source },
    })
  }

  const part = partPath(dest)
  const existingPart = await statOrNull(part)
  let resumeFrom = existingPart?.isFile ? existingPart.size : 0
  const expectedSize = typeof task.size === 'number' ? task.size : null
  const partValidators = resumeFrom > 0 ? await readPartValidators(dest) : null

  if (expectedSize !== null && resumeFrom > expectedSize) {
    await removePart(dest)
    resumeFrom = 0
  }

  if (expectedSize !== null && resumeFrom > 0 && resumeFrom === expectedSize) {
    // A crash may leave a complete `.part`; verify and adopt it without a request.
    const digest = expectedHash
      ? await hashFile(part, [expectedHash.algorithm], { signal: options.signal })
      : {}
    if (checkDigest(expectedHash, digest).ok) {
      await renameAtomic(part, dest)
      await removeQuietly(partMetaPath(dest))
      return 0
    }
    await removePart(dest)
    resumeFrom = 0
  }

  // Large artifacts: fetch as parallel byte ranges (see transferChunked). Only
  // from a clean slate — a half-written .part must keep using the single resume
  // path so its existing bytes are not duplicated.
  if (
    expectedHash &&
    expectedSize !== null &&
    expectedSize >= CHUNK_THRESHOLD_BYTES &&
    resumeFrom === 0
  ) {
    const chunkedBytes = await transferChunked(
      task,
      candidate,
      dest,
      options,
      hooks,
      hostLimiter,
      rateLimiter,
      expectedSize,
    )
    if (chunkedBytes !== null) {
      const digest = await hashFile(part, [expectedHash.algorithm], { signal: options.signal })
      const check = checkDigest(expectedHash, digest)
      if (!check.ok) {
        await removePart(dest)
        throw new DownloadError('DOWNLOAD.HASH_MISMATCH', {
          message: `hash mismatch for ${task.destRel} (${check.algorithm})`,
          details: {
            destRel: task.destRel,
            algorithm: check.algorithm,
            expected: check.expected,
            actual: check.actual,
            source: candidate.source,
          },
        })
      }
      await renameAtomic(part, dest)
      await removeQuietly(partMetaPath(dest))
      return chunkedBytes
    }
  }

  const release = await hostLimiter.acquire(hostOf(candidate.url))
  let response: StreamResponse | null = null

  try {
    const headers: Record<string, string> = {}
    if (resumeFrom > 0) {
      headers.range = `bytes=${resumeFrom}-`
      // RFC 9110 If-Range: only send when the resource is unchanged. We also
      // verify the 206 validators below because some CDNs ignore If-Range.
      if (partValidators?.etag) headers['if-range'] = partValidators.etag
      else if (partValidators?.lastModified) headers['if-range'] = partValidators.lastModified
    }
    response = await options.http.openStream(candidate.url, {
      headers,
      signal: options.signal,
      idleTimeoutMs: 30_000,
      isRedirectAllowed: (from, to) =>
        options.sources.isRedirectAllowed(candidate.source, from, to, {
          hashPinned: Boolean(expectedHash),
        }),
    })

    if (response.status === 416) {
      response.stream.resume()
      await removePart(dest)
      throw new DownloadError('DOWNLOAD.HTTP_ERROR', {
        message: `416 range not satisfiable; restarting ${task.destRel}`,
        details: { url: candidate.url, status: 416 },
        retryable: true,
      })
    }

    if (response.status === 200 && resumeFrom > 0) {
      // Server ignored Range: fall back to a single connection from byte 0.
      resumeFrom = 0
      await removeQuietly(partMetaPath(dest))
    } else if (response.status !== 200 && response.status !== 206) {
      response.stream.resume()
      const retryable =
        response.status === 408 ||
        response.status === 429 ||
        response.status === 425 ||
        response.status >= 500
      throw new DownloadError('DOWNLOAD.HTTP_ERROR', {
        message: `unexpected status ${response.status} for ${task.destRel}`,
        details: { url: candidate.url, status: response.status },
        retryable,
      })
    }

    if (response.status === 206) {
      const contentRange = headerValue(response.headers, 'content-range')
      const match = contentRange ? /^bytes (\d+)-(\d+)\/(\d+|\*)$/i.exec(contentRange) : null
      if (!match || Number(match[1]) !== resumeFrom) {
        response.stream.destroy()
        await removePart(dest)
        throw new DownloadError('DOWNLOAD.HTTP_ERROR', {
          message: `bad content-range "${contentRange ?? ''}" for ${task.destRel}`,
          details: { url: candidate.url, contentRange },
          retryable: true,
        })
      }
      if (expectedSize !== null && match[3] !== '*' && Number(match[3]) !== expectedSize) {
        response.stream.destroy()
        await removePart(dest)
        throw new DownloadError('DOWNLOAD.SIZE_MISMATCH', {
          message: `remote total ${match[3]} != metadata ${expectedSize}`,
          details: { expected: expectedSize, actual: Number(match[3]) },
        })
      }
      if (partValidators) {
        const responseEtag = headerValue(response.headers, 'etag')
        const responseLastModified = headerValue(response.headers, 'last-modified')
        const etagChanged =
          partValidators.etag !== null &&
          (responseEtag === null || responseEtag !== partValidators.etag)
        const lastModifiedChanged =
          partValidators.etag === null &&
          partValidators.lastModified !== null &&
          (responseLastModified === null || responseLastModified !== partValidators.lastModified)
        if (etagChanged || lastModifiedChanged) {
          response.stream.destroy()
          await removePart(dest)
          throw new DownloadError('DOWNLOAD.RANGE_VALIDATOR_CHANGED', {
            message: `range validator changed for ${task.destRel}; restarting from zero`,
            details: {
              url: candidate.url,
              expectedEtag: partValidators.etag,
              actualEtag: responseEtag,
              expectedLastModified: partValidators.lastModified,
              actualLastModified: responseLastModified,
            },
          })
        }
      }
    }

    const declared = contentLength(response.headers)
    if (expectedSize !== null && declared !== null && resumeFrom + declared !== expectedSize) {
      response.stream.destroy()
      await removePart(dest)
      throw new DownloadError('DOWNLOAD.SIZE_MISMATCH', {
        message: `content-length ${declared} + ${resumeFrom} != metadata ${expectedSize}`,
        details: { expected: expectedSize, actual: resumeFrom + declared },
      })
    }

    // Store validators for the next resume attempt before streaming begins.
    await writePartValidators(dest, response)

    const { written, digest } = await writeStreamToFile(response, part, {
      resumeFrom,
      expectedSize,
      algorithms: expectedHash,
      signal: options.signal,
      ...(options.sleep ? { sleep: options.sleep } : {}),
      rateLimiter,
      onBytes: (delta) => hooks.onBytes?.(delta, task.destRel, candidate.source),
    })

    const check = checkDigest(expectedHash, digest)
    if (!check.ok) {
      await removePart(dest)
      throw new DownloadError('DOWNLOAD.HASH_MISMATCH', {
        message: `hash mismatch for ${task.destRel} (${check.algorithm})`,
        details: {
          destRel: task.destRel,
          algorithm: check.algorithm,
          expected: check.expected,
          actual: check.actual,
          source: candidate.source,
        },
      })
    }

    await renameAtomic(part, dest)
    await removeQuietly(partMetaPath(dest))
    return written
  } catch (error) {
    if (response && !response.stream.destroyed) response.stream.destroy()
    // A cancelled/paused job must not leave a half file behind, even when the
    // abort surfaced as ECONNRESET rather than as DOWNLOAD.CANCELLED.
    const terminal = options.signal?.aborted === true || isTerminalDownloadError(error)
    if (terminal && options.cleanPartOnCancel !== false) {
      await removePart(dest)
    }
    if (options.signal?.aborted) throw cancelledError()
    throw error
  } finally {
    release()
  }
}

export async function runTasks(
  tasks: DownloadTask[],
  options: QueueOptions,
): Promise<QueueResult> {
  const startedAt = options.now?.() ?? Date.now()
  const sleep = options.sleep ?? defaultSleep
  const hostLimiter = new HostLimiter(Math.max(1, options.perHostConcurrency))
  const rateLimiter = new RateLimiter(Math.max(0, options.speedLimitBytesPerSec ?? 0), options.now)
  const hooks: QueueHooks = options

  // Validate every destination before the first request: a bad path must not
  // leave a half-installed game directory behind.
  const destinations = new Map<DownloadTask, string>()
  for (const task of tasks) {
    destinations.set(task, resolveInside(options.root, task.destRel))
  }

  const outcomes: TaskOutcome[] = new Array(tasks.length)
  const failures: DownloadFailure[] = []
  const order = tasks
    .map((task, index) => ({ task, index }))
    .sort((a, b) => (b.task.priority ?? 5) - (a.task.priority ?? 5) || a.index - b.index)

  let cursor = 0
  let cancelled = false
  let paused = false
  let downloaded = 0
  let skipped = 0
  let bytes = 0

  const waitWhilePaused = async (): Promise<void> => {
    while (options.isPaused?.() && !options.signal?.aborted) {
      paused = true
      await sleepWithAbort(100, options.signal, sleep)
    }
  }

  const runOne = async (task: DownloadTask, index: number): Promise<void> => {
    const destRel = task.destRel
    const dest = destinations.get(task) as string

    try {
      throwIfAborted(options.signal)
      await cleanStalePart(dest, options.now?.() ?? Date.now())

      const existing = await checkExistingFile(dest, {
        sha1: task.sha1,
        sha256: task.sha256,
        sha512: task.sha512,
        expectedSize: typeof task.size === 'number' ? task.size : null,
        verify: options.verifyExisting,
        signal: options.signal,
      })

      if (existing.ok) {
        skipped += 1
        outcomes[index] = {
          destRel,
          status: 'skipped',
          bytes: 0,
          source: null,
          attempts: 0,
          skipped: true,
          code: null,
          message: null,
        }
        hooks.onTaskDone?.(task, destRel, true, existing.actualSize ?? 0)
        return
      }

      const sourcePolicy =
        task.sourcePolicy ?? (task.label === 'version-json' ? 'metadata' : 'file')
      const candidates = options.sources.candidates(task, sourcePolicy)
      const availability = options.sources.availability(task, sourcePolicy)
      if (candidates.length === 0) {
        const errorCode = availability.network
          ? 'DOWNLOAD.NETWORK_UNREACHABLE'
          : 'DOWNLOAD.NO_SOURCE'
        throw new DownloadError(errorCode, {
          message: availability.network
            ? `all applicable sources are cooling down for ${destRel}; retry in ${availability.retryAfterMs ?? 0} ms`
            : `no enabled source for ${destRel}`,
          details: {
            destRel,
            attempted: [],
            disabled: options.sources.disabledSources(),
            cooling: availability.cooling,
            possible: availability.possible,
            retryAfterMs: availability.retryAfterMs,
          },
        })
      }

      let lastError: DownloadError | null = null
      const attemptedUrls: string[] = []

      for (const candidate of candidates) {
        for (let attempt = 0; attempt <= options.maxRetries; attempt += 1) {
          throwIfAborted(options.signal)
          await waitWhilePaused()
          throwIfAborted(options.signal)
          attemptedUrls.push(candidate.url)
          hooks.onTaskStart?.(task, destRel, candidate.source)
          try {
            const transferred = await transfer(
              task,
              candidate,
              dest,
              options,
              hooks,
              hostLimiter,
              rateLimiter,
            )
            options.sources.recordSuccess(candidate.source)
            downloaded += 1
            bytes += transferred
            outcomes[index] = {
              destRel,
              status: 'downloaded',
              bytes: transferred,
              source: candidate.source,
              attempts: attempt + 1,
              skipped: false,
              code: null,
              message: null,
            }
            options.log?.info('file downloaded', {
              destRel,
              source: candidate.source,
              attempts: attempt + 1,
              bytes: transferred,
            })
            hooks.onTaskDone?.(task, destRel, false, transferred)
            return
          } catch (error) {
            const downloadError = asDownloadError(error)
            if (isTerminalDownloadError(downloadError)) throw downloadError
            // A user cancellation/reset must never trip the session breaker:
            // an aborted transfer can surface as ECONNRESET.
            if (options.signal?.aborted) throw cancelledError()
            lastError = downloadError
            options.sources.recordFailure(candidate.source, downloadError.message)
            options.log?.warn('download attempt failed', {
              destRel,
              source: candidate.source,
              attempt: attempt + 1,
              code: downloadError.code,
              message: downloadError.message,
            })
            if (attempt >= options.maxRetries) break
            await sleepWithAbort(backoffDelay(attempt), options.signal, sleep)
          }
        }
      }

      const finalAvailability = options.sources.availability(task, sourcePolicy)
      const networkUnavailable =
        finalAvailability.network || isNetworkTransportError(lastError)
      const failureError =
        networkUnavailable
          ? new DownloadError('DOWNLOAD.NETWORK_UNREACHABLE', {
              message: `network unreachable for ${destRel}: all applicable sources failed (${
                finalAvailability.cooling.join(', ') || 'transport error'
              }); retry in ${finalAvailability.retryAfterMs ?? 0} ms`,
              details: {
                destRel,
                urls: attemptedUrls,
                cooling: finalAvailability.cooling,
                retryAfterMs: finalAvailability.retryAfterMs,
                lastCode: lastError?.code ?? null,
                lastMessage: lastError?.message ?? null,
              },
              ...(lastError ? { cause: lastError } : {}),
            })
          : lastError === null
            ? new DownloadError('DOWNLOAD.NO_SOURCE', { message: `no source for ${destRel}` })
            : candidates.length > 1
              ? new DownloadError('DOWNLOAD.NO_SOURCE', {
                  message: `all sources failed for ${destRel}: ${describeCandidates(candidates)}; last: ${lastError.message}`,
                  details: {
                    destRel,
                    urls: attemptedUrls,
                    lastCode: lastError.code,
                    lastMessage: lastError.message,
                  },
                  cause: lastError,
                })
              : lastError
      throw failureError
    } catch (error) {
      const downloadError = asDownloadError(error)
      if (downloadError.code === 'DOWNLOAD.CANCELLED') {
        cancelled = true
        if (options.cleanPartOnCancel !== false) {
          await removePart(dest)
        }
        outcomes[index] = {
          destRel,
          status: 'failed',
          bytes: 0,
          source: null,
          attempts: 0,
          skipped: false,
          code: downloadError.code,
          message: downloadError.userMessage,
        }
        return
      }
      const failure: DownloadFailure = {
        destRel,
        code: downloadError.code,
        message:
          downloadError.code === 'DOWNLOAD.NETWORK_UNREACHABLE'
            ? downloadError.userMessage
            : downloadError.message || downloadError.userMessage,
        userMessage: downloadError.userMessage,
        retryable: downloadError.retryable,
        attempts: 0,
        urls: [],
      }
      failures.push(failure)
      outcomes[index] = {
        destRel,
        status: 'failed',
        bytes: 0,
        source: null,
        attempts: 0,
        skipped: false,
        code: failure.code,
        message: failure.message,
      }
      options.log?.error('file failed', { destRel, code: failure.code, message: failure.message })
      hooks.onTaskFailed?.(failure)
    }
  }

  const workerCount = Math.max(1, Math.min(options.concurrency, order.length))
  const workers: Promise<void>[] = []
  for (let worker = 0; worker < workerCount; worker += 1) {
    workers.push(
      (async () => {
        while (!cancelled && !options.signal?.aborted) {
          const index = cursor
          cursor += 1
          if (index >= order.length) return
          const entry = order[index]
          await runOne(entry.task, entry.index)
        }
      })(),
    )
  }

  await Promise.all(workers)

  const durationMs = (options.now?.() ?? Date.now()) - startedAt
  return {
    outcomes: outcomes.filter((outcome) => outcome !== undefined),
    failures,
    downloaded,
    skipped,
    bytes,
    cancelled,
    paused,
    durationMs,
  }
}

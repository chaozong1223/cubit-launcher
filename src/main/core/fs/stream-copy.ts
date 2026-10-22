import { createReadStream, createWriteStream } from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { JobCancelledError } from '../job/kernel'

export interface StreamCopyOptions {
  signal?: AbortSignal
  /** Bytes moved so far (called with each chunk). */
  onBytes?: (delta: number) => void
}

/**
 * Copies one regular file through Node streams.
 *
 * Used instead of `fs.copyFile` when the operation must be cancellable: the
 * abort signal destroys both streams, the partially written target is removed,
 * and `JobCancelledError` is thrown so the caller can roll back its directory.
 */
export async function copyFileStreaming(
  source: string,
  target: string,
  options: StreamCopyOptions = {},
): Promise<void> {
  await fsp.mkdir(path.dirname(target), { recursive: true })
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      options.onBytes?.(chunk.length)
      callback(null, chunk)
    },
  })
  try {
    await pipeline(
      createReadStream(source),
      meter,
      createWriteStream(target),
      options.signal ? { signal: options.signal } : {},
    )
  } catch (error) {
    await fsp.rm(target, { force: true }).catch(() => undefined)
    if (options.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
      throw new JobCancelledError('复制已取消')
    }
    throw error
  }
}

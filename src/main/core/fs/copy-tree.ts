import fsp from 'node:fs/promises'
import path from 'node:path'
import { copyFileStreaming } from './stream-copy'

/**
 * Async, streaming directory copy shared by save imports and other asset moves.
 *
 * - regular files are streamed (cancel-safe, low memory);
 * - symlinks are skipped (they could escape the source tree);
 * - `skip(relative)` filters entries such as `session.lock`;
 * - `signal`/`checkpoint` make a long save copy cancellable between files.
 */

export interface CopyTreeOptions {
  signal?: AbortSignal
  /** Return true to skip one file/directory (relative POSIX-ish path). */
  skip?: (relative: string) => boolean
  /** Cooperative pause/cancel gate between entries. */
  checkpoint?: () => Promise<void>
  onBytes?: (delta: number) => void
  /** Notified before each regular file is streamed. */
  onFile?: (relative: string, size: number) => void
}

export interface CopyTreeResult {
  files: number
  bytes: number
  skipped: number
  directories: number
}

function throwIfAborted(signal?: AbortSignal, checkpoint?: () => Promise<void>): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new Error('copy cancelled'))
  }
  return checkpoint ? checkpoint() : Promise.resolve()
}

export async function copyTree(
  source: string,
  target: string,
  options: CopyTreeOptions = {},
): Promise<CopyTreeResult> {
  const result: CopyTreeResult = { files: 0, bytes: 0, skipped: 0, directories: 0 }

  const walk = async (relative: string): Promise<void> => {
    await throwIfAborted(options.signal, options.checkpoint)
    const sourceDir = relative ? path.join(source, relative) : source
    let entries
    try {
      entries = await fsp.readdir(sourceDir, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    for (const entry of entries) {
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name
      if (options.skip?.(childRelative)) {
        result.skipped += 1
        continue
      }
      if (entry.isSymbolicLink()) {
        result.skipped += 1
        continue
      }
      const childSource = path.join(source, childRelative)
      const childTarget = path.join(target, childRelative)
      if (entry.isDirectory()) {
        await fsp.mkdir(childTarget, { recursive: true })
        result.directories += 1
        await walk(childRelative)
        continue
      }
      if (!entry.isFile()) {
        result.skipped += 1
        continue
      }
      await throwIfAborted(options.signal, options.checkpoint)
      const sourceStat = await fsp.stat(childSource)
      options.onFile?.(childRelative, sourceStat.size)
      await copyFileStreaming(childSource, childTarget, {
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.onBytes ? { onBytes: options.onBytes } : {}),
      })
      result.files += 1
      result.bytes += sourceStat.size
    }
  }

  await fsp.mkdir(target, { recursive: true })
  await walk('')
  return result
}

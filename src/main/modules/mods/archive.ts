import path from 'node:path'
import type { FsPort } from '../../core/ports'
import { JobCancelledError } from '../../core/job/kernel'
import { safeEntryPath, type ZipArchive } from '../../core/zip/reader'
import { AppError } from '@shared/errors'

/** Re-exported so `.mrpack` export and tests keep one stored-ZIP writer. */
export { createStoredZip, type ZipWriteEntry } from '../../core/zip/writer'

/** Extract only `overrides/` (or `client-overrides/`) from a pack archive. */
export interface ExtractOverridesOptions {
  /** Cancels between archive entries (zip reads themselves are synchronous). */
  signal?: AbortSignal
  /** Pause/cancel gate supplied by the job kernel. */
  checkpoint?: () => Promise<void>
  onEntry?: (relative: string, bytes: number) => void
}

export interface ExtractOverridesResult {
  written: number
  bytes: number
}

export async function extractOverrides(
  fs: FsPort,
  archive: ZipArchive,
  destination: string,
  prefixes: string[] = ['overrides/', 'client-overrides/'],
  options: ExtractOverridesOptions = {},
): Promise<ExtractOverridesResult> {
  let written = 0
  let bytes = 0
  for (const entry of archive.entries) {
    if (options.checkpoint) {
      await options.checkpoint()
    } else if (options.signal?.aborted) {
      throw new JobCancelledError()
    }
    if (entry.isDirectory || entry.isSymlink) continue
    const prefix = prefixes.find((candidate) => entry.name.startsWith(candidate))
    if (!prefix) continue
    const relative = entry.name.slice(prefix.length)
    if (!relative || relative.endsWith('/')) continue
    // A pack must never be able to replace launcher-owned instance metadata.
    if (
      relative.toLowerCase() === 'instance.json' ||
      relative.toLowerCase().startsWith('versions/')
    ) {
      continue
    }
    const target = safeEntryPath(destination, relative)
    const data = archive.readEntry(entry)
    fs.mkdirp(path.dirname(target))
    fs.writeBytes(target, data)
    written += 1
    bytes += data.length
    options.onEntry?.(relative, data.length)
  }
  return { written, bytes }
}

export function readJsonEntry<T>(archive: ZipArchive, name: string, maxBytes = 8 * 1024 * 1024): T {
  if (!archive.has(name)) {
    throw new AppError('MODS.PACK_INVALID', `整合包缺少 ${name}`, { details: { entry: name } })
  }
  const data = archive.read(name)
  if (data.length > maxBytes) {
    throw new AppError('MODS.PACK_INVALID', `${name} 过大`, {
      details: { entry: name, bytes: data.length },
    })
  }
  try {
    return JSON.parse(data.toString('utf8')) as T
  } catch (error) {
    throw new AppError('MODS.PACK_INVALID', `${name} 不是有效 JSON`, {
      cause: error,
      details: { entry: name },
    })
  }
}

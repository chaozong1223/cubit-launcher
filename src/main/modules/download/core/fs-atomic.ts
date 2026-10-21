import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { DownloadError } from './errors'
import { checkDigest, hashFile, resolveExpectedHash, type HashExpectation } from './hash'

/**
 * File helpers for the install chain (SEC-DL-02/03/08/09/11).
 *
 * Every write goes to `<dest>.part` next to the destination and is renamed only
 * after the whole file has been size- and hash-checked. Paths coming from a
 * version JSON, an asset index or a modpack are treated as untrusted input.
 */

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i
const DRIVE_LETTER = /^[a-zA-Z]:[\\/]/

export const PART_SUFFIX = '.part'
export const STALE_PART_MS = 24 * 60 * 60 * 1000

/** `\\?\` prefix for long absolute Windows paths (01 §7.6). */
export function winLongPath(target: string): string {
  if (process.platform !== 'win32') return target
  if (target.startsWith('\\\\?\\')) return target
  const absolute = path.resolve(target)
  if (absolute.length < 248) return absolute
  if (absolute.startsWith('\\\\')) return `\\\\?\\UNC\\${absolute.slice(2)}`
  return `\\\\?\\${absolute}`
}

export interface SafeRelPath {
  /** Normalized relative path with native separators. */
  relative: string
  /** Path segments in order. */
  segments: string[]
}

/**
 * Validates a `destRel`-style path: relative, no traversal, no drive/UNC, no
 * NTFS alternate data streams, no reserved device names, no trailing dot/space.
 * This is the downloader's half of the zip-slip defence (SEC-DL-08/09); archive
 * entries go through `core/zip` which applies the same rules.
 */
export function assertSafeRelPath(input: string, label = 'destRel'): SafeRelPath {
  const reject = (reason: string): never => {
    throw new DownloadError('DOWNLOAD.PATH_UNSAFE', {
      message: `${label}: ${reason}`,
      details: { [label]: input, reason },
    })
  }

  if (typeof input !== 'string' || input.trim().length === 0) reject('empty path')
  if (input.includes('\0')) reject('NUL byte')
  if (input.startsWith('\\\\') || input.startsWith('//')) reject('UNC path')
  if (input.startsWith('/') || input.startsWith('\\')) reject('absolute path')
  if (DRIVE_LETTER.test(input)) reject('drive letter')

  const segments = input.replaceAll('\\', '/').split('/')
  const out: string[] = []
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') reject('parent traversal')
    if (segment.includes(':')) reject('alternate data stream')
    if (/[. ]$/.test(segment)) reject('trailing dot or space')
    if (WINDOWS_RESERVED.test(segment)) reject('reserved device name')
    if (/[\x00-\x1f]/.test(segment)) reject('control character')
    out.push(segment)
  }

  if (out.length === 0) reject('no path segments')
  return { relative: out.join(path.sep), segments: out }
}

export function resolveInside(root: string, relative: string, label = 'destRel'): string {
  const safe = assertSafeRelPath(relative, label)
  const resolvedRoot = path.resolve(root)
  const target = path.resolve(resolvedRoot, safe.relative)
  const rel = path.relative(resolvedRoot, target)
  if (rel.length === 0 || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new DownloadError('DOWNLOAD.PATH_UNSAFE', {
      message: `${label} escapes root: ${relative}`,
      details: { [label]: relative, root: resolvedRoot },
    })
  }
  return target
}

export function partPath(destination: string): string {
  return `${destination}${PART_SUFFIX}`
}

/** Validators for a resumable `.part` (ETag / Last-Modified). */
export function partMetaPath(destination: string): string {
  return `${partPath(destination)}.meta.json`
}

export async function ensureDir(target: string): Promise<void> {
  await fsp.mkdir(winLongPath(target), { recursive: true })
}

export interface StatInfo {
  size: number
  mtimeMs: number
  isFile: boolean
}

export async function statOrNull(target: string): Promise<StatInfo | null> {
  try {
    const stat = await fsp.stat(winLongPath(target))
    return { size: stat.size, mtimeMs: stat.mtimeMs, isFile: stat.isFile() }
  } catch {
    return null
  }
}

export async function fileExists(target: string): Promise<boolean> {
  return (await statOrNull(target)) !== null
}

export async function removeQuietly(target: string): Promise<void> {
  try {
    await fsp.rm(winLongPath(target), { recursive: true, force: true })
  } catch {
    /* best effort: a Windows file may still be open */
  }
}

export async function readTextFile(target: string): Promise<string> {
  const text = await fsp.readFile(winLongPath(target), 'utf8')
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/** Atomic replace: write sibling temp file, then rename (Windows fallback). */
export async function writeTextAtomic(target: string, contents: string): Promise<void> {
  await ensureDir(path.dirname(target))
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`
  await fsp.writeFile(winLongPath(tmp), contents, 'utf8')
  await renameAtomic(tmp, target)
}

export async function renameAtomic(from: string, to: string): Promise<void> {
  await ensureDir(path.dirname(to))
  try {
    await fsp.rename(winLongPath(from), winLongPath(to))
  } catch {
    // Windows refuses to replace a file another process has open.
    await removeQuietly(to)
    await fsp.rename(winLongPath(from), winLongPath(to))
  }
}

/** Removes a leftover `.part` only when it is older than SEC-DL-02's 24 h. */
export async function cleanStalePart(
  destination: string,
  now: number = Date.now(),
  maxAgeMs: number = STALE_PART_MS,
): Promise<boolean> {
  const part = partPath(destination)
  const stat = await statOrNull(part)
  if (!stat) return false
  if (now - stat.mtimeMs <= maxAgeMs) return false
  await removeQuietly(part)
  await removeQuietly(partMetaPath(destination))
  return true
}

export interface ExistingCheckOptions extends HashExpectation {
  expectedSize?: number | null
  /** 'size' is the fast default; 'hash' re-reads the file (SEC-DL-01). */
  verify?: 'size' | 'hash'
  signal?: AbortSignal
}

export interface ExistingCheck {
  ok: boolean
  reason: 'missing' | 'size' | 'hash' | null
  actualSize: number | null
}

/**
 * Is a file already complete? Size first (cheap, catches truncated files such as
 * the 10-byte logging jar in 01 §5.2 negative case 3), then optionally the
 * strongest hash.
 */
export async function checkExistingFile(
  destination: string,
  options: ExistingCheckOptions = {},
): Promise<ExistingCheck> {
  const stat = await statOrNull(destination)
  if (!stat || !stat.isFile) return { ok: false, reason: 'missing', actualSize: null }

  if (typeof options.expectedSize === 'number' && options.expectedSize >= 0) {
    if (stat.size !== options.expectedSize) {
      return { ok: false, reason: 'size', actualSize: stat.size }
    }
  }

  if ((options.verify ?? 'size') === 'hash') {
    const expected = resolveExpectedHash(options)
    if (expected) {
      const digest = await hashFile(destination, [expected.algorithm], {
        signal: options.signal,
      })
      const check = checkDigest(expected, digest)
      if (!check.ok) return { ok: false, reason: 'hash', actualSize: stat.size }
    }
  }

  return { ok: true, reason: null, actualSize: stat.size }
}

export async function fileSize(target: string): Promise<number | null> {
  const stat = await statOrNull(target)
  return stat?.isFile ? stat.size : null
}

/** Free bytes for the volume containing `dir`; null when the OS cannot tell. */
export async function freeSpaceBytes(dir: string): Promise<number | null> {
  type StatFs = (target: string) => Promise<{ bavail: number | bigint; bsize: number | bigint }>
  const statfs = (fsp as unknown as { statfs?: StatFs }).statfs
  if (typeof statfs !== 'function') return null
  try {
    const stats = await statfs(winLongPath(dir))
    return Number(stats.bavail) * Number(stats.bsize)
  } catch {
    return null
  }
}

export interface JobLockOptions {
  /** Lock files older than this are considered abandoned (docs/03 §6.3). */
  staleMs?: number
  /** Refresh mtime this often so long installs are not mistaken for stale. */
  heartbeatMs?: number
  now?: () => number
}

export interface JobLockHandle {
  file: string
  release(): Promise<void>
}

/**
 * Cross-process job lock under `dataRoot/tmp/`. One install per game root keeps
 * two launcher windows from writing the same libraries concurrently.
 */
export async function acquireJobLock(
  lockFile: string,
  options: JobLockOptions = {},
): Promise<JobLockHandle> {
  const staleMs = options.staleMs ?? 10 * 60 * 1000
  const heartbeatMs = Math.max(10, options.heartbeatMs ?? Math.max(1000, Math.floor(staleMs / 3)))
  const now = options.now ?? Date.now
  await ensureDir(path.dirname(lockFile))

  const createHandle = (): JobLockHandle => {
    let released = false
    const timer = setInterval(() => {
      if (released) return
      // Refresh the mtime used by the stale-lock check. A long 1.20.1 install
      // can exceed the 10-minute threshold on a slow connection (H5).
      void fsp
        .utimes(winLongPath(lockFile), new Date(), new Date())
        .catch(() => undefined)
    }, heartbeatMs)
    timer.unref?.()
    return {
      file: lockFile,
      release: async () => {
        if (released) return
        released = true
        clearInterval(timer)
        await removeQuietly(lockFile)
      },
    }
  }

  const tryCreate = async (): Promise<boolean> => {
    try {
      const handle = await fsp.open(winLongPath(lockFile), 'wx')
      await handle.writeFile(
        JSON.stringify({ pid: process.pid, at: new Date(now()).toISOString() }),
        'utf8',
      )
      await handle.close()
      return true
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EEXIST') return false
      throw error
    }
  }

  if (!(await tryCreate())) {
    const stat = await statOrNull(lockFile)
    const stale = stat !== null && now() - stat.mtimeMs > staleMs
    if (stale) {
      await removeQuietly(lockFile)
      if (await tryCreate()) {
        return createHandle()
      }
    }
    throw new DownloadError('DOWNLOAD.LOCKED', {
      message: `lock file exists: ${lockFile}`,
      details: { lockFile },
    })
  }

  return createHandle()
}

/** Synchronous variant used by boot-time cleanup paths. */
export function removeQuietlySync(target: string): void {
  try {
    fs.rmSync(winLongPath(target), { recursive: true, force: true })
  } catch {
    /* best effort */
  }
}

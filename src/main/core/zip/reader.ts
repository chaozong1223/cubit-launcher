import path from 'node:path'
import zlib from 'node:zlib'
import { CoreError } from '../errors'
import type { FsPort } from '../ports'

/**
 * Minimal ZIP reader for natives extraction and (later) modpack inspection.
 *
 * Deliberately dependency free and strict: stored/deflated entries only, no
 * encryption, no zip64, CRCs verified, and every path checked against
 * traversal/ADS/reserved names before anything is written. Limits come from
 * docs/02 SEC-DL-08.
 */
export interface ZipLimits {
  maxEntries: number
  maxEntrySize: number
  maxTotalSize: number
  maxArchiveSize: number
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxEntries: 20_000,
  maxEntrySize: 512 * 1024 * 1024,
  maxTotalSize: 8 * 1024 * 1024 * 1024,
  maxArchiveSize: 1024 * 1024 * 1024,
}

export interface ZipEntry {
  name: string
  method: number
  crc32: number
  compressedSize: number
  size: number
  localHeaderOffset: number
  flags: number
  externalAttrs: number
  isDirectory: boolean
  isSymlink: boolean
}

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

export function crc32Update(crc: number, buffer: Buffer): number {
  let value = crc >>> 0
  for (let index = 0; index < buffer.length; index += 1) {
    value = (value >>> 8) ^ CRC_TABLE[(value ^ buffer[index]) & 0xff]
  }
  return value >>> 0
}

export function crc32(buffer: Buffer): number {
  return (crc32Update(0xffffffff, buffer) ^ 0xffffffff) >>> 0
}

const RESERVED_NAMES = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9',
])

export function assertSafeEntryName(name: string): void {
  if (name.length === 0 || name.length > 1024) {
    throw new CoreError('ARCHIVE.UNSAFE_PATH', {
      message: `invalid archive entry length: ${name.slice(0, 80)}`,
      details: { name },
    })
  }
  if (name.includes('\\')) {
    throw new CoreError('ARCHIVE.UNSAFE_PATH', {
      message: `backslash in archive entry: ${name}`,
      details: { name },
    })
  }
  if (name.includes('\0') || /[\u0000-\u001f]/.test(name)) {
    throw new CoreError('ARCHIVE.UNSAFE_PATH', {
      message: 'control character in archive entry',
      details: { name },
    })
  }
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name) || name.startsWith('//')) {
    throw new CoreError('ARCHIVE.UNSAFE_PATH', {
      message: `absolute path in archive: ${name}`,
      details: { name },
    })
  }

  const segments = name.split('/')
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue // trailing slash for dirs
    if (segment === '..') {
      throw new CoreError('ARCHIVE.UNSAFE_PATH', {
        message: `path traversal in archive: ${name}`,
        details: { name },
      })
    }
    if (segment.includes(':')) {
      throw new CoreError('ARCHIVE.UNSAFE_PATH', {
        message: `alternate data stream in archive: ${name}`,
        details: { name },
      })
    }
    if (/[. ]$/.test(segment)) {
      throw new CoreError('ARCHIVE.UNSAFE_PATH', {
        message: `windows-unsafe trailing character in archive: ${name}`,
        details: { name },
      })
    }
    const base = segment.split('.')[0].toLowerCase()
    if (RESERVED_NAMES.has(base)) {
      throw new CoreError('ARCHIVE.UNSAFE_PATH', {
        message: `reserved windows name in archive: ${name}`,
        details: { name },
      })
    }
  }
}

/** Joins an archive entry onto a destination, refusing escapes. */
export function safeEntryPath(destination: string, entryName: string): string {
  assertSafeEntryName(entryName)
  const root = path.resolve(destination)
  const resolved = path.resolve(root, entryName)
  const relative = path.relative(root, resolved)
  if (relative.length === 0 || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new CoreError('ARCHIVE.UNSAFE_PATH', {
      message: `entry escapes destination: ${entryName}`,
      details: { entryName },
    })
  }
  return resolved
}

export class ZipArchive {
  readonly entries: ZipEntry[]
  private readonly buffer: Buffer
  private readonly byName: Map<string, ZipEntry>

  private constructor(buffer: Buffer, entries: ZipEntry[]) {
    this.buffer = buffer
    this.entries = entries
    this.byName = new Map(entries.map((entry) => [entry.name, entry]))
  }

  static open(buffer: Buffer, limits: Partial<ZipLimits> = {}): ZipArchive {
    const effective: ZipLimits = { ...DEFAULT_ZIP_LIMITS, ...limits }
    if (buffer.length > effective.maxArchiveSize) {
      throw new CoreError('ARCHIVE.LIMIT_EXCEEDED', {
        message: `archive larger than ${effective.maxArchiveSize} bytes`,
      })
    }
    if (buffer.length < 22) {
      throw new CoreError('ARCHIVE.INVALID', { message: 'file too small to be a zip' })
    }

    const eocdOffset = findEocd(buffer)
    if (eocdOffset < 0) {
      throw new CoreError('ARCHIVE.INVALID', { message: 'zip end-of-central-directory not found' })
    }

    const entriesOnDisk = buffer.readUInt16LE(eocdOffset + 8)
    const totalEntries = buffer.readUInt16LE(eocdOffset + 10)
    const centralSize = buffer.readUInt32LE(eocdOffset + 12)
    const centralOffset = buffer.readUInt32LE(eocdOffset + 16)

    if (totalEntries === 0xffff || centralOffset === 0xffffffff || centralSize === 0xffffffff) {
      throw new CoreError('ARCHIVE.INVALID', { message: 'zip64 archives are not supported' })
    }
    if (entriesOnDisk !== totalEntries) {
      throw new CoreError('ARCHIVE.INVALID', { message: 'multi-disk archives are not supported' })
    }
    if (totalEntries > effective.maxEntries) {
      throw new CoreError('ARCHIVE.LIMIT_EXCEEDED', {
        message: `archive has ${totalEntries} entries (limit ${effective.maxEntries})`,
      })
    }
    if (centralOffset + centralSize > buffer.length) {
      throw new CoreError('ARCHIVE.INVALID', { message: 'central directory outside file' })
    }

    const entries: ZipEntry[] = []
    let offset = centralOffset
    let totalUncompressed = 0
    const seen = new Set<string>()

    for (let index = 0; index < totalEntries; index += 1) {
      if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
        throw new CoreError('ARCHIVE.INVALID', { message: 'corrupt central directory' })
      }

      const flags = buffer.readUInt16LE(offset + 8)
      const method = buffer.readUInt16LE(offset + 10)
      const crc = buffer.readUInt32LE(offset + 16)
      const compressedSize = buffer.readUInt32LE(offset + 20)
      const size = buffer.readUInt32LE(offset + 24)
      const nameLength = buffer.readUInt16LE(offset + 28)
      const extraLength = buffer.readUInt16LE(offset + 30)
      const commentLength = buffer.readUInt16LE(offset + 32)
      const externalAttrs = buffer.readUInt32LE(offset + 38)
      const localHeaderOffset = buffer.readUInt32LE(offset + 42)
      const nameStart = offset + 46
      if (nameStart + nameLength > buffer.length) {
        throw new CoreError('ARCHIVE.INVALID', { message: 'corrupt entry name' })
      }
      const name = buffer.subarray(nameStart, nameStart + nameLength).toString('utf8')

      if (flags & 0x1) {
        throw new CoreError('ARCHIVE.INVALID', { message: `encrypted entry: ${name}` })
      }
      if (method !== 0 && method !== 8) {
        throw new CoreError('ARCHIVE.INVALID', {
          message: `unsupported compression method ${method} for ${name}`,
        })
      }
      if (size > effective.maxEntrySize) {
        throw new CoreError('ARCHIVE.LIMIT_EXCEEDED', {
          message: `entry larger than ${effective.maxEntrySize} bytes: ${name}`,
        })
      }
      totalUncompressed += size
      if (totalUncompressed > effective.maxTotalSize) {
        throw new CoreError('ARCHIVE.LIMIT_EXCEEDED', {
          message: `archive expands beyond ${effective.maxTotalSize} bytes`,
        })
      }
      if (seen.has(name)) {
        throw new CoreError('ARCHIVE.INVALID', { message: `duplicate entry: ${name}` })
      }
      seen.add(name)
      assertSafeEntryName(name)

      const unixMode = (externalAttrs >>> 16) & 0xffff
      const isSymlink = (unixMode & 0xf000) === 0xa000
      const isDirectory = name.endsWith('/') || (unixMode & 0xf000) === 0x4000
      if (isSymlink) {
        throw new CoreError('ARCHIVE.UNSAFE_PATH', {
          message: `symlink entry rejected: ${name}`,
        })
      }

      entries.push({
        name,
        method,
        crc32: crc,
        compressedSize,
        size,
        localHeaderOffset,
        flags,
        externalAttrs,
        isDirectory,
        isSymlink,
      })

      offset = nameStart + nameLength + extraLength + commentLength
    }

    return new ZipArchive(buffer, entries)
  }

  has(name: string): boolean {
    return this.byName.has(name)
  }

  entry(name: string): ZipEntry | null {
    return this.byName.get(name) ?? null
  }

  /** Reads and verifies one entry. */
  read(name: string): Buffer {
    const entry = this.entry(name)
    if (!entry) {
      throw new CoreError('ARCHIVE.INVALID', { message: `entry not found: ${name}` })
    }
    return this.readEntry(entry)
  }

  readEntry(entry: ZipEntry): Buffer {
    const offset = entry.localHeaderOffset
    if (offset + 30 > this.buffer.length || this.buffer.readUInt32LE(offset) !== LOCAL_SIGNATURE) {
      throw new CoreError('ARCHIVE.INVALID', { message: `corrupt local header: ${entry.name}` })
    }
    const nameLength = this.buffer.readUInt16LE(offset + 26)
    const extraLength = this.buffer.readUInt16LE(offset + 28)
    const dataStart = offset + 30 + nameLength + extraLength
    const dataEnd = dataStart + entry.compressedSize
    if (dataEnd > this.buffer.length) {
      throw new CoreError('ARCHIVE.INVALID', { message: `entry data outside file: ${entry.name}` })
    }

    const compressed = this.buffer.subarray(dataStart, dataEnd)
    let output: Buffer
    if (entry.method === 0) {
      output = Buffer.from(compressed)
    } else {
      try {
        output = zlib.inflateRawSync(compressed, {
          maxOutputLength: Math.max(entry.size, 1),
        })
      } catch (error) {
        throw new CoreError('ARCHIVE.INVALID', {
          message: `inflate failed for ${entry.name}`,
          cause: error,
        })
      }
    }

    if (output.length !== entry.size) {
      throw new CoreError('ARCHIVE.INVALID', {
        message: `size mismatch for ${entry.name}: ${output.length} != ${entry.size}`,
      })
    }
    if (crc32(output) !== entry.crc32) {
      throw new CoreError('ARCHIVE.INVALID', { message: `checksum mismatch for ${entry.name}` })
    }
    return output
  }
}

function findEocd(buffer: Buffer): number {
  const minimum = Math.max(0, buffer.length - 22 - 0xffff)
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) return offset
  }
  return -1
}

export interface ExtractZipOptions {
  excludePrefixes?: string[]
  limits?: Partial<ZipLimits>
  /**
   * Write every file directly into `destination`, dropping its folder prefix.
   * Needed for native jars: modern LWJGL ships `windows/x64/org/lwjgl/*.dll`
   * and Windows' `java.library.path` does not search subdirectories.
   */
  flatten?: boolean
  /** When flattening, keep only entries whose name ends with one of these. */
  flattenExtensions?: string[]
}

export interface ExtractZipResult {
  written: string[]
  skipped: string[]
}

/** Extracts every regular file (no symlinks), honouring prefix exclusions. */
export function extractZip(
  fs: FsPort,
  archive: ZipArchive,
  destination: string,
  options: ExtractZipOptions = {},
): ExtractZipResult {
  const excludes = (options.excludePrefixes ?? []).map((prefix) =>
    prefix.endsWith('/') ? prefix : `${prefix}/`,
  )
  const written: string[] = []
  const skipped: string[] = []

  for (const entry of archive.entries) {
    if (entry.isDirectory) {
      skipped.push(entry.name)
      continue
    }
    if (excludes.some((prefix) => entry.name.startsWith(prefix))) {
      skipped.push(entry.name)
      continue
    }
    if (options.flatten) {
      const base = entry.name.split('/').pop() ?? entry.name
      const allowed = options.flattenExtensions
      if (allowed && allowed.length > 0) {
        const lower = base.toLowerCase()
        if (!allowed.some((ext) => lower.endsWith(ext))) {
          skipped.push(entry.name)
          continue
        }
      }
      fs.writeBytes(safeEntryPath(destination, base), archive.readEntry(entry))
      written.push(entry.name)
      continue
    }
    const target = safeEntryPath(destination, entry.name)
    fs.writeBytes(target, archive.readEntry(entry))
    written.push(entry.name)
  }

  return { written, skipped }
}

export function openZipFile(fs: FsPort, file: string, limits?: Partial<ZipLimits>): ZipArchive {
  if (!fs.exists(file)) {
    throw new CoreError('ARCHIVE.INVALID', { message: `archive not found: ${file}` })
  }
  return ZipArchive.open(fs.readBytes(file), limits)
}

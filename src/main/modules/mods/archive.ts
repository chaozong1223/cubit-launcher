import path from 'node:path'
import type { FsPort } from '../../core/ports'
import {
  assertSafeEntryName,
  crc32,
  safeEntryPath,
  type ZipArchive,
} from '../../core/zip/reader'
import { AppError } from '@shared/errors'

/** Minimal stored-ZIP writer used for `.mrpack` export. Compression is
 * intentionally skipped: modpacks are mostly already-compressed jars, and a
 * store-only archive keeps this dependency-free and deterministic. */
export interface ZipWriteEntry {
  name: string
  data: Buffer
}

const MAX_ENTRIES = 50_000
const MAX_TOTAL = 8 * 1024 * 1024 * 1024

function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear())
  const time =
    (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)
  const day = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  return { time, date: day }
}

export function createStoredZip(entries: ZipWriteEntry[], now = new Date()): Buffer {
  if (entries.length > MAX_ENTRIES) {
    throw new AppError('MODS.PACK_TOO_LARGE', '整合包文件数量超过上限')
  }
  const { time, date } = dosDateTime(now)
  const pieces: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  let total = 0
  let count = 0

  for (const entry of entries) {
    assertSafeEntryName(entry.name)
    if (entry.name.endsWith('/')) continue
    count += 1
    total += entry.data.length
    if (total > MAX_TOTAL) {
      throw new AppError('MODS.PACK_TOO_LARGE', '整合包解压后体积超过上限')
    }
    const name = Buffer.from(entry.name, 'utf8')
    const checksum = crc32(entry.data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6) // UTF-8 names
    local.writeUInt16LE(0, 8) // stored
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(entry.data.length, 18)
    local.writeUInt32LE(entry.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)

    const centralHeader = Buffer.alloc(46)
    centralHeader.writeUInt32LE(0x02014b50, 0)
    centralHeader.writeUInt16LE(20, 4)
    centralHeader.writeUInt16LE(20, 6)
    centralHeader.writeUInt16LE(0x0800, 8)
    centralHeader.writeUInt16LE(0, 10)
    centralHeader.writeUInt16LE(time, 12)
    centralHeader.writeUInt16LE(date, 14)
    centralHeader.writeUInt32LE(checksum, 16)
    centralHeader.writeUInt32LE(entry.data.length, 20)
    centralHeader.writeUInt32LE(entry.data.length, 24)
    centralHeader.writeUInt16LE(name.length, 28)
    centralHeader.writeUInt16LE(0, 30)
    centralHeader.writeUInt16LE(0, 32)
    centralHeader.writeUInt16LE(0, 34)
    centralHeader.writeUInt16LE(0, 36)
    centralHeader.writeUInt32LE(0, 38)
    centralHeader.writeUInt32LE(offset, 42)

    pieces.push(local, name, entry.data)
    central.push(centralHeader, name)
    offset += local.length + name.length + entry.data.length
  }

  const centralOffset = offset
  let centralSize = 0
  for (const piece of central) centralSize += piece.length
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(count, 8)
  end.writeUInt16LE(count, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(centralOffset, 16)
  end.writeUInt16LE(0, 20)

  return Buffer.concat([...pieces, ...central, end])
}

/** Extract only `overrides/` (or `client-overrides/`) from a pack archive. */
export function extractOverrides(
  fs: FsPort,
  archive: ZipArchive,
  destination: string,
  prefixes: string[] = ['overrides/', 'client-overrides/'],
): number {
  let written = 0
  for (const entry of archive.entries) {
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
    fs.mkdirp(path.dirname(target))
    fs.writeBytes(target, archive.readEntry(entry))
    written += 1
  }
  return written
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

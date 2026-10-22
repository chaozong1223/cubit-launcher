import { AppError } from '@shared/errors'
import { assertSafeEntryName, crc32 } from './reader'

/**
 * Minimal stored-ZIP writer (no compression, no zip64, no encryption).
 *
 * Shared by the modpack exporter (`.mrpack`) and the instance share pack
 * (`.cubitpack`): both are mostly already-compressed payloads, and a
 * store-only archive keeps the implementation dependency-free and byte
 * deterministic for tests.
 */

export interface ZipWriteEntry {
  name: string
  data: Buffer
}

export interface StoredZipOptions {
  /** Archive timestamp; tests inject a fixed date for stable bytes. */
  now?: Date
  maxEntries?: number
  maxTotalBytes?: number
}

const DEFAULT_MAX_ENTRIES = 50_000
const DEFAULT_MAX_TOTAL = 8 * 1024 * 1024 * 1024

function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear())
  const time =
    (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)
  const day = ((year - 1980) << 9) | (date.getMonth() + 1) << 5 | date.getDate()
  return { time, date: day }
}

export function createStoredZip(
  entries: ZipWriteEntry[],
  options: StoredZipOptions = {},
): Buffer {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES
  const maxTotal = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL
  if (entries.length > maxEntries) {
    throw new AppError('ARCHIVE.LIMIT_EXCEEDED', '压缩包文件数量超过上限')
  }
  const { time, date } = dosDateTime(options.now ?? new Date())
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
    if (total > maxTotal) {
      throw new AppError('ARCHIVE.LIMIT_EXCEEDED', '压缩包解压后体积超过上限')
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

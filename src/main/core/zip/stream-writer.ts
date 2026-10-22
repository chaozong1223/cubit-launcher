import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { AppError } from '@shared/errors'
import { assertSafeEntryName, crc32Update } from './reader'

/**
 * Streaming stored-ZIP writer.
 *
 * Writes one entry at a time to a file descriptor and never holds the whole
 * archive in memory. Files can be streamed straight from disk; the archive
 * SHA-256 is computed while writing (share-pack export wants both).
 *
 * ZIP details: stored-only (no compression), data-descriptor flag, UTF-8 names,
 * no ZIP64 (the share pack is limited to 2 GB / 65 535 entries). Our reader uses
 * the central directory, so the zeroed local CRC/sizes are fine.
 */

export interface StoredZipStreamEntry {
  name: string
  data?: Buffer
  filePath?: string
  /** Required for filePath entries (checked against bytes actually read). */
  size?: number
}

export interface StoredZipStreamOptions {
  now?: Date
  maxEntries?: number
  maxTotalBytes?: number
  /** Yield to the event loop every N bytes while streaming entries. */
  yieldEveryBytes?: number
  /** Called between chunks; throw to abort (e.g. share export cancellation). */
  onCheck?: () => void
}

const DEFAULT_MAX_ENTRIES = 65_535
const DEFAULT_MAX_TOTAL = 8 * 1024 * 1024 * 1024
const CHUNK_SIZE = 1024 * 1024
const DEFAULT_YIELD_BYTES = 8 * 1024 * 1024

function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear())
  const time =
    (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)
  const day = ((year - 1980) << 9) | (date.getMonth() + 1) << 5 | date.getDate()
  return { time, date: day }
}

function yieldToLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

export async function writeStoredZipFile(
  file: string,
  entries: StoredZipStreamEntry[],
  options: StoredZipStreamOptions = {},
): Promise<{ bytes: number; sha256: string }> {
  const maxEntries = Math.min(options.maxEntries ?? DEFAULT_MAX_ENTRIES, DEFAULT_MAX_ENTRIES)
  const maxTotal = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL
  if (entries.length > maxEntries) {
    throw new AppError('ARCHIVE.LIMIT_EXCEEDED', `压缩包文件数超过 ${maxEntries} 上限`)
  }
  const { time, date } = dosDateTime(options.now ?? new Date())
  const yieldEvery = Math.max(CHUNK_SIZE, options.yieldEveryBytes ?? DEFAULT_YIELD_BYTES)
  const hash = createHash('sha256')
  const fd = fs.openSync(file, 'w', 0o600)
  let offset = 0
  let total = 0
  let count = 0
  let sinceYield = 0
  const central: Buffer[] = []

  const write = (buffer: Buffer): void => {
    fs.writeSync(fd, buffer)
    hash.update(buffer)
    offset += buffer.length
  }

  try {
    for (const entry of entries) {
      options.onCheck?.()
      assertSafeEntryName(entry.name)
      if (entry.name.endsWith('/')) continue
      const data = entry.data
      const filePath = entry.filePath
      if (!data && !filePath) {
        throw new AppError('ARCHIVE.INVALID', `entry has no data: ${entry.name}`)
      }
      const declaredSize = data ? data.length : entry.size
      if (declaredSize === undefined) {
        throw new AppError('ARCHIVE.INVALID', `entry size missing: ${entry.name}`)
      }
      if (declaredSize > 0xffffffff) {
        throw new AppError('ARCHIVE.LIMIT_EXCEEDED', `单文件超过 4 GB: ${entry.name}`)
      }
      total += declaredSize
      if (total > maxTotal) {
        throw new AppError('ARCHIVE.LIMIT_EXCEEDED', '压缩包解压后体积超过上限')
      }
      count += 1
      if (count > maxEntries) {
        throw new AppError('ARCHIVE.LIMIT_EXCEEDED', `压缩包文件数超过 ${maxEntries} 上限`)
      }

      const name = Buffer.from(entry.name, 'utf8')
      const localOffset = offset
      const local = Buffer.alloc(30)
      local.writeUInt32LE(0x04034b50, 0)
      local.writeUInt16LE(20, 4)
      local.writeUInt16LE(0x0808, 6) // data descriptor + UTF-8
      local.writeUInt16LE(0, 8) // stored
      local.writeUInt16LE(time, 10)
      local.writeUInt16LE(date, 12)
      local.writeUInt32LE(0, 14)
      local.writeUInt32LE(0, 18)
      local.writeUInt32LE(0, 22)
      local.writeUInt16LE(name.length, 26)
      local.writeUInt16LE(0, 28)
      write(Buffer.concat([local, name]))

      let crc = 0xffffffff
      let written = 0
      if (data) {
        crc = crc32Update(crc, data)
        written = data.length
        write(data)
      } else {
        const readFd = fs.openSync(filePath as string, 'r')
        try {
          const buffer = Buffer.allocUnsafe(CHUNK_SIZE)
          for (;;) {
            const read = fs.readSync(readFd, buffer, 0, CHUNK_SIZE, null)
            if (read === 0) break
            const chunk = buffer.subarray(0, read)
            crc = crc32Update(crc, chunk)
            written += read
            write(chunk)
            sinceYield += read
            if (sinceYield >= yieldEvery) {
              sinceYield = 0
              await yieldToLoop()
              options.onCheck?.()
            }
          }
        } finally {
          fs.closeSync(readFd)
        }
      }
      if (written !== declaredSize) {
        throw new AppError(
          'ARCHIVE.INVALID',
          `文件在打包过程中发生变化: ${entry.name}（预期 ${declaredSize}，实际 ${written}）`,
        )
      }
      const finalCrc = (crc ^ 0xffffffff) >>> 0
      const descriptor = Buffer.alloc(16)
      descriptor.writeUInt32LE(0x08074b50, 0)
      descriptor.writeUInt32LE(finalCrc, 4)
      descriptor.writeUInt32LE(written, 8)
      descriptor.writeUInt32LE(written, 12)
      write(descriptor)

      const centralHeader = Buffer.alloc(46)
      centralHeader.writeUInt32LE(0x02014b50, 0)
      centralHeader.writeUInt16LE(20, 4)
      centralHeader.writeUInt16LE(20, 6)
      centralHeader.writeUInt16LE(0x0808, 8)
      centralHeader.writeUInt16LE(0, 10)
      centralHeader.writeUInt16LE(time, 12)
      centralHeader.writeUInt16LE(date, 14)
      centralHeader.writeUInt32LE(finalCrc, 16)
      centralHeader.writeUInt32LE(written, 20)
      centralHeader.writeUInt32LE(written, 24)
      centralHeader.writeUInt16LE(name.length, 28)
      centralHeader.writeUInt16LE(0, 30)
      centralHeader.writeUInt16LE(0, 32)
      centralHeader.writeUInt16LE(0, 34)
      centralHeader.writeUInt16LE(0, 36)
      centralHeader.writeUInt32LE(0, 38)
      centralHeader.writeUInt32LE(localOffset, 42)
      central.push(centralHeader, name)
      await yieldToLoop()
    }

    const centralOffset = offset
    for (const piece of central) write(piece)
    const centralSize = offset - centralOffset
    const end = Buffer.alloc(22)
    end.writeUInt32LE(0x06054b50, 0)
    end.writeUInt16LE(0, 4)
    end.writeUInt16LE(0, 6)
    end.writeUInt16LE(count, 8)
    end.writeUInt16LE(count, 10)
    end.writeUInt32LE(centralSize, 12)
    end.writeUInt32LE(centralOffset, 16)
    end.writeUInt16LE(0, 20)
    write(end)
    return { bytes: offset, sha256: hash.digest('hex') }
  } finally {
    fs.closeSync(fd)
  }
}

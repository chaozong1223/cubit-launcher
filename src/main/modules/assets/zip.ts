import { crc32, assertSafeEntryName } from '../../core/zip/reader'
import { AppError } from '@shared/errors'

export interface ZipEntryInput {
  name: string
  data: Buffer
}

/** Store-only ZIP writer; save backups/diagnostics are small enough and this
 * keeps the module dependency free. */
export function createStoredZip(entries: ZipEntryInput[], now = new Date()): Buffer {
  const pieces: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  let total = 0
  let count = 0
  const time =
    (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2)
  const date =
    ((Math.max(1980, now.getFullYear()) - 1980) << 9) |
    ((now.getMonth() + 1) << 5) |
    now.getDate()

  for (const entry of entries) {
    assertSafeEntryName(entry.name)
    if (entry.name.endsWith('/')) continue
    total += entry.data.length
    if (total > 2 * 1024 * 1024 * 1024) {
      throw new AppError('ASSETS.BACKUP_TOO_LARGE', '备份内容超过 2 GB 上限')
    }
    count += 1
    const name = Buffer.from(entry.name, 'utf8')
    const checksum = crc32(entry.data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(entry.data.length, 18)
    local.writeUInt32LE(entry.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)

    const header = Buffer.alloc(46)
    header.writeUInt32LE(0x02014b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(20, 6)
    header.writeUInt16LE(0x0800, 8)
    header.writeUInt16LE(0, 10)
    header.writeUInt16LE(time, 12)
    header.writeUInt16LE(date, 14)
    header.writeUInt32LE(checksum, 16)
    header.writeUInt32LE(entry.data.length, 20)
    header.writeUInt32LE(entry.data.length, 24)
    header.writeUInt16LE(name.length, 28)
    header.writeUInt16LE(0, 30)
    header.writeUInt16LE(0, 32)
    header.writeUInt16LE(0, 34)
    header.writeUInt16LE(0, 36)
    header.writeUInt32LE(0, 38)
    header.writeUInt32LE(offset, 42)

    pieces.push(local, name, entry.data)
    central.push(header, name)
    offset += local.length + name.length + entry.data.length
  }

  const centralOffset = offset
  const centralSize = central.reduce((sum, piece) => sum + piece.length, 0)
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

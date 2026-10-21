import { crc32 } from '../../../../core/zip/reader'

/**
 * Minimal stored-ZIP writer for tests (method 0). Mirrors the structure the t6
 * reader expects; enough to exercise extraction, zip-slip and progress.
 */

export interface ZipInputEntry {
  name: string
  data: Buffer | string
}

const DOS_TIME = 0
const DOS_DATE = 0x5021 // 2020-01-01, valid DOS date

export function makeZip(entries: ZipInputEntry[]): Buffer {
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8')
    const name = Buffer.from(entry.name, 'utf8')
    const checksum = crc32(data)
    const flags = 0x800 // UTF-8 names

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(flags, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt16LE(DOS_TIME, 10)
    local.writeUInt16LE(DOS_DATE, 12)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    localParts.push(local, name, data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(flags, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(DOS_TIME, 12)
    central.writeUInt16LE(DOS_DATE, 14)
    central.writeUInt32LE(checksum, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    centralParts.push(central, name)

    offset += local.length + name.length + data.length
  }

  const centralDir = Buffer.concat(centralParts)
  const localDir = Buffer.concat(localParts)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralDir.length, 12)
  eocd.writeUInt32LE(localDir.length, 16)
  eocd.writeUInt16LE(0, 20)

  return Buffer.concat([localDir, centralDir, eocd])
}

/** A tiny fake JDK zip with a versioned root folder. */
export function fakeJdkZip(major = 17, version = '17.0.9+9'): Buffer {
  const root = `jdk-${version}`
  return makeZip([
    { name: `${root}/bin/java.exe`, data: Buffer.from(`fake-java-${major}`) },
    { name: `${root}/bin/javaw.exe`, data: Buffer.from(`fake-javaw-${major}`) },
    { name: `${root}/release`, data: Buffer.from(`JAVA_VERSION="${version}"\n`) },
    { name: `${root}/lib/modules`, data: Buffer.from('fake-modules') },
    { name: `${root}/legal/java.base/LICENSE`, data: Buffer.from('license') },
  ])
}

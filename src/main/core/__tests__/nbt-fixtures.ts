import zlib from 'node:zlib'
import type { TagType } from '../nbt/types'

/**
 * Tiny NBT **writer** for tests and real-machine fixtures only (the production
 * code is read-only). Mirrors Java `DataOutput.writeUTF` so emoji take 6 bytes.
 */

export type FixtureTag =
  | { type: 1 | 2 | 3; value: number }
  | { type: 4; value: bigint }
  | { type: 5 | 6; value: number }
  | { type: 7 | 11 | 12; value: Buffer }
  | { type: 8; value: string }
  | { type: 9; elementType: TagType; value: FixtureTag[] }
  | { type: 10; value: Array<[string, FixtureTag]> | Map<string, FixtureTag> }

export const tagByte = (value: number): FixtureTag => ({ type: 1, value })
export const tagShort = (value: number): FixtureTag => ({ type: 2, value })
export const tagInt = (value: number): FixtureTag => ({ type: 3, value })
export const tagLong = (value: bigint): FixtureTag => ({ type: 4, value })
export const tagFloat = (value: number): FixtureTag => ({ type: 5, value })
export const tagDouble = (value: number): FixtureTag => ({ type: 6, value })
export const tagByteArray = (value: Buffer): FixtureTag => ({ type: 7, value })
export const tagString = (value: string): FixtureTag => ({ type: 8, value })
export const tagList = (elementType: TagType, value: FixtureTag[]): FixtureTag => ({
  type: 9,
  elementType,
  value,
})
export const tagCompound = (
  value: Array<[string, FixtureTag]> | Map<string, FixtureTag>,
): FixtureTag => ({ type: 10, value })
export const tagIntArray = (value: Buffer): FixtureTag => ({ type: 11, value })
export const tagLongArray = (value: Buffer): FixtureTag => ({ type: 12, value })

function writeInt32(value: number): Buffer {
  const buffer = Buffer.alloc(4)
  buffer.writeInt32BE(value)
  return buffer
}

function writeInt16(value: number): Buffer {
  const buffer = Buffer.alloc(2)
  buffer.writeInt16BE(value)
  return buffer
}

function writeInt64(value: bigint): Buffer {
  const buffer = Buffer.alloc(8)
  buffer.writeBigInt64BE(value)
  return buffer
}

function writeFloat(value: number): Buffer {
  const buffer = Buffer.alloc(4)
  buffer.writeFloatBE(value)
  return buffer
}

function writeDouble(value: number): Buffer {
  const buffer = Buffer.alloc(8)
  buffer.writeDoubleBE(value)
  return buffer
}

/** Java modified UTF-8: NUL → C0 80, supplemented chars → CESU-8 surrogate pair. */
export function encodeModifiedUtf8(text: string): Buffer {
  const bytes: number[] = []
  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0
    if (codePoint === 0) {
      bytes.push(0xc0, 0x80)
    } else if (codePoint < 0x80) {
      bytes.push(codePoint)
    } else if (codePoint < 0x800) {
      bytes.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f))
    } else if (codePoint < 0x10000) {
      bytes.push(
        0xe0 | (codePoint >> 12),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      )
    } else {
      const adjusted = codePoint - 0x10000
      const high = 0xd800 + (adjusted >> 10)
      const low = 0xdc00 + (adjusted & 0x3ff)
      for (const unit of [high, low]) {
        bytes.push(0xe0 | (unit >> 12), 0x80 | ((unit >> 6) & 0x3f), 0x80 | (unit & 0x3f))
      }
    }
  }
  return Buffer.from(bytes)
}

function payload(tag: FixtureTag): Buffer {
  switch (tag.type) {
    case 1:
      return Buffer.from([tag.value & 0xff])
    case 2:
      return writeInt16(tag.value)
    case 3:
      return writeInt32(tag.value)
    case 4:
      return writeInt64(tag.value)
    case 5:
      return writeFloat(tag.value)
    case 6:
      return writeDouble(tag.value)
    case 7:
    case 11:
    case 12:
      return Buffer.concat([writeInt32(tag.value.length), tag.value])
    case 8: {
      const bytes = encodeModifiedUtf8(tag.value)
      return Buffer.concat([writeInt16(bytes.length), bytes])
    }
    case 9: {
      const items = Buffer.concat(tag.value.map((item) => payload(item)))
      return Buffer.concat([Buffer.from([tag.elementType]), writeInt32(tag.value.length), items])
    }
    case 10: {
      const entries =
        tag.value instanceof Map ? [...tag.value.entries()] : tag.value
      const parts: Buffer[] = []
      for (const [key, child] of entries) {
        const nameBytes = encodeModifiedUtf8(key)
        parts.push(
          Buffer.from([child.type]),
          writeInt16(nameBytes.length),
          nameBytes,
          payload(child),
        )
      }
      parts.push(Buffer.from([0]))
      return Buffer.concat(parts)
    }
    default:
      throw new Error(`unsupported fixture tag ${String((tag as { type: unknown }).type)}`)
  }
}

export interface RawRootEntry {
  type: number
  key: string
  payload: Buffer
}

export function rawRoot(entries: RawRootEntry[], rootName = ''): Buffer {
  const nameBytes = encodeModifiedUtf8(rootName)
  const parts: Buffer[] = [Buffer.from([10]), writeInt16(nameBytes.length), nameBytes]
  for (const entry of entries) {
    const keyBytes = encodeModifiedUtf8(entry.key)
    parts.push(Buffer.from([entry.type]), writeInt16(keyBytes.length), keyBytes, entry.payload)
  }
  parts.push(Buffer.from([0]))
  return Buffer.concat(parts)
}

export function rawEntryPayload(type: TagType, body: Buffer): Buffer {
  return Buffer.concat([Buffer.from([type]), writeInt16(0), body])
}

export function buildNbt(rootEntries: Array<[string, FixtureTag]>, rootName = ''): Buffer {
  return rawRoot(
    rootEntries.map(([key, tag]) => ({ type: tag.type, key, payload: payload(tag) })),
    rootName,
  )
}

export type FixtureCompression = 'gzip' | 'zlib' | 'none'

export function compress(buffer: Buffer, compression: FixtureCompression): Buffer {
  if (compression === 'gzip') return zlib.gzipSync(buffer)
  if (compression === 'zlib') return zlib.deflateSync(buffer)
  return buffer
}

export { writeInt32, writeInt16, writeInt64, writeFloat, writeDouble }

import zlib from 'node:zlib'
import { CoreError } from '../errors'
import {
  DEFAULT_NBT_LIMITS,
  TAG_TYPE,
  type NbtCompression,
  type NbtFile,
  type NbtLimits,
  type Tag,
  type TagType,
} from './types'

/**
 * Zero-dependency Java NBT reader with gzip/zlib sniffing.
 *
 * Security posture (docs/11 §8):
 *  - decompression uses `maxOutputLength` (gzip bomb);
 *  - every length is validated against the remaining bytes before allocation;
 *  - nesting depth, array/list length and compound key count are capped;
 *  - arrays are `Buffer.subarray` views (or skipped entirely for list views);
 *  - compounds are `Map`s, so a `__proto__` key is inert.
 */

function invalid(message: string, details?: Record<string, unknown>): never {
  throw new CoreError('SCHEMATIC.INVALID', { message, details })
}

function limitExceeded(message: string, details?: Record<string, unknown>): never {
  throw new CoreError('SCHEMATIC.LIMIT_EXCEEDED', { message, details })
}

function effectiveLimits(limits: NbtLimits = {}): Required<NbtLimits> {
  return { ...DEFAULT_NBT_LIMITS, ...limits }
}

function mapZlibError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error)
  const code = (error as { code?: unknown } | null)?.code
  if (
    code === 'ERR_BUFFER_TOO_LARGE' ||
    /maxOutputLength|buffer too large|Cannot create a Buffer larger/i.test(message)
  ) {
    limitExceeded('解压后的 NBT 数据超过大小限制（可能是 gzip bomb）', { message })
  }
  invalid(`NBT 解压失败: ${message}`, { causeCode: typeof code === 'string' ? code : undefined })
}

function decompress(
  buffer: Buffer,
  limits: Required<NbtLimits>,
): { compression: NbtCompression; payload: Buffer } {
  if (buffer.length === 0) invalid('投影文件为空')
  if (buffer.length > limits.maxCompressedBytes) {
    limitExceeded('压缩文件本身超过大小限制', {
      bytes: buffer.length,
      maxCompressedBytes: limits.maxCompressedBytes,
    })
  }
  const first = buffer[0]
  const second = buffer.length > 1 ? buffer[1] : -1
  let compression: NbtCompression
  let payload: Buffer
  try {
    if (first === 0x1f && second === 0x8b) {
      compression = 'gzip'
      payload = zlib.gunzipSync(buffer, { maxOutputLength: limits.maxDecompressedBytes })
    } else if (first === 0x78) {
      compression = 'zlib'
      payload = zlib.inflateSync(buffer, { maxOutputLength: limits.maxDecompressedBytes })
    } else if (first === TAG_TYPE.compound) {
      // Uncompressed NBT: the first byte is already the root compound tag.
      compression = 'none'
      payload = buffer
    } else {
      invalid('不是 gzip/zlib/NBT 文件（无法识别文件头）', {
        header: [...buffer.subarray(0, 8)].map((byte) => byte.toString(16).padStart(2, '0')),
      })
    }
  } catch (error) {
    if (error instanceof CoreError) throw error
    return mapZlibError(error)
  }
  if (payload.length === 0) invalid('NBT 解压后为空')
  if (payload.length > limits.maxDecompressedBytes) {
    limitExceeded('解压后的 NBT 数据超过大小限制', {
      bytes: payload.length,
      maxDecompressedBytes: limits.maxDecompressedBytes,
    })
  }
  return { compression, payload }
}

/** Minimum payload byte count per element type, used to reject absurd lengths. */
const MIN_PAYLOAD: Record<TagType, number> = {
  0: 0,
  1: 1,
  2: 2,
  3: 4,
  4: 8,
  5: 4,
  6: 8,
  7: 4,
  8: 2,
  9: 5,
  10: 1,
  11: 4,
  12: 4,
}

const ARRAY_TAG_TYPES = new Set<TagType>([TAG_TYPE.byteArray, TAG_TYPE.intArray, TAG_TYPE.longArray])

class NbtReader {
  offset = 0

  constructor(
    readonly buffer: Buffer,
    readonly limits: Required<NbtLimits>,
  ) {}

  remaining(): number {
    return this.buffer.length - this.offset
  }

  need(bytes: number): void {
    if (bytes < 0 || this.offset + bytes > this.buffer.length) {
      invalid('NBT 数据被截断（长度超出剩余字节）', {
        offset: this.offset,
        bytes,
        total: this.buffer.length,
      })
    }
  }

  u8(): number {
    this.need(1)
    const value = this.buffer.readUInt8(this.offset)
    this.offset += 1
    return value
  }

  i8(): number {
    this.need(1)
    const value = this.buffer.readInt8(this.offset)
    this.offset += 1
    return value
  }

  u16(): number {
    this.need(2)
    const value = this.buffer.readUInt16BE(this.offset)
    this.offset += 2
    return value
  }

  i16(): number {
    this.need(2)
    const value = this.buffer.readInt16BE(this.offset)
    this.offset += 2
    return value
  }

  i32(): number {
    this.need(4)
    const value = this.buffer.readInt32BE(this.offset)
    this.offset += 4
    return value
  }

  i64(): bigint {
    this.need(8)
    const value = this.buffer.readBigInt64BE(this.offset)
    this.offset += 8
    return value
  }

  f32(): number {
    this.need(4)
    const value = this.buffer.readFloatBE(this.offset)
    this.offset += 4
    return value
  }

  f64(): number {
    this.need(8)
    const value = this.buffer.readDoubleBE(this.offset)
    this.offset += 8
    return value
  }

  /** u16 byte-length prefix + modified-UTF-8 bytes. */
  name(): string {
    const length = this.u16()
    this.need(length)
    const slice = this.buffer.subarray(this.offset, this.offset + length)
    this.offset += length
    return decodeModifiedUtf8(slice)
  }
}

/**
 * Java `DataOutput.writeUTF` (modified UTF-8): NUL is `C0 80`, supplementary
 * characters are two 3-byte surrogate sequences (an emoji takes 6 bytes).
 * Standard 4-byte UTF-8 is accepted too because some third-party writers use it.
 */
export function decodeModifiedUtf8(bytes: Buffer): string {
  const units: number[] = []
  let index = 0
  const byteAt = (position: number): number => {
    if (position >= bytes.length) invalid('字符串字节越界')
    return bytes[position]
  }
  while (index < bytes.length) {
    const first = bytes[index]
    if (first < 0x80) {
      units.push(first)
      index += 1
      continue
    }
    if (first === 0xc0) {
      const second = byteAt(index + 1)
      if (second !== 0x80) invalid('非法 modified UTF-8 字符串')
      units.push(0)
      index += 2
      continue
    }
    if ((first & 0xe0) === 0xc0) {
      const second = byteAt(index + 1)
      if ((second & 0xc0) !== 0x80) invalid('非法 modified UTF-8 字符串')
      units.push(((first & 0x1f) << 6) | (second & 0x3f))
      index += 2
      continue
    }
    if ((first & 0xf0) === 0xe0) {
      const second = byteAt(index + 1)
      const third = byteAt(index + 2)
      if ((second & 0xc0) !== 0x80 || (third & 0xc0) !== 0x80) {
        invalid('非法 modified UTF-8 字符串')
      }
      units.push(((first & 0x0f) << 12) | ((second & 0x3f) << 6) | (third & 0x3f))
      index += 3
      continue
    }
    if ((first & 0xf8) === 0xf0) {
      const second = byteAt(index + 1)
      const third = byteAt(index + 2)
      const fourth = byteAt(index + 3)
      if (
        (second & 0xc0) !== 0x80 ||
        (third & 0xc0) !== 0x80 ||
        (fourth & 0xc0) !== 0x80
      ) {
        invalid('非法 UTF-8 字符串')
      }
      const codePoint =
        ((first & 0x07) << 18) |
        ((second & 0x3f) << 12) |
        ((third & 0x3f) << 6) |
        (fourth & 0x3f)
      if (codePoint < 0x10000 || codePoint > 0x10ffff) invalid('非法 UTF-8 码点')
      const adjusted = codePoint - 0x10000
      units.push(0xd800 + (adjusted >> 10), 0xdc00 + (adjusted & 0x3ff))
      index += 4
      continue
    }
    invalid('非法 UTF-8 字符串首字节')
  }
  let text = ''
  for (let start = 0; start < units.length; start += 4096) {
    text += String.fromCharCode(...units.slice(start, start + 4096))
  }
  return text
}

function readPayload(reader: NbtReader, type: TagType, depth: number): Tag {
  switch (type) {
    case TAG_TYPE.byte:
      return { type: 'byte', value: reader.i8() }
    case TAG_TYPE.short:
      return { type: 'short', value: reader.i16() }
    case TAG_TYPE.int:
      return { type: 'int', value: reader.i32() }
    case TAG_TYPE.long:
      return { type: 'long', value: reader.i64() }
    case TAG_TYPE.float:
      return { type: 'float', value: reader.f32() }
    case TAG_TYPE.double:
      return { type: 'double', value: reader.f64() }
    case TAG_TYPE.byteArray:
      return readArray(reader, type, 1)
    case TAG_TYPE.string:
      return { type: 'string', value: reader.name() }
    case TAG_TYPE.list:
      return readList(reader, depth)
    case TAG_TYPE.compound:
      return { type: 'compound', value: readCompoundPayload(reader, depth) }
    case TAG_TYPE.intArray:
      return readArray(reader, type, 4)
    case TAG_TYPE.longArray:
      return readArray(reader, type, 8)
    default:
      return invalid(`未知 NBT tag 类型: ${type}`)
  }
}

function readArray(reader: NbtReader, type: TagType, elementBytes: number): Tag {
  const length = reader.i32()
  if (length < 0) invalid('NBT 数组长度为负', { type, length })
  if (length > reader.limits.maxArrayLength) {
    limitExceeded('NBT 数组长度超过限制', { type, length, max: reader.limits.maxArrayLength })
  }
  const bytes = length * elementBytes
  reader.need(bytes)
  if (reader.limits.skipArrays) {
    reader.offset += bytes
    return { type: 'skipped', tagType: type, byteLength: bytes }
  }
  const start = reader.offset
  reader.offset += bytes
  const value = reader.buffer.subarray(start, start + bytes)
  if (type === TAG_TYPE.byteArray) return { type: 'byteArray', value }
  if (type === TAG_TYPE.intArray) return { type: 'intArray', value }
  return { type: 'longArray', value }
}

function readList(reader: NbtReader, depth: number): Tag {
  const elementType = reader.u8() as TagType
  if (elementType > TAG_TYPE.longArray) {
    invalid(`list 元素类型非法: ${elementType}`)
  }
  const length = reader.i32()
  if (length < 0) invalid('list 长度为负', { length })
  if (length > reader.limits.maxArrayLength) {
    limitExceeded('list 长度超过限制', { length, max: reader.limits.maxArrayLength })
  }
  if (length === 0) return { type: 'list', elementType, value: [] }
  if (elementType === TAG_TYPE.end) {
    invalid('list 元素类型为 0（end）但长度非 0')
  }
  if (depth + 1 > reader.limits.maxDepth) {
    limitExceeded('NBT 嵌套层级超过限制', {
      depth: depth + 1,
      maxDepth: reader.limits.maxDepth,
    })
  }
  const minimum = MIN_PAYLOAD[elementType] * length
  if (minimum > reader.remaining()) {
    invalid('list 长度超出剩余字节', { elementType, length, remaining: reader.remaining() })
  }
  const values: Tag[] = []
  for (let index = 0; index < length; index += 1) {
    values.push(readPayload(reader, elementType, depth + 1))
  }
  return { type: 'list', elementType, value: values }
}

function readCompoundPayload(reader: NbtReader, depth: number): Map<string, Tag> {
  if (depth > reader.limits.maxDepth) {
    limitExceeded('NBT 嵌套层级超过限制', { depth, maxDepth: reader.limits.maxDepth })
  }
  const map = new Map<string, Tag>()
  for (;;) {
    const rawType = reader.u8()
    if (rawType === TAG_TYPE.end) return map
    if (rawType > TAG_TYPE.longArray) invalid(`compound 内未知 tag 类型: ${rawType}`)
    const type = rawType as TagType
    const name = reader.name()
    if (map.size >= reader.limits.maxArrayLength) {
      limitExceeded('compound 子键数量超过限制', { max: reader.limits.maxArrayLength })
    }
    map.set(name, readPayload(reader, type, depth + 1))
  }
}

/** Reads gzip/zlib/uncompressed NBT. Throws `SCHEMATIC.*` CoreErrors. */
export function readNbtFile(buffer: Buffer, limits: NbtLimits = {}): NbtFile {
  if (!Buffer.isBuffer(buffer)) invalid('NBT 输入不是 Buffer')
  const effective = effectiveLimits(limits)
  const { compression, payload } = decompress(buffer, effective)
  const reader = new NbtReader(payload, effective)
  const rootType = reader.u8()
  if (rootType !== TAG_TYPE.compound) {
    invalid('NBT 根节点不是 compound', { rootType })
  }
  const rootName = reader.name()
  const root = readCompoundPayload(reader, 1)
  // Trailing bytes are ignored: several tools append padding to .nbt files.
  return { compression, rootName, root: { type: 'compound', value: root } }
}

export { ARRAY_TAG_TYPES }

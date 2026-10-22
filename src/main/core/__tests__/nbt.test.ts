import zlib from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { CoreError } from '../errors'
import { readNbtFile } from '../nbt/read'
import { compoundAt, isArrayTag, tagOf } from '../nbt/query'
import {
  buildNbt,
  compress,
  rawRoot,
  tagByteArray,
  tagCompound,
  tagInt,
  tagList,
  tagLong,
  tagString,
  writeInt32,
  writeInt16,
  type FixtureTag,
} from './nbt-fixtures'

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn()
  } catch (error) {
    expect(error).toBeInstanceOf(CoreError)
    expect((error as CoreError).code).toBe(code)
    return
  }
  throw new Error(`expected ${code}`)
}

describe('NBT reader — successful parses', () => {
  it('reads gzip, zlib and uncompressed NBT with the same values', () => {
    const bytes = buildNbt([
      ['name', tagString('中文🎮')],
      ['count', tagInt(42)],
      ['stamp', tagLong(1_700_000_000_000n)],
      ['blocks', tagByteArray(Buffer.from([1, 2, 3]))],
      ['list', tagList(3, [tagInt(1), tagInt(2)])],
      ['nested', tagCompound([['flag', tagInt(1)]])],
    ])

    for (const compression of ['gzip', 'zlib', 'none'] as const) {
      const file = readNbtFile(compress(bytes, compression))
      expect(file.compression).toBe(compression)
      expect(file.root.value.get('name')).toMatchObject({ type: 'string', value: '中文🎮' })
      expect(file.root.value.get('count')).toMatchObject({ type: 'int', value: 42 })
      expect(file.root.value.get('stamp')).toMatchObject({
        type: 'long',
        value: 1_700_000_000_000n,
      })
      expect(compoundAt(file.root.value, 'nested')?.get('flag')).toMatchObject({ value: 1 })
      const blocks = tagOf(file.root.value, 'blocks')
      expect(isArrayTag(blocks)).toBe(true)
      expect(tagOf(file.root.value, 'list')).toMatchObject({ elementType: 3 })
    }
  })

  it('decodes modified UTF-8, including NUL and 6-byte emoji sequences', () => {
    const file = readNbtFile(
      compress(buildNbt([['s', tagString('a\u0000中文🎮z')]]), 'gzip'),
    )
    expect(tagOf(file.root.value, 's')).toMatchObject({ type: 'string', value: 'a\u0000中文🎮z' })
  })

  it('zero-copies arrays or skips them entirely', () => {
    const bytes = compress(
      buildNbt([['blocks', tagByteArray(Buffer.from([9, 8, 7, 6]))]]),
      'gzip',
    )
    const full = readNbtFile(bytes)
    expect(tagOf(full.root.value, 'blocks')).toMatchObject({ type: 'byteArray' })
    const skipped = readNbtFile(bytes, { skipArrays: true })
    expect(tagOf(skipped.root.value, 'blocks')).toMatchObject({
      type: 'skipped',
      tagType: 7,
      byteLength: 4,
    })
  })

  it('ignores trailing bytes after the root compound', () => {
    const valid = buildNbt([['x', tagInt(1)]])
    const file = readNbtFile(Buffer.concat([valid, Buffer.from('trailing-garbage')]))
    expect(tagOf(file.root.value, 'x')).toMatchObject({ value: 1 })
  })

  it('keeps __proto__ as an inert compound key', () => {
    const file = readNbtFile(compress(buildNbt([['__proto__', tagString('safe')]]), 'gzip'))
    expect(tagOf(file.root.value, '__proto__')).toMatchObject({ value: 'safe' })
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })
})

describe('NBT reader — corrupt input', () => {
  it('rejects empty files, gzip headers without payload and unreadable magic', () => {
    expectCode(() => readNbtFile(Buffer.alloc(0)), 'SCHEMATIC.INVALID')
    expectCode(() => readNbtFile(zlib.gzipSync(Buffer.alloc(0))), 'SCHEMATIC.INVALID')
    expectCode(() => readNbtFile(Buffer.from('not an nbt file')), 'SCHEMATIC.INVALID')
    expectCode(() => readNbtFile(Buffer.from([0x1f, 0x8b, 1, 2])), 'SCHEMATIC.INVALID')
  })

  it('rejects a corrupt CRC and a truncated gzip stream', () => {
    const gzip = zlib.gzipSync(buildNbt([['x', tagInt(1)]]))
    const crcBroken = Buffer.from(gzip)
    crcBroken[crcBroken.length - 1] ^= 0xff
    expectCode(() => readNbtFile(crcBroken), 'SCHEMATIC.INVALID')
    expectCode(() => readNbtFile(gzip.subarray(0, gzip.length - 8)), 'SCHEMATIC.INVALID')
  })

  it('rejects a non-compound root', () => {
    expectCode(() => readNbtFile(Buffer.from([1, 0, 0, 0])), 'SCHEMATIC.INVALID')
  })

  it('rejects truncated integers and strings with out-of-bounds lengths', () => {
    expectCode(
      () =>
        readNbtFile(
          rawRoot([{ type: 3, key: 'x', payload: Buffer.from([0, 0]) }]),
        ),
      'SCHEMATIC.INVALID',
    )
    expectCode(
      () => readNbtFile(rawRoot([{ type: 8, key: 's', payload: writeInt16(100) }])),
      'SCHEMATIC.INVALID',
    )
  })
})

describe('NBT reader — resource limits', () => {
  it('stops deep nesting at the configured depth', () => {
    let nested: FixtureTag = tagInt(1)
    for (let depth = 0; depth < 200; depth += 1) {
      nested = tagCompound([['c', nested]])
    }
    const bytes = compress(buildNbt([['root', nested]]), 'gzip')
    expectCode(() => readNbtFile(bytes, { maxDepth: 64 }), 'SCHEMATIC.LIMIT_EXCEEDED')
  })

  it('rejects a 10 000-level nest without recursing into it', () => {
    const levels = 10_000
    const prefix = Buffer.from([10, 0, 1, 0x63]) // compound tag, name "c"
    const suffix = Buffer.from([0])
    const leaf = Buffer.from([1, 0, 0, 0]) // byte tag, empty name, value 0
    const payload = Buffer.concat([
      ...Array.from({ length: levels }, () => prefix),
      leaf,
      ...Array.from({ length: levels }, () => suffix),
    ])
    const root = rawRoot([{ type: 10, key: 'root', payload }])
    expectCode(() => readNbtFile(root), 'SCHEMATIC.LIMIT_EXCEEDED')
  })

  it('accepts empty strings and rejects only out-of-bounds lengths', () => {
    const file = readNbtFile(compress(buildNbt([['s', tagString('')]]), 'gzip'))
    expect(tagOf(file.root.value, 's')).toMatchObject({ type: 'string', value: '' })
  })

  it('rejects absurd list/array lengths before allocating', () => {
    // byteArray with length = 0x7FFFFFFF (no payload)
    expectCode(
      () => readNbtFile(rawRoot([{ type: 7, key: 'a', payload: writeInt32(0x7fffffff) }])),
      'SCHEMATIC.LIMIT_EXCEEDED',
    )
    // Negative list length.
    expectCode(
      () =>
        readNbtFile(
          rawRoot([{ type: 9, key: 'l', payload: Buffer.concat([Buffer.from([1]), writeInt32(-1)]) }]),
        ),
      'SCHEMATIC.INVALID',
    )
    // List claims more elements than the remaining bytes can hold.
    expectCode(
      () =>
        readNbtFile(
          rawRoot([{ type: 9, key: 'l', payload: Buffer.concat([Buffer.from([1]), writeInt32(10)]) }]),
        ),
      'SCHEMATIC.INVALID',
    )
    // Empty list is valid; a non-zero-length list of type 0 is not.
    const empty = readNbtFile(
      rawRoot([{ type: 9, key: 'l', payload: Buffer.concat([Buffer.from([0]), writeInt32(0)]) }]),
    )
    expect(tagOf(empty.root.value, 'l')).toMatchObject({ elementType: 0, value: [] })
    expectCode(
      () =>
        readNbtFile(
          rawRoot([{ type: 9, key: 'l', payload: Buffer.concat([Buffer.from([0]), writeInt32(1)]) }]),
        ),
      'SCHEMATIC.INVALID',
    )
  })

  it('caps decompressed size (gzip bomb)', () => {
    const bomb = zlib.gzipSync(Buffer.alloc(4 * 1024 * 1024))
    expectCode(() => readNbtFile(bomb, { maxDecompressedBytes: 1024 }), 'SCHEMATIC.LIMIT_EXCEEDED')
  })

  it('caps the compressed file size', () => {
    const bytes = compress(buildNbt([['x', tagInt(1)]]), 'gzip')
    expectCode(() => readNbtFile(bytes, { maxCompressedBytes: 4 }), 'SCHEMATIC.LIMIT_EXCEEDED')
  })
})

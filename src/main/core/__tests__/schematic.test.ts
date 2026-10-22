import { describe, expect, it } from 'vitest'
import { CoreError } from '../errors'
import { isSchematicFileName, readSchematic } from '../schematic'
import {
  buildNbt,
  compress,
  tagByteArray,
  tagCompound,
  tagInt,
  tagList,
  tagLong,
  tagShort,
  tagString,
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

function vec(x: number, y: number, z: number): FixtureTag {
  return tagCompound([
    ['x', tagInt(x)],
    ['y', tagInt(y)],
    ['z', tagInt(z)],
  ])
}

function regions(): FixtureTag {
  return tagCompound([
    ['R1', tagCompound([['Size', vec(5, 11, 3)], ['Position', vec(0, 0, 0)]])],
    ['R2', tagCompound([['Size', vec(4, -8, 3)], ['Position', vec(5, 0, 0)]])],
    ['R3', tagCompound([['Size', vec(3, -14, 2)], ['Position', vec(9, 0, 0)]])],
    ['R4', tagCompound([['Size', vec(2, -10, 1)], ['Position', vec(12, 0, 0)]])],
  ])
}

function metadata(extra: Array<[string, FixtureTag]> = []): FixtureTag {
  return tagCompound([
    ['EnclosingSize', vec(14, 24, 3)],
    ['TotalVolume', tagInt(999)],
    ['RegionCount', tagInt(99)],
    ['Name', tagString('Sample')],
    ['Author', tagString('Tester')],
    ['Description', tagString('sample description')],
    ['TimeCreated', tagLong(1_700_000_000_000n)],
    ...extra,
  ])
}

function litematic(metadataTag: FixtureTag = metadata()): Buffer {
  return compress(
    buildNbt([
      ['Version', tagInt(6)],
      ['Metadata', metadataTag],
      ['Regions', regions()],
    ]),
    'gzip',
  )
}

describe('schematic detection and metadata', () => {
  it('parses litematic with negative Region.Size and counts per region', () => {
    const parsed = readSchematic(litematic())
    expect(parsed.format).toBe('litematic')
    expect(parsed.version).toBe(6)
    // EnclosingSize wins when present; negative sizes are directions, not corruption.
    expect(parsed.size).toEqual({ x: 14, y: 24, z: 3 })
    // Metadata.TotalVolume (999) is unreliable: the region sum is 365.
    expect(parsed.volume).toBe(365)
    // RegionCount metadata lies (99); the actual count is used.
    expect(parsed.regionCount).toBe(4)
    expect(parsed.name).toBe('Sample')
    expect(parsed.author).toBe('Tester')
    expect(parsed.timeCreated).toBe(1_700_000_000_000)
    expect(parsed.regions[1]).toMatchObject({
      name: 'R2',
      position: { x: 5, y: 0, z: 0 },
      size: { x: 4, y: 8, z: 3 },
    })
  })

  it('derives dimensions from the region union when EnclosingSize is missing', () => {
    const withoutEnclosing = tagCompound([
      ['Name', tagString('No enclosing')],
      ['RegionCount', tagInt(4)],
    ])
    const parsed = readSchematic(litematic(withoutEnclosing))
    expect(parsed.format).toBe('litematic')
    expect(parsed.size).toEqual({ x: 14, y: 24, z: 3 })
    expect(parsed.volume).toBe(365)
    expect(parsed.name).toBe('No enclosing')
  })

  it('parses litematic without a Metadata compound (regions only)', () => {
    const bytes = compress(
      buildNbt([
        ['Version', tagInt(6)],
        ['Regions', tagCompound([['R', tagCompound([['Size', vec(-4, 5, -6)], ['Position', vec(-2, -3, -4)]])]])],
      ]),
      'gzip',
    )
    const parsed = readSchematic(bytes)
    expect(parsed.size).toEqual({ x: 4, y: 5, z: 6 })
    expect(parsed.regionCount).toBe(1)
    expect(parsed.regions[0]).toMatchObject({ position: { x: -2, y: -3, z: -4 } })
  })

  it('parses Sponge v1/v2 with unsigned short dimensions', () => {
    for (const version of [1, 2]) {
      const bytes = compress(
        buildNbt(
          [
            ['Version', tagInt(version)],
            ['Width', tagShort(300)],
            ['Height', tagShort(5)],
            ['Length', tagShort(7)],
            ['Palette', tagCompound([['minecraft:stone', tagInt(0)]])],
            ['BlockData', tagByteArray(Buffer.from([0]))],
          ],
          'Schematic',
        ),
        'gzip',
      )
      const parsed = readSchematic(bytes)
      expect(parsed.format).toBe(version === 1 ? 'sponge-v1' : 'sponge-v2')
      expect(parsed.size).toEqual({ x: 300, y: 5, z: 7 })
      expect(parsed.version).toBe(version)
    }
  })

  it('parses Sponge v3 from the nested Schematic compound', () => {
    const bytes = compress(
      buildNbt([
        [
          'Schematic',
          tagCompound([
            ['Version', tagInt(3)],
            ['Width', tagShort(2)],
            ['Height', tagShort(3)],
            ['Length', tagShort(4)],
            ['Palette', tagCompound([['minecraft:stone', tagInt(0)]])],
            ['BlockData', tagByteArray(Buffer.from([0]))],
          ]),
        ],
      ]),
      'gzip',
    )
    const parsed = readSchematic(bytes)
    expect(parsed.format).toBe('sponge-v3')
    expect(parsed.size).toEqual({ x: 2, y: 3, z: 4 })
  })

  it('parses MCEdit .schematic (Materials + Blocks, no Version)', () => {
    const bytes = compress(
      buildNbt(
        [
          ['Materials', tagString('Alpha')],
          ['Blocks', tagByteArray(Buffer.from([1, 2, 3]))],
          ['Width', tagShort(10)],
          ['Height', tagShort(20)],
          ['Length', tagShort(30)],
        ],
        'Schematic',
      ),
      'gzip',
    )
    const parsed = readSchematic(bytes)
    expect(parsed.format).toBe('mcedit')
    expect(parsed.size).toEqual({ x: 10, y: 20, z: 30 })
  })

  it('parses vanilla structure .nbt (size List<Int>[3])', () => {
    const bytes = compress(
      buildNbt([
        ['size', tagList(3, [tagInt(5), tagInt(6), tagInt(7)])],
        ['palette', tagList(10, [])],
        ['blocks', tagList(10, [])],
        ['DataVersion', tagInt(3465)],
      ]),
      'gzip',
    )
    const parsed = readSchematic(bytes)
    expect(parsed.format).toBe('structure')
    expect(parsed.size).toEqual({ x: 5, y: 6, z: 7 })
  })

  it('prefers litematic over the other candidates', () => {
    const bytes = compress(
      buildNbt([
        ['Version', tagInt(6)],
        ['Metadata', metadata()],
        ['Regions', regions()],
        ['Schematic', tagCompound([['Version', tagInt(3)], ['Width', tagShort(1)], ['Height', tagShort(1)], ['Length', tagShort(1)]])],
      ]),
      'gzip',
    )
    expect(readSchematic(bytes).format).toBe('litematic')
  })

  it('gives readable errors for unsupported and corrupt files', () => {
    expectCode(() => readSchematic(Buffer.alloc(0)), 'SCHEMATIC.INVALID')
    expectCode(
      () => readSchematic(compress(buildNbt([['hello', tagString('world')]]), 'gzip')),
      'SCHEMATIC.INVALID',
    )
    expectCode(
      () =>
        readSchematic(
          compress(
            buildNbt([
              ['Version', tagInt(6)],
              ['Metadata', metadata()],
              ['Regions', tagCompound([['R', tagCompound([['Position', vec(0, 0, 0)]])]])],
            ]),
            'gzip',
          ),
        ),
      'SCHEMATIC.INVALID',
    )
    expectCode(
      () => readSchematic(litematic(), { maxDecompressedBytes: 32 }),
      'SCHEMATIC.LIMIT_EXCEEDED',
    )
  })
})

describe('schematic file names', () => {
  it('accepts the four supported extensions case-insensitively', () => {
    for (const name of ['a.litematic', 'b.NBT', 'c.schem', 'd.Schematic']) {
      expect(isSchematicFileName(name)).toBe(true)
    }
    expect(isSchematicFileName('readme.txt')).toBe(false)
    expect(isSchematicFileName('schem')).toBe(false)
  })
})

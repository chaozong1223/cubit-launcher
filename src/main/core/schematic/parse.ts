import { CoreError } from '../errors'
import type { SchematicDimensions, SchematicFormat } from '@shared/assets'
import { readNbtFile } from '../nbt/read'
import {
  compoundAt,
  compoundValue,
  intValue,
  isArrayTag,
  listValue,
  longValue,
  stringValue,
  tagOf,
} from '../nbt/query'
import type { NbtFile, NbtLimits, Tag } from '../nbt/types'

/**
 * Projection detector/parser for `.litematic`, `.schem`, `.schematic` and
 * structure `.nbt` files (docs/11-schematic-format.md).
 *
 * Detection order is byte-driven, never extension-driven:
 *   litematic → Sponge v3 → MCEdit → Sponge v1/v2 → vanilla structure.
 */

export interface SchematicVec3 {
  x: number
  y: number
  z: number
}

export interface SchematicRegion {
  name: string
  /** Raw position; may be negative. */
  position: SchematicVec3
  /** Absolute size (Region.Size may be negative to indicate direction). */
  size: SchematicVec3
}

export interface ParsedSchematic {
  format: Exclude<SchematicFormat, 'unknown'>
  version: number | null
  size: SchematicDimensions
  name: string | null
  author: string | null
  description: string | null
  regionCount: number | null
  /** Block count; region-sum when possible (Metadata.TotalVolume can overflow). */
  volume: number | null
  timeCreated: number | null
  timeModified: number | null
  regions: SchematicRegion[]
}

export const SCHEMATIC_EXTENSIONS = ['.litematic', '.schem', '.schematic', '.nbt'] as const

const MAX_REGIONS = 4_096
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER)

function invalid(message: string, details?: Record<string, unknown>): never {
  throw new CoreError('SCHEMATIC.INVALID', { message, details })
}

function limitExceeded(message: string, details?: Record<string, unknown>): never {
  throw new CoreError('SCHEMATIC.LIMIT_EXCEEDED', { message, details })
}

export function isSchematicFileName(name: string): boolean {
  const lower = name.toLowerCase()
  return SCHEMATIC_EXTENSIONS.some((extension) => lower.endsWith(extension))
}

function vec3(tag: Tag | undefined, field: string, source: string): SchematicVec3 | null {
  const map = compoundValue(tag)
  if (!map) return null
  const x = intValue(tagOf(map, 'x'))
  const y = intValue(tagOf(map, 'y'))
  const z = intValue(tagOf(map, 'z'))
  if (x === null || y === null || z === null) {
    invalid(`${source}.${field} 不是有效的整数坐标`)
  }
  return { x, y, z }
}

function dimensionsOf(vec: SchematicVec3): SchematicDimensions {
  return { x: Math.abs(vec.x), y: Math.abs(vec.y), z: Math.abs(vec.z) }
}

function timeValue(tag: Tag | undefined): number | null {
  const value = longValue(tag) ?? (tag?.type === 'int' ? BigInt(tag.value) : null)
  if (value === null || value <= 0n) return null
  if (value > MAX_SAFE) return null
  return Number(value)
}

/** Unsigned short dimensions as written by MCEdit/Sponge v1/v2. */
function spongeDimension(tag: Tag | undefined, field: string): number {
  if (!tag) invalid(`缺少 ${field} 尺寸字段`)
  if (tag.type === 'short') return tag.value & 0xffff
  if (tag.type === 'int') return Math.abs(tag.value)
  return invalid(`${field} 不是 short/int 尺寸`)
}

function regionBounds(region: SchematicRegion): { min: SchematicVec3; max: SchematicVec3 } {
  const axis = (position: number, size: number): [number, number] => {
    if (size === 0) return [position, position]
    const end = position + (size > 0 ? size - 1 : size + 1)
    return end < position ? [end, position] : [position, end]
  }
  const [minX, maxX] = axis(region.position.x, region.size.x)
  const [minY, maxY] = axis(region.position.y, region.size.y)
  const [minZ, maxZ] = axis(region.position.z, region.size.z)
  return { min: { x: minX, y: minY, z: minZ }, max: { x: maxX, y: maxY, z: maxZ } }
}

function regionVolume(region: SchematicRegion): bigint {
  return (
    BigInt(Math.abs(region.size.x)) *
    BigInt(Math.abs(region.size.y)) *
    BigInt(Math.abs(region.size.z))
  )
}

function safeNumber(value: bigint): number | null {
  if (value < 0n || value > MAX_SAFE) return null
  return Number(value)
}

function parseLitematic(nbt: NbtFile): ParsedSchematic {
  const root = nbt.root.value
  const metadata = compoundValue(tagOf(root, 'Metadata'))
  const regionsMap = compoundValue(tagOf(root, 'Regions'))
  if (!regionsMap) invalid('litematic 缺少 Regions compound')

  const regions: SchematicRegion[] = []
  // Union must be computed from the *signed* Size; the display size is abs().
  let minX = Infinity
  let minY = Infinity
  let minZ = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let maxZ = -Infinity
  for (const [name, tag] of regionsMap) {
    if (regions.length >= MAX_REGIONS) {
      limitExceeded('litematic region 数量超过限制', { max: MAX_REGIONS })
    }
    const region = compoundValue(tag)
    if (!region) invalid(`litematic region「${name}」不是 compound`)
    const position = vec3(tagOf(region, 'Position'), 'Position', `Regions.${name}`) ?? {
      x: 0,
      y: 0,
      z: 0,
    }
    const rawSize = vec3(tagOf(region, 'Size'), 'Size', `Regions.${name}`)
    if (!rawSize) invalid(`litematic region「${name}」缺少 Size`)
    // Negative Region.Size is a direction marker, not corruption.
    const size = {
      x: Math.abs(rawSize.x),
      y: Math.abs(rawSize.y),
      z: Math.abs(rawSize.z),
    }
    regions.push({ name, position, size })
    const bounds = regionBounds({ name, position, size: rawSize })
    minX = Math.min(minX, bounds.min.x)
    minY = Math.min(minY, bounds.min.y)
    minZ = Math.min(minZ, bounds.min.z)
    maxX = Math.max(maxX, bounds.max.x)
    maxY = Math.max(maxY, bounds.max.y)
    maxZ = Math.max(maxZ, bounds.max.z)
  }

  let size: SchematicDimensions | null = null
  const metadataMap: Map<string, Tag> = metadata ?? new Map<string, Tag>()
  const enclosing = vec3(tagOf(metadataMap, 'EnclosingSize'), 'EnclosingSize', 'Metadata')
  if (enclosing) {
    size = dimensionsOf(enclosing)
    if (size.x === 0 && size.y === 0 && size.z === 0) size = null
  }
  if (!size) {
    if (regions.length === 0) invalid('litematic 既没有 EnclosingSize 也没有 region')
    size = { x: maxX - minX + 1, y: maxY - minY + 1, z: maxZ - minZ + 1 }
  }

  let volumeBig = 0n
  for (const region of regions) volumeBig += regionVolume(region)
  let volume = safeNumber(volumeBig)
  if (volume === null && regions.length === 0) {
    const metadataVolume = intValue(tagOf(metadataMap, 'TotalVolume'))
    if (metadataVolume !== null && metadataVolume >= 0) volume = metadataVolume
  }

  const regionCount =
    regions.length > 0
      ? regions.length
      : Math.max(0, intValue(tagOf(metadataMap, 'RegionCount')) ?? 0)

  return {
    format: 'litematic',
    version: intValue(tagOf(root, 'Version')),
    size,
    name: stringValue(tagOf(metadataMap, 'Name')),
    author: stringValue(tagOf(metadataMap, 'Author')),
    description: stringValue(tagOf(metadataMap, 'Description')),
    regionCount,
    volume,
    timeCreated: timeValue(tagOf(metadataMap, 'TimeCreated')),
    timeModified: timeValue(tagOf(metadataMap, 'TimeModified')),
    regions,
  }
}

function parseSponge(
  compound: Map<string, Tag>,
  version: number,
  format: 'sponge-v1' | 'sponge-v2' | 'sponge-v3',
  label: string,
): ParsedSchematic {
  const width = spongeDimension(tagOf(compound, 'Width'), `${label}.Width`)
  const height = spongeDimension(tagOf(compound, 'Height'), `${label}.Height`)
  const length = spongeDimension(tagOf(compound, 'Length'), `${label}.Length`)
  return {
    format,
    version,
    size: { x: width, y: height, z: Math.abs(length) },
    name: null,
    author: null,
    description: null,
    regionCount: null,
    volume: null,
    timeCreated: null,
    timeModified: null,
    regions: [],
  }
}

function parseMcedit(nbt: NbtFile): ParsedSchematic {
  const root = nbt.root.value
  const width = spongeDimension(tagOf(root, 'Width'), 'Width')
  const height = spongeDimension(tagOf(root, 'Height'), 'Height')
  const length = spongeDimension(tagOf(root, 'Length'), 'Length')
  return {
    format: 'mcedit',
    version: null,
    size: { x: width, y: height, z: length },
    name: null,
    author: null,
    description: null,
    regionCount: null,
    volume: null,
    timeCreated: null,
    timeModified: null,
    regions: [],
  }
}

function parseStructure(root: Map<string, Tag>): ParsedSchematic {
  const sizeList = listValue(tagOf(root, 'size'))
  if (!sizeList || sizeList.value.length < 3) {
    invalid('原版结构文件缺少 size List<Int>[3]')
  }
  if (sizeList.elementType !== 3) {
    invalid('原版结构文件 size 的元素类型不是 Int')
  }
  const values = sizeList.value.slice(0, 3).map((tag) => intValue(tag))
  if (values.some((value) => value === null)) invalid('原版结构文件 size 含非法数值')
  const [x, y, z] = values as number[]
  return {
    format: 'structure',
    version: null,
    size: { x: Math.abs(x), y: Math.abs(y), z: Math.abs(z) },
    name: null,
    author: null,
    description: null,
    regionCount: null,
    volume: null,
    timeCreated: null,
    timeModified: null,
    regions: [],
  }
}

/** Detects and parses a schematic from raw file bytes (compressed or not). */
export function readSchematic(buffer: Buffer, limits: NbtLimits = {}): ParsedSchematic {
  const nbt = readNbtFile(buffer, limits)
  const root = nbt.root.value
  const version = intValue(tagOf(root, 'Version'))

  // 1. litematic: Version + Metadata + Regions at the root. Version alone is
  //    not required, so a metadata-stripped litematic still opens read-only.
  if (compoundValue(tagOf(root, 'Regions')) && (version !== null || root.has('Metadata'))) {
    return parseLitematic(nbt)
  }

  // 2. Sponge v3: nested `Schematic` compound carrying Version=3.
  const nested = compoundAt(root, 'Schematic')
  if (nested) {
    const nestedVersion = intValue(tagOf(nested, 'Version'))
    if (nestedVersion === 3) return parseSponge(nested, 3, 'sponge-v3', 'Schematic')
  }

  // 3. MCEdit `.schematic`: root name "Schematic", Materials + Blocks, no Version.
  if (
    nbt.rootName === 'Schematic' &&
    tagOf(root, 'Materials')?.type === 'string' &&
    isArrayTag(tagOf(root, 'Blocks')) &&
    version === null
  ) {
    return parseMcedit(nbt)
  }

  // 4. Sponge v1/v2: root name "Schematic", Version 1/2, Palette + BlockData.
  if (
    nbt.rootName === 'Schematic' &&
    (version === 1 || version === 2) &&
    root.has('Palette') &&
    root.has('BlockData')
  ) {
    return parseSponge(root, version, version === 1 ? 'sponge-v1' : 'sponge-v2', 'Schematic')
  }

  // 5. Vanilla structure: empty root name + size List<Int>[3].
  if (listValue(tagOf(root, 'size'))?.elementType === 3) {
    return parseStructure(root)
  }

  return invalid('不支持的投影格式（无法识别的 NBT 根结构）', {
    rootName: nbt.rootName.length > 0 ? nbt.rootName : '(empty)',
    keys: [...root.keys()].slice(0, 16),
  }) as never
}

export type { NbtLimits, SchematicDimensions }

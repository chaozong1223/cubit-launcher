/** NBT tag model (docs/11-schematic-format.md §6). */

export type TagType = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12

export type Tag =
  | { type: 'byte'; value: number }
  | { type: 'short'; value: number }
  | { type: 'int'; value: number }
  | { type: 'long'; value: bigint }
  | { type: 'float'; value: number }
  | { type: 'double'; value: number }
  | { type: 'byteArray'; value: Buffer }
  | { type: 'string'; value: string }
  | { type: 'list'; elementType: TagType; value: Tag[] }
  | { type: 'compound'; value: Map<string, Tag> }
  | { type: 'intArray'; value: Buffer }
  | { type: 'longArray'; value: Buffer }
  /** Present when `skipArrays` is enabled: payload validated then skipped. */
  | { type: 'skipped'; tagType: TagType; byteLength: number }

export interface CompoundTag {
  type: 'compound'
  value: Map<string, Tag>
}

export interface NbtLimits {
  /** Maximum compound/list nesting (root compound counts as level 1). */
  maxDepth?: number
  /** Maximum element count for arrays and lists. */
  maxArrayLength?: number
  /** Decompressed payload ceiling; protects against gzip bombs. */
  maxDecompressedBytes?: number
  /** Compressed input ceiling; protects against huge files in the list view. */
  maxCompressedBytes?: number
  /** Skip array payloads after validating them (list page). */
  skipArrays?: boolean
}

export const DEFAULT_NBT_LIMITS: Required<NbtLimits> = {
  maxDepth: 64,
  maxArrayLength: 1_000_000,
  maxDecompressedBytes: 256 * 1024 * 1024,
  maxCompressedBytes: 128 * 1024 * 1024,
  skipArrays: false,
}

export type NbtCompression = 'gzip' | 'zlib' | 'none'

export interface NbtFile {
  compression: NbtCompression
  /** Root compound name; unreliable for format detection (often empty). */
  rootName: string
  root: CompoundTag
}

export const TAG_TYPE = {
  end: 0,
  byte: 1,
  short: 2,
  int: 3,
  long: 4,
  float: 5,
  double: 6,
  byteArray: 7,
  string: 8,
  list: 9,
  compound: 10,
  intArray: 11,
  longArray: 12,
} as const

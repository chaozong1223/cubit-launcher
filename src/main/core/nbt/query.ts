import type { Tag, TagType } from './types'

/** Safe accessors used by the schematic detector; never throw on wrong types. */

export function tagOf(
  compound: Map<string, Tag> | null | undefined,
  key: string,
): Tag | undefined {
  return compound?.get(key)
}

export function compoundValue(tag: Tag | undefined): Map<string, Tag> | null {
  return tag && tag.type === 'compound' ? tag.value : null
}

export function compoundAt(
  compound: Map<string, Tag> | null | undefined,
  key: string,
): Map<string, Tag> | null {
  return compoundValue(tagOf(compound, key))
}

/** Integer-ish payloads (byte/short/int); longs are intentionally excluded. */
export function intValue(tag: Tag | undefined): number | null {
  if (!tag) return null
  switch (tag.type) {
    case 'byte':
    case 'short':
    case 'int':
      return tag.value
    default:
      return null
  }
}

/** Any numeric payload, including long when it fits a JS safe integer. */
export function numberValue(tag: Tag | undefined): number | null {
  if (!tag) return null
  switch (tag.type) {
    case 'byte':
    case 'short':
    case 'int':
    case 'float':
    case 'double':
      return Number.isFinite(tag.value) ? tag.value : null
    case 'long': {
      if (tag.value > BigInt(Number.MAX_SAFE_INTEGER) || tag.value < BigInt(Number.MIN_SAFE_INTEGER)) {
        return null
      }
      return Number(tag.value)
    }
    default:
      return null
  }
}

export function longValue(tag: Tag | undefined): bigint | null {
  return tag && tag.type === 'long' ? tag.value : null
}

export function stringValue(tag: Tag | undefined, maxLength = 512): string | null {
  if (!tag || tag.type !== 'string') return null
  return tag.value.length > maxLength ? tag.value.slice(0, maxLength) : tag.value
}

export function listValue(
  tag: Tag | undefined,
): { elementType: TagType; value: Tag[] } | null {
  return tag && tag.type === 'list' ? { elementType: tag.elementType, value: tag.value } : null
}

export function isArrayTag(tag: Tag | undefined): boolean {
  if (!tag) return false
  if (tag.type === 'byteArray' || tag.type === 'intArray' || tag.type === 'longArray') return true
  return tag.type === 'skipped' && [7, 11, 12].includes(tag.tagType)
}

export function arrayByteLength(tag: Tag | undefined): number | null {
  if (!tag) return null
  if (tag.type === 'byteArray' || tag.type === 'intArray' || tag.type === 'longArray') {
    return tag.value.length
  }
  if (tag.type === 'skipped') return tag.byteLength
  return null
}

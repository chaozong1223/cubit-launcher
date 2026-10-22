import { AppError } from '@shared/errors'
import { crc32 } from '../zip/reader'

/**
 * Minimal PNG header validation for local skin imports.
 *
 * We only accept PNG (no JPEG/WebP) and require a real IHDR chunk with a valid
 * CRC; the actual skin dimensions are enforced by the skin service (64x64 or
 * 64x32). Never trust the file extension.
 */

export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
export const MAX_SKIN_BYTES = 2 * 1024 * 1024

export interface PngInfo {
  width: number
  height: number
  bitDepth: number
  colorType: number
}

function invalid(message: string, details?: Record<string, unknown>): never {
  throw new AppError('SKIN.INVALID_PNG', message, { details })
}

export function readPngInfo(buffer: Buffer): PngInfo {
  if (buffer.length < 33) invalid('文件太小，不是有效的 PNG')
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) invalid('不是 PNG 文件（文件头不匹配）')
  const length = buffer.readUInt32BE(8)
  if (length !== 13) invalid('PNG 缺少有效的 IHDR 数据')
  if (buffer.toString('ascii', 12, 16) !== 'IHDR') invalid('PNG 第一个数据块不是 IHDR')
  const width = buffer.readUInt32BE(16)
  const height = buffer.readUInt32BE(20)
  const bitDepth = buffer[24]
  const colorType = buffer[25]
  const expectedCrc = buffer.readUInt32BE(29)
  const actualCrc = crc32(buffer.subarray(12, 29))
  if (actualCrc !== expectedCrc) invalid('PNG IHDR 校验失败，文件可能已损坏')
  if (width <= 0 || height <= 0 || width > 4096 || height > 4096) {
    invalid('PNG 尺寸不合法', { width, height })
  }
  if (bitDepth !== 8) invalid('只支持 8 位深度的 PNG 皮肤', { bitDepth })
  if (colorType !== 6 && colorType !== 2) {
    invalid('皮肤 PNG 必须是 RGBA 或 RGB', { colorType })
  }
  return { width, height, bitDepth, colorType }
}

export function isSupportedSkinSize(width: number, height: number): boolean {
  return (width === 64 && height === 64) || (width === 64 && height === 32)
}

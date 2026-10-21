import crypto from 'node:crypto'
import { AppError } from '@shared/errors'

export const MAX_PACK_FILE_BYTES = 256 * 1024 * 1024

export interface FileDownloader {
  download(url: string, maxBytes?: number): Promise<Buffer>
}

export interface FileHashes {
  sha1?: string
  sha512?: string
}

export function createFetchDownloader(fetchImpl: typeof fetch = fetch): FileDownloader {
  return {
    async download(url, maxBytes = MAX_PACK_FILE_BYTES) {
      let parsed: URL
      try {
        parsed = new URL(url)
      } catch {
        throw new AppError('MODS.PACK_DOWNLOAD_FAILED', `下载地址无效: ${url}`)
      }
      // Pack files are public artifacts; never download them over plain HTTP.
      if (parsed.protocol !== 'https:') {
        throw new AppError('MODS.PACK_DOWNLOAD_FAILED', `拒绝非 HTTPS 下载地址: ${url}`, {
          details: { url },
        })
      }
      const response = await fetchImpl(parsed, { redirect: 'follow' })
      if (!response.ok) {
        throw new AppError('MODS.PACK_DOWNLOAD_FAILED', `下载失败 HTTP ${response.status}`, {
          retryable: response.status >= 500,
          details: { url, status: response.status },
        })
      }
      const length = Number(response.headers.get('content-length') ?? '0')
      if (Number.isFinite(length) && length > maxBytes) {
        throw new AppError('MODS.PACK_TOO_LARGE', `文件超过大小上限: ${url}`, {
          details: { url, bytes: length, maxBytes },
        })
      }
      const data = Buffer.from(await response.arrayBuffer())
      if (data.length > maxBytes) {
        throw new AppError('MODS.PACK_TOO_LARGE', `文件超过大小上限: ${url}`, {
          details: { url, bytes: data.length, maxBytes },
        })
      }
      return data
    },
  }
}

export function sha1(data: Buffer): string {
  return crypto.createHash('sha1').update(data).digest('hex').toLowerCase()
}

export function sha512(data: Buffer): string {
  return crypto.createHash('sha512').update(data).digest('hex').toLowerCase()
}

function hashMatches(data: Buffer, hashes: FileHashes): boolean {
  if (hashes.sha512 && sha512(data) !== hashes.sha512.toLowerCase()) return false
  if (hashes.sha1 && sha1(data) !== hashes.sha1.toLowerCase()) return false
  return true
}

/**
 * Try every mirror until one payload matches the declared hash. A hash mismatch
 * is a hard failure (not a reason to silently write an unverified jar).
 */
export async function downloadVerified(
  downloader: FileDownloader,
  urls: string[],
  hashes: FileHashes,
  maxBytes = MAX_PACK_FILE_BYTES,
): Promise<{ data: Buffer; url: string }> {
  const usable = urls.filter((url) => typeof url === 'string' && url.length > 0)
  if (usable.length === 0) {
    throw new AppError('MODS.PACK_DOWNLOAD_FAILED', '整合包文件没有可用的下载地址')
  }
  const errors: string[] = []
  for (const url of usable) {
    try {
      const data = await downloader.download(url, maxBytes)
      if (!hashMatches(data, hashes)) {
        errors.push(`${url}: 哈希不匹配`)
        continue
      }
      return { data, url }
    } catch (error) {
      errors.push(`${url}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new AppError('MODS.PACK_DOWNLOAD_FAILED', '所有下载地址均失败或哈希不匹配', {
    retryable: true,
    details: { errors },
  })
}

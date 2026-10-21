import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { AppError } from '@shared/errors'
import { DownloadError } from '../../download/core/errors'
import type { HttpClient } from '../../download/core/http'

/**
 * Catalog artifact download.
 *
 * Modrinth files carry sha1+sha512; both are checked when present. Downloads
 * go to a `.part` file first, are size/hash checked, then atomically renamed.
 */

export interface CatalogDownloadInput {
  http: HttpClient
  url: string
  dest: string
  sha1?: string | null
  sha512?: string | null
  size?: number | null
  maxBytes?: number
  allowedHosts?: string[]
  allowInsecureHosts?: string[]
  signal?: AbortSignal
  onProgress?: (bytes: number, total: number | null) => void
}

export interface CatalogDownloadResult {
  dest: string
  bytes: number
  sha1: string
  sha512: string
}

const DEFAULT_MAX_BYTES = 512 * 1024 * 1024

function hostAllowed(hostname: string, patterns: string[]): boolean {
  const host = hostname.toLowerCase()
  return patterns.some((pattern) => {
    const value = pattern.toLowerCase()
    if (value.startsWith('*.')) return host === value.slice(2) || host.endsWith(value.slice(1))
    return host === value
  })
}

export async function downloadCatalogFile(input: CatalogDownloadInput): Promise<CatalogDownloadResult> {
  let target: URL
  try {
    target = new URL(input.url)
  } catch {
    throw new AppError('CATALOG.UNSAFE_URL', 'Modrinth 文件地址不合法，已拒绝', {
      details: { url: input.url },
    })
  }
  const insecure = input.allowInsecureHosts ?? []
  if (target.protocol !== 'https:' && !(target.protocol === 'http:' && hostAllowed(target.hostname, insecure))) {
    throw new AppError('CATALOG.UNSAFE_URL', 'Modrinth 文件地址不是 HTTPS，已拒绝', {
      details: { url: input.url },
    })
  }
  if (!hostAllowed(target.hostname, [...(input.allowedHosts ?? ['cdn.modrinth.com', '*.modrinth.com']), ...insecure])) {
    throw new AppError('CATALOG.UNSAFE_URL', 'Modrinth 文件地址指向了未授权主机，已拒绝', {
      details: { host: target.hostname },
    })
  }

  const part = `${input.dest}.part`
  await fsp.mkdir(path.dirname(input.dest), { recursive: true })
  await fsp.rm(part, { force: true })

  let response
  try {
    response = await input.http.openStream(input.url, {
      ...(input.signal ? { signal: input.signal } : {}),
      idleTimeoutMs: 60_000,
      headers: { accept: 'application/java-archive, application/octet-stream' },
      isRedirectAllowed: (_from, to) => {
        if (to.protocol !== 'https:') {
          return to.protocol === 'http:' && hostAllowed(to.hostname, input.allowInsecureHosts ?? [])
        }
        return hostAllowed(to.hostname, [
          ...(input.allowedHosts ?? ['cdn.modrinth.com', '*.modrinth.com']),
          ...(input.allowInsecureHosts ?? []),
        ])
      },
    })
  } catch (error) {
    throw new AppError('CATALOG.DOWNLOAD_FAILED', `无法下载 Modrinth 文件: ${input.url}`, {
      retryable: true,
      cause: error,
    })
  }

  if (response.status !== 200) {
    response.stream.resume()
    throw new AppError('CATALOG.DOWNLOAD_FAILED', `Modrinth 返回 HTTP ${response.status}`, {
      retryable: response.status === 429 || response.status >= 500,
      details: { status: response.status, url: input.url },
    })
  }

  const declared = Number(response.headers['content-length'] ?? 0)
  const total = input.size ?? (Number.isFinite(declared) && declared > 0 ? declared : null)
  const maxBytes = input.maxBytes ?? DEFAULT_MAX_BYTES
  if (total !== null && total > maxBytes) {
    response.stream.destroy()
    throw new AppError('CATALOG.SIZE_MISMATCH', '文件超过允许的最大大小', {
      details: { size: total, maxBytes },
    })
  }

  const sha1 = createHash('sha1')
  const sha512 = createHash('sha512')
  const out = fs.createWriteStream(part, { flags: 'w' })
  let bytes = 0
  let streamError: Error | null = null
  out.on('error', (error) => {
    streamError = error
  })

  try {
    for await (const chunk of response.stream) {
      if (input.signal?.aborted) {
        throw new AppError('CATALOG.CANCELLED', '下载已取消')
      }
      if (streamError) throw streamError
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
      bytes += buffer.length
      if (bytes > maxBytes) {
        throw new AppError('CATALOG.SIZE_MISMATCH', '文件超过允许的最大大小', {
          details: { size: bytes, maxBytes },
        })
      }
      sha1.update(buffer)
      sha512.update(buffer)
      if (!out.write(buffer)) await once(out, 'drain')
      input.onProgress?.(bytes, total)
    }
    await new Promise<void>((resolve, reject) => {
      out.end(() => (streamError ? reject(streamError) : resolve()))
    })
  } catch (error) {
    out.destroy()
    await fsp.rm(part, { force: true }).catch(() => undefined)
    if (error instanceof AppError) throw error
    throw new AppError('CATALOG.DOWNLOAD_FAILED', '文件下载中断', {
      retryable: true,
      cause: error,
    })
  }

  const actualSha1 = sha1.digest('hex')
  const actualSha512 = sha512.digest('hex')
  try {
    if (total !== null && bytes !== total) {
      throw new AppError('CATALOG.SIZE_MISMATCH', `文件大小 ${bytes} != ${total}`, {
        details: { expected: total, actual: bytes },
      })
    }
    if (input.sha512 && actualSha512.toLowerCase() !== input.sha512.toLowerCase()) {
      throw new AppError('CATALOG.HASH_MISMATCH', 'SHA-512 校验失败，已删除下载文件', {
        retryable: true,
        details: { expected: input.sha512, actual: actualSha512 },
      })
    }
    if (input.sha1 && actualSha1.toLowerCase() !== input.sha1.toLowerCase()) {
      throw new AppError('CATALOG.HASH_MISMATCH', 'SHA-1 校验失败，已删除下载文件', {
        retryable: true,
        details: { expected: input.sha1, actual: actualSha1 },
      })
    }
    await fsp.rename(part, input.dest)
  } catch (error) {
    await fsp.rm(part, { force: true }).catch(() => undefined)
    throw error
  }

  return { dest: input.dest, bytes, sha1: actualSha1, sha512: actualSha512 }
}

export function isDownloadError(error: unknown): error is DownloadError {
  return error instanceof DownloadError
}

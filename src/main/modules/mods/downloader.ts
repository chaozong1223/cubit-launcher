import crypto from 'node:crypto'
import https from 'node:https'
import { JobCancelledError } from '../../core/job/kernel'
import { AppError } from '@shared/errors'

export const MAX_PACK_FILE_BYTES = 256 * 1024 * 1024

export interface FileDownloadOptions {
  /** Aborts the HTTP body read (modpack import job cancellation). */
  signal?: AbortSignal
  /** Called with each received chunk so the job can report byte progress. */
  onBytes?: (delta: number) => void
}

export interface FileDownloader {
  download(url: string, maxBytes?: number, options?: FileDownloadOptions): Promise<Buffer>
}

export interface FileHashes {
  sha1?: string
  sha512?: string
}

function abortError(): JobCancelledError {
  return new JobCancelledError('下载已取消')
}

/**
 * HTTPS downloader with explicit timeouts.
 *
 * `fetch` was the wrong tool here: undici's connect timeout is ~10 s, and
 * cdn.modrinth.com measured 51 s for a 3 MB jar on this network (and often
 * refuses the connection outright). Every modpack import therefore died with
 * "fetch failed / UND_ERR_CONNECT_TIMEOUT" on the first file. `https.get` with
 * a 30 s socket timeout and a 5 min overall budget actually completes.
 */
const DOWNLOAD_CONNECT_TIMEOUT_MS = 30_000
const DOWNLOAD_TOTAL_TIMEOUT_MS = 5 * 60_000

function httpsDownload(
  url: string,
  maxBytes: number,
  options: FileDownloadOptions,
  redirects = 0,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      reject(new AppError('MODS.PACK_DOWNLOAD_FAILED', `下载地址无效: ${url}`))
      return
    }
    if (parsed.protocol !== 'https:') {
      reject(
        new AppError('MODS.PACK_DOWNLOAD_FAILED', `拒绝非 HTTPS 下载地址: ${url}`, {
          details: { url },
        }),
      )
      return
    }
    if (options.signal?.aborted) {
      reject(abortError())
      return
    }

    let settled = false
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(totalTimer)
      options.signal?.removeEventListener('abort', onAbort)
      fn()
    }

    const request = https.get(parsed, {
      timeout: DOWNLOAD_CONNECT_TIMEOUT_MS,
      headers: { 'User-Agent': 'mc-launcher' },
    })
    const totalTimer = setTimeout(() => {
      request.destroy(
        new AppError('MODS.PACK_DOWNLOAD_FAILED', `下载超时（5 分钟）: ${url}`, {
          details: { url },
        }),
      )
    }, DOWNLOAD_TOTAL_TIMEOUT_MS)
    totalTimer.unref?.()

    function onAbort(): void {
      request.destroy(abortError())
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })

    request.on('timeout', () => {
      request.destroy(
        new AppError('MODS.PACK_DOWNLOAD_FAILED', `连接超时: ${url}`, {
          details: { url },
        }),
      )
    })

    request.on('response', (response) => {
      const status = response.statusCode ?? 0
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume()
        if (redirects >= 5) {
          finish(() =>
            reject(
              new AppError('MODS.PACK_DOWNLOAD_FAILED', `重定向过多: ${url}`, {
                details: { url },
              }),
            ),
          )
          return
        }
        const next = new URL(response.headers.location, parsed).toString()
        finish(() => resolve(httpsDownload(next, maxBytes, options, redirects + 1)))
        return
      }
      if (status < 200 || status >= 300) {
        response.resume()
        finish(() =>
          reject(
            new AppError('MODS.PACK_DOWNLOAD_FAILED', `下载失败 HTTP ${status}`, {
              retryable: status >= 500,
              details: { url, status },
            }),
          ),
        )
        return
      }
      const length = Number(response.headers['content-length'] ?? '0')
      if (Number.isFinite(length) && length > maxBytes) {
        response.destroy()
        finish(() =>
          reject(
            new AppError('MODS.PACK_TOO_LARGE', `文件超过大小上限: ${url}`, {
              details: { url, bytes: length, maxBytes },
            }),
          ),
        )
        return
      }

      const chunks: Buffer[] = []
      let total = 0
      let tooLarge = false
      response.on('data', (chunk: Buffer) => {
        if (tooLarge) return
        total += chunk.length
        if (total > maxBytes) {
          tooLarge = true
          request.destroy()
          finish(() =>
            reject(
              new AppError('MODS.PACK_TOO_LARGE', `文件超过大小上限: ${url}`, {
                details: { url, bytes: total, maxBytes },
              }),
            ),
          )
          return
        }
        chunks.push(chunk)
        options.onBytes?.(chunk.length)
      })
      response.on('end', () => finish(() => resolve(Buffer.concat(chunks, total))))
      response.on('error', (error) => finish(() => reject(error)))
    })

    request.on('error', (error) => finish(() => reject(error)))
  })
}

export function createHttpsDownloader(): FileDownloader {
  return {
    download(url, maxBytes = MAX_PACK_FILE_BYTES, options: FileDownloadOptions = {}) {
      return httpsDownload(url, maxBytes, options)
    },
  }
}

export function createFetchDownloader(fetchImpl: typeof fetch = fetch): FileDownloader {
  return {
    async download(url, maxBytes = MAX_PACK_FILE_BYTES, options: FileDownloadOptions = {}) {
      if (options.signal?.aborted) throw abortError()
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
      const response = await fetchImpl(parsed, {
        redirect: 'follow',
        ...(options.signal ? { signal: options.signal } : {}),
      })
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

      const body = response.body
      if (!body) {
        const data = Buffer.from(await response.arrayBuffer())
        if (data.length > maxBytes) {
          throw new AppError('MODS.PACK_TOO_LARGE', `文件超过大小上限: ${url}`, {
            details: { url, bytes: data.length, maxBytes },
          })
        }
        options.onBytes?.(data.length)
        return data
      }

      const reader = body.getReader()
      const chunks: Buffer[] = []
      let total = 0
      try {
        for (;;) {
          if (options.signal?.aborted) throw abortError()
          const { done, value } = await reader.read()
          if (done) break
          if (!value) continue
          total += value.byteLength
          if (total > maxBytes) {
            throw new AppError('MODS.PACK_TOO_LARGE', `文件超过大小上限: ${url}`, {
              details: { url, bytes: total, maxBytes },
            })
          }
          chunks.push(Buffer.from(value))
          options.onBytes?.(value.byteLength)
        }
      } catch (error) {
        await reader.cancel().catch(() => undefined)
        if (options.signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
          throw abortError()
        }
        throw error
      }
      const data = Buffer.concat(chunks, total)
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
 *
 * Each URL is attempted up to three times with a short backoff: the pack CDN
 * fails intermittently on this network (a file that downloads fine one minute
 * reports an empty error the next), and one flaky connection must not abort a
 * 4000-file import.
 *
 * Cancellation short-circuits the retry list: once the import job is aborted
 * there is no point trying another URL.
 */
export async function downloadVerified(
  downloader: FileDownloader,
  urls: string[],
  hashes: FileHashes,
  maxBytes = MAX_PACK_FILE_BYTES,
  options: FileDownloadOptions = {},
): Promise<{ data: Buffer; url: string }> {
  const usable = urls.filter((url) => typeof url === 'string' && url.length > 0)
  if (usable.length === 0) {
    throw new AppError('MODS.PACK_DOWNLOAD_FAILED', '整合包文件没有可用的下载地址')
  }
  const errors: string[] = []
  const attemptsPerUrl = 3
  for (const url of usable) {
    for (let attempt = 1; attempt <= attemptsPerUrl; attempt += 1) {
      if (options.signal?.aborted) throw abortError()
      try {
        const data = await downloader.download(url, maxBytes, options)
        if (!hashMatches(data, hashes)) {
          errors.push(`${url}: 哈希不匹配`)
          break
        }
        return { data, url }
      } catch (error) {
        if (options.signal?.aborted || error instanceof JobCancelledError) {
          throw abortError()
        }
        const code = (error as { code?: unknown } | null)?.code
        const name = error instanceof Error ? error.name : typeof error
        const message = error instanceof Error ? error.message : String(error)
        const suffix = `${code ? ` (${String(code)})` : ''} [${name}]`
        errors.push(`${url}: ${message}${suffix}${attempt < attemptsPerUrl ? ` · 第 ${attempt} 次重试` : ''}`)
        if (attempt < attemptsPerUrl) {
          await new Promise((resolve) => setTimeout(resolve, 800 * attempt))
        }
      }
    }
  }
  throw new AppError('MODS.PACK_DOWNLOAD_FAILED', '所有下载地址均失败或哈希不匹配', {
    retryable: true,
    details: { errors },
  })
}

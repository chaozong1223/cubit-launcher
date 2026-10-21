import { createHash } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import path from 'node:path'
import { JavaError } from './errors'

/**
 * HTTP client for JDK downloads.
 *
 * SEC-DL-05: JDKs come only from Adoptium (SHA-256 from its API) or Microsoft
 * OpenJDK (SHA-256 sidecar); BMCLAPI's Java list is explicitly not used.
 * SEC-DL-01/02: `.part` → SHA-256 → rename; a mismatch deletes the part.
 */

export interface JavaHttpLogger {
  debug(message: string, fields?: Record<string, unknown>): void
  warn(message: string, fields?: Record<string, unknown>): void
}

export interface JavaHttpOptions {
  userAgent: string
  /** Test-only loopback hosts allowed over plain http. */
  allowInsecureHosts?: string[]
  log?: JavaHttpLogger
}

export interface FetchOptions {
  signal?: AbortSignal
  totalTimeoutMs?: number
  maxBytes?: number
  /** Redirects may leave the allowlist (body is hash-verified later). */
  hashPinned?: boolean
}

export interface DownloadOptions {
  dest: string
  sha256: string
  size?: number | null
  signal?: AbortSignal
  onBytes?: (delta: number, total: number) => void
  retries?: number
}

export interface DownloadResult {
  file: string
  bytes: number
  sha256: string
  redirects: string[]
}

const MAX_REDIRECTS = 3
const MAX_TEXT_BYTES = 4 * 1024 * 1024
const ALLOWED_HOSTS = [
  'api.adoptium.net',
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'aka.ms',
  'download.visualstudio.microsoft.com',
  'download.microsoft.com',
]

function hostMatches(hostname: string, patterns: string[]): boolean {
  const host = hostname.toLowerCase()
  return patterns.some((pattern) => {
    const value = pattern.toLowerCase()
    if (value.startsWith('*.')) return host === value.slice(2) || host.endsWith(value.slice(1))
    return host === value
  })
}

function parseUrl(raw: string): URL {
  try {
    return new URL(raw)
  } catch {
    throw new JavaError('JAVA.PROVIDER_METADATA_INVALID', { message: `invalid url: ${raw}` })
  }
}

export class JavaHttp {
  private readonly allowInsecure: string[]

  constructor(private readonly options: JavaHttpOptions) {
    this.allowInsecure = options.allowInsecureHosts ?? []
  }

  private isAllowedHost(hostname: string): boolean {
    return hostMatches(hostname, [...ALLOWED_HOSTS, ...this.allowInsecure])
  }

  private assertScheme(url: URL): void {
    if (url.protocol === 'https:') return
    if (url.protocol === 'http:' && hostMatches(url.hostname, this.allowInsecure)) return
    throw new JavaError('JAVA.PROVIDER_METADATA_INVALID', {
      message: `refusing non-https url: ${url.toString()}`,
      details: { url: url.toString() },
    })
  }

  private requestOnce(
    url: URL,
    options: { method?: 'GET' | 'HEAD'; timeoutMs: number; signal?: AbortSignal },
  ): Promise<{ status: number; headers: http.IncomingHttpHeaders; stream: NodeJS.ReadableStream }> {
    const transport = url.protocol === 'https:' ? https : http
    return new Promise((resolve, reject) => {
      let settled = false
      const done = (
        error: Error | null,
        value?: { status: number; headers: http.IncomingHttpHeaders; stream: NodeJS.ReadableStream },
      ) => {
        if (settled) return
        settled = true
        if (error) reject(error)
        else if (value) resolve(value)
      }

      const request = transport.request(
        url,
        {
          method: options.method ?? 'GET',
          headers: {
            'user-agent': this.options.userAgent,
            accept: '*/*',
          },
          agent: false,
        },
        (response) => {
          done(null, {
            status: response.statusCode ?? 0,
            headers: response.headers,
            stream: response,
          })
        },
      )
      request.setTimeout(options.timeoutMs, () => {
        request.destroy(new JavaError('JAVA.DOWNLOAD_FAILED', { message: `timeout: ${url.toString()}` }))
      })
      request.on('error', (error) => {
        if (error instanceof JavaError) done(error)
        else {
          done(
            new JavaError('JAVA.DOWNLOAD_FAILED', {
              message: `${url.toString()}: ${error.message}`,
              cause: error,
            }),
          )
        }
      })
      if (options.signal) {
        if (options.signal.aborted) {
          request.destroy(new JavaError('JAVA.CANCELLED', { message: 'aborted' }))
        } else {
          options.signal.addEventListener(
            'abort',
            () => request.destroy(new JavaError('JAVA.CANCELLED', { message: 'aborted' })),
            { once: true },
          )
        }
      }
      request.end()
    })
  }

  /** HEAD without following redirects, used to resolve Microsoft's versioned URL. */
  async headLocation(rawUrl: string, options: { signal?: AbortSignal } = {}): Promise<{
    status: number
    location: string | null
  }> {
    const url = parseUrl(rawUrl)
    this.assertScheme(url)
    if (!this.isAllowedHost(url.hostname)) {
      throw new JavaError('JAVA.PROVIDER_UNAVAILABLE', {
        message: `untrusted host: ${url.hostname}`,
        details: { url: rawUrl },
      })
    }
    const response = await this.requestOnce(url, {
      method: 'HEAD',
      timeoutMs: 20_000,
      ...(options.signal ? { signal: options.signal } : {}),
    })
    response.stream.resume()
    const location = response.headers.location
    return { status: response.status, location: location ?? null }
  }

  async fetchText(rawUrl: string, options: FetchOptions = {}): Promise<{
    text: string
    finalUrl: string
    redirects: string[]
  }> {
    const controller = new AbortController()
    let timedOut = false
    const onAbort = () => controller.abort()
    if (options.signal) {
      if (options.signal.aborted) controller.abort()
      else options.signal.addEventListener('abort', onAbort, { once: true })
    }
    const timer =
      options.totalTimeoutMs && options.totalTimeoutMs > 0
        ? setTimeout(() => {
            timedOut = true
            controller.abort()
          }, options.totalTimeoutMs)
        : null

    const visited: string[] = []
    let current = rawUrl
    try {
      for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
        visited.push(current)
        const url = parseUrl(current)
        this.assertScheme(url)
        if (!options.hashPinned && !this.isAllowedHost(url.hostname)) {
          throw new JavaError('JAVA.PROVIDER_UNAVAILABLE', {
            message: `untrusted metadata host: ${url.hostname}`,
            details: { url: current },
          })
        }
        const response = await this.requestOnce(url, {
          timeoutMs: 25_000,
          ...(controller.signal ? { signal: controller.signal } : {}),
        })
        const location = response.headers.location
        if ([301, 302, 303, 307, 308].includes(response.status) && location) {
          response.stream.resume()
          const next = new URL(location, current)
          this.assertScheme(next)
          if (!options.hashPinned && !this.isAllowedHost(next.hostname)) {
            throw new JavaError('JAVA.PROVIDER_UNAVAILABLE', {
              message: `untrusted redirect host: ${next.hostname}`,
              details: { from: current, to: next.toString() },
            })
          }
          this.options.log?.debug('java http redirect', { from: current, to: next.toString() })
          current = next.toString()
          continue
        }
        if (response.status < 200 || response.status >= 300) {
          response.stream.resume()
          throw new JavaError('JAVA.PROVIDER_METADATA_INVALID', {
            message: `unexpected status ${response.status}: ${current}`,
            details: { status: response.status, url: current },
          })
        }
        const chunks: Buffer[] = []
        let total = 0
        for await (const chunk of response.stream) {
          const buffer =
            typeof chunk === 'string'
              ? Buffer.from(chunk, 'utf8')
              : Buffer.isBuffer(chunk)
                ? chunk
                : Buffer.from(chunk as unknown as Uint8Array)
          total += buffer.length
          if (total > (options.maxBytes ?? MAX_TEXT_BYTES)) {
            throw new JavaError('JAVA.PROVIDER_METADATA_INVALID', { message: `response too large` })
          }
          chunks.push(buffer)
        }
        return { text: Buffer.concat(chunks).toString('utf8'), finalUrl: current, redirects: visited }
      }
      throw new JavaError('JAVA.DOWNLOAD_FAILED', { message: `too many redirects: ${visited.join(' -> ')}` })
    } catch (error) {
      if (timedOut) {
        throw new JavaError('JAVA.DOWNLOAD_FAILED', { message: `request timed out: ${rawUrl}`, cause: error })
      }
      throw error
    } finally {
      if (timer) clearTimeout(timer)
      if (options.signal) options.signal.removeEventListener('abort', onAbort)
    }
  }

  async fetchJson<T = unknown>(rawUrl: string, options: FetchOptions = {}): Promise<T> {
    const response = await this.fetchText(rawUrl, options)
    try {
      return JSON.parse(response.text) as T
    } catch (error) {
      throw new JavaError('JAVA.PROVIDER_METADATA_INVALID', {
        message: `invalid JSON from ${response.finalUrl}`,
        cause: error,
      })
    }
  }

  async download(rawUrl: string, options: DownloadOptions): Promise<DownloadResult> {
    const retries = Math.max(0, options.retries ?? 2)
    let lastError: unknown = null
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      if (options.signal?.aborted) {
        throw new JavaError('JAVA.CANCELLED', { message: 'cancelled before download' })
      }
      try {
        return await this.downloadOnce(rawUrl, options)
      } catch (error) {
        lastError = error
        if (error instanceof JavaError && error.code === 'JAVA.CANCELLED') throw error
        this.options.log?.warn('java download attempt failed', {
          attempt: attempt + 1,
          message: error instanceof Error ? error.message : String(error),
        })
        if (attempt < retries) {
          await new Promise((resolve) => setTimeout(resolve, 400 * 2 ** attempt))
        }
      }
    }
    // A hash/size mismatch is actionable and must keep its own code.
    if (
      lastError instanceof JavaError &&
      (lastError.code === 'JAVA.HASH_MISMATCH' || lastError.code === 'JAVA.SIZE_MISMATCH')
    ) {
      throw lastError
    }
    throw new JavaError('JAVA.DOWNLOAD_FAILED', {
      message: `download failed after ${retries + 1} attempts: ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`,
      cause: lastError,
    })
  }

  private async downloadOnce(rawUrl: string, options: DownloadOptions): Promise<DownloadResult> {
    const part = `${options.dest}.part`
    await fsp.mkdir(path.dirname(options.dest), { recursive: true })
    await fsp.rm(part, { force: true })

    const visited: string[] = []
    let current = rawUrl
    let stream: NodeJS.ReadableStream | null = null

    try {
      for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
        visited.push(current)
        const url = parseUrl(current)
        this.assertScheme(url)
        if (!this.isAllowedHost(url.hostname)) {
          throw new JavaError('JAVA.PROVIDER_UNAVAILABLE', {
            message: `untrusted download host: ${url.hostname}`,
            details: { url: current },
          })
        }
        const response = await this.requestOnce(url, {
          timeoutMs: 60_000,
          ...(options.signal ? { signal: options.signal } : {}),
        })
        if ([301, 302, 303, 307, 308].includes(response.status) && response.headers.location) {
          response.stream.resume()
          const next = new URL(response.headers.location, current)
          this.assertScheme(next)
          this.options.log?.debug('java download redirect', { from: current, to: next.toString() })
          current = next.toString()
          continue
        }
        if (response.status < 200 || response.status >= 300) {
          response.stream.resume()
          throw new JavaError('JAVA.DOWNLOAD_FAILED', {
            message: `unexpected status ${response.status}: ${current}`,
            details: { status: response.status, url: current },
          })
        }
        stream = response.stream
        break
      }
      if (!stream) {
        throw new JavaError('JAVA.DOWNLOAD_FAILED', { message: `too many redirects: ${visited.join(' -> ')}` })
      }

      const hasher = createHash('sha256')
      const out = fs.createWriteStream(part, { flags: 'w' })
      let streamError: Error | null = null
      out.on('error', (error) => {
        streamError = error
      })
      let bytes = 0
      try {
        for await (const chunk of stream) {
          if (options.signal?.aborted) {
            throw new JavaError('JAVA.CANCELLED', { message: 'cancelled during download' })
          }
          if (streamError) throw streamError
          const buffer =
            typeof chunk === 'string'
              ? Buffer.from(chunk, 'utf8')
              : Buffer.isBuffer(chunk)
                ? chunk
                : Buffer.from(chunk as unknown as Uint8Array)
          if (!out.write(buffer)) await waitForDrain(out)
          hasher.update(buffer)
          bytes += buffer.length
          options.onBytes?.(buffer.length, bytes)
        }
        await new Promise<void>((resolve, reject) => {
          out.end(() => (streamError ? reject(streamError) : resolve()))
        })
      } catch (error) {
        out.destroy()
        throw error
      }

      const digest = hasher.digest('hex')
      if (digest.toLowerCase() !== options.sha256.toLowerCase()) {
        await fsp.rm(part, { force: true })
        throw new JavaError('JAVA.HASH_MISMATCH', {
          message: `sha256 mismatch: expected ${options.sha256}, got ${digest}`,
          details: { expected: options.sha256, actual: digest, url: current },
        })
      }
      if (typeof options.size === 'number' && options.size >= 0 && bytes !== options.size) {
        await fsp.rm(part, { force: true })
        throw new JavaError('JAVA.SIZE_MISMATCH', {
          message: `size ${bytes} != ${options.size}`,
          details: { expected: options.size, actual: bytes },
        })
      }
      await renameAtomic(part, options.dest)
      return { file: options.dest, bytes, sha256: digest, redirects: visited }
    } catch (error) {
      await fsp.rm(part, { force: true }).catch(() => undefined)
      throw error
    }
  }
}

function waitForDrain(stream: fs.WriteStream): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      stream.off('drain', onDrain)
      stream.off('close', onClose)
      stream.off('error', onError)
    }
    const onDrain = () => {
      cleanup()
      resolve()
    }
    const onClose = () => {
      cleanup()
      resolve()
    }
    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }
    stream.once('drain', onDrain)
    stream.once('close', onClose)
    stream.once('error', onError)
  })
}

async function renameAtomic(from: string, to: string): Promise<void> {
  try {
    await fsp.rename(from, to)
  } catch {
    await fsp.rm(to, { force: true }).catch(() => undefined)
    await fsp.rename(from, to)
  }
}

export async function sha256File(file: string): Promise<string> {
  const hasher = createHash('sha256')
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(file)
    stream.on('data', (chunk) => hasher.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve())
  })
  return hasher.digest('hex')
}

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import path from 'node:path'
import { LoaderError } from './errors'

/**
 * HTTP/file helpers for the loader installer.
 *
 * Kept separate from the game-file downloader on purpose: installers are
 * components, not game files (SEC-DL-14 asks for a separate queue), and the
 * loader module must stay usable even when the download service is busy.
 *
 * Security: https only (loopback http for tests), ≤3 redirects, fixed UA,
 * `.part` → SHA1 → rename, and every installer is hash-checked before it is
 * executed when an upstream hash exists (SEC-EXE-05).
 */

export interface LoaderHttpLogger {
  debug(message: string, fields?: Record<string, unknown>): void
  warn(message: string, fields?: Record<string, unknown>): void
}

export interface LoaderHttpOptions {
  userAgent: string
  /** Test-only loopback hosts allowed over plain http. */
  allowInsecureHosts?: string[]
  log?: LoaderHttpLogger
}

export interface FetchOptions {
  signal?: AbortSignal
  totalTimeoutMs?: number
  maxBytes?: number
  /** When true, redirects may leave the host allowlist (hash is verified later). */
  hashPinned?: boolean
}

export interface DownloadSource {
  url: string
  source: 'official' | 'mirror'
}

export interface DownloadOptions {
  dest: string
  sha1: string | null
  size?: number | null
  signal?: AbortSignal
  onBytes?: (delta: number) => void
  retries?: number
  /** Hash is mandatory for execution; null is only allowed with explicit consent. */
  hashPinned?: boolean
}

export interface DownloadResult {
  file: string
  bytes: number
  sha1: string | null
  source: 'official' | 'mirror'
  redirects: string[]
}

const MAX_REDIRECTS = 3
const MAX_TEXT_BYTES = 16 * 1024 * 1024
const OFFICIAL_HOSTS = [
  'maven.minecraftforge.net',
  'files.minecraftforge.net',
  'maven.neoforged.net',
  'meta.fabricmc.net',
  'maven.fabricmc.net',
  'meta.quiltmc.org',
  'maven.quiltmc.org',
]
const MIRROR_HOSTS = [
  'bmclapi2.bangbang93.com',
  'bmclapi.bangbang93.com',
  'mirrors.cernet.edu.cn',
]

function hostMatches(hostname: string, patterns: string[]): boolean {
  const host = hostname.toLowerCase()
  return patterns.some((pattern) => {
    const value = pattern.toLowerCase()
    if (value.startsWith('*.')) return host === value.slice(2) || host.endsWith(value.slice(1))
    return host === value
  })
}

export function isTrustedLoaderHost(hostname: string): boolean {
  return hostMatches(hostname, [...OFFICIAL_HOSTS, ...MIRROR_HOSTS])
}

function parseUrl(raw: string): URL {
  try {
    return new URL(raw)
  } catch {
    throw new LoaderError('LOADER.META_UNAVAILABLE', { message: `invalid url: ${raw}` })
  }
}

export class LoaderHttp {
  private readonly allowInsecure: string[]

  constructor(private readonly options: LoaderHttpOptions) {
    this.allowInsecure = options.allowInsecureHosts ?? []
  }

  get userAgent(): string {
    return this.options.userAgent
  }

  private isAllowedHost(hostname: string): boolean {
    return isTrustedLoaderHost(hostname) || hostMatches(hostname, this.allowInsecure)
  }

  private assertScheme(url: URL): void {
    if (url.protocol === 'https:') return
    if (url.protocol === 'http:' && hostMatches(url.hostname, this.allowInsecure)) return
    throw new LoaderError('LOADER.META_UNAVAILABLE', {
      message: `refusing non-https url: ${url.toString()}`,
      details: { url: url.toString() },
    })
  }

  private requestOnce(
    url: URL,
    options: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<{ status: number; headers: http.IncomingHttpHeaders; stream: NodeJS.ReadableStream }> {
    const transport = url.protocol === 'https:' ? https : http
    return new Promise((resolve, reject) => {
      let settled = false
      const done = (error: Error | null, value?: {
        status: number
        headers: http.IncomingHttpHeaders
        stream: NodeJS.ReadableStream
      }) => {
        if (settled) return
        settled = true
        if (error) reject(error)
        else if (value) resolve(value)
      }

      const request = transport.request(
        url,
        {
          method: 'GET',
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
        request.destroy(
          new LoaderError('LOADER.META_UNAVAILABLE', {
            message: `timeout: ${url.toString()}`,
          }),
        )
      })
      request.on('error', (error) => {
        if (error instanceof LoaderError) done(error)
        else {
          done(
            new LoaderError('LOADER.META_UNAVAILABLE', {
              message: `${url.toString()}: ${error.message}`,
              cause: error,
            }),
          )
        }
      })
      if (options.signal) {
        if (options.signal.aborted) {
          request.destroy(new LoaderError('LOADER.CANCELLED', { message: 'aborted' }))
        } else {
          options.signal.addEventListener(
            'abort',
            () => request.destroy(new LoaderError('LOADER.CANCELLED', { message: 'aborted' })),
            { once: true },
          )
        }
      }
      request.end()
    })
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
        if (!this.isAllowedHost(url.hostname)) {
          throw new LoaderError('LOADER.META_UNAVAILABLE', {
            message: `untrusted metadata host: ${url.hostname}`,
            details: { url: current },
          })
        }

        const response = await this.requestOnce(url, {
          timeoutMs: 30_000,
          ...(controller.signal ? { signal: controller.signal } : {}),
        })
        const location = response.headers.location
        if ([301, 302, 303, 307, 308].includes(response.status) && location) {
          response.stream.resume()
          const next = new URL(location, current)
          this.assertScheme(next)
          if (!options.hashPinned && !this.isAllowedHost(next.hostname)) {
            throw new LoaderError('LOADER.META_UNAVAILABLE', {
              message: `untrusted redirect host: ${next.hostname}`,
              details: { from: current, to: next.toString() },
            })
          }
          this.options.log?.debug('loader http redirect', { from: current, to: next.toString() })
          current = next.toString()
          continue
        }
        if (response.status < 200 || response.status >= 300) {
          response.stream.resume()
          throw new LoaderError('LOADER.META_UNAVAILABLE', {
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
            throw new LoaderError('LOADER.META_UNAVAILABLE', {
              message: `response too large: ${current}`,
            })
          }
          chunks.push(buffer)
        }
        return {
          text: Buffer.concat(chunks).toString('utf8'),
          finalUrl: current,
          redirects: visited,
        }
      }
      throw new LoaderError('LOADER.META_UNAVAILABLE', {
        message: `too many redirects: ${visited.join(' -> ')}`,
      })
    } catch (error) {
      if (timedOut) {
        throw new LoaderError('LOADER.META_UNAVAILABLE', {
          message: `request timed out: ${rawUrl}`,
          cause: error,
        })
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
      throw new LoaderError('LOADER.PROFILE_INVALID', {
        message: `invalid JSON from ${response.finalUrl}`,
        cause: error,
      })
    }
  }

  /** Downloads one installer jar, trying mirror then official with retries. */
  async download(
    sources: DownloadSource[],
    options: DownloadOptions,
  ): Promise<DownloadResult> {
    const retries = Math.max(0, options.retries ?? 2)
    const attempts: string[] = []
    let lastError: unknown = null

    for (const candidate of sources) {
      for (let attempt = 0; attempt <= retries; attempt += 1) {
        if (options.signal?.aborted) {
          throw new LoaderError('LOADER.CANCELLED', { message: 'cancelled before download' })
        }
        attempts.push(candidate.url)
        try {
          return await this.downloadOnce(candidate, options)
        } catch (error) {
          lastError = error
          if (error instanceof LoaderError && error.code === 'LOADER.CANCELLED') throw error
          this.options.log?.warn('installer download failed', {
            source: candidate.source,
            attempt: attempt + 1,
            message: error instanceof Error ? error.message : String(error),
          })
          if (attempt < retries) {
            await new Promise((resolve) => setTimeout(resolve, 300 * 2 ** attempt))
          }
        }
      }
    }

    // A hash mismatch is a distinct, actionable failure; do not bury it in a
    // generic "download failed" wrapper.
    if (lastError instanceof LoaderError && lastError.code === 'LOADER.INSTALLER_HASH_MISMATCH') {
      throw lastError
    }

    throw new LoaderError('LOADER.INSTALLER_DOWNLOAD_FAILED', {
      message: `installer unavailable; tried ${attempts.join(', ')}; last: ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`,
      details: { urls: attempts },
      cause: lastError,
    })
  }
  private async downloadOnce(
    candidate: DownloadSource,
    options: DownloadOptions,
  ): Promise<DownloadResult> {
    const part = `${options.dest}.part`
    await fsp.mkdir(path.dirname(options.dest), { recursive: true })
    await fsp.rm(part, { force: true })

    const visited: string[] = []
    let current = candidate.url
    let stream: NodeJS.ReadableStream | null = null

    try {
      for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
        visited.push(current)
        const url = parseUrl(current)
        this.assertScheme(url)
        if (!this.isAllowedHost(url.hostname)) {
          throw new LoaderError('LOADER.INSTALLER_DOWNLOAD_FAILED', {
            message: `untrusted installer host: ${url.hostname}`,
            details: { url: current },
          })
        }
        const response = await this.requestOnce(url, {
          timeoutMs: 30_000,
          ...(options.signal ? { signal: options.signal } : {}),
        })
        if ([301, 302, 303, 307, 308].includes(response.status) && response.headers.location) {
          response.stream.resume()
          const next = new URL(response.headers.location, current)
          this.assertScheme(next)
          // BMCLAPI redirects to university mirrors (cernet/qlu). A mirror
          // download may follow those; official downloads stay strict unless
          // the body is hash-pinned.
          if (
            !options.hashPinned &&
            candidate.source !== 'mirror' &&
            !this.isAllowedHost(next.hostname)
          ) {
            throw new LoaderError('LOADER.INSTALLER_DOWNLOAD_FAILED', {
              message: `untrusted redirect host: ${next.hostname}`,
              details: { from: current, to: next.toString() },
            })
          }
          this.options.log?.debug('installer redirect', { from: current, to: next.toString() })
          current = next.toString()
          continue
        }
        if (response.status < 200 || response.status >= 300) {
          response.stream.resume()
          throw new LoaderError('LOADER.INSTALLER_DOWNLOAD_FAILED', {
            message: `unexpected status ${response.status}: ${current}`,
            details: { status: response.status, url: current },
          })
        }
        stream = response.stream
        break
      }
      if (!stream) {
        throw new LoaderError('LOADER.INSTALLER_DOWNLOAD_FAILED', {
          message: `too many redirects: ${visited.join(' -> ')}`,
        })
      }

      const hasher = createHash('sha1')
      const out = fs.createWriteStream(part, { flags: 'w' })
      let streamError: Error | null = null
      out.on('error', (error) => {
        streamError = error
      })
      let bytes = 0

      try {
        for await (const chunk of stream) {
          if (options.signal?.aborted) {
            throw new LoaderError('LOADER.CANCELLED', { message: 'cancelled during download' })
          }
          if (streamError) throw streamError
          const buffer =
            typeof chunk === 'string'
              ? Buffer.from(chunk, 'utf8')
              : Buffer.isBuffer(chunk)
                ? chunk
                : Buffer.from(chunk as unknown as Uint8Array)
          if (!out.write(buffer)) {
            await waitForDrain(out)
            if (streamError) throw streamError
          }
          hasher.update(buffer)
          bytes += buffer.length
          options.onBytes?.(buffer.length)
        }
        await new Promise<void>((resolve, reject) => {
          out.end(() => (streamError ? reject(streamError) : resolve()))
        })
      } catch (error) {
        out.destroy()
        throw error
      }

      const digest = hasher.digest('hex')
      if (options.sha1 && digest.toLowerCase() !== options.sha1.toLowerCase()) {
        await fsp.rm(part, { force: true })
        throw new LoaderError('LOADER.INSTALLER_HASH_MISMATCH', {
          message: `installer sha1 mismatch: expected ${options.sha1}, got ${digest}`,
          details: { expected: options.sha1, actual: digest, url: current },
        })
      }
      if (typeof options.size === 'number' && bytes !== options.size) {
        await fsp.rm(part, { force: true })
        throw new LoaderError('LOADER.INSTALLER_DOWNLOAD_FAILED', {
          message: `installer size ${bytes} != ${options.size}`,
          details: { expected: options.size, actual: bytes },
        })
      }

      await renameAtomic(part, options.dest)
      return { file: options.dest, bytes, sha1: digest, source: candidate.source, redirects: visited }
    } catch (error) {
      await fsp.rm(part, { force: true }).catch(() => undefined)
      throw error
    }
  }
}

async function renameAtomic(from: string, to: string): Promise<void> {
  try {
    await fsp.rename(from, to)
  } catch {
    await fsp.rm(to, { force: true }).catch(() => undefined)
    await fsp.rename(from, to)
  }
}

/** Waits for drain/close without accumulating listeners across chunks. */
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

export async function sha1File(file: string): Promise<string> {
  const hasher = createHash('sha1')
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(file)
    stream.on('data', (chunk) => hasher.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve())
  })
  return hasher.digest('hex')
}

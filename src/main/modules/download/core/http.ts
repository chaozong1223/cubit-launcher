import http from 'node:http'
import https from 'node:https'
import { URL } from 'node:url'
import type { Readable } from 'node:stream'
import { DownloadError } from './errors'

/**
 * Minimal HTTP client for the install chain.
 *
 * Why not `fetch`: downloads need precise Range/resume handling, redirect
 * policy per source, idle timeouts and abort semantics that all had to be
 * explicit anyway. Node's `http`/`https` keeps those knobs visible and works
 * against the local test server without extra dependencies.
 *
 * Security rules implemented here (docs/02):
 *  - SEC-DL-13: https only. `allowInsecureHosts` exists solely for loopback
 *    test servers and is never populated by the app.
 *  - SEC-DL-06: at most 3 redirects, every hop https, every hop checked by the
 *    source's host policy (BMCLAPI redirects to its own CDN hosts).
 *  - SEC-DL-12: every request URL is emitted to the caller for the network log.
 */

export interface HttpLogger {
  debug(message: string, fields?: Record<string, unknown>): void
  warn(message: string, fields?: Record<string, unknown>): void
}

export interface HttpClientOptions {
  userAgent: string
  /** Hosts (exact or `*.suffix`) allowed to use plain http. Tests only. */
  allowInsecureHosts?: string[]
  maxRedirects?: number
  connectTimeoutMs?: number
  log?: HttpLogger
}

export interface RequestOptions {
  headers?: Record<string, string>
  method?: 'GET' | 'HEAD'
  signal?: AbortSignal
  /** Socket idle timeout, default 30 s. */
  idleTimeoutMs?: number
  /** Wall-clock cap for the whole request, default none (streams can be huge). */
  totalTimeoutMs?: number
  maxRedirects?: number
  /** Per-hop policy, evaluated before following a redirect. */
  isRedirectAllowed?: (from: URL, to: URL) => boolean
  /**
   * Return a 304 response with empty text instead of throwing. Used by the
   * metadata cache with If-None-Match / If-Modified-Since.
   */
  allowNotModified?: boolean
}

export interface ResponseHead {
  status: number
  headers: NodeJS.Dict<string | string[]>
  finalUrl: string
  /** Every URL visited, starting with the requested one (SEC-DL-06 audit). */
  redirects: string[]
}

export interface StreamResponse extends ResponseHead {
  stream: Readable
}

export interface TextResponse extends ResponseHead {
  text: string
}

export const DEFAULT_IDLE_TIMEOUT_MS = 30_000
export const DEFAULT_CONNECT_TIMEOUT_MS = 10_000
export const DEFAULT_MAX_REDIRECTS = 3
export const MAX_TEXT_BYTES = 16 * 1024 * 1024

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308])

export function headerValue(
  headers: NodeJS.Dict<string | string[]>,
  name: string,
): string | null {
  const value = headers[name.toLowerCase()]
  if (value === undefined) return null
  return Array.isArray(value) ? (value[0] ?? null) : value
}

export function contentLength(headers: NodeJS.Dict<string | string[]>): number | null {
  const raw = headerValue(headers, 'content-length')
  if (!raw) return null
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

function hostMatches(hostname: string, allowed: string[]): boolean {
  const host = hostname.toLowerCase()
  return allowed.some((entry) => {
    const value = entry.trim().toLowerCase()
    if (!value) return false
    if (value.startsWith('*.')) return host === value.slice(2) || host.endsWith(value.slice(1))
    return host === value
  })
}

function mapNetworkError(error: unknown, url: string): DownloadError {
  if (error instanceof DownloadError) return error
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  const message = error instanceof Error ? error.message : String(error)
  if (code === 'ETIMEDOUT' || /timed?\s*out/i.test(message)) {
    return new DownloadError('DOWNLOAD.TIMEOUT', { message: `${url}: ${message}`, cause: error })
  }
  return new DownloadError('DOWNLOAD.HTTP_ERROR', {
    message: `${url}: ${message}`,
    details: { code: code ?? null },
    cause: error,
  })
}

export class HttpClient {
  private readonly allowInsecureHosts: string[]
  private readonly maxRedirects: number
  private readonly connectTimeoutMs: number

  constructor(private readonly options: HttpClientOptions) {
    this.allowInsecureHosts = options.allowInsecureHosts ?? []
    this.maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
  }

  get userAgent(): string {
    return this.options.userAgent
  }

  /** SEC-DL-13: https everywhere except explicitly allowed loopback test hosts. */
  assertAllowedScheme(url: URL): void {
    if (url.protocol === 'https:') return
    if (url.protocol === 'http:' && hostMatches(url.hostname, this.allowInsecureHosts)) return
    throw new DownloadError('DOWNLOAD.INSECURE_URL', {
      message: `refusing non-https url: ${url.toString()}`,
      details: { url: url.toString(), protocol: url.protocol },
    })
  }

  private requestOnce(rawUrl: string, options: RequestOptions): Promise<{
    status: number
    headers: NodeJS.Dict<string | string[]>
    stream: Readable
    url: URL
  }> {
    let url: URL
    try {
      url = new URL(rawUrl)
    } catch {
      return Promise.reject(
        new DownloadError('DOWNLOAD.INVALID_TASK', {
          message: `invalid url: ${rawUrl}`,
          details: { url: rawUrl },
        }),
      )
    }

    try {
      this.assertAllowedScheme(url)
    } catch (error) {
      return Promise.reject(error)
    }

    const transport = url.protocol === 'https:' ? https : http
    const headers: Record<string, string> = {
      'user-agent': this.options.userAgent,
      accept: '*/*',
      ...(options.headers ?? {}),
    }

    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (error: Error | null, value?: { status: number; headers: NodeJS.Dict<string | string[]>; stream: Readable }) => {
        if (settled) return
        settled = true
        if (error) reject(error)
        else if (value) resolve({ ...value, url })
      }

      const request = transport.request(
        url,
        {
          method: options.method ?? 'GET',
          headers,
          // A fresh connection per task keeps concurrency accounting honest.
          agent: false,
        },
        (response) => {
          finish(null, {
            status: response.statusCode ?? 0,
            headers: response.headers,
            stream: response,
          })
        },
      )

      request.setTimeout(this.connectTimeoutMs, () => {
        request.destroy(new DownloadError('DOWNLOAD.TIMEOUT', {
          message: `connect timeout: ${url.toString()}`,
          details: { url: url.toString() },
        }))
      })

      request.on('response', () => {
        // Once headers arrived, switch from connect to idle timeout.
        request.setTimeout(options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS, () => {
          request.destroy(new DownloadError('DOWNLOAD.TIMEOUT', {
            message: `idle timeout: ${url.toString()}`,
            details: { url: url.toString() },
          }))
        })
      })

      request.on('error', (error) => finish(mapNetworkError(error, url.toString())))

      if (options.signal) {
        if (options.signal.aborted) {
          request.destroy(
            new DownloadError('DOWNLOAD.CANCELLED', { message: 'aborted before request' }),
          )
        } else {
          options.signal.addEventListener(
            'abort',
            () => {
              request.destroy(
                new DownloadError('DOWNLOAD.CANCELLED', { message: 'aborted' }),
              )
            },
            { once: true },
          )
        }
      }

      request.end()
    })
  }

  /**
   * Opens a stream, following redirects according to the caller's policy.
   * The returned stream is the final body; non-2xx bodies are not drained here
   * so the caller can decide (downloads inspect status; JSON fetches throw).
   */
  async openStream(rawUrl: string, options: RequestOptions = {}): Promise<StreamResponse> {
    const maxRedirects = options.maxRedirects ?? this.maxRedirects
    const visited: string[] = []
    let current = rawUrl

    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      visited.push(current)
      const response = await this.requestOnce(current, options)
      const location = headerValue(response.headers, 'location')

      if (!REDIRECT_STATUS.has(response.status) || !location) {
        if (REDIRECT_STATUS.has(response.status) && !location) {
          response.stream.resume()
          throw new DownloadError('DOWNLOAD.HTTP_ERROR', {
            message: `redirect without location: ${current}`,
            details: { url: current, status: response.status },
          })
        }
        return {
          status: response.status,
          headers: response.headers,
          finalUrl: current,
          redirects: visited,
          stream: response.stream,
        }
      }

      // Drain the tiny redirect body so the socket is reusable.
      response.stream.resume()

      let next: URL
      try {
        next = new URL(location, current)
      } catch {
        throw new DownloadError('DOWNLOAD.HTTP_ERROR', {
          message: `invalid redirect target: ${location}`,
          details: { url: current, location },
        })
      }

      try {
        this.assertAllowedScheme(next)
      } catch (error) {
        throw error
      }

      const from = new URL(current)
      if (options.isRedirectAllowed && !options.isRedirectAllowed(from, next)) {
        throw new DownloadError('DOWNLOAD.HOST_NOT_ALLOWED', {
          message: `redirect to disallowed host: ${next.hostname} (from ${from.hostname})`,
          details: { from: from.toString(), to: next.toString() },
        })
      }

      this.options.log?.debug('http redirect', {
        from: from.toString(),
        to: next.toString(),
        status: response.status,
      })
      current = next.toString()

      if (hop === maxRedirects) {
        throw new DownloadError('DOWNLOAD.REDIRECT_LIMIT', {
          message: `more than ${maxRedirects} redirects: ${visited.join(' -> ')}`,
          details: { redirects: visited },
        })
      }
    }

    throw new DownloadError('DOWNLOAD.REDIRECT_LIMIT', {
      message: `redirect loop: ${visited.join(' -> ')}`,
      details: { redirects: visited },
    })
  }

  /** Small JSON/text fetch with a size cap and an optional total timeout. */
  async fetchText(rawUrl: string, options: RequestOptions = {}): Promise<TextResponse> {
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

    try {
      const response = await this.openStream(rawUrl, {
        ...options,
        signal: controller.signal,
      })

      if (response.status === 304 && options.allowNotModified) {
        response.stream.resume()
        return {
          status: 304,
          headers: response.headers,
          finalUrl: response.finalUrl,
          redirects: response.redirects,
          text: '',
        }
      }

      if (response.status < 200 || response.status >= 300) {
        response.stream.resume()
        throw new DownloadError('DOWNLOAD.HTTP_ERROR', {
          message: `unexpected status ${response.status}: ${response.finalUrl}`,
          details: { status: response.status, url: response.finalUrl },
        })
      }

      const chunks: Buffer[] = []
      let total = 0
      for await (const chunk of response.stream) {
        if (controller.signal.aborted) {
          throw new DownloadError('DOWNLOAD.TIMEOUT', {
            message: `request exceeded ${options.totalTimeoutMs} ms: ${response.finalUrl}`,
            details: { url: response.finalUrl, timeoutMs: options.totalTimeoutMs },
          })
        }
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
        total += buffer.length
        if (total > MAX_TEXT_BYTES) {
          throw new DownloadError('DOWNLOAD.HTTP_ERROR', {
            message: `response larger than ${MAX_TEXT_BYTES} bytes: ${response.finalUrl}`,
            details: { url: response.finalUrl, bytes: total },
          })
        }
        chunks.push(buffer)
      }

      return {
        status: response.status,
        headers: response.headers,
        finalUrl: response.finalUrl,
        redirects: response.redirects,
        text: Buffer.concat(chunks).toString('utf8'),
      }
    } catch (error) {
      if (timedOut) {
        throw new DownloadError('DOWNLOAD.TIMEOUT', {
          message: `request exceeded ${options.totalTimeoutMs} ms: ${rawUrl}`,
          details: { url: rawUrl, timeoutMs: options.totalTimeoutMs },
          cause: error,
        })
      }
      throw mapNetworkError(error, rawUrl)
    } finally {
      if (timer) clearTimeout(timer)
      if (options.signal) options.signal.removeEventListener('abort', onAbort)
    }
  }
}

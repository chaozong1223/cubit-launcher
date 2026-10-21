import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { createHash } from 'node:crypto'
import type { Readable } from 'node:stream'

/**
 * Local HTTP server used by the download tests (docs/03 §10 L4).
 *
 * It can serve bytes with real Range support, ignore Range (single-connection
 * fallback), lie about Content-Length, fail with status codes, delay chunks and
 * count concurrent requests. No network access is required.
 */

export interface ServedRequest {
  method: string
  path: string
  headers: http.IncomingHttpHeaders
  at: number
  endAt?: number
}

export interface RouteContext {
  req: http.IncomingMessage
  res: http.ServerResponse
  url: URL
  path: string
  range: { start: number; end: number } | null
}

export type RouteHandler = (ctx: RouteContext) => void | Promise<void>

export interface ServeOptions {
  status?: number
  /** Honour `Range` headers (default true, returns 206). */
  ranges?: boolean
  /** Reply 200 with the whole body even when a Range header was sent. */
  ignoreRange?: boolean
  chunkSize?: number
  chunkDelayMs?: number
  /** Send a wrong Content-Length header (SEC-DL-11 test). */
  contentLengthOverride?: number
  headers?: Record<string, string>
}

export interface TestHttpServer {
  baseUrl: string
  port: number
  requests: ServedRequest[]
  readonly maxActive: number
  route(path: string, handler: RouteHandler): void
  serve(path: string, body: Buffer | string, options?: ServeOptions): void
  requestsFor(path: string): ServedRequest[]
  countRequests(path: string): number
  reset(): void
  close(): Promise<void>
}

export function sha1(buffer: Buffer | string): string {
  return createHash('sha1').update(buffer).digest('hex')
}

function parseRange(header: string | undefined, total: number): { start: number; end: number } | null {
  if (!header) return null
  const match = /^bytes=(\d+)-(\d*)$/.exec(header.trim())
  if (!match) return null
  const start = Number(match[1])
  const end = match[2] ? Math.min(Number(match[2]), total - 1) : total - 1
  if (!Number.isFinite(start) || start >= total || end < start) return null
  return { start, end }
}

async function writeBody(
  res: http.ServerResponse,
  body: Buffer,
  options: ServeOptions,
): Promise<void> {
  const chunkSize = options.chunkSize ?? body.length
  const delay = options.chunkDelayMs ?? 0
  for (let offset = 0; offset < body.length; offset += chunkSize) {
    if (res.destroyed) return
    res.write(body.subarray(offset, Math.min(body.length, offset + chunkSize)))
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
  }
  res.end()
}

export async function startTestHttpServer(): Promise<TestHttpServer> {
  const routes = new Map<string, RouteHandler>()
  const requests: ServedRequest[] = []
  let active = 0
  let maxActive = 0

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    active += 1
    maxActive = Math.max(maxActive, active)
    const record: ServedRequest = {
      method: req.method ?? 'GET',
      path: url.pathname,
      headers: req.headers,
      at: Date.now(),
    }
    requests.push(record)

    try {
      const handler = routes.get(url.pathname)
      if (!handler) {
        res.writeHead(404, { 'content-type': 'text/plain' }).end('not found')
        return
      }
      const totalHint = Number(req.headers['x-total-size'] ?? '0')
      await handler({
        req,
        res,
        url,
        path: url.pathname,
        range: parseRange(req.headers.range, totalHint),
      })
    } catch (error) {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' })
      if (!res.writableEnded) res.end(String(error))
    } finally {
      active -= 1
      record.endAt = Date.now()
    }
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo

  const api: TestHttpServer = {
    baseUrl: `http://127.0.0.1:${address.port}`,
    port: address.port,
    requests,
    get maxActive() {
      return maxActive
    },
    route(path, handler) {
      routes.set(path, handler)
    },
    serve(path, body, options = {}) {
      const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body)
      routes.set(path, async ({ req, res }) => {
        const range = options.ignoreRange ? null : parseRange(req.headers.range, buffer.length)
        if (options.ignoreRange && req.headers.range) {
          // Explicit single-connection fallback: a 200 for a Range request.
          res.writeHead(200, {
            'content-type': 'application/octet-stream',
            'content-length': options.contentLengthOverride ?? buffer.length,
            'accept-ranges': 'bytes',
            ...(options.headers ?? {}),
          })
          await writeBody(res, buffer, options)
          return
        }
        if (range && options.ranges !== false) {
          const slice = buffer.subarray(range.start, range.end + 1)
          res.writeHead(206, {
            'content-type': 'application/octet-stream',
            'content-length': options.contentLengthOverride ?? slice.length,
            'content-range': `bytes ${range.start}-${range.end}/${buffer.length}`,
            'accept-ranges': 'bytes',
            ...(options.headers ?? {}),
          })
          await writeBody(res, slice, options)
          return
        }
        res.writeHead(options.status ?? 200, {
          'content-type': 'application/octet-stream',
          'content-length': options.contentLengthOverride ?? buffer.length,
          'accept-ranges': 'bytes',
          ...(options.headers ?? {}),
        })
        await writeBody(res, buffer, options)
      })
    },
    requestsFor(path) {
      return requests.filter((request) => request.path === path)
    },
    countRequests(path) {
      return api.requestsFor(path).length
    },
    reset() {
      requests.length = 0
      maxActive = 0
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }

  return api
}

/** Reads a response body into a Buffer (used by seed helpers). */
export async function drain(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array))
  return Buffer.concat(chunks)
}

import { AppError } from '@shared/errors'

export interface HttpRequestInit {
  method: 'GET' | 'POST'
  headers?: Record<string, string>
  body?: string
  timeoutMs?: number
}

export interface HttpResponse {
  status: number
  body: string
  headers: Record<string, string>
}

/** Minimal HTTP seam so device-code/token flows are unit-testable. */
export interface HttpPort {
  request(url: string, init: HttpRequestInit): Promise<HttpResponse>
}

export class HttpNetworkError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'HttpNetworkError'
  }
}

export function createFetchHttp(fetchImpl: typeof fetch = fetch): HttpPort {
  return {
    async request(url, init) {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), init.timeoutMs ?? 20_000)
      try {
        const response = await fetchImpl(url, {
          method: init.method,
          headers: init.headers,
          body: init.body,
          signal: controller.signal,
          redirect: 'follow',
        })
        const headers: Record<string, string> = {}
        response.headers.forEach((value, key) => {
          headers[key.toLowerCase()] = value
        })
        return { status: response.status, body: await response.text(), headers }
      } catch (error) {
        throw new HttpNetworkError(
          error instanceof Error ? error.message : String(error),
          { cause: error },
        )
      } finally {
        clearTimeout(timeout)
      }
    },
  }
}

export function requireOk(response: HttpResponse, what: string): AppError | null {
  if (response.status >= 200 && response.status < 300) return null
  return new AppError('AUTH.HTTP_ERROR', `${what}失败（HTTP ${response.status}）`, {
    retryable: response.status >= 500 || response.status === 429,
    details: { status: response.status, body: response.body.slice(0, 400) },
  })
}

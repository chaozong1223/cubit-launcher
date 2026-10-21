import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HttpClient } from '../core/http'
import { DownloadError } from '../core/errors'
import { runTasks, type QueueOptions } from '../core/queue'
import { createSourceRegistry, type SourceRegistry } from '../core/sources'
import { sha1, startTestHttpServer, type TestHttpServer } from './support/http-server'

/**
 * Queue behaviour required by 01 R1.2–R1.5 / 02 SEC-DL-01~11. Every test runs
 * against a local HTTP server (docs/03 §10 L4) — no internet needed.
 */

interface Harness {
  server: TestHttpServer
  root: string
  http: HttpClient
  sources: SourceRegistry
  options: QueueOptions
}

let harness: Harness | null = null

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mcl-dl-'))
}

async function setup(
  patch: Partial<QueueOptions> & { preference?: 'auto' | 'official' | 'mirror' } = {},
): Promise<Harness> {
  const server = await startTestHttpServer()
  const root = tempRoot()
  const http = new HttpClient({
    userAgent: 'mc-launcher/0.1.0 (+https://example.test; test@example.test)',
    allowInsecureHosts: ['127.0.0.1'],
  })
  const sources = createSourceRegistry({
    preference: patch.preference ?? 'official',
    mirrorEnabled: true,
    allowInsecureHosts: ['127.0.0.1'],
    selfHosts: ['127.0.0.1'],
  })
  const options: QueueOptions = {
    root,
    http,
    sources,
    concurrency: 4,
    perHostConcurrency: 2,
    maxRetries: 3,
    verifyExisting: 'size',
    ...patch,
  }
  harness = { server, root, http, sources, options }
  return harness
}

beforeEach(() => {
  harness = null
})

afterEach(async () => {
  if (harness) {
    await harness.server.close()
    fs.rmSync(harness.root, { recursive: true, force: true })
  }
  harness = null
})

function task(url: string, destRel: string, body: Buffer, patch: Record<string, unknown> = {}) {
  return {
    url,
    destRel,
    sha1: sha1(body),
    size: body.length,
    priority: 5,
    sourceHint: 'auto' as const,
    unverified: false,
    ...patch,
  }
}

describe('runTasks: download + hash + atomic write', () => {
  it('downloads a file, verifies sha1 and leaves no .part behind', async () => {
    const h = await setup()
    const body = Buffer.from('hello minecraft')
    h.server.serve('/file.bin', body)

    const result = await runTasks([task(`${h.server.baseUrl}/file.bin`, 'libraries/a.bin', body)], h.options)

    expect(result.failures).toEqual([])
    expect(result.downloaded).toBe(1)
    expect(fs.readFileSync(path.join(h.root, 'libraries/a.bin'))).toEqual(body)
    expect(fs.existsSync(path.join(h.root, 'libraries/a.bin.part'))).toBe(false)
    expect(h.server.countRequests('/file.bin')).toBe(1)
    expect(result.outcomes[0]).toMatchObject({ status: 'downloaded', source: 'official' })
  })

  it('skips an existing valid file without any request', async () => {
    const h = await setup()
    const body = Buffer.from('already here')
    h.server.serve('/skip.bin', body)
    fs.mkdirSync(path.join(h.root, 'libraries'), { recursive: true })
    fs.writeFileSync(path.join(h.root, 'libraries/skip.bin'), body)

    const result = await runTasks([task(`${h.server.baseUrl}/skip.bin`, 'libraries/skip.bin', body)], h.options)

    expect(result.skipped).toBe(1)
    expect(result.downloaded).toBe(0)
    expect(h.server.requests).toHaveLength(0)
  })

  it('re-downloads a same-size corrupted file when verify=hash (negative case 3)', async () => {
    const h = await setup({ verifyExisting: 'hash' })
    const body = Buffer.from('correct bytes here')
    h.server.serve('/corrupt.bin', body)
    fs.mkdirSync(path.join(h.root, 'libraries'), { recursive: true })
    fs.writeFileSync(path.join(h.root, 'libraries/corrupt.bin'), Buffer.alloc(body.length, 1))

    const result = await runTasks(
      [task(`${h.server.baseUrl}/corrupt.bin`, 'libraries/corrupt.bin', body)],
      h.options,
    )

    expect(result.downloaded).toBe(1)
    expect(fs.readFileSync(path.join(h.root, 'libraries/corrupt.bin'))).toEqual(body)
    expect(h.server.countRequests('/corrupt.bin')).toBe(1)
  })

  it('never leaves a corrupt destination when the upstream bytes fail the hash', async () => {
    const h = await setup({ maxRetries: 1 })
    const expected = Buffer.from('expected bytes')
    const served = Buffer.from('tampered bytez')
    expect(served.length).toBe(expected.length)
    h.server.serve('/bad-hash.bin', served)

    const result = await runTasks(
      [task(`${h.server.baseUrl}/bad-hash.bin`, 'libraries/bad.bin', expected)],
      h.options,
    )

    expect(result.failures).toHaveLength(1)
    expect(result.failures[0].code).toBe('DOWNLOAD.HASH_MISMATCH')
    expect(fs.existsSync(path.join(h.root, 'libraries/bad.bin'))).toBe(false)
    expect(fs.existsSync(path.join(h.root, 'libraries/bad.bin.part'))).toBe(false)
    // Retries restarted from scratch: 1 initial + 1 retry.
    expect(h.server.countRequests('/bad-hash.bin')).toBe(2)
  })
})

describe('runTasks: retry and failover', () => {
  it('retries a 500 and succeeds (>= 3 attempts allowed)', async () => {
    const h = await setup({ maxRetries: 3 })
    const body = Buffer.from('eventually ok')
    let calls = 0
    h.server.route('/flaky.bin', ({ res }) => {
      calls += 1
      if (calls < 3) {
        res.writeHead(500, { 'content-length': 0 }).end()
        return
      }
      res.writeHead(200, { 'content-length': body.length }).end(body)
    })

    const result = await runTasks([task(`${h.server.baseUrl}/flaky.bin`, 'lib/flaky.bin', body)], h.options)

    expect(result.failures).toEqual([])
    expect(result.outcomes[0]).toMatchObject({ status: 'downloaded', attempts: 3 })
    expect(h.server.countRequests('/flaky.bin')).toBe(3)
  })

  it('falls back from the mirror to the official source and records it', async () => {
    const h = await setup({ preference: 'auto', maxRetries: 1 })
    const body = Buffer.from('official wins')
    h.server.route('/mirror/x.bin', ({ res }) => {
      res.writeHead(500, { 'content-length': 0 }).end()
    })
    h.server.serve('/official/x.bin', body)
    const job = task(`${h.server.baseUrl}/official/x.bin`, 'lib/x.bin', body, {
      mirrorUrl: `${h.server.baseUrl}/mirror/x.bin`,
    })

    const result = await runTasks([job], h.options)

    expect(result.failures).toEqual([])
    expect(result.outcomes[0].source).toBe('official')
    expect(h.server.countRequests('/mirror/x.bin')).toBe(2)
    expect(h.server.countRequests('/official/x.bin')).toBe(1)
  })

  it('reports DOWNLOAD.NO_SOURCE with every attempted URL when all sources fail', async () => {
    const h = await setup({ preference: 'auto', maxRetries: 1 })
    h.server.route('/m.bin', ({ res }) => {
      res.writeHead(500, { 'content-length': 0 }).end()
    })
    h.server.route('/o.bin', ({ res }) => {
      res.writeHead(500, { 'content-length': 0 }).end()
    })
    const job = task(`${h.server.baseUrl}/o.bin`, 'lib/no.bin', Buffer.from('x'), {
      mirrorUrl: `${h.server.baseUrl}/m.bin`,
    })

    const result = await runTasks([job], h.options)

    expect(result.failures).toHaveLength(1)
    expect(result.failures[0].code).toBe('DOWNLOAD.NO_SOURCE')
    expect(result.failures[0].message).toContain('/m.bin')
    expect(result.failures[0].message).toContain('/o.bin')
    expect(fs.existsSync(path.join(h.root, 'lib/no.bin'))).toBe(false)
  })

  it('refuses a hash-less file from the mirror (SEC-DL-04)', async () => {
    const h = await setup({ preference: 'mirror', maxRetries: 0 })
    const body = Buffer.from('no hash')
    h.server.serve('/unverified.bin', body)

    const result = await runTasks(
      [
        {
          url: `${h.server.baseUrl}/unverified.bin`,
          mirrorUrl: `${h.server.baseUrl}/unverified.bin`,
          destRel: 'lib/unverified.bin',
          sha1: null,
          size: body.length,
          priority: 5,
          sourceHint: 'auto' as const,
          unverified: true,
        },
      ],
      h.options,
    )

    expect(result.failures[0].code).toBe('DOWNLOAD.HASH_REQUIRED')
    expect(h.server.requests).toHaveLength(0)
  })
})

describe('runTasks: resume (SEC-DL-03)', () => {
  it('continues an existing .part with a Range request and verifies the whole file', async () => {
    const h = await setup()
    const body = Buffer.alloc(100_000, 7)
    h.server.serve('/big.bin', body)
    const dest = path.join(h.root, 'libraries/big.bin')
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(`${dest}.part`, body.subarray(0, 40_000))

    const result = await runTasks([task(`${h.server.baseUrl}/big.bin`, 'libraries/big.bin', body)], h.options)

    expect(result.failures).toEqual([])
    expect(h.server.requestsFor('/big.bin')[0].headers.range).toBe('bytes=40000-')
    expect(result.outcomes[0].bytes).toBe(60_000)
    expect(fs.readFileSync(dest)).toEqual(body)
    expect(fs.existsSync(`${dest}.part`)).toBe(false)
  })

  it('restarts from zero when the server ignores Range (200 reply)', async () => {
    const h = await setup()
    const body = Buffer.alloc(50_000, 3)
    h.server.serve('/no-range.bin', body, { ignoreRange: true })
    const dest = path.join(h.root, 'lib/nr.bin')
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(`${dest}.part`, Buffer.alloc(20_000, 9))

    const result = await runTasks([task(`${h.server.baseUrl}/no-range.bin`, 'lib/nr.bin', body)], h.options)

    expect(result.failures).toEqual([])
    expect(fs.readFileSync(dest)).toEqual(body)
    expect(result.outcomes[0].bytes).toBe(50_000)
    expect(h.server.countRequests('/no-range.bin')).toBe(1)
  })

  it('deletes a stale .part on 416 and retries from scratch', async () => {
    const h = await setup({ maxRetries: 1 })
    const body = Buffer.from('restart me')
    h.server.route('/416.bin', ({ req, res }) => {
      if (req.headers.range) {
        res.writeHead(416, { 'content-range': `bytes */${body.length}` }).end()
        return
      }
      res.writeHead(200, { 'content-length': body.length }).end(body)
    })
    const dest = path.join(h.root, 'lib/416.bin')
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(`${dest}.part`, Buffer.alloc(5, 1))

    const result = await runTasks([task(`${h.server.baseUrl}/416.bin`, 'lib/416.bin', body)], h.options)

    expect(result.failures).toEqual([])
    expect(h.server.countRequests('/416.bin')).toBe(2)
    expect(fs.readFileSync(dest)).toEqual(body)
  })

  it('treats a complete .part as finished without a request', async () => {
    const h = await setup()
    const body = Buffer.from('complete part')
    h.server.serve('/cp.bin', body)
    const dest = path.join(h.root, 'lib/cp.bin')
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(`${dest}.part`, body)

    const result = await runTasks([task(`${h.server.baseUrl}/cp.bin`, 'lib/cp.bin', body)], h.options)

    expect(result.failures).toEqual([])
    expect(h.server.requests).toHaveLength(0)
    expect(fs.readFileSync(dest)).toEqual(body)
  })

  it('restarts when a resume update changes the ETag (t42)', async () => {
    const h = await setup({ maxRetries: 1 })
    const body = Buffer.alloc(100_000, 7)
    h.server.route('/changed.bin', ({ req, res }) => {
      if (req.headers.range) {
        const slice = body.subarray(40_000)
        res.writeHead(206, {
          'content-length': slice.length,
          'content-range': `bytes 40000-${body.length - 1}/${body.length}`,
          etag: '"v2"',
        }).end(slice)
        return
      }
      res.writeHead(200, { 'content-length': body.length, etag: '"v2"' }).end(body)
    })
    const dest = path.join(h.root, 'lib/changed.bin')
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(`${dest}.part`, body.subarray(0, 40_000))
    fs.writeFileSync(
      `${dest}.part.meta.json`,
      JSON.stringify({ etag: '"v1"', lastModified: null }),
    )

    const result = await runTasks([task(`${h.server.baseUrl}/changed.bin`, 'lib/changed.bin', body)], h.options)

    expect(result.failures).toEqual([])
    expect(h.server.requestsFor('/changed.bin')[0].headers['if-range']).toBe('"v1"')
    expect(h.server.requestsFor('/changed.bin')[1].headers.range).toBeUndefined()
    expect(h.server.countRequests('/changed.bin')).toBe(2)
    expect(fs.readFileSync(dest)).toEqual(body)
    expect(fs.existsSync(`${dest}.part.meta.json`)).toBe(false)
  })
})

describe('runTasks: guards', () => {
  it('fails after the explicit redirect limit (t42)', async () => {
    const h = await setup({ maxRetries: 0 })
    const body = Buffer.from('redirect target')
    for (let index = 0; index < 4; index += 1) {
      h.server.route(`/r${index}`, ({ res }) => {
        res.writeHead(301, { location: `/r${index + 1}` }).end()
      })
    }
    h.server.serve('/r4', body)

    const result = await runTasks([task(`${h.server.baseUrl}/r0`, 'lib/r.bin', body)], h.options)

    expect(result.failures[0]?.code).toBe('DOWNLOAD.REDIRECT_LIMIT')
    expect(h.server.countRequests('/r0')).toBe(1)
    expect(h.server.countRequests('/r4')).toBe(0)
  })

  it('rejects a content-length that contradicts the metadata (SEC-DL-11)', async () => {
    const h = await setup({ maxRetries: 0 })
    const body = Buffer.from('12345')
    h.server.serve('/len.bin', body, { contentLengthOverride: body.length + 10 })

    const result = await runTasks([task(`${h.server.baseUrl}/len.bin`, 'lib/len.bin', body)], h.options)

    expect(result.failures[0].code).toBe('DOWNLOAD.SIZE_MISMATCH')
    expect(fs.existsSync(path.join(h.root, 'lib/len.bin'))).toBe(false)
  })

  it('refuses path traversal before any request (SEC-DL-09)', async () => {
    const h = await setup()
    await expect(
      runTasks(
        [
          {
            url: `${h.server.baseUrl}/x`,
            destRel: '../escape.bin',
            sha1: null,
            size: null,
            priority: 5,
            sourceHint: 'auto' as const,
            unverified: true,
          },
        ],
        h.options,
      ),
    ).rejects.toMatchObject({ code: 'DOWNLOAD.PATH_UNSAFE' })
    expect(h.server.requests).toHaveLength(0)
  })

  it('refuses plain http unless the host is explicitly allowlisted (SEC-DL-13)', async () => {
    const http = new HttpClient({ userAgent: 'mc-launcher/0.1.0' })
    await expect(http.openStream('http://127.0.0.1:1/x')).rejects.toMatchObject({
      code: 'DOWNLOAD.INSECURE_URL',
    })
  })

  it('honours per-host concurrency (SRC-05)', async () => {
    const h = await setup({ concurrency: 4, perHostConcurrency: 2 })
    const bodies = Array.from({ length: 6 }, (_, index) => Buffer.alloc(5_000, index + 1))
    bodies.forEach((body, index) => {
      h.server.serve(`/c${index}.bin`, body, { chunkSize: 500, chunkDelayMs: 10 })
    })

    // Count in-flight *client* requests: the per-host limit is a client policy,
    // and the server's handler bookkeeping lags a released socket by a tick.
    let active = 0
    let maxActive = 0
    const original = h.http.openStream.bind(h.http)
    h.http.openStream = async (url, options) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      try {
        const response = await original(url, options)
        const release = () => {
          active = Math.max(0, active - 1)
        }
        response.stream.once('end', release)
        response.stream.once('close', release)
        response.stream.once('error', release)
        return response
      } catch (error) {
        active = Math.max(0, active - 1)
        throw error
      }
    }

    const tasks = bodies.map((body, index) =>
      task(`${h.server.baseUrl}/c${index}.bin`, `lib/c${index}.bin`, body),
    )
    const result = await runTasks(tasks, h.options)

    expect(result.downloaded).toBe(6)
    expect(maxActive).toBeLessThanOrEqual(2)
    expect(maxActive).toBeGreaterThanOrEqual(2)
  })

  it('cancels in-flight work, removes the .part and reports cancelled', async () => {
    const h = await setup()
    const body = Buffer.alloc(200_000, 5)
    h.server.serve('/slow.bin', body, { chunkSize: 1_000, chunkDelayMs: 25 })
    const controller = new AbortController()
    const running = runTasks([task(`${h.server.baseUrl}/slow.bin`, 'lib/slow.bin', body)], {
      ...h.options,
      signal: controller.signal,
    })
    setTimeout(() => controller.abort(), 80)
    const result = await running

    expect(result.cancelled).toBe(true)
    expect(fs.existsSync(path.join(h.root, 'lib/slow.bin'))).toBe(false)
    expect(fs.existsSync(path.join(h.root, 'lib/slow.bin.part'))).toBe(false)
  })

  it('keeps the event loop responsive while streaming (01 R1.16)', async () => {
    const h = await setup({ concurrency: 2 })
    const body = Buffer.alloc(80_000, 2)
    h.server.serve('/tick.bin', body, { chunkSize: 1_000, chunkDelayMs: 3 })
    let ticks = 0
    const timer = setInterval(() => {
      ticks += 1
    }, 2)

    try {
      await runTasks([task(`${h.server.baseUrl}/tick.bin`, 'lib/tick.bin', body)], h.options)
    } finally {
      clearInterval(timer)
    }

    expect(ticks).toBeGreaterThan(5)
    expect(fs.readFileSync(path.join(h.root, 'lib/tick.bin'))).toEqual(body)
  })

  it('reports progress bytes through the hook', async () => {
    const h = await setup()
    const body = Buffer.alloc(10_000, 4)
    h.server.serve('/p.bin', body, { chunkSize: 1_000 })
    let bytes = 0
    const result = await runTasks([task(`${h.server.baseUrl}/p.bin`, 'lib/p.bin', body)], {
      ...h.options,
      onBytes: (delta) => {
        bytes += delta
      },
    })
    expect(result.bytes).toBe(10_000)
    expect(bytes).toBe(10_000)
  })

  it('reports an unreadable DownloadError for a refused connection', async () => {
    const h = await setup({ maxRetries: 0 })
    const result = await runTasks(
      [task('https://127.0.0.1:1/x.bin', 'lib/refused.bin', Buffer.from('x'))],
      h.options,
    )
    expect(result.failures[0].code).toMatch(/DOWNLOAD\.(HTTP_ERROR|TIMEOUT|NO_SOURCE|NETWORK_UNREACHABLE)/)
    expect(result.failures[0].message.length).toBeGreaterThan(0)
    expect(() => {
      throw new DownloadError('DOWNLOAD.NO_SOURCE')
    }).toThrowError(/NO_SOURCE/)
  })
})

describe('runTasks: per-source cooldown (t46)', () => {
  it('cools only the failing source and completes from the other source', async () => {
    const h = await setup({ preference: 'auto', maxRetries: 2, sleep: async () => undefined })
    const body = Buffer.from('official wins during mirror cooldown')
    h.server.route('/mirror/one.bin', ({ res }) => {
      res.writeHead(500, { 'content-length': 0 }).end()
    })
    h.server.serve('/official/one.bin', body)
    h.server.serve('/official/two.bin', body)

    const first = await runTasks(
      [
        task(`${h.server.baseUrl}/official/one.bin`, 'libraries/one.bin', body, {
          mirrorUrl: `${h.server.baseUrl}/mirror/one.bin`,
        }),
      ],
      h.options,
    )
    expect(first.failures).toEqual([])
    expect(first.outcomes[0]).toMatchObject({ status: 'downloaded', source: 'official' })
    expect(h.server.countRequests('/mirror/one.bin')).toBe(3)
    expect(h.sources.isDisabled('mirror')).toBe(true)
    expect(h.sources.isDisabled('official')).toBe(false)

    // The next file must not retry the cooled mirror; official serves it.
    const second = await runTasks(
      [
        task(`${h.server.baseUrl}/official/two.bin`, 'libraries/two.bin', body, {
          mirrorUrl: `${h.server.baseUrl}/mirror/two.bin`,
        }),
      ],
      h.options,
    )
    expect(second.failures).toEqual([])
    expect(second.outcomes[0]).toMatchObject({ status: 'downloaded', source: 'official' })
    expect(h.server.countRequests('/mirror/two.bin')).toBe(0)
  })

  it('reports NETWORK_UNREACHABLE when every applicable source is cooling', async () => {
    const h = await setup({ preference: 'auto', maxRetries: 2, sleep: async () => undefined })
    const body = Buffer.from('never served')
    h.server.route('/mirror/down.bin', ({ res }) => {
      res.writeHead(503, { 'content-length': 0 }).end()
    })
    h.server.route('/official/down.bin', ({ res }) => {
      res.writeHead(503, { 'content-length': 0 }).end()
    })

    const result = await runTasks(
      [
        task(`${h.server.baseUrl}/official/down.bin`, 'libraries/down.bin', body, {
          mirrorUrl: `${h.server.baseUrl}/mirror/down.bin`,
        }),
      ],
      h.options,
    )

    expect(result.failures).toHaveLength(1)
    expect(result.failures[0].code).toBe('DOWNLOAD.NETWORK_UNREACHABLE')
    expect(result.failures[0].message).toContain('网络不可达')
    expect(result.failures[0].userMessage).toContain('网络不可达')
    expect(result.failures[0].retryable).toBe(true)
    expect(h.sources.disabledSources()).toEqual(['mirror', 'official'])
    expect(h.server.countRequests('/mirror/down.bin')).toBe(3)
    expect(h.server.countRequests('/official/down.bin')).toBe(3)
  })

  it('recovers a cooled source after its cooldown in a later task', async () => {
    let now = 1_000
    const h = await setup({ preference: 'auto', maxRetries: 2, sleep: async () => undefined })
    const registry = createSourceRegistry({
      preference: 'auto',
      mirrorEnabled: true,
      allowInsecureHosts: ['127.0.0.1'],
      selfHosts: ['127.0.0.1'],
      cooldownMs: 50,
      now: () => now,
    })
    h.options.sources = registry
    const body = Buffer.from('mirror returns after cooldown')
    h.server.route('/mirror/recover.bin', ({ res }) => {
      res.writeHead(500, { 'content-length': 0 }).end()
    })
    h.server.serve('/official/recover.bin', body)

    const first = await runTasks(
      [
        task(`${h.server.baseUrl}/official/recover.bin`, 'libraries/recover-one.bin', body, {
          mirrorUrl: `${h.server.baseUrl}/mirror/recover.bin`,
        }),
      ],
      { ...h.options, sources: registry },
    )
    expect(first.outcomes[0].source).toBe('official')
    expect(registry.isDisabled('mirror')).toBe(true)

    now += 51
    h.server.serve('/mirror/recover.bin', body)
    const second = await runTasks(
      [
        task(`${h.server.baseUrl}/official/recover.bin`, 'libraries/recover-two.bin', body, {
          mirrorUrl: `${h.server.baseUrl}/mirror/recover.bin`,
        }),
      ],
      { ...h.options, sources: registry },
    )
    expect(second.outcomes[0].source).toBe('mirror')
    expect(registry.isDisabled('mirror')).toBe(false)
  })
})

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HttpClient } from '../core/http'
import {
  fetchAssetIndex,
  fetchVersionJson,
  findManifestVersion,
  loadManifest,
  MANIFEST_TTL_MS,
  parseAssetIndex,
  parseVersionJsonText,
} from '../core/manifest'
import { createSourceRegistry } from '../core/sources'
import { sha1, startTestHttpServer, type TestHttpServer } from './support/http-server'

interface Harness {
  server: TestHttpServer
  cacheDir: string
  http: HttpClient
  sources: ReturnType<typeof createSourceRegistry>
  deps: Parameters<typeof loadManifest>[0]
}

let harness: Harness | null = null

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mcl-manifest-'))
}

const VERSION_JSON = JSON.stringify({
  id: '1.20.1',
  type: 'release',
  mainClass: 'net.minecraft.client.main.Main',
  libraries: [],
})

async function setup(
  now: () => number = Date.now,
  options: { mirrorEnabled?: boolean } = {},
): Promise<Harness> {
  const server = await startTestHttpServer()
  const cacheDir = tempDir()
  const http = new HttpClient({
    userAgent: 'mc-launcher/0.1.0 (+https://example.test; test@example.test)',
    allowInsecureHosts: ['127.0.0.1'],
  })
  const sources = createSourceRegistry({
    preference: options.mirrorEnabled ? 'auto' : 'official',
    mirrorEnabled: Boolean(options.mirrorEnabled),
    allowInsecureHosts: ['127.0.0.1'],
  })
  const deps = {
    http,
    sources,
    cacheDir,
    now,
    retries: 0,
    urls: {
      official: `${server.baseUrl}/manifest.json`,
      mirror: `${server.baseUrl}/mirror-manifest.json`,
    },
  }
  harness = { server, cacheDir, http, sources, deps }
  return harness
}

beforeEach(() => {
  harness = null
})

afterEach(async () => {
  if (harness) {
    await harness.server.close()
    fs.rmSync(harness.cacheDir, { recursive: true, force: true })
  }
  harness = null
})

function serveManifest(h: Harness, versionUrl = 'https://piston-meta.mojang.com/v1/packages/x/1.20.1.json') {
  h.server.serve(
    '/manifest.json',
    JSON.stringify({
      latest: { release: '1.20.1', snapshot: '24w14a' },
      versions: [
        {
          id: '1.20.1',
          type: 'release',
          url: versionUrl,
          sha1: sha1(VERSION_JSON),
          releaseTime: '2023-06-12T13:25:51+00:00',
          complianceLevel: 1,
        },
        {
          id: '1.20',
          type: 'release',
          url: 'https://piston-meta.mojang.com/v1/packages/y/1.20.json',
          sha1: 'a'.repeat(40),
        },
      ],
    }),
  )
}

describe('version_manifest_v2 (01 R1.1)', () => {
  it('parses the manifest and writes the 10-minute cache', async () => {
    const h = await setup()
    serveManifest(h)
    const loaded = await loadManifest(h.deps)

    expect(loaded.result.source).toBe('official')
    expect(loaded.result.cached).toBe(false)
    expect(loaded.result.latest.release).toBe('1.20.1')
    expect(loaded.result.versions.map((version) => version.id)).toEqual(['1.20.1', '1.20'])
    expect(loaded.result.versions[0].sha1).toBe(sha1(VERSION_JSON))
    expect(fs.existsSync(path.join(h.cacheDir, 'version_manifest_v2.json'))).toBe(true)
  })

  it('serves the cache within the TTL without another request', async () => {
    const h = await setup()
    serveManifest(h)
    await loadManifest(h.deps)
    h.server.reset()
    const second = await loadManifest(h.deps)
    expect(second.result.cached).toBe(true)
    expect(h.server.requests).toHaveLength(0)
  })

  it('refetches when forced or when the TTL expired', async () => {
    let now = 1_000_000
    const h = await setup(() => now)
    serveManifest(h)
    await loadManifest(h.deps)
    h.server.reset()

    now += MANIFEST_TTL_MS + 1
    const refreshed = await loadManifest(h.deps)
    expect(refreshed.result.cached).toBe(false)
    expect(h.server.countRequests('/manifest.json')).toBe(1)

    h.server.reset()
    await loadManifest({ ...h.deps, force: true })
    expect(h.server.countRequests('/manifest.json')).toBe(1)
  })

  it('falls back to an expired cache when every source is down', async () => {
    let now = 1_000_000
    const h = await setup(() => now)
    serveManifest(h)
    await loadManifest(h.deps)

    h.server.route('/manifest.json', ({ res }) => {
      res.writeHead(503, { 'content-length': 0 }).end()
    })
    now += MANIFEST_TTL_MS + 1
    const stale = await loadManifest(h.deps)
    expect(stale.result.cached).toBe(true)
    expect(stale.result.versions[0].id).toBe('1.20.1')
  })

  it('reports an unreadable manifest as DOWNLOAD.NO_SOURCE (no cache at all)', async () => {
    const h = await setup()
    h.server.serve('/manifest.json', '{"latest": 1}')
    await expect(loadManifest(h.deps)).rejects.toMatchObject({ code: 'DOWNLOAD.NO_SOURCE' })
  })

  it('reports all metadata sources cooling as NETWORK_UNREACHABLE, then recovers (t46)', async () => {
    let now = 1_000
    const h = await setup(() => now)
    const registry = createSourceRegistry({
      preference: 'auto',
      mirrorEnabled: true,
      allowInsecureHosts: ['127.0.0.1'],
      cooldownMs: 50,
      now: () => now,
    })
    h.deps.sources = registry
    for (let i = 0; i < 3; i += 1) registry.recordFailure('official', 'ETIMEDOUT')
    for (let i = 0; i < 3; i += 1) registry.recordFailure('mirror', 'ETIMEDOUT')

    await expect(loadManifest(h.deps)).rejects.toMatchObject({
      code: 'DOWNLOAD.NETWORK_UNREACHABLE',
      userMessage: expect.stringContaining('网络不可达'),
    })

    now += 51
    serveManifest(h)
    const loaded = await loadManifest(h.deps)
    expect(loaded.result.source).toBe('official')
    expect(loaded.result.cached).toBe(false)
  })

  it('finds a version entry by id', async () => {
    const h = await setup()
    serveManifest(h)
    const loaded = await loadManifest(h.deps)
    expect(findManifestVersion(loaded.raw, '1.20.1')?.type).toBe('release')
    expect(findManifestVersion(loaded.raw, '1.20.1-does-not-exist')).toBeNull()
  })

  it('prefers the official manifest over the mirror (t42)', async () => {
    const h = await setup(Date.now, { mirrorEnabled: true })
    serveManifest(h)
    h.server.serve(
      '/mirror-manifest.json',
      JSON.stringify({
        latest: { release: '1.21', snapshot: 'x' },
        versions: [{ id: '1.21', type: 'release', url: 'https://x/1.21.json' }],
      }),
    )
    const loaded = await loadManifest(h.deps)
    expect(loaded.result.source).toBe('official')
    expect(loaded.result.warnings ?? []).toEqual([])
    expect(h.server.countRequests('/manifest.json')).toBe(1)
    expect(h.server.countRequests('/mirror-manifest.json')).toBe(0)
  })

  it('falls back to the mirror with a visible trust warning (t42)', async () => {
    const h = await setup(Date.now, { mirrorEnabled: true })
    h.server.route('/manifest.json', ({ res }) => {
      res.writeHead(503, { 'content-length': 0 }).end()
    })
    h.server.serve(
      '/mirror-manifest.json',
      JSON.stringify({
        latest: { release: '1.20.1', snapshot: '24w14a' },
        versions: [{ id: '1.20.1', type: 'release', url: 'https://x/1.20.1.json' }],
      }),
    )
    const loaded = await loadManifest(h.deps)
    expect(loaded.result.source).toBe('mirror')
    expect(loaded.result.warnings?.join('\n')).toContain('镜像')
    expect(h.server.countRequests('/manifest.json')).toBe(1)
    expect(h.server.countRequests('/mirror-manifest.json')).toBe(1)
    const cache = JSON.parse(
      fs.readFileSync(path.join(h.cacheDir, 'version_manifest_v2.json'), 'utf8'),
    ) as { source: string }
    expect(cache.source).toBe('mirror')
  })

  it('uses ETag + If-None-Match and re-uses the cached manifest on 304 (t42)', async () => {
    const h = await setup()
    const body = JSON.stringify({
      latest: { release: '1.20.1', snapshot: '24w14a' },
      versions: [{ id: '1.20.1', type: 'release', url: 'https://x/1.20.1.json' }],
    })
    h.server.route('/manifest.json', ({ req, res }) => {
      if (req.headers['if-none-match'] === '"v1"') {
        res.writeHead(304, { etag: '"v1"' }).end()
        return
      }
      res.writeHead(200, {
        'content-type': 'application/json',
        etag: '"v1"',
        'last-modified': 'Wed, 21 Oct 2026 10:00:00 GMT',
        'content-length': Buffer.byteLength(body),
      }).end(body)
    })

    const first = await loadManifest(h.deps)
    expect(first.result.cached).toBe(false)
    const second = await loadManifest({ ...h.deps, force: true })
    expect(second.result.cached).toBe(true)
    expect(second.result.source).toBe('official')
    expect(second.result.versions[0].id).toBe('1.20.1')
    expect(h.server.requestsFor('/manifest.json')[1].headers['if-none-match']).toBe('"v1"')
    expect(h.server.countRequests('/manifest.json')).toBe(2)
  })

  it('re-downloads when the ETag changes (t42)', async () => {
    const h = await setup()
    const v1 = JSON.stringify({
      latest: { release: '1.20.1', snapshot: '24w14a' },
      versions: [{ id: '1.20.1', type: 'release', url: 'https://x/1.20.1.json' }],
    })
    const v2 = JSON.stringify({
      latest: { release: '1.21', snapshot: 'x' },
      versions: [{ id: '1.21', type: 'release', url: 'https://x/1.21.json' }],
    })
    h.server.route('/manifest.json', ({ req, res }) => {
      const inm = req.headers['if-none-match']
      if (inm === '"v2"') {
        res.writeHead(304, { etag: '"v2"' }).end()
        return
      }
      const body = inm === '"v1"' ? v2 : v1
      res.writeHead(200, {
        'content-type': 'application/json',
        etag: inm === '"v1"' ? '"v2"' : '"v1"',
        'content-length': Buffer.byteLength(body),
      }).end(body)
    })

    const first = await loadManifest(h.deps)
    expect(first.result.versions[0].id).toBe('1.20.1')
    const second = await loadManifest({ ...h.deps, force: true })
    expect(second.result.cached).toBe(false)
    expect(second.result.versions[0].id).toBe('1.21')
    expect(h.server.requestsFor('/manifest.json')[1].headers['if-none-match']).toBe('"v1"')
    const third = await loadManifest({ ...h.deps, force: true })
    expect(third.result.cached).toBe(true)
    expect(h.server.requestsFor('/manifest.json')[2].headers['if-none-match']).toBe('"v2"')
  })

  it('uses Last-Modified + If-Modified-Since when the server has no ETag (t42)', async () => {
    const h = await setup()
    const body = JSON.stringify({
      latest: { release: '1.20.1', snapshot: '24w14a' },
      versions: [{ id: '1.20.1', type: 'release', url: 'https://x/1.20.1.json' }],
    })
    const lastModified = 'Wed, 21 Oct 2026 10:00:00 GMT'
    h.server.route('/manifest.json', ({ req, res }) => {
      if (req.headers['if-modified-since'] === lastModified) {
        res.writeHead(304, { 'last-modified': lastModified }).end()
        return
      }
      res.writeHead(200, {
        'content-type': 'application/json',
        'last-modified': lastModified,
        'content-length': Buffer.byteLength(body),
      }).end(body)
    })
    await loadManifest(h.deps)
    const hit = await loadManifest({ ...h.deps, force: true })
    expect(hit.result.cached).toBe(true)
    expect(h.server.requestsFor('/manifest.json')[1].headers['if-modified-since']).toBe(lastModified)
  })
})

describe('version JSON (MC-11: runtime download, hash from the manifest)', () => {
  it('downloads, verifies sha1 and returns the parsed JSON', async () => {
    const h = await setup()
    h.server.serve('/1.20.1.json', VERSION_JSON)
    const fetched = await fetchVersionJson(
      {
        id: '1.20.1',
        type: 'release',
        url: `${h.server.baseUrl}/1.20.1.json`,
        sha1: sha1(VERSION_JSON),
      },
      { http: h.http, sources: h.sources, retries: 0 },
    )
    expect(fetched.json.id).toBe('1.20.1')
    expect(fetched.text).toContain('net.minecraft.client.main.Main')
    expect(fetched.source).toBe('official')
  })

  it('refuses a version JSON whose bytes do not match the manifest sha1', async () => {
    const h = await setup()
    h.server.serve('/1.20.1.json', VERSION_JSON)
    await expect(
      fetchVersionJson(
        {
          id: '1.20.1',
          type: 'release',
          url: `${h.server.baseUrl}/1.20.1.json`,
          sha1: 'b'.repeat(40),
        },
        { http: h.http, sources: h.sources, retries: 0 },
      ),
    ).rejects.toMatchObject({ code: 'DOWNLOAD.NO_SOURCE' })
  })

  it('rejects structurally invalid version JSON', () => {
    expect(() => parseVersionJsonText('{"id": 3}', 'x')).toThrowError(/missing id/)
    expect(() => parseVersionJsonText('[]', 'x')).toThrowError(/not an object/)
    expect(() => parseVersionJsonText('{', 'x')).toThrowError(/invalid JSON/)
    expect(() => parseVersionJsonText('{"id":"x","libraries":{}}', 'x')).toThrowError(/libraries/)
  })
})

describe('asset index (R1.2/R1.4)', () => {
  const index = {
    objects: {
      'icons/icon_128x128.png': { hash: 'b62ca8ec10d07e6bf5ac8dae0c8c1d2e6a1e3356', size: 9101 },
    },
  }
  const text = JSON.stringify(index)

  it('verifies size and sha1 before parsing', async () => {
    const h = await setup()
    h.server.serve('/5.json', text)
    const fetched = await fetchAssetIndex(
      {
        id: '5',
        url: `${h.server.baseUrl}/5.json`,
        sha1: sha1(text),
        size: Buffer.byteLength(text),
      },
      { http: h.http, sources: h.sources, retries: 0 },
    )
    expect(Object.keys(fetched.index.objects)).toHaveLength(1)
  })

  it('rejects a wrong size or hash', async () => {
    const h = await setup()
    h.server.serve('/5.json', text)
    await expect(
      fetchAssetIndex(
        { id: '5', url: `${h.server.baseUrl}/5.json`, sha1: sha1(text), size: 1 },
        { http: h.http, sources: h.sources, retries: 0 },
      ),
    ).rejects.toMatchObject({ code: 'DOWNLOAD.NO_SOURCE' })
  })

  it('validates the object shape', () => {
    expect(() => parseAssetIndex('{"objects":[]}', 'x')).toThrowError(/does not match/)
    expect(() => parseAssetIndex('{"objects":{"a":{"hash":"zz","size":1}}}', 'x')).toThrowError(
      /does not match/,
    )
  })
})

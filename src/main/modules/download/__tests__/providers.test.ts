import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HttpClient } from '../core/http'
import { ModrinthProvider } from '../providers/modrinth'
import { CurseForgeProvider } from '../providers/curseforge'
import { createModProviderRegistry } from '../providers/registry'
import { RequestLimiter } from '../providers/types'
import { sha1, startTestHttpServer, type TestHttpServer } from './support/http-server'

/**
 * P0 mod-source scope (docs/02 API-01~07): Modrinth is the only live provider;
 * CurseForge must fail loudly without ever calling its API.
 */

let server: TestHttpServer | null = null

beforeEach(() => {
  server = null
})

afterEach(async () => {
  if (server) await server.close()
  server = null
})

const UA = 'mc-launcher/0.1.0 (+https://example.test; test@example.test)'

async function setup() {
  const httpServer = await startTestHttpServer()
  server = httpServer
  const http = new HttpClient({ userAgent: UA, allowInsecureHosts: ['127.0.0.1'] })
  const provider = new ModrinthProvider({
    http,
    apiBase: `${httpServer.baseUrl}/v2`,
  })
  return { httpServer, http, provider }
}

const SEARCH = {
  hits: [
    {
      project_id: 'AABBCCDD',
      slug: 'sodium',
      title: 'Sodium',
      description: 'Modern rendering engine',
      author: 'jellysquid3',
      downloads: 123456,
      follows: 4321,
      icon_url: 'https://cdn.modrinth.com/data/AABBCCDD/icon.png',
    },
  ],
  offset: 0,
  limit: 10,
  total_hits: 1,
}

const VERSIONS = [
  {
    id: 'v1',
    project_id: 'AABBCCDD',
    name: 'Sodium 0.5.8',
    version_number: '0.5.8',
    version_type: 'release',
    game_versions: ['1.20.1'],
    loaders: ['fabric'],
    files: [
      {
        url: 'https://cdn.modrinth.com/data/AABBCCDD/versions/v1/sodium.jar',
        filename: 'sodium-0.5.8.jar',
        size: 1234,
        primary: true,
        hashes: { sha1: sha1('sodium'), sha512: 'f'.repeat(128) },
      },
      {
        url: 'https://cdn.modrinth.com/data/AABBCCDD/versions/v1/sodium-sources.jar',
        filename: 'sodium-sources.jar',
        size: 99,
        primary: false,
        hashes: { sha1: sha1('sources') },
      },
    ],
  },
]

describe('Modrinth provider (API-01/02/03)', () => {
  it('sends the unique User-Agent and parses search hits', async () => {
    const { httpServer, provider } = await setup()
    httpServer.serve('/v2/search', JSON.stringify(SEARCH), {
      headers: { 'content-type': 'application/json' },
    })
    const hits = await provider.search({ query: 'sodium', gameVersion: '1.20.1', loaders: ['fabric'] })
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({
      id: 'AABBCCDD',
      slug: 'sodium',
      title: 'Sodium',
      pageUrl: 'https://modrinth.com/mod/sodium',
    })
    const request = httpServer.requestsFor('/v2/search')[0]
    expect(request.headers['user-agent']).toBe(UA)
    expect(request.headers['user-agent']).toContain('mc-launcher/0.1.0')
    const url = new URL(`http://x${request.path}`)
    expect(url.pathname).toBe('/v2/search')
  })

  it('parses versions and keeps sha1 + sha512', async () => {
    const { httpServer, provider } = await setup()
    httpServer.serve('/v2/project/AABBCCDD/version', JSON.stringify(VERSIONS), {
      headers: { 'content-type': 'application/json' },
    })
    const versions = await provider.listVersions('AABBCCDD')
    expect(versions).toHaveLength(1)
    expect(versions[0].files[0].hashes).toEqual({ sha1: sha1('sodium'), sha512: 'f'.repeat(128) })
    expect(versions[0].loaders).toEqual(['fabric'])
  })

  it('maps only the primary file and prefers sha512 (API-03)', async () => {
    const { provider } = await setup()
    const version = {
      id: 'v1',
      projectId: 'AABBCCDD',
      name: 'Sodium',
      versionNumber: '0.5.8',
      versionType: 'release',
      gameVersions: ['1.20.1'],
      loaders: ['fabric'],
      files: [
        {
          url: 'https://cdn.modrinth.com/data/AABBCCDD/versions/v1/sodium.jar',
          filename: 'sodium-0.5.8.jar',
          size: 1234,
          primary: true,
          hashes: { sha1: sha1('sodium'), sha512: 'f'.repeat(128) },
        },
        {
          url: 'https://cdn.modrinth.com/data/AABBCCDD/versions/v1/sources.jar',
          filename: 'sources.jar',
          size: 10,
          primary: false,
          hashes: { sha1: sha1('sources'), sha512: null },
        },
      ],
    }
    const tasks = provider.toDownloadTasks(version, { destDir: 'versions/1.20.1/mods' })
    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toMatchObject({
      destRel: 'versions/1.20.1/mods/sodium-0.5.8.jar',
      sha512: 'f'.repeat(128),
      sha1: sha1('sodium'),
      size: 1234,
      sourceHint: 'official',
    })
    expect(tasks[0].mirrorUrl).toBeNull()
  })

  it('rejects a download URL that is not the Modrinth CDN (API-21)', async () => {
    const { provider } = await setup()
    const version = {
      id: 'v1',
      projectId: 'AABBCCDD',
      name: 'x',
      versionNumber: '1',
      versionType: 'release',
      gameVersions: [],
      loaders: [],
      files: [
        {
          url: 'https://evil.example/x.jar',
          filename: 'x.jar',
          size: 1,
          primary: true,
          hashes: { sha1: sha1('x'), sha512: null },
        },
      ],
    }
    expect(() => provider.toDownloadTasks(version, { destDir: 'mods' })).toThrowError(
      /not the Modrinth CDN/,
    )
  })

  it('refuses a file without any hash and a traverse-y filename', async () => {
    const { provider } = await setup()
    const noHash = {
      id: 'v1',
      projectId: 'AABBCCDD',
      name: 'x',
      versionNumber: '1',
      versionType: 'release',
      gameVersions: [],
      loaders: [],
      files: [
        {
          url: 'https://cdn.modrinth.com/x.jar',
          filename: 'x.jar',
          size: 1,
          primary: true,
          hashes: { sha1: null, sha512: null },
        },
      ],
    }
    expect(() => provider.toDownloadTasks(noHash, { destDir: 'mods' })).toThrowError(/no hash/)

    const traversal = { ...noHash, files: [{ ...noHash.files[0], filename: '../x.jar', hashes: { sha1: sha1('x'), sha512: null } }] }
    expect(() => provider.toDownloadTasks(traversal, { destDir: 'mods' })).toThrowError(
      /contains a directory/,
    )
  })

  it('builds project page URLs for both string and object input', async () => {
    const { provider } = await setup()
    expect(provider.projectPage('sodium')).toBe('https://modrinth.com/mod/sodium')
    expect(
      provider.projectPage({
        source: 'modrinth',
        id: 'AABBCCDD',
        slug: 'sodium',
        title: 'Sodium',
        description: '',
        author: '',
        downloads: 0,
        follows: 0,
        iconUrl: null,
        pageUrl: 'https://modrinth.com/mod/sodium',
      }),
    ).toBe('https://modrinth.com/mod/sodium')
  })
})

describe('CurseForge stays a declaration in P0 (API-07/08)', () => {
  it('reports unavailable and never exposes an API call', async () => {
    const curseforge = new CurseForgeProvider()
    expect(curseforge.info).toMatchObject({ available: false, requiresKey: true })
    await expect(curseforge.search({ query: 'jei' })).rejects.toMatchObject({
      code: 'SOURCE.PROVIDER_UNAVAILABLE',
    })
    await expect(curseforge.listVersions('jei')).rejects.toMatchObject({
      code: 'SOURCE.PROVIDER_UNAVAILABLE',
    })
    expect(() =>
      curseforge.toDownloadTasks(
        {
          id: 'x',
          projectId: 'jei',
          name: 'x',
          versionNumber: '1',
          versionType: 'release',
          gameVersions: [],
          loaders: [],
          files: [],
        },
        { destDir: 'mods' },
      ),
    ).toThrowError(/P1 API integration/)
    expect(curseforge.projectPage('jei')).toBe(
      'https://www.curseforge.com/minecraft/mc-mods/jei',
    )
  })

  it('exposes both providers through the registry', async () => {
    const { http } = await setup()
    const registry = createModProviderRegistry({ http })
    expect(registry.list().map((provider) => provider.id)).toEqual(['modrinth', 'curseforge'])
    expect(registry.get('modrinth').info.available).toBe(true)
  })
})

describe('RequestLimiter (API-02: <= 300 rpm, self-limited to 240)', () => {
  it('waits for the sliding window instead of bursting', async () => {
    let now = 0
    const sleeps: number[] = []
    const limiter = new RequestLimiter(
      2,
      () => now,
      async (ms) => {
        sleeps.push(ms)
        now += ms
      },
    )
    await limiter.acquire()
    await limiter.acquire()
    await limiter.acquire()
    expect(sleeps).toHaveLength(1)
    expect(sleeps[0]).toBe(60_000)
    expect(limiter.used).toBe(1)
  })
})

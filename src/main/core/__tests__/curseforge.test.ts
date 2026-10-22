import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CurseForgeClient,
  chooseLatestPackFile,
  type CfFile,
} from '../curseforge/client'
import {
  loadCurseForgeConfig,
  loadStoredCurseForgeConfig,
  maskCurseForgeConfig,
  normalizeMirrorBase,
  saveCurseForgeConfig,
} from '../curseforge/settings'
import { startServer, type TestServer } from '../../modules/catalog/__tests__/support/harness'

const cleanup: string[] = []
afterEach(() => {
  for (const dir of cleanup.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function dataRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcl-cf-'))
  cleanup.push(dir)
  return dir
}

interface CapturedLog {
  message: string
  fields?: Record<string, unknown>
}

function captureLog(): { log: { debug: (m: string, f?: Record<string, unknown>) => void; warn: (m: string, f?: Record<string, unknown>) => void }; lines: CapturedLog[] } {
  const lines: CapturedLog[] = []
  return {
    lines,
    log: {
      debug: (message, fields) => lines.push({ message, ...(fields ? { fields } : {}) }),
      warn: (message, fields) => lines.push({ message, ...(fields ? { fields } : {}) }),
    },
  }
}

async function withClient(
  options: {
    apiKey?: string | null
    mirrorBase?: string | null
    settings?: (server: TestServer) => { officialBase: string; mirrorBase?: string | null }
  } = {},
) {
  const server = await startServer()
  const official = options.settings?.(server)
  const officialBase = official?.officialBase ?? `${server.baseUrl}/v1`
  const client = new CurseForgeClient({
    config: {
      apiKey: options.apiKey === undefined ? 'secret-key-value' : options.apiKey,
      mirrorBase: official?.mirrorBase ?? options.mirrorBase ?? null,
    },
    userAgent: 'mc-launcher-test/0.1.0',
    officialBase,
    allowInsecureHosts: ['127.0.0.1'],
    timeoutMs: 5_000,
  })
  return { server, client }
}

function project(slug = 'atm9') {
  return {
    id: 123,
    name: 'All the Mods 9',
    slug,
    summary: 'Kitchen sink pack',
    downloadCount: 10_000,
    classId: 4471,
    links: { websiteUrl: `https://www.curseforge.com/minecraft/modpacks/${slug}` },
  }
}

function file(id = 456, overrides: Record<string, unknown> = {}) {
  return {
    id,
    modId: 123,
    displayName: 'ATM9 1.0.0',
    fileName: 'ATM9-1.0.0.zip',
    releaseType: 1,
    fileDate: '2026-01-01T00:00:00Z',
    fileLength: 1024,
    downloadUrl: 'https://edge.forgecdn.net/files/0/456/ATM9-1.0.0.zip',
    gameVersions: ['1.20.1', 'Forge'],
    hashes: [
      { value: 'a'.repeat(40), algo: 1 },
      { value: 'b'.repeat(64), algo: 3 },
    ],
    ...overrides,
  }
}

describe('CurseForge settings', () => {
  it('stores the key locally, masks it and never puts it in the view', () => {
    const root = dataRoot()
    expect(loadCurseForgeConfig(root)).toEqual({ apiKey: null, mirrorBase: null })
    saveCurseForgeConfig(root, { apiKey: 'my-secret', mirrorBase: 'https://cf.example.com/api/v1' })
    const stored = loadStoredCurseForgeConfig(root)
    expect(stored).toEqual({ apiKey: 'my-secret', mirrorBase: 'https://cf.example.com/api/v1' })
    const view = maskCurseForgeConfig(loadCurseForgeConfig(root))
    expect(view).toEqual({ hasApiKey: true, mirrorBase: 'https://cf.example.com/api/v1' })
    expect(JSON.stringify(view)).not.toContain('my-secret')
  })

  it('validates mirror URLs and drops the official base', () => {
    expect(normalizeMirrorBase('https://mirror.example.com/api/v1/')).toBe(
      'https://mirror.example.com/api/v1',
    )
    expect(normalizeMirrorBase('')).toBeNull()
    expect(normalizeMirrorBase('https://api.curseforge.com/v1')).toBeNull()
    expect(() => normalizeMirrorBase('http://mirror.example.com')).toThrowError(
      expect.objectContaining({ code: 'CATALOG.CF_MIRROR_INVALID' }),
    )
    expect(
      normalizeMirrorBase('http://127.0.0.1:8080/api', { allowInsecureHosts: ['127.0.0.1'] }),
    ).toBe('http://127.0.0.1:8080/api')
  })
})

describe('CurseForge client', () => {
  it('sends the key only as a header to the API host and never logs it', async () => {
    const { server, client } = await withClient()
    const captured = captureLog()
    server.json('/v1/mods/search', { data: [project()] })
    const projectResult = await client.searchModpacks('atm9')
    expect(projectResult).toMatchObject({ id: 123, slug: 'atm9', name: 'All the Mods 9' })
    const request = server.requests[0]
    expect(request.headers['x-api-key']).toBe('secret-key-value')
    expect(request.url).not.toContain('secret-key-value')
    expect(request.headers['user-agent']).toContain('mc-launcher-test')
    // The client's own debug log may contain host/path/status only.
    const fallback = new CurseForgeClient({
      config: { apiKey: 'secret-key-value', mirrorBase: null },
      userAgent: 'test',
      officialBase: `${server.baseUrl}/v1`,
      allowInsecureHosts: ['127.0.0.1'],
      log: captured.log,
    })
    await fallback.searchModpacks('atm9')
    expect(JSON.stringify(captured.lines)).not.toContain('secret-key-value')
    await server.close()
  })

  it('prefers the official API and falls back to the mirror on 5xx', async () => {
    const server = await startServer()
    const officialMount = '/v1'
    const mirrorMount = '/mirror'
    server.route(`${officialMount}/mods/search`, (_req, res) => {
      res.writeHead(503, { 'content-length': 0 }).end()
    })
    server.json(`${mirrorMount}/mods/search`, { data: [project()] })
    const client = new CurseForgeClient({
      config: { apiKey: 'secret-key-value', mirrorBase: `${server.baseUrl}${mirrorMount}` },
      userAgent: 'test',
      officialBase: `${server.baseUrl}${officialMount}`,
      allowInsecureHosts: ['127.0.0.1'],
    })
    const result = await client.searchModpacks('atm9')
    expect(result?.slug).toBe('atm9')
    expect(server.count(`${officialMount}/mods/search`)).toBe(1)
    expect(server.count(`${mirrorMount}/mods/search`)).toBe(1)
    const mirrorRequest = server.requests.find(
      (request) => request.path === `${mirrorMount}/mods/search`,
    )
    // The key follows the configured API base (mirror) as a header, never a URL.
    expect(mirrorRequest?.headers['x-api-key']).toBe('secret-key-value')
    expect(mirrorRequest?.url).not.toContain('secret-key-value')
    expect(client.lastSourceHost).toBe('127.0.0.1')
    await server.close()
  })

  it('does not use the mirror for 404 and maps auth/rate errors', async () => {
    const server = await startServer()
    server.route('/v1/mods/search', (_req, res) => {
      res.writeHead(404, { 'content-length': 0 }).end()
    })
    server.json('/mirror/mods/search', { data: [project()] })
    const notFound = new CurseForgeClient({
      config: { apiKey: 'secret-key-value', mirrorBase: `${server.baseUrl}/mirror` },
      userAgent: 'test',
      officialBase: `${server.baseUrl}/v1`,
      allowInsecureHosts: ['127.0.0.1'],
    })
    await expect(notFound.searchModpacks('atm9')).rejects.toMatchObject({
      code: 'CATALOG.CF_NOT_FOUND',
    })
    expect(server.count('/mirror/mods/search')).toBe(0)

    server.route('/v1/mods/123/files/456', (_req, res) => {
      res.writeHead(401, { 'content-length': 0 }).end()
    })
    await expect(notFound.file(123, 456)).rejects.toMatchObject({
      code: 'CATALOG.CF_ACCESS_DENIED',
    })
    await server.close()
  })

  it('requires a key before issuing any request', async () => {
    const { server, client } = await withClient({ apiKey: null })
    await expect(client.searchModpacks('atm9')).rejects.toMatchObject({
      code: 'CATALOG.CF_KEY_MISSING',
    })
    expect(server.requests).toHaveLength(0)
    await server.close()
  })

  it('keeps downloadUrl null (distribution disabled) and parses hashes', async () => {
    const { server, client } = await withClient()
    server.json('/v1/mods/123/files/456', { data: file(456, { downloadUrl: null }) })
    const parsed = await client.file(123, 456)
    expect(parsed.downloadUrl).toBeNull()
    expect(parsed.hashes).toEqual({ sha1: 'a'.repeat(40), sha256: 'b'.repeat(64) })
    await server.close()
  })

  it('chooses the newest release file', () => {
    const files: CfFile[] = [
      {
        id: 1,
        modId: 123,
        displayName: 'beta',
        fileName: 'beta.zip',
        releaseType: 2,
        fileDate: '2026-03-01T00:00:00Z',
        fileLength: 1,
        downloadUrl: 'https://edge.forgecdn.net/x',
        gameVersions: [],
        hashes: {},
      },
      {
        id: 2,
        modId: 123,
        displayName: 'release-old',
        fileName: 'release.zip',
        releaseType: 1,
        fileDate: '2026-01-01T00:00:00Z',
        fileLength: 1,
        downloadUrl: 'https://edge.forgecdn.net/y',
        gameVersions: [],
        hashes: {},
      },
      {
        id: 3,
        modId: 123,
        displayName: 'release-new',
        fileName: 'release2.zip',
        releaseType: 1,
        fileDate: '2026-02-01T00:00:00Z',
        fileLength: 1,
        downloadUrl: 'https://edge.forgecdn.net/z',
        gameVersions: [],
        hashes: {},
      },
    ]
    expect(chooseLatestPackFile(files)?.id).toBe(3)
    expect(chooseLatestPackFile([])).toBeNull()
  })

  it('reports AppError codes for missing files and unreachable API', async () => {
    const { server, client } = await withClient()
    server.route('/v1/mods/123/files/999', (_req, res) => {
      res.writeHead(404, { 'content-length': 0 }).end()
    })
    await expect(client.file(123, 999)).rejects.toMatchObject({ code: 'CATALOG.CF_NOT_FOUND' })
    await server.close()

    const unreachable = new CurseForgeClient({
      config: { apiKey: 'secret-key-value', mirrorBase: null },
      userAgent: 'test',
      officialBase: 'http://127.0.0.1:1/v1',
      allowInsecureHosts: ['127.0.0.1'],
      timeoutMs: 500,
    })
    await expect(unreachable.searchModpacks('atm9')).rejects.toMatchObject({
      code: 'CATALOG.CF_UNAVAILABLE',
    })
  })
})

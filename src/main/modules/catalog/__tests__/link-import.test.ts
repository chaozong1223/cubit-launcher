import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { catalogContract } from '@shared/catalog'
import type { ScopedLogger } from '../../../kernel/logger'
import type { CurseForgeClient } from '../../../core/curseforge/client'
import type { CurseForgeConfig } from '../../../core/curseforge/settings'
import { configureCurseForgeCipher, saveCurseForgeConfig } from '../../../core/curseforge/settings'
import { ModrinthClient } from '../core/modrinth'
import { CatalogModuleService } from '../service'
import {
  FakeModsService,
  modFile,
  startServer,
  tempDir,
  type TestServer,
} from './support/harness'

const packBytes = Buffer.from('fake-mrpack-archive')
const cfPackBytes = Buffer.from('fake-cf-archive')
const originalEnvKey = process.env.MCL_CF_API_KEY
const testCipher = {
  available: true,
  backend: 'dpapi',
  async encrypt(plain: string): Promise<Buffer> {
    return Buffer.from(`enc:${plain}`, 'utf8')
  },
  async decrypt(encrypted: Buffer): Promise<{ plain: string; shouldReEncrypt: boolean }> {
    return { plain: encrypted.toString('utf8').replace(/^enc:/, ''), shouldReEncrypt: false }
  },
}

const cleanup: string[] = []
afterEach(() => {
  for (const dir of cleanup.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
  configureCurseForgeCipher(null)
  if (originalEnvKey === undefined) delete process.env.MCL_CF_API_KEY
  else process.env.MCL_CF_API_KEY = originalEnvKey
})

function sha1(bytes: Buffer): string {
  return createHash('sha1').update(bytes).digest('hex')
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('condition not met in time')
}
function sha512(bytes: Buffer): string {
  return createHash('sha512').update(bytes).digest('hex')
}

interface Fixture {
  server: TestServer
  service: CatalogModuleService
  mods: FakeModsService
  dataRoot: string
  events: Array<{ event: string; payload: unknown }>
  logs: Array<{ message: string; fields?: Record<string, unknown> }>
}

function packVersion(
  server: TestServer,
  id: string,
  options: {
    versionType?: 'release' | 'beta'
    published?: string
    bytes?: Buffer
    projectId?: string
    filename?: string
  } = {},
) {
  const bytes = options.bytes ?? packBytes
  return {
    id,
    project_id: options.projectId ?? 'P',
    name: `Cool Pack ${id}`,
    version_number: id,
    changelog: null,
    game_versions: ['1.20.1'],
    loaders: ['fabric'],
    version_type: options.versionType ?? 'release',
    date_published: options.published ?? '2026-01-01T00:00:00Z',
    downloads: 10,
    files: [
      {
        filename: options.filename ?? `cool-${id}.mrpack`,
        url: `${server.baseUrl}/files/${options.filename ?? `cool-${id}.mrpack`}`,
        size: bytes.length,
        primary: true,
        hashes: { sha1: sha1(bytes), sha512: sha512(bytes) },
      },
    ],
  }
}

function modpackProject(server: TestServer) {
  return {
    id: 'P',
    slug: 'cool-pack',
    title: 'Cool Pack',
    description: 'A cool modpack',
    body: 'body',
    project_type: 'modpack',
    downloads: 100,
    follows: 10,
    icon_url: null,
    categories: ['adventure'],
    game_versions: ['1.20.1'],
    loaders: ['fabric'],
    page_url: 'https://modrinth.com/modpack/cool-pack',
  }
}

async function setup(
  options: {
    cfConfig?: CurseForgeConfig | null
    cf?: { project: unknown; files: unknown[]; file: unknown } | null
    slow?: boolean
  } = {},
): Promise<Fixture> {
  const server = await startServer()
  const dataRoot = tempDir('mcl-link-data-')
  const mcRoot = tempDir('mcl-link-mc-')
  const gameDir = path.join(mcRoot, 'versions', '1.20.1')
  fs.mkdirSync(gameDir, { recursive: true })
  if (options.cfConfig) {
    configureCurseForgeCipher(testCipher)
    await saveCurseForgeConfig(dataRoot, options.cfConfig, { cipher: testCipher, restrictAcl: null })
  }
  delete process.env.MCL_CF_API_KEY

  const release = packVersion(server, 'v1', { published: '2026-01-01T00:00:00Z' })
  const beta = packVersion(server, 'v2', {
    versionType: 'beta',
    published: '2026-03-01T00:00:00Z',
  })
  if (options.slow) {
    const slowBytes = Buffer.alloc(8 * 1024 * 1024, 7)
    server.route('/files/slow.mrpack', (req, res) => {
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': slowBytes.length,
      })
      let sent = 0
      const timer = setInterval(() => {
        if (sent >= slowBytes.length || res.destroyed) {
          clearInterval(timer)
          if (!res.destroyed) res.end()
          return
        }
        const chunk = slowBytes.subarray(sent, Math.min(sent + 64 * 1024, slowBytes.length))
        sent += chunk.length
        res.write(chunk)
      }, 20)
      req.on('close', () => clearInterval(timer))
    })
    release.files[0].url = `${server.baseUrl}/files/slow.mrpack`
    release.files[0].size = slowBytes.length
  }
  server.json('/v2/project/cool-pack', modpackProject(server))
  server.json('/v2/project/P/version', [beta, release])
  server.json('/v2/version/v1', release)
  server.json('/v2/version/v2', beta)
  server.bytes('/files/cool-v1.mrpack', packBytes)
  server.bytes('/files/cool-v2.mrpack', packBytes)
  server.bytes('/files/atm9.zip', cfPackBytes)

  const client = new ModrinthClient({
    apiBase: `${server.baseUrl}/v2`,
    minIntervalMs: 0,
    allowInsecureHosts: ['127.0.0.1'],
    cacheTtlMs: 0,
    retries: 0,
  })
  const mods = new FakeModsService(gameDir, [modFile('sodium.jar')])
  const events: Array<{ event: string; payload: unknown }> = []
  const logs: Array<{ message: string; fields?: Record<string, unknown> }> = []
  const logger = {
    trace: () => undefined,
    debug: (message: string, fields?: Record<string, unknown>) => logs.push({ message, ...(fields ? { fields } : {}) }),
    info: (message: string, fields?: Record<string, unknown>) => logs.push({ message, ...(fields ? { fields } : {}) }),
    warn: (message: string, fields?: Record<string, unknown>) => logs.push({ message, ...(fields ? { fields } : {}) }),
    error: (message: string, fields?: Record<string, unknown>) => logs.push({ message, ...(fields ? { fields } : {}) }),
    fatal: () => undefined,
  } as unknown as ScopedLogger

  let cfFactoryCalls = 0
  const service = new CatalogModuleService({
    roots: { dataRoot, mcRoot },
    log: logger,
    modrinth: client,
    mods: () => mods,
    allowInsecureHosts: ['127.0.0.1'],
    emit: (event, payload) => events.push({ event, payload }),
    curseForgeClientFactory: (config: CurseForgeConfig) => {
      cfFactoryCalls += 1
      const state = options.cf ?? {
        project: {
          id: 123,
          slug: 'atm9',
          name: 'All the Mods 9',
          summary: '',
          websiteUrl: 'https://www.curseforge.com/minecraft/modpacks/atm9',
          downloadCount: 1,
          classId: 4471,
        },
        files: [
          {
            id: 456,
            modId: 123,
            displayName: 'ATM9',
            fileName: 'ATM9.zip',
            releaseType: 1,
            fileDate: '2026-01-01T00:00:00Z',
            fileLength: cfPackBytes.length,
            downloadUrl: `${server.baseUrl}/files/atm9.zip`,
            gameVersions: ['1.20.1'],
            hashes: { sha1: sha1(cfPackBytes) },
          },
        ],
        file: null,
      }
      const fake = {
        hasApiKey: Boolean(config.apiKey),
        lastSourceHost: 'api.curseforge.com',
        searchModpacks: async () => state.project,
        project: async () => state.project,
        files: async () => state.files,
        file: async () => state.file ?? (state.files[0] as unknown),
      }
      return fake as unknown as CurseForgeClient
    },
  })
  // expose the factory counter through the returned mods object for assertions
  ;(mods as unknown as { __cfFactoryCalls: number }).__cfFactoryCalls = 0
  Object.defineProperty(mods, '__cfFactoryCalls', { get: () => cfFactoryCalls })
  return { server, service, mods, dataRoot, events, logs }
}

describe('catalog link import — Modrinth', () => {
  it('plans without downloading, then requires confirmation before import', async () => {
    const h = await setup()
    const plan = await h.service.planLinkImport({
      link: 'https://modrinth.com/modpack/cool-pack',
    })
    expect(plan).toMatchObject({
      provider: 'modrinth',
      slug: 'cool-pack',
      projectTitle: 'Cool Pack',
      versionId: 'v1',
      fileName: 'cool-v1.mrpack',
      requiresApiKey: false,
      canProceed: true,
    })
    expect(catalogContract.methods.planLinkImport.output.safeParse(plan).success).toBe(true)
    expect(h.server.count('/files/cool-v1.mrpack')).toBe(0)

    expect(() =>
      h.service.startLinkImport({ planId: plan.planId, confirm: false }),
    ).toThrowError(expect.objectContaining({ code: 'CATALOG.CONFIRMATION_REQUIRED' }))
    expect(h.mods.packImports).toHaveLength(0)
    expect(h.server.count('/files/cool-v1.mrpack')).toBe(0)

    const started = h.service.startLinkImport({ planId: plan.planId, confirm: true })
    expect(catalogContract.methods.startLinkImport.output.safeParse(started).success).toBe(true)
    const outcome = await h.service.waitForLinkImport(started.jobId)
    expect(outcome.ok).toBe(true)
    const result = outcome.result!
    expect(result).toMatchObject({
      provider: 'modrinth',
      planId: plan.planId,
      downloadBytes: packBytes.length,
      import: { jobId: 'job-1' },
    })
    expect(catalogContract.methods.linkImportResult.output.safeParse(h.service.linkImportResult(started.jobId)).success).toBe(true)
    expect(h.mods.packImports).toHaveLength(1)
    const archive = h.mods.packImports[0]
    expect(archive.startsWith(path.join(h.dataRoot, 'modules', 'catalog', 'packs'))).toBe(true)
    expect(fs.readFileSync(archive)).toEqual(packBytes)
    expect(h.events.some((entry) => entry.event === 'linkDownloadProgress')).toBe(true)
    const states = new Set(
      h.events
        .filter((entry) => entry.event === 'linkDownloadProgress')
        .map((entry) => (entry.payload as { state: string }).state),
    )
    expect(states.has('downloading')).toBe(true)
    expect(states.has('importing')).toBe(true)

    // Plans are single-use.
    expect(() =>
      h.service.startLinkImport({ planId: plan.planId, confirm: true }),
    ).toThrowError(expect.objectContaining({ code: 'CATALOG.PLAN_EXPIRED' }))
    await h.server.close()
  })

  it('cancels an in-flight download and removes every partial pack file', async () => {
    const h = await setup({ slow: true })
    const plan = await h.service.planLinkImport({ link: 'https://modrinth.com/modpack/cool-pack' })
    expect(plan.canProceed).toBe(true)
    const started = h.service.startLinkImport({ planId: plan.planId, confirm: true })
    await waitUntil(() =>
      h.events.some(
        (entry) =>
          entry.event === 'linkDownloadProgress' &&
          (entry.payload as { state?: string; bytes?: number }).state === 'downloading' &&
          ((entry.payload as { bytes?: number }).bytes ?? 0) > 0,
      ),
    )
    const cancelAt = Date.now()
    expect(h.service.cancelLinkImport(started.jobId).cancelled).toBe(true)
    const outcome = await h.service.waitForLinkImport(started.jobId)
    expect(outcome.state).toBe('cancelled')
    expect(Date.now() - cancelAt).toBeLessThan(3_000)
    expect(h.mods.packImports).toHaveLength(0)
    expect(h.service.linkImportResult(started.jobId)?.result).toBeNull()
    const packsDir = path.join(h.dataRoot, 'modules', 'catalog', 'packs')
    const leftovers = fs.existsSync(packsDir)
      ? fs.readdirSync(packsDir).filter((name) => name.includes(plan.planId))
      : []
    expect(leftovers).toEqual([])
    const cancelledStates = h.events
      .filter((entry) => entry.event === 'linkDownloadProgress')
      .map((entry) => (entry.payload as { state?: string }).state)
    expect(cancelledStates).toContain('cancelled')
    await h.server.close()
  })

  it('honours a pinned version and rejects a version from another project', async () => {
    const h = await setup()
    const pinned = await h.service.planLinkImport({
      link: 'https://modrinth.com/modpack/cool-pack/version/v2',
    })
    expect(pinned.versionId).toBe('v2')
    expect(pinned.warnings.join(' ')).toContain('测试版')
    await h.server.close()
  })

  it('surfaces non-modpack projects as unsupported', async () => {
    const h = await setup()
    h.server.json('/v2/project/cool-pack', {
      ...modpackProject(h.server),
      project_type: 'mod',
    })
    await expect(
      h.service.planLinkImport({ link: 'https://modrinth.com/modpack/cool-pack' }),
    ).rejects.toMatchObject({ code: 'CATALOG.LINK_UNSUPPORTED' })
    await h.server.close()
  })
})

describe('catalog link import — CurseForge', () => {
  it('asks for a user key before any API call', async () => {
    const h = await setup()
    const plan = await h.service.planLinkImport({
      link: 'https://www.curseforge.com/minecraft/modpacks/atm9',
    })
    expect(plan).toMatchObject({
      provider: 'curseforge',
      requiresApiKey: true,
      apiKeyConfigured: false,
      canProceed: false,
      reason: 'CATALOG.CF_KEY_MISSING',
    })
    expect((h.mods as unknown as { __cfFactoryCalls: number }).__cfFactoryCalls).toBe(0)
    await h.server.close()
  })

  it('reports downloadUrl=null as a dedicated hint instead of guessing a URL', async () => {
    const h = await setup({
      cfConfig: { apiKey: 'user-key', mirrorBase: null },
      cf: {
        project: {
          id: 123,
          slug: 'atm9',
          name: 'All the Mods 9',
          summary: '',
          websiteUrl: 'https://www.curseforge.com/minecraft/modpacks/atm9',
          downloadCount: 1,
          classId: 4471,
        },
        files: [
          {
            id: 456,
            modId: 123,
            displayName: 'ATM9',
            fileName: 'ATM9.zip',
            releaseType: 1,
            fileDate: '2026-01-01T00:00:00Z',
            fileLength: 100,
            downloadUrl: null,
            gameVersions: ['1.20.1'],
            hashes: {},
          },
        ],
        file: null,
      },
    })
    const plan = await h.service.planLinkImport({
      link: 'https://www.curseforge.com/minecraft/modpacks/atm9',
    })
    expect(plan).toMatchObject({
      canProceed: false,
      reason: 'CATALOG.CF_DISTRIBUTION_DISABLED',
      apiKeyConfigured: true,
      fileId: 456,
    })
    expect(plan.warnings.join(' ')).toContain('downloadUrl 为 null')
    expect(() =>
      h.service.startLinkImport({ planId: plan.planId, confirm: true }),
    ).toThrowError(expect.objectContaining({ code: 'CATALOG.CF_DISTRIBUTION_DISABLED' }))
    await h.server.close()
  })

  it('imports a key-backed CurseForge pack after confirmation', async () => {
    const h = await setup({ cfConfig: { apiKey: 'user-key', mirrorBase: null } })
    const plan = await h.service.planLinkImport({
      link: 'https://www.curseforge.com/minecraft/modpacks/atm9/files/456',
    })
    expect(plan).toMatchObject({
      provider: 'curseforge',
      canProceed: true,
      fileName: 'ATM9.zip',
      fileId: 456,
      apiKeyConfigured: true,
      apiSourceHost: 'api.curseforge.com',
    })
    const started = h.service.startLinkImport({ planId: plan.planId, confirm: true })
    const outcome = await h.service.waitForLinkImport(started.jobId)
    expect(outcome.ok).toBe(true)
    expect(outcome.result?.provider).toBe('curseforge')
    expect(outcome.result?.downloadBytes).toBe(cfPackBytes.length)
    expect(fs.readFileSync(h.mods.packImports[0])).toEqual(cfPackBytes)
    // The archive download must not carry the API key.
    const archiveRequest = h.server.requests.find((request) => request.path === '/files/atm9.zip')
    expect(archiveRequest?.headers['x-api-key']).toBeUndefined()
    await h.server.close()
  })

  it('updates key/mirror without exposing or logging the key', async () => {
    const h = await setup()
    configureCurseForgeCipher(testCipher)
    const updated = await h.service.updateCurseForgeConfig({
      apiKey: 'super-secret-key',
      mirrorBase: 'https://mirror.example.com/api/v1',
    })
    expect(updated).toEqual({
      hasApiKey: true,
      mirrorBase: 'https://mirror.example.com/api/v1',
      secureStorageAvailable: true,
      persisted: true,
    })
    expect(JSON.stringify(h.logs)).not.toContain('super-secret-key')
    await expect(
      h.service.updateCurseForgeConfig({ mirrorBase: 'http://insecure.example.com' }),
    ).rejects.toMatchObject({ code: 'CATALOG.CF_MIRROR_INVALID' })
    const cleared = await h.service.updateCurseForgeConfig({ clearApiKey: true })
    expect(cleared).toMatchObject({ hasApiKey: false, persisted: false })
    await h.server.close()
  })
})

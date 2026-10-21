import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultInstanceSettings, writeInstanceSettings } from '../../../core/instance/settings'
import { nodeFsPort } from '../../../core/ports'
import { Logger } from '../../../kernel/logger'
import { AppError } from '@shared/errors'
import { ModrinthClient } from '../core/modrinth'
import { CatalogModuleService } from '../service'
import {
  FakeModsService,
  modFile,
  startServer,
  tempDir,
  type TestServer,
} from './support/harness'

interface Fixture {
  server: TestServer
  service: CatalogModuleService
  mods: FakeModsService
  mcRoot: string
  dataRoot: string
  gameDir: string
  oldBytes: Buffer
  newBytes: Buffer
  events: Array<{ event: string; payload: unknown }>
  opened: string[]
}

let fixture: Fixture | null = null

function sha1(bytes: Buffer): string {
  return createHash('sha1').update(bytes).digest('hex')
}
function sha512(bytes: Buffer): string {
  return createHash('sha512').update(bytes).digest('hex')
}

function version(
  id: string,
  bytes: Buffer,
  gameVersions = ['1.20.1'],
  loaders = ['fabric'],
  versionType: 'release' | 'beta' = 'release',
) {
  return {
    id,
    project_id: 'P',
    name: `Sodium ${id}`,
    version_number: id === 'v1' ? '0.5.8' : '0.6.0',
    changelog: id === 'v1' ? 'initial' : '## 0.6.0\n- faster',
    game_versions: gameVersions,
    loaders,
    version_type: versionType,
    date_published: id === 'v1' ? '2026-01-01T00:00:00Z' : '2026-02-01T00:00:00Z',
    downloads: 100,
    files: [
      {
        filename: `sodium-${id}.jar`,
        url: '',
        size: bytes.length,
        primary: true,
        hashes: { sha1: sha1(bytes), sha512: sha512(bytes) },
      },
    ],
  }
}

async function setup(
  options: { mods?: ReturnType<typeof modFile>[]; oldBytes?: Buffer; latestVersion?: ReturnType<typeof version> } = {},
): Promise<Fixture> {
  const server = await startServer()
  const mcRoot = tempDir('mcl-cat-mc-')
  const dataRoot = tempDir('mcl-cat-data-')
  const gameDir = path.join(mcRoot, 'versions', '1.20.1')
  fs.mkdirSync(path.join(gameDir, 'mods'), { recursive: true })
  fs.mkdirSync(path.join(mcRoot, 'versions', '1.20.1'), { recursive: true })
  fs.writeFileSync(
    path.join(mcRoot, 'versions', '1.20.1', '1.20.1.json'),
    JSON.stringify({
      id: '1.20.1',
      type: 'release',
      mainClass: 'net.minecraft.client.main.Main',
      assetIndex: { id: '5', url: 'https://x/5.json', sha1: 'a'.repeat(40), size: 1 },
      downloads: { client: { url: 'https://x/c.jar', sha1: 'b'.repeat(40), size: 1 } },
      libraries: [],
    }),
  )
  fs.writeFileSync(path.join(gameDir, '1.20.1.jar'), 'jar')
  writeInstanceSettings(
    nodeFsPort(),
    gameDir,
    {
      ...defaultInstanceSettings({
        dirName: '1.20.1',
        id: '1.20.1',
        mcVersion: '1.20.1',
        loader: { type: 'fabric', version: '0.15.0' },
      }),
      isolation: 'isolated',
    },
  )

  const oldBytes = options.oldBytes ?? Buffer.from('old-sodium')
  const newBytes = Buffer.from('new-sodium')
  const files = options.mods ?? [modFile('sodium.jar')]
  if (files.length > 0) fs.writeFileSync(path.join(gameDir, 'mods', files[0].fileName), oldBytes)
  const latest =
    options.latestVersion ??
    version('v2', newBytes)
  latest.files[0].url = `${server.baseUrl}/files/sodium-new.jar`
  const current = version('v1', oldBytes)
  current.files[0].url = `${server.baseUrl}/files/sodium-old.jar`

  server.json('/v2/search', {
    hits: [
      {
        project_id: 'P',
        slug: 'sodium',
        title: 'Sodium',
        description: 'Rendering engine',
        author: 'jellysquid3',
        downloads: 1000,
        follows: 50,
        icon_url: 'https://cdn.modrinth.com/icon.png',
        project_type: 'mod',
        categories: ['fabric', 'optimization'],
        versions: ['1.20.1'],
        latest_version: 'v2',
        date_modified: '2026-02-01T00:00:00Z',
      },
    ],
    offset: 0,
    limit: 20,
    total_hits: 1,
  })
  server.json('/v2/project/P', {
    id: 'P',
    slug: 'sodium',
    title: 'Sodium',
    description: 'Rendering engine',
    body: 'A modern rendering engine',
    project_type: 'mod',
    downloads: 1000,
    follows: 50,
    icon_url: null,
    categories: ['fabric'],
    game_versions: ['1.20.1'],
    loaders: ['fabric'],
  })
  server.json('/v2/project/P/version', [latest, current])
  server.json('/v2/version/v2', latest)
  server.json('/v2/version/v1', current)
  server.json(`/v2/version_file/${sha1(oldBytes)}`, current)
  server.bytes('/files/sodium-new.jar', newBytes)
  server.bytes('/files/sodium-old.jar', oldBytes)

  const client = new ModrinthClient({
    apiBase: `${server.baseUrl}/v2`,
    minIntervalMs: 0,
    allowInsecureHosts: ['127.0.0.1'],
    cacheTtlMs: 60_000,
    retries: 0,
  })
  const mods = new FakeModsService(gameDir, files)
  const events: Array<{ event: string; payload: unknown }> = []
  const opened: string[] = []
  const service = new CatalogModuleService({
    roots: { dataRoot, mcRoot },
    log: new Logger({ dataRoot, console: false }).child('module:catalog'),
    modrinth: client,
    mods: () => mods,
    allowInsecureHosts: ['127.0.0.1'],
    emit: (event, payload) => events.push({ event, payload }),
    openExternal: (url) => {
      opened.push(url)
    },
  })
  fixture = { server, service, mods, mcRoot, dataRoot, gameDir, oldBytes, newBytes, events, opened }
  return fixture
}

beforeEach(() => {
  fixture = null
})

afterEach(async () => {
  if (fixture) {
    await fixture.server.close()
    fs.rmSync(fixture.mcRoot, { recursive: true, force: true })
    fs.rmSync(fixture.dataRoot, { recursive: true, force: true })
  }
  fixture = null
})

describe('catalog search', () => {
  it('filters Modrinth by query/loader/game version, paginates and caches', async () => {
    const h = await setup()
    const first = await h.service.search({
      query: 'sodium',
      loaders: ['fabric'],
      gameVersion: '1.20.1',
      projectType: 'mod',
      limit: 20,
      offset: 0,
    })
    expect(first.hits[0]).toMatchObject({
      projectId: 'P',
      slug: 'sodium',
      title: 'Sodium',
      projectType: 'mod',
      pageUrl: 'https://modrinth.com/mod/sodium',
    })
    expect(first.total).toBe(1)
    expect(first.cached).toBe(false)
    const request = h.server.requests.find((entry) => entry.path === '/v2/search')
    expect(request?.headers['user-agent']).toContain('mc-launcher/')
    const requestUrl = new URL(request!.url)
    const facets = JSON.parse(requestUrl.searchParams.get('facets') ?? '[]') as string[][]
    expect(facets).toContainEqual(['project_type:mod'])
    expect(facets).toContainEqual(['categories:fabric'])
    expect(facets).toContainEqual(['versions:1.20.1'])
    expect(requestUrl.searchParams.get('query')).toBe('sodium')

    const second = await h.service.search({
      query: 'sodium',
      loaders: ['fabric'],
      gameVersion: '1.20.1',
      projectType: 'mod',
      limit: 20,
      offset: 0,
    })
    expect(second.cached).toBe(true)
    expect(h.server.count('/v2/search')).toBe(1)

    await h.service.search({
      query: 'sodium',
      loaders: [],
      projectType: 'mod',
      limit: 20,
      offset: 20,
    })
    expect(h.server.count('/v2/search')).toBe(2)
  })

  it('spaces API requests according to the 300 rpm limit', async () => {
    const h = await setup()
    const client = new ModrinthClient({
      apiBase: `${h.server.baseUrl}/v2`,
      minIntervalMs: 80,
      allowInsecureHosts: ['127.0.0.1'],
      retries: 0,
    })
    const started = Date.now()
    await client.search({
      query: 'first',
      loaders: [],
      projectType: 'mod',
      limit: 1,
      offset: 0,
    })
    await client.search({
      query: 'second',
      loaders: [],
      projectType: 'mod',
      limit: 1,
      offset: 0,
    })
    expect(Date.now() - started).toBeGreaterThanOrEqual(60)
  })

  it('returns project details and versions', async () => {
    const h = await setup()
    const project = await h.service.project({ idOrSlug: 'P' })
    expect(project.title).toBe('Sodium')
    const versions = await h.service.versions({ projectId: 'P', gameVersion: '1.20.1', loader: 'fabric' })
    expect(versions.map((entry) => entry.id)).toEqual(['v2', 'v1'])
    expect(versions[0].files[0].sha512).toMatch(/^[a-f0-9]{128}$/)
  })
})

describe('catalog install', () => {
  it('downloads a compatible version, verifies hashes and installs into the instance', async () => {
    const h = await setup()
    const result = await h.service.install({
      instanceId: '1.20.1',
      projectId: 'P',
      versionId: 'v2',
      allowPrerelease: false,
    })
    expect(result.versionId).toBe('v2')
    expect(result.targetPath).toBe(path.join(h.gameDir, 'mods', 'sodium-v2.jar'))
    expect(fs.readFileSync(result.targetPath)).toEqual(h.newBytes)
    expect(h.mods.installs).toHaveLength(1)
    expect(h.events.some((event) => event.event === 'installProgress')).toBe(true)
  })

  it('requires explicit opt-in for beta/alpha versions', async () => {
    const h = await setup({
      latestVersion: version('v2', Buffer.from('new-sodium'), ['1.20.1'], ['fabric'], 'beta'),
    })
    await expect(
      h.service.install({ instanceId: '1.20.1', projectId: 'P', versionId: 'v2', allowPrerelease: false }),
    ).rejects.toMatchObject({ code: 'CATALOG.PRERELEASE' })
    const installed = await h.service.install({
      instanceId: '1.20.1',
      projectId: 'P',
      versionId: 'v2',
      allowPrerelease: true,
    })
    expect(installed.versionType).toBe('beta')
    expect(installed.warnings.join('\n')).toContain('beta')
  })

  it('rejects incompatible versions and hash mismatches', async () => {
    const h = await setup()
    const incompatible = await setup({ latestVersion: version('v2', Buffer.from('x'), ['1.21'], ['fabric']) })
    await expect(
      incompatible.service.install({
        instanceId: '1.20.1',
        projectId: 'P',
        versionId: 'v2',
        allowPrerelease: false,
      }),
    ).rejects.toMatchObject({ code: 'CATALOG.INCOMPATIBLE' })
    await incompatible.server.close()
    fs.rmSync(incompatible.mcRoot, { recursive: true, force: true })
    fs.rmSync(incompatible.dataRoot, { recursive: true, force: true })
    fixture = h

    const bad = await setup()
    const latest = version('v2', Buffer.from('other'))
    latest.files[0].url = `${bad.server.baseUrl}/files/sodium-bad.jar`
    latest.files[0].hashes.sha512 = 'f'.repeat(128)
    bad.server.bytes('/files/sodium-bad.jar', Buffer.from('xxxxx'))
    bad.server.json('/v2/version/v2', latest)
    await expect(
      bad.service.install({ instanceId: '1.20.1', projectId: 'P', versionId: 'v2', allowPrerelease: false }),
    ).rejects.toMatchObject({ code: 'CATALOG.HASH_MISMATCH' })
    expect(bad.mods.installs).toHaveLength(0)
  })
})

describe('catalog update check/update', () => {
  it('finds an update, includes changelog, and moves the old file to the recycle bin', async () => {
    const h = await setup()
    const check = await h.service.checkUpdates({ instanceId: '1.20.1', includeDisabled: false })
    expect(check.checked).toBe(1)
    expect(check.matched).toBe(1)
    expect(check.updates).toHaveLength(1)
    expect(check.updates[0]).toMatchObject({
      projectId: 'P',
      currentFile: 'sodium.jar',
      latestVersionId: 'v2',
      risk: 'ok',
    })
    expect(check.updates[0].changelogSummary).toContain('faster')
    expect(h.events.some((event) => event.event === 'checkProgress')).toBe(true)

    const result = await h.service.update({
      instanceId: '1.20.1',
      projectId: 'P',
      versionId: 'v2',
      currentFile: 'sodium.jar',
      allowPrerelease: false,
    })
    expect(result.previousFile).toBe('sodium.jar')
    expect(result.recycledPath).not.toBeNull()
    expect(fs.existsSync(path.join(h.gameDir, 'mods', 'sodium.jar'))).toBe(false)
    expect(fs.existsSync(result.recycledPath!)).toBe(true)
    expect(fs.readFileSync(result.targetPath)).toEqual(h.newBytes)
  })

  it('blocks incompatible updates and preserves a disabled state', async () => {
    const h = await setup({ mods: [modFile('sodium.jar', false)] })
    const blocked = await setup({
      mods: [modFile('sodium.jar')],
      latestVersion: version('v2', Buffer.from('x'), ['1.21'], ['fabric']),
    })
    const blockedLatest = version('v2', Buffer.from('x'), ['1.21'], ['fabric'])
    blockedLatest.files[0].url = `${blocked.server.baseUrl}/files/sodium-new.jar`
    const blockedCurrent = version('v1', blocked.oldBytes, ['1.21'], ['fabric'])
    blockedCurrent.files[0].url = `${blocked.server.baseUrl}/files/sodium-old.jar`
    blocked.server.json('/v2/project/P/version', [blockedLatest, blockedCurrent])
    blocked.server.json(`/v2/version_file/${sha1(blocked.oldBytes)}`, blockedCurrent)
    const check = await blocked.service.checkUpdates({ instanceId: '1.20.1', includeDisabled: false })
    expect(check.updates[0]?.risk).toBe('blocked')
    await expect(
      blocked.service.update({
        instanceId: '1.20.1',
        projectId: 'P',
        versionId: 'v2',
        currentFile: 'sodium.jar',
        allowPrerelease: false,
      }),
    ).rejects.toMatchObject({ code: 'CATALOG.INCOMPATIBLE' })
    await blocked.server.close()
    fs.rmSync(blocked.mcRoot, { recursive: true, force: true })
    fs.rmSync(blocked.dataRoot, { recursive: true, force: true })
    fixture = h

    const disabledCheck = await h.service.checkUpdates({ instanceId: '1.20.1', includeDisabled: true })
    expect(disabledCheck.updates[0]?.currentEnabled).toBe(false)
    const result = await h.service.update({
      instanceId: '1.20.1',
      projectId: 'P',
      versionId: 'v2',
      currentFile: 'sodium.jar.disabled',
      allowPrerelease: false,
    })
    expect(result.targetPath.endsWith('.disabled')).toBe(true)
    expect(fs.existsSync(result.targetPath)).toBe(true)
  })
})

describe('CurseForge page-only boundary', () => {
  it('builds/open the CurseForge page without calling its API', async () => {
    const h = await setup()
    const page = await h.service.pageUrl({ provider: 'curseforge', slug: 'jei' })
    expect(page.url).toBe('https://www.curseforge.com/minecraft/mc-mods/jei')
    expect(page.opened).toBe(false)
    expect(h.server.requests).toHaveLength(0)
    const opened = await h.service.openPage({ provider: 'curseforge', slug: 'jei' })
    expect(opened.opened).toBe(true)
    expect(h.opened).toEqual(['https://www.curseforge.com/minecraft/mc-mods/jei'])
  })
})

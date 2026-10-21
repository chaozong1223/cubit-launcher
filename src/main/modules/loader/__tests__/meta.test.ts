import fs from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LoaderHttp } from '../core/http'
import {
  fetchInstallerSha1,
  fetchLoaderProfile,
  listLoaderVersions,
  parseFabricList,
  parseForgeList,
  parseMavenMetadataVersions,
  parseNeoForgeList,
  parseNeoForgeMavenVersions,
  parseSha1Text,
  predictVersionId,
  selectVersion,
  buildForgeInstaller,
  buildNeoForgeInstaller,
  type LoaderEndpoints,
  type MetaDeps,
} from '../core/meta'
import { localEndpoints, startServer, tempDir, type TestServer } from './support/harness'

let server: TestServer | null = null
let cacheDir = ''

beforeEach(() => {
  server = null
  cacheDir = tempDir('mcl-loader-meta-')
})

afterEach(async () => {
  if (server) await server.close()
  fs.rmSync(cacheDir, { recursive: true, force: true })
  server = null
})

const FABRIC_LIST = JSON.stringify([
  { loader: { version: '0.16.10', stable: true } },
  { loader: { version: '0.17.0-beta.1', stable: false } },
  { loader: { version: '0.15.0', stable: true } },
])

function deps(endpoints: LoaderEndpoints): MetaDeps {
  const http = new LoaderHttp({
    userAgent: 'mc-launcher/0.1.0 (+https://example.test; test@example.test)',
    allowInsecureHosts: ['127.0.0.1'],
  })
  return { http, endpoints, cacheDir }
}

describe('metadata parsers', () => {
  it('parses Fabric lists and selects the newest stable version', () => {
    const versions = parseFabricList(JSON.parse(FABRIC_LIST))
    expect(versions).toHaveLength(3)
    const selected = selectVersion(versions, undefined)
    expect(selected?.version).toBe('0.16.10')
    expect(selected?.recommended).toBe(true)
    const explicit = selectVersion(versions, '0.15.0')
    expect(explicit?.version).toBe('0.15.0')
    expect(selectVersion(versions, '9.9.9')).toBeNull()
  })

  it('parses the Forge list including the installer sha1 and both URLs', () => {
    const endpoints: LoaderEndpoints = {
      fabricMeta: [],
      quiltMeta: [],
      forgeList: () => [],
      forgeMaven: ['https://bmclapi2.bangbang93.com/maven', 'https://maven.minecraftforge.net'],
      neoList: () => [],
      neoMaven: [],
    }
    const versions = parseForgeList(
      [
        {
          version: '47.2.0',
          mcversion: '1.20.1',
          build: 4702,
          files: [
            { format: 'txt', category: 'changelog', hash: 'a'.repeat(40) },
            { format: 'jar', category: 'installer', hash: '2bdc0e68530daf0af01cae44a05e7f84849bdc6e' },
          ],
        },
      ],
      '1.20.1',
      endpoints,
    )
    expect(versions).toHaveLength(1)
    expect(versions[0].version).toBe('47.2.0')
    expect(versions[0].installer).toMatchObject({
      url: 'https://maven.minecraftforge.net/net/minecraftforge/forge/1.20.1-47.2.0/forge-1.20.1-47.2.0-installer.jar',
      mirrorUrl:
        'https://bmclapi2.bangbang93.com/maven/net/minecraftforge/forge/1.20.1-47.2.0/forge-1.20.1-47.2.0-installer.jar',
      sha1: '2bdc0e68530daf0af01cae44a05e7f84849bdc6e',
      hashSource: 'list',
    })
  })

  it('parses maven metadata and NeoForge version mapping (no hardcoding)', () => {
    const xml =
      '<metadata><versioning><versions>' +
      '<version>20.2.88</version><version>20.2.89</version><version>20.4.170</version>' +
      '<version>21.1.263</version><version>1.20.1-47.1.106</version>' +
      '</versions></versioning></metadata>'
    expect(parseMavenMetadataVersions(xml)).toEqual([
      '20.2.88',
      '20.2.89',
      '20.4.170',
      '21.1.263',
      '1.20.1-47.1.106',
    ])
    // 20.2.x → 1.20.2, 20.4.x → 1.20.4, 21.1.x → 1.21.1 (t6 mapping).
    expect(parseNeoForgeMavenVersions(parseMavenMetadataVersions(xml), '1.20.2').map((v) => v.version)).toEqual([
      '20.2.88',
      '20.2.89',
    ])
    expect(parseNeoForgeMavenVersions(parseMavenMetadataVersions(xml), '1.21.1').map((v) => v.version)).toEqual([
      '21.1.263',
    ])
  })

  it('parses the NeoForge 1.20.1 list (rawVersion/version, mixed shapes)', () => {
    const pairs = parseNeoForgeList(
      [
        { rawVersion: '1.20.1-47.1.106', version: '47.1.106', mcversion: '1.20.1' },
        { rawVersion: '1.20.1-forge-47.1.105', version: '1.20.1-47.1.105', mcversion: '1.20.1' },
        { rawVersion: '1.20.1-47.1.5', version: '47.1.5', mcversion: '1.20.1' },
        { rawVersion: '1.20.4-20.4.170', version: '20.4.170', mcversion: '1.20.4' },
      ],
      '1.20.1',
    )
    expect(pairs.map((pair) => pair.version)).toEqual(['47.1.106', '47.1.105', '47.1.5'])
  })

  it('builds installer URLs for all loader artifacts', () => {
    const endpoints: LoaderEndpoints = {
      fabricMeta: [],
      quiltMeta: [],
      forgeList: () => [],
      forgeMaven: ['https://mirror/maven', 'https://official'],
      neoList: () => [],
      neoMaven: ['https://mirror/maven', 'https://official'],
    }
    expect(buildForgeInstaller('1.20.1-47.2.0', null, endpoints, 'none').url).toBe(
      'https://official/net/minecraftforge/forge/1.20.1-47.2.0/forge-1.20.1-47.2.0-installer.jar',
    )
    expect(buildNeoForgeInstaller('1.20.1', '47.1.106', endpoints).url).toBe(
      'https://official/net/neoforged/forge/1.20.1-47.1.106/forge-1.20.1-47.1.106-installer.jar',
    )
    expect(buildNeoForgeInstaller('1.20.2', '20.2.88', endpoints).url).toBe(
      'https://official/net/neoforged/neoforge/20.2.88/neoforge-20.2.88-installer.jar',
    )
    expect(predictVersionId('fabric', '1.20.1', '0.16.10')).toBe('fabric-loader-0.16.10-1.20.1')
    expect(predictVersionId('quilt', '1.20.1', '0.24.0')).toBe('quilt-loader-0.24.0-1.20.1')
    expect(predictVersionId('forge', '1.20.1', '47.2.0')).toBe('1.20.1-forge-47.2.0')
    expect(predictVersionId('neoforge', '1.20.1', '47.1.106')).toBe('1.20.1-neoforge-47.1.106')
    expect(predictVersionId('neoforge', '1.20.2', '20.2.88')).toBe('neoforge-20.2.88')
  })

  it('parses .sha1 sidecar text', () => {
    expect(parseSha1Text('2bdc0e68530daf0af01cae44a05e7f84849bdc6e\n')).toBe(
      '2bdc0e68530daf0af01cae44a05e7f84849bdc6e',
    )
    expect(parseSha1Text('not a hash')).toBeNull()
  })
})

describe('metadata fetching + cache', () => {
  it('fetches Fabric versions through the mirror and caches for 10 minutes', async () => {
    const local = await startServer()
    server = local
    local.serveText('/fabric-meta/v2/versions/loader/1.20.1', FABRIC_LIST)

    const meta = deps(localEndpoints(local))
    const first = await listLoaderVersions(meta, 'fabric', '1.20.1')
    expect(first.source).toBe('mirror')
    expect(first.versions.find((entry) => entry.recommended)?.version).toBe('0.16.10')
    expect(first.versions.find((entry) => entry.version === '0.17.0-beta.1')?.stable).toBe(false)
    expect(local.count('/fabric-meta/v2/versions/loader/1.20.1')).toBe(1)

    const second = await listLoaderVersions(meta, 'fabric', '1.20.1')
    expect(local.count('/fabric-meta/v2/versions/loader/1.20.1')).toBe(1)
    expect(second.fetchedAt).toBe(first.fetchedAt)

    await listLoaderVersions(meta, 'fabric', '1.20.1', { force: true })
    expect(local.count('/fabric-meta/v2/versions/loader/1.20.1')).toBe(2)
  })

  it('fetches a Fabric profile and rejects a mismatched inheritsFrom', async () => {
    const local = await startServer()
    server = local
    const profile = {
      id: 'fabric-loader-0.16.10-1.20.1',
      inheritsFrom: '1.20.1',
      mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotClient',
      libraries: [],
    }
    local.serveText(
      '/fabric-meta/v2/versions/loader/1.20.1/0.16.10/profile/json',
      JSON.stringify(profile),
    )
    const meta = deps(localEndpoints(local))
    const fetched = await fetchLoaderProfile(meta, 'fabric', '1.20.1', '0.16.10')
    expect(fetched.json.id).toBe(profile.id)

    local.serveText(
      '/fabric-meta/v2/versions/loader/1.20.1/0.16.11/profile/json',
      JSON.stringify({ ...profile, inheritsFrom: '1.20.4' }),
    )
    await expect(fetchLoaderProfile(meta, 'fabric', '1.20.1', '0.16.11')).rejects.toMatchObject({
      code: 'LOADER.PROFILE_INVALID',
    })
  })

  it('reads the official installer .sha1 and returns null when absent', async () => {
    const local = await startServer()
    server = local
    const installer = buildForgeInstaller(
      '1.20.1-47.2.0',
      null,
      localEndpoints(local),
      'none',
    )
    local.serveText(
      '/official-maven/net/minecraftforge/forge/1.20.1-47.2.0/forge-1.20.1-47.2.0-installer.jar.sha1',
      `${'f'.repeat(40)}\n`,
    )
    const meta = deps(localEndpoints(local))
    expect(await fetchInstallerSha1(meta, installer)).toEqual({
      sha1: 'f'.repeat(40),
      source: 'official',
    })

    const neo = buildNeoForgeInstaller('1.20.1', '47.1.106', localEndpoints(local))
    expect(await fetchInstallerSha1(meta, neo, { allowMirror: true, timeoutMs: 1_500 })).toBeNull()
  })
})

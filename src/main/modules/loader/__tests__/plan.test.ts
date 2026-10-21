import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { nodeFsPort } from '../../../core/ports'
import { LoaderHttp } from '../core/http'
import type { MetaDeps } from '../core/meta'
import { assertVersionIdSafe, buildLoaderPlan } from '../core/plan'
import {
  fabricProfile,
  localEndpoints,
  startServer,
  tempDir,
  writeVanilla,
  type TestServer,
} from './support/harness'

let server: TestServer | null = null
let cacheDir = ''
let mcRoot = ''

beforeEach(() => {
  cacheDir = tempDir('mcl-loader-plan-cache-')
  mcRoot = tempDir('mcl-loader-plan-mc-')
  server = null
})

afterEach(async () => {
  if (server) await server.close()
  fs.rmSync(cacheDir, { recursive: true, force: true })
  fs.rmSync(mcRoot, { recursive: true, force: true })
  server = null
})

async function setup(): Promise<{ local: TestServer; deps: MetaDeps }> {
  const local = await startServer()
  server = local
  const http = new LoaderHttp({
    userAgent: 'mc-launcher/0.1.0 (+https://example.test; test@example.test)',
    allowInsecureHosts: ['127.0.0.1'],
  })
  return { local, deps: { http, endpoints: localEndpoints(local), cacheDir } }
}

const FABRIC_LIST = JSON.stringify([
  { loader: { version: '0.16.10', stable: true } },
  { loader: { version: '0.17.0-beta.1', stable: false } },
])

describe('buildLoaderPlan', () => {
  it('plans a Fabric install from meta only (no installer, id comes from profile)', async () => {
    const { local, deps } = await setup()
    writeVanilla(mcRoot)
    local.serveText('/fabric-meta/v2/versions/loader/1.20.1', FABRIC_LIST)
    local.serveText(
      '/fabric-meta/v2/versions/loader/1.20.1/0.16.10/profile/json',
      JSON.stringify(fabricProfile('0.16.10')),
    )

    const result = await buildLoaderPlan(deps, nodeFsPort(), mcRoot, {
      type: 'fabric',
      mcVersion: '1.20.1',
    })
    expect(result.plan).toMatchObject({
      type: 'fabric',
      mcVersion: '1.20.1',
      loaderVersion: '0.16.10',
      versionId: 'fabric-loader-0.16.10-1.20.1',
      method: 'meta-json',
      installer: null,
      requiredJavaMajor: 17,
      parentInstalled: true,
      libraries: 2,
    })
    expect(result.profile?.id).toBe('fabric-loader-0.16.10-1.20.1')
  })

  it('marks a missing parent and keeps it as a warning (install refuses later)', async () => {
    const { local, deps } = await setup()
    local.serveText('/fabric-meta/v2/versions/loader/1.20.1', FABRIC_LIST)
    local.serveText(
      '/fabric-meta/v2/versions/loader/1.20.1/0.16.10/profile/json',
      JSON.stringify(fabricProfile('0.16.10')),
    )
    const result = await buildLoaderPlan(deps, nodeFsPort(), mcRoot, {
      type: 'fabric',
      mcVersion: '1.20.1',
    })
    expect(result.plan.parentInstalled).toBe(false)
    expect(result.plan.warnings.join('\n')).toContain('原版 1.20.1 尚未安装')
  })

  it('resolves the Forge installer hash from the official .sha1', async () => {
    const { local, deps } = await setup()
    writeVanilla(mcRoot)
    local.serveText(
      '/forge/1.20.1',
      JSON.stringify([
        {
          version: '47.2.0',
          mcversion: '1.20.1',
          build: 4702,
          files: [
            { format: 'jar', category: 'installer', hash: '2bdc0e68530daf0af01cae44a05e7f84849bdc6e' },
          ],
        },
      ]),
    )
    local.serveText(
      '/official-maven/net/minecraftforge/forge/1.20.1-47.2.0/forge-1.20.1-47.2.0-installer.jar.sha1',
      `${'9'.repeat(40)}\n`,
    )
    const result = await buildLoaderPlan(deps, nodeFsPort(), mcRoot, {
      type: 'forge',
      mcVersion: '1.20.1',
    })
    expect(result.plan).toMatchObject({
      type: 'forge',
      loaderVersion: '47.2.0',
      versionId: '1.20.1-forge-47.2.0',
      method: 'installer',
      requiredJavaMajor: 17,
      parentInstalled: true,
    })
    expect(result.plan.installer).toMatchObject({
      sha1: '9'.repeat(40),
      hashSource: 'official',
      fileName: 'forge-1.20.1-47.2.0-installer.jar',
    })
    expect(result.plan.warnings.join('\n')).toContain('官方安装器哈希与镜像列表不一致')
  })

  it('plans NeoForge 1.20.1 via net.neoforged:forge and reports no hash', async () => {
    const { local, deps } = await setup()
    writeVanilla(mcRoot)
    local.serveText(
      '/neoforge/1.20.1',
      JSON.stringify([{ rawVersion: '1.20.1-47.1.106', version: '47.1.106', mcversion: '1.20.1' }]),
    )
    const result = await buildLoaderPlan(deps, nodeFsPort(), mcRoot, {
      type: 'neoforge',
      mcVersion: '1.20.1',
    })
    expect(result.plan.versionId).toBe('1.20.1-neoforge-47.1.106')
    expect(result.plan.installer?.url).toBe(
      `${local.baseUrl}/official-maven/net/neoforged/forge/1.20.1-47.1.106/forge-1.20.1-47.1.106-installer.jar`,
    )
    expect(result.plan.installer?.sha1).toBeNull()
    expect(result.plan.installer?.hashSource).toBe('none')
    expect(result.plan.warnings.join('\n')).toContain('明确确认风险')
  })

  it('plans NeoForge 1.20.2 via the neoforge artifact and maven metadata', async () => {
    const { local, deps } = await setup()
    writeVanilla(mcRoot, '1.20.2')
    const xml =
      '<metadata><versioning><versions>' +
      '<version>20.2.88</version><version>20.4.170</version>' +
      '</versions></versioning></metadata>'
    local.serveText('/neoforge/1.20.2', xml)
    const result = await buildLoaderPlan(deps, nodeFsPort(), mcRoot, {
      type: 'neoforge',
      mcVersion: '1.20.2',
    })
    expect(result.plan.loaderVersion).toBe('20.2.88')
    expect(result.plan.versionId).toBe('neoforge-20.2.88')
    expect(result.plan.installer?.url).toContain(
      '/official-maven/net/neoforged/neoforge/20.2.88/neoforge-20.2.88-installer.jar',
    )
  })

  it('rejects unsafe version ids and unknown loader versions', async () => {
    expect(() => assertVersionIdSafe('../evil')).toThrowError(/unsafe version id/)
    const { local, deps } = await setup()
    writeVanilla(mcRoot)
    local.serveText('/fabric-meta/v2/versions/loader/1.20.1', FABRIC_LIST)
    await expect(
      buildLoaderPlan(deps, nodeFsPort(), mcRoot, {
        type: 'fabric',
        mcVersion: '1.20.1',
        loaderVersion: '9.9.9',
      }),
    ).rejects.toMatchObject({ code: 'LOADER.VERSION_NOT_FOUND' })
  })

  it('rejects an unsafe mcVersion before any request', async () => {
    const { deps } = await setup()
    await expect(
      buildLoaderPlan(deps, nodeFsPort(), mcRoot, { type: 'fabric', mcVersion: '../1.20.1' }),
    ).rejects.toMatchObject({ code: 'LOADER.INVALID_INPUT' })
  })
})

describe('parent java requirement', () => {
  it('uses the parent JSON javaVersion when present', async () => {
    const { local, deps } = await setup()
    writeVanilla(mcRoot)
    const jsonPath = path.join(mcRoot, 'versions', '1.20.1', '1.20.1.json')
    const json = JSON.parse(fs.readFileSync(jsonPath, 'utf8')) as Record<string, unknown>
    json.javaVersion = { component: 'jdk', majorVersion: 21 }
    fs.writeFileSync(jsonPath, JSON.stringify(json))
    local.serveText('/fabric-meta/v2/versions/loader/1.20.1', FABRIC_LIST)
    local.serveText(
      '/fabric-meta/v2/versions/loader/1.20.1/0.16.10/profile/json',
      JSON.stringify(fabricProfile('0.16.10')),
    )
    const result = await buildLoaderPlan(deps, nodeFsPort(), mcRoot, {
      type: 'fabric',
      mcVersion: '1.20.1',
    })
    expect(result.plan.requiredJavaMajor).toBe(21)
  })
})

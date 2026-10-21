import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { nodeFsPort } from '../../../core/ports'
import { LoaderHttp, sha1File } from '../core/http'
import {
  defaultEndpoints,
  fetchLoaderProfile,
  listLoaderVersions,
  selectVersion,
  type MetaDeps,
} from '../core/meta'
import { buildLoaderPlan } from '../core/plan'
import { tempDir, writeVanilla } from './support/harness'

/**
 * Opt-in real-endpoint evidence (MCL_REAL_LOADER=1).
 *
 *   $env:MCL_REAL_LOADER='1'; npm.cmd --prefix mc-launcher run test -- \
 *       src/main/modules/loader/__tests__/real-meta.test.ts
 *
 * It fetches loader metadata and one real Forge installer jar (≈6 MB, SHA1
 * verified) but does not execute anything.
 */

const enabled = process.env.MCL_REAL_LOADER === '1'
const real = enabled ? describe : describe.skip

let root = ''
let cacheDir = ''
let mcRoot = ''
let http: LoaderHttp

function deps(): MetaDeps {
  return { http, endpoints: defaultEndpoints(), cacheDir, now: Date.now }
}

beforeAll(() => {
  if (!enabled) return
  root = tempDir('mcl-loader-real-')
  cacheDir = path.join(root, 'cache')
  mcRoot = path.join(root, 'mc')
  fs.mkdirSync(mcRoot, { recursive: true })
  writeVanilla(mcRoot)
  http = new LoaderHttp({
    userAgent: 'mc-launcher/0.1.0 (+https://github.com/mc-launcher; test@example.test)',
  })
})

afterAll(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true })
})

real('real loader metadata (2026-10-21)', () => {
  it('lists Fabric loaders and downloads a complete profile (inheritsFrom)', async () => {
    const list = await listLoaderVersions(deps(), 'fabric', '1.20.1')
    expect(list.source).toBe('mirror')
    expect(list.versions.length).toBeGreaterThan(20)
    const entry = selectVersion(list.versions, undefined)
    expect(entry).not.toBeNull()
    const profile = await fetchLoaderProfile(deps(), 'fabric', '1.20.1', entry!.version)
    expect(profile.json.inheritsFrom).toBe('1.20.1')
    expect(String(profile.json.id)).toMatch(/^fabric-loader-/)
    expect(String(profile.json.mainClass)).toContain('KnotClient')
    expect(Array.isArray(profile.json.libraries)).toBe(true)
    expect((profile.json.libraries as unknown[]).length).toBeGreaterThan(3)
  }, 120_000)

  it('lists Quilt loaders and fetches its profile from the official v3 meta', async () => {
    const list = await listLoaderVersions(deps(), 'quilt', '1.20.1')
    expect(list.versions.length).toBeGreaterThan(20)
    const entry = selectVersion(list.versions, undefined)
    const profile = await fetchLoaderProfile(deps(), 'quilt', '1.20.1', entry!.version)
    expect(profile.json.inheritsFrom).toBe('1.20.1')
    expect(String(profile.json.id)).toMatch(/^quilt-loader-/)
    expect(String(profile.json.mainClass)).toContain('KnotClient')
  }, 180_000)

  it('lists Forge versions and resolves the official installer sha1', async () => {
    const list = await listLoaderVersions(deps(), 'forge', '1.20.1')
    expect(list.versions.length).toBeGreaterThan(10)
    const plan = await buildLoaderPlan(deps(), nodeFsPort(), mcRoot, {
      type: 'forge',
      mcVersion: '1.20.1',
    })
    expect(plan.plan.method).toBe('installer')
    expect(plan.plan.installer?.url).toContain('maven.minecraftforge.net/net/minecraftforge/forge/')
    expect(plan.plan.installer?.sha1).toMatch(/^[a-f0-9]{40}$/)
    // Official maven can be slow; the BMCLAPI list already carries Forge's own
    // installer sha1, so either source is an upstream-trustworthy hash.
    expect(['official', 'list']).toContain(plan.plan.installer?.hashSource)
    expect(plan.plan.versionId).toMatch(/^1\.20\.1-forge-/)
  }, 120_000)

  it('lists NeoForge 1.20.1 versions through the neoforged:forge artifact', async () => {
    const list = await listLoaderVersions(deps(), 'neoforge', '1.20.1')
    expect(list.versions.length).toBeGreaterThan(10)
    const plan = await buildLoaderPlan(deps(), nodeFsPort(), mcRoot, {
      type: 'neoforge',
      mcVersion: '1.20.1',
    })
    expect(plan.plan.installer?.url).toContain('net/neoforged/forge/1.20.1-')
    expect(plan.plan.loaderVersion).toMatch(/^47\.1\.\d+$/)
    expect(plan.plan.versionId).toMatch(/^1\.20\.1-neoforge-/)
    expect(plan.plan.installer?.url).toContain(`1.20.1-${plan.plan.loaderVersion}/`)
    // Hash availability depends on maven.neoforged.net reachability; either a
    // verified sha1 or the explicit "none + consent" path is acceptable.
    if (plan.plan.installer?.sha1) {
      expect(plan.plan.installer.sha1).toMatch(/^[a-f0-9]{40}$/)
      expect(['official', 'mirror']).toContain(plan.plan.installer.hashSource)
    } else {
      expect(plan.plan.installer?.hashSource).toBe('none')
      expect(plan.plan.warnings.join('\n')).toContain('明确确认风险')
    }
  }, 120_000)

  it('downloads a real Forge installer and verifies its SHA1', async () => {
    const plan = await buildLoaderPlan(deps(), nodeFsPort(), mcRoot, {
      type: 'forge',
      mcVersion: '1.20.1',
    })
    const installer = plan.plan.installer!
    expect(installer.sha1).toMatch(/^[a-f0-9]{40}$/)
    const dest = path.join(root, 'cache', 'installers', installer.fileName)
    // Evidence run: official maven is deterministic here; production tries the
    // mirror first (exercised by the local HTTP tests).
    const result = await http.download([{ url: installer.url, source: 'official' }], {
      dest,
      sha1: installer.sha1,
      hashPinned: true,
      retries: 1,
    })
    expect(result.bytes).toBeGreaterThan(1_000_000)
    expect(await sha1File(dest)).toBe(installer.sha1)
  }, 240_000)
})

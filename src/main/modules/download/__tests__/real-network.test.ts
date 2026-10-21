import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { HttpClient } from '../core/http'
import { fetchAssetIndex, fetchVersionJson, findManifestVersion, loadManifest } from '../core/manifest'
import { buildInstallPlan, buildLoggingTask } from '../core/plan'
import { runTasks } from '../core/queue'
import { createSourceRegistry, mirrorUrlFor } from '../core/sources'
import { sha1 } from './support/http-server'
import type { VersionJson } from '../../../core/version/types'

/**
 * Opt-in evidence run against the real Mojang/BMCLAPI endpoints (01 §3.5).
 *
 *   $env:MCL_REAL_DOWNLOAD='1'; npm.cmd --prefix mc-launcher run test -- \
 *       src/main/modules/download/__tests__/real-network.test.ts
 *
 * It only downloads metadata plus two tiny files (one asset object and the
 * logging config), never the 700 MiB footprint. Everything is written to a
 * temp directory created in `beforeAll` so a run can never pollute the repo.
 */

const enabled = process.env.MCL_REAL_DOWNLOAD === '1'
const real = enabled ? describe : describe.skip

let root = ''
let http: HttpClient
let sources: ReturnType<typeof createSourceRegistry>

function deps() {
  return { http, sources, cacheDir: path.join(root, 'cache') }
}

beforeAll(() => {
  if (!enabled) return
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcl-real-net-'))
  http = new HttpClient({
    userAgent: 'mc-launcher/0.1.0 (+https://github.com/mc-launcher; test@example.test)',
  })
  sources = createSourceRegistry({ preference: 'auto', mirrorEnabled: true })
})

afterAll(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true })
})

real('real endpoints (2026-10-21 evidence)', () => {
  it('reads version_manifest_v2 and finds 1.20.1', async () => {
    const loaded = await loadManifest(deps())
    // t42: the manifest has no upstream content hash, so metadata is
    // official-first; the mirror remains a fallback if official is unavailable.
    expect(loaded.result.source).toBe('official')
    expect(loaded.result.versions.length).toBeGreaterThan(500)
    const entry = findManifestVersion(loaded.raw, '1.20.1')
    expect(entry).not.toBeNull()
    expect(entry?.sha1).toBe('38d412af3b247e485c7f7e50ac25febc4e79ab1d')
    expect(entry?.url.startsWith('https://piston-meta.mojang.com/')).toBe(true)
  }, 120_000)

  it('downloads the version JSON with its manifest sha1 and extracts the footprint', async () => {
    const loaded = await loadManifest(deps())
    const entry = findManifestVersion(loaded.raw, '1.20.1')
    expect(entry).not.toBeNull()
    const fetched = await fetchVersionJson(entry!, { http, sources })
    expect(fetched.source).toBe('official')
    const version = fetched.json as unknown as VersionJson
    expect(version.id).toBe('1.20.1')
    expect(version.mainClass).toBe('net.minecraft.client.main.Main')
    expect(version.libraries).toHaveLength(88)
    expect(version.javaVersion?.majorVersion).toBe(17)
    expect(version.assetIndex).toMatchObject({ id: '5', size: 413067 })
    expect(version.downloads?.client?.size).toBe(23_028_853)
    expect(version.downloads?.client?.sha1).toBe('0c3ec587af28e5a785c0b4a7b8a30f9a8f78f838')

    const index = await fetchAssetIndex(
      {
        id: version.assetIndex!.id,
        url: version.assetIndex!.url,
        sha1: version.assetIndex!.sha1 ?? null,
        size: version.assetIndex!.size ?? null,
      },
      { http, sources },
    )
    // The index lists 3,598 entries; some names share a hash, so the install
    // footprint is 3,575 distinct object files (01 A1.4).
    expect(Object.keys(index.index.objects)).toHaveLength(3598)

    const plan = await buildInstallPlan({
      versionId: '1.20.1',
      mcRoot: root,
      version,
      assetIndex: index.index,
      platform: 'win32',
      arch: 'x64',
      stat: async () => null,
    })
    expect(plan.summary.libraries).toMatchObject({ total: 88, allowed: 64, files: 64, natives: 21 })
    expect(plan.summary.assets.objects).toBe(3575)
    expect(plan.summary.clientJar?.size).toBe(23_028_853)
    // 01 §5.2 R1.2: the Windows footprint is roughly 700 MiB.
    expect(plan.summary.bytes).toBeGreaterThan(690 * 1024 * 1024)
    expect(plan.summary.bytes).toBeLessThan(720 * 1024 * 1024)
  }, 180_000)

  it('downloads one real asset object from the mirror and the logging config from Mojang', async () => {
    const loaded = await loadManifest(deps())
    const entry = findManifestVersion(loaded.raw, '1.20.1')!
    const fetched = await fetchVersionJson(entry, { http, sources })
    const version = fetched.json as unknown as VersionJson
    const index = await fetchAssetIndex(
      {
        id: version.assetIndex!.id,
        url: version.assetIndex!.url,
        sha1: version.assetIndex!.sha1 ?? null,
        size: version.assetIndex!.size ?? null,
      },
      { http, sources },
    )

    const [object] = Object.values(index.index.objects)
    const officialAssetUrl = `https://resources.download.minecraft.net/${object.hash.slice(0, 2)}/${object.hash}`
    const assetTask = {
      url: officialAssetUrl,
      mirrorUrl: mirrorUrlFor(officialAssetUrl),
      destRel: `assets/objects/${object.hash.slice(0, 2)}/${object.hash}`,
      sha1: object.hash,
      size: object.size,
      priority: 3,
      sourceHint: 'auto' as const,
      unverified: false,
    }
    const loggingTask = buildLoggingTask({ version, warnings: [] })
    expect(loggingTask).not.toBeNull()
    expect(loggingTask?.mirrorUrl).toBeNull()

    const result = await runTasks([assetTask, loggingTask!], {
      root,
      http,
      sources,
      concurrency: 2,
      perHostConcurrency: 2,
      maxRetries: 3,
      verifyExisting: 'size',
    })

    expect(result.failures).toEqual([])
    expect(result.downloaded).toBe(2)
    expect(
      fs.existsSync(path.join(root, 'assets', 'objects', object.hash.slice(0, 2), object.hash)),
    ).toBe(true)
    expect(fs.existsSync(path.join(root, 'assets', 'log_configs', 'client-1.12.xml'))).toBe(true)
    expect(sha1(fs.readFileSync(path.join(root, 'assets', 'log_configs', 'client-1.12.xml')))).toBe(
      'bd65e7d2e3c237be76cfbef4c2405033d7f91521',
    )
  }, 180_000)
})

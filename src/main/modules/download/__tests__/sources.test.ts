import { describe, expect, it } from 'vitest'
import {
  buildUserAgent,
  createSourceRegistry,
  describeCandidates,
  isDescriptiveUserAgent,
  mirrorClientJarUrl,
  mirrorUrlFor,
  MIRROR_BASE,
  SourceRegistry,
} from '../core/sources'

const OFFICIAL_LIB = 'https://libraries.minecraft.net/org/lwjgl/lwjgl/3.3.1/lwjgl-3.3.1.jar'
const OFFICIAL_ASSET = 'https://resources.download.minecraft.net/b6/b62ca8ec10d07e6bf5ac8dae0c8c1d2e6a1e3356'
const OFFICIAL_META = 'https://piston-meta.mojang.com/v1/packages/38d4/1.20.1.json'
const OFFICIAL_DATA = 'https://piston-data.mojang.com/v1/objects/bd65/client-1.12.xml'

describe('mirror mapping (docs/02 SRC-07, verified 2026-10-21)', () => {
  it('maps launchermeta / piston-meta path-preserving', () => {
    expect(mirrorUrlFor('https://launchermeta.mojang.com/mc/game/version_manifest_v2.json')).toBe(
      `${MIRROR_BASE}/mc/game/version_manifest_v2.json`,
    )
    expect(mirrorUrlFor(OFFICIAL_META)).toBe(
      `${MIRROR_BASE}/v1/packages/38d4/1.20.1.json`,
    )
  })

  it('maps libraries to /maven and assets to /assets', () => {
    expect(mirrorUrlFor(OFFICIAL_LIB)).toBe(
      `${MIRROR_BASE}/maven/org/lwjgl/lwjgl/3.3.1/lwjgl-3.3.1.jar`,
    )
    expect(mirrorUrlFor(OFFICIAL_ASSET)).toBe(
      `${MIRROR_BASE}/assets/b6/b62ca8ec10d07e6bf5ac8dae0c8c1d2e6a1e3356`,
    )
  })

  it('does not pretend to mirror piston-data objects (404 verified)', () => {
    expect(mirrorUrlFor(OFFICIAL_DATA)).toBeNull()
    expect(mirrorUrlFor('https://cdn.modrinth.com/data/a/b.jar')).toBeNull()
    expect(mirrorUrlFor('not a url')).toBeNull()
  })

  it('builds the version-scoped client mirror URL', () => {
    expect(mirrorClientJarUrl('1.20.1')).toBe(`${MIRROR_BASE}/version/1.20.1/client`)
    expect(mirrorClientJarUrl('中文 1.0')).toContain(encodeURIComponent('中文 1.0'))
  })

  it('honours a custom mirror base (self-hosted mirrors)', () => {
    expect(mirrorUrlFor(OFFICIAL_LIB, { base: 'https://mirror.example/' })).toBe(
      'https://mirror.example/maven/org/lwjgl/lwjgl/3.3.1/lwjgl-3.3.1.jar',
    )
  })
})

describe('User-Agent (docs/02 API-01)', () => {
  it('matches the documented format', () => {
    const ua = buildUserAgent({ version: '0.1.0' })
    expect(ua).toContain('mc-launcher/0.1.0 (+')
    expect(isDescriptiveUserAgent(ua)).toBe(true)
  })

  it('rejects opaque agents that get blocked by Modrinth', () => {
    expect(isDescriptiveUserAgent('okhttp/4.9.3')).toBe(false)
    expect(isDescriptiveUserAgent('')).toBe(false)
  })
})

describe('SourceRegistry (SRC-01/04/05/06)', () => {
  const makeRegistry = (patch: Partial<ConstructorParameters<typeof SourceRegistry>[0]> = {}) =>
    createSourceRegistry({
      preference: 'auto',
      mirrorEnabled: true,
      allowInsecureHosts: ['127.0.0.1'],
      ...patch,
    })

  it('defaults to mirror then official (docs/01 §3.5)', () => {
    expect(makeRegistry().order()).toEqual(['mirror', 'official'])
    expect(makeRegistry({ preference: 'official' }).order()).toEqual(['official'])
    expect(makeRegistry({ mirrorEnabled: false }).order()).toEqual(['official'])
  })

  it('metadata is official-first while files stay mirror-first (t42 trust anchor)', () => {
    const registry = makeRegistry()
    expect(registry.order('metadata')).toEqual(['official', 'mirror'])
    expect(registry.order('file')).toEqual(['mirror', 'official'])
    expect(
      registry
        .candidates({ url: OFFICIAL_META, mirrorUrl: null, sourceHint: 'auto' }, 'metadata')
        .map((candidate) => candidate.source),
    ).toEqual(['official', 'mirror'])
    expect(makeRegistry({ preference: 'mirror' }).order('metadata')).toEqual(['mirror', 'official'])
    expect(makeRegistry({ mirrorEnabled: false }).order('metadata')).toEqual(['official'])
  })

  it('produces candidates with a mirror override first and official fallback', () => {
    const registry = makeRegistry()
    const candidates = registry.candidates({
      url: OFFICIAL_LIB,
      mirrorUrl: null,
      sourceHint: 'auto',
    })
    expect(candidates).toHaveLength(2)
    expect(candidates[0]).toEqual({
      source: 'mirror',
      url: `${MIRROR_BASE}/maven/org/lwjgl/lwjgl/3.3.1/lwjgl-3.3.1.jar`,
    })
    expect(candidates[1]).toEqual({ source: 'official', url: OFFICIAL_LIB })
  })

  it('skips the mirror when the file has no mirror mapping', () => {
    const registry = makeRegistry()
    const candidates = registry.candidates({ url: OFFICIAL_DATA, mirrorUrl: null, sourceHint: 'auto' })
    expect(candidates).toEqual([{ source: 'official', url: OFFICIAL_DATA }])
  })

  it('respects a per-task source hint', () => {
    const registry = makeRegistry()
    const candidates = registry.candidates({ url: OFFICIAL_LIB, mirrorUrl: null, sourceHint: 'official' })
    expect(candidates[0].source).toBe('official')
    expect(candidates[1].source).toBe('mirror')
  })

  it('cools a source after three consecutive failures and switches to the other source (t46)', () => {
    const registry = makeRegistry()
    for (let i = 0; i < 3; i += 1) registry.recordFailure('mirror', 'ECONNRESET')
    expect(registry.isDisabled('mirror')).toBe(true)
    expect(registry.isDisabled('official')).toBe(false)
    expect(registry.candidates({ url: OFFICIAL_LIB, mirrorUrl: null, sourceHint: 'auto' })).toEqual([
      { source: 'official', url: OFFICIAL_LIB },
    ])
    const mirrorInfo = registry.info().find((info) => info.id === 'mirror')
    expect(mirrorInfo?.enabled).toBe(false)
    expect(mirrorInfo?.note).toContain('连续失败')
    expect(mirrorInfo?.note).toContain('冷却')
    expect(registry.availability({ url: OFFICIAL_LIB, mirrorUrl: null, sourceHint: 'auto' })).toMatchObject({
      network: false,
      cooling: ['mirror'],
    })
  })

  it('recovers a cooled source after the cooldown (t46)', () => {
    let now = 1_000
    const registry = makeRegistry({ cooldownMs: 100, now: () => now })
    for (let i = 0; i < 3; i += 1) registry.recordFailure('mirror', 'ETIMEDOUT')
    expect(registry.isDisabled('mirror')).toBe(true)
    expect(registry.candidates({ url: OFFICIAL_LIB, mirrorUrl: null, sourceHint: 'auto' }).map((c) => c.source)).toEqual([
      'official',
    ])

    now += 101
    expect(registry.isDisabled('mirror')).toBe(false)
    expect(registry.candidates({ url: OFFICIAL_LIB, mirrorUrl: null, sourceHint: 'auto' }).map((c) => c.source)).toEqual([
      'mirror',
      'official',
    ])
    registry.recordSuccess('mirror')
    expect(registry.isDisabled('mirror')).toBe(false)
    expect(registry.info().find((info) => info.id === 'mirror')?.enabled).toBe(true)
  })

  it('reports all applicable sources cooling as a network outage (t46)', () => {
    const registry = makeRegistry({ cooldownMs: 100, now: () => 1_000 })
    registry.recordFailure('mirror', 'ETIMEDOUT')
    registry.recordFailure('mirror', 'ETIMEDOUT')
    registry.recordFailure('mirror', 'ETIMEDOUT')
    registry.recordFailure('official', 'ETIMEDOUT')
    registry.recordFailure('official', 'ETIMEDOUT')
    registry.recordFailure('official', 'ETIMEDOUT')
    expect(registry.disabledSources()).toEqual(['mirror', 'official'])
    const availability = registry.availability({
      url: OFFICIAL_LIB,
      mirrorUrl: null,
      sourceHint: 'auto',
    })
    expect(availability).toMatchObject({
      network: true,
      cooling: ['mirror', 'official'],
    })
    expect(availability.retryAfterMs).toBe(100)
    expect(registry.candidates({ url: OFFICIAL_LIB, mirrorUrl: null, sourceHint: 'auto' })).toEqual([])
  })

  it('reports display names and homepages so the UI never hardcodes them (SRC-01)', () => {
    const info = makeRegistry().info()
    expect(info[0].displayName).toBe('BMCLAPI（bangbang93）')
    expect(info[0].homepage).toBe('https://bmclapi.bangbang93.com/')
    expect(info[1].displayName).toBe('Mojang 官方')
  })

  it('describes attempted candidates for DOWNLOAD.NO_SOURCE messages', () => {
    expect(describeCandidates([])).toBe('(无可用源)')
    expect(describeCandidates([{ source: 'official', url: 'https://x/y' }])).toContain('official:https://x/y')
  })
})

describe('redirect policy (SEC-DL-06)', () => {
  const registry = createSourceRegistry({
    preference: 'auto',
    mirrorEnabled: true,
    extraRedirectHosts: ['cdn.example.net'],
  })

  it('allows the mirror to redirect to its own CDN', () => {
    expect(
      registry.isRedirectAllowed(
        'mirror',
        new URL('https://bmclapi2.bangbang93.com/maven/x'),
        new URL('https://bmclapi9.sakura.sld.tw:443/download/x'),
      ),
    ).toBe(true)
  })

  it('allows extra configured CDN hosts only for the mirror', () => {
    expect(
      registry.isRedirectAllowed('mirror', new URL('https://a/'), new URL('https://cdn.example.net/x')),
    ).toBe(true)
    expect(
      registry.isRedirectAllowed('official', new URL('https://a/'), new URL('https://cdn.example.net/x')),
    ).toBe(false)
  })

  it('rejects redirects to unrelated hosts and plain http', () => {
    expect(
      registry.isRedirectAllowed('mirror', new URL('https://a/'), new URL('https://evil.example/x')),
    ).toBe(false)
    expect(
      registry.isRedirectAllowed('official', new URL('https://a/'), new URL('http://piston-meta.mojang.com/x')),
    ).toBe(false)
  })

  it('allows a hash-pinned mirror download to use its rotating CDN', () => {
    // Observed 2026-10-21: BMCLAPI redirects downloads to rotating domains
    // (`bmclapiN.sakura.sld.tw`, `2.749333.xyz`). The SHA1 from Mojang metadata
    // remains the integrity boundary (SRC-07), so https hosts are accepted.
    expect(
      registry.isRedirectAllowed(
        'mirror',
        new URL('https://bmclapi2.bangbang93.com/maven/x'),
        new URL('https://2.749333.xyz/download/x?name=x'),
        { hashPinned: true },
      ),
    ).toBe(true)
    expect(
      registry.isRedirectAllowed('mirror', new URL('https://a/'), new URL('http://evil.example/x'), {
        hashPinned: true,
      }),
    ).toBe(false)
    // The official source is never allowed to wander off, even with a hash.
    expect(
      registry.isRedirectAllowed('official', new URL('https://a/'), new URL('https://evil.example/x'), {
        hashPinned: true,
      }),
    ).toBe(false)
    // The manifest (no hash) keeps the strict allowlist.
    expect(
      registry.isRedirectAllowed('mirror', new URL('https://a/'), new URL('https://2.749333.xyz/x')),
    ).toBe(false)
  })

  it('allows official -> official hosts', () => {
    expect(
      registry.isRedirectAllowed(
        'official',
        new URL('https://libraries.minecraft.net/x'),
        new URL('https://resources.download.minecraft.net/x'),
      ),
    ).toBe(true)
  })
})

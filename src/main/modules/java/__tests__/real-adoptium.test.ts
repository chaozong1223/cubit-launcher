import { describe, expect, it } from 'vitest'
import { JavaHttp } from '../core/http'
import { createJavaProviders } from '../core/providers'

/**
 * Opt-in evidence against the real official endpoints (metadata only; the
 * actual ~190 MB download is exercised with the local HTTP fixture in
 * `providers.test.ts`/`install.test.ts`).
 *
 *   MCL_REAL_JAVA=1 npm.cmd --prefix mc-launcher run test -- src/main/modules/java/__tests__/real-adoptium.test.ts
 */

const enabled = process.env.MCL_REAL_JAVA === '1'

function realHttp(): JavaHttp {
  return new JavaHttp({
    userAgent:
      'mc-launcher/0.1.0 (+https://github.com/mc-launcher; contact: mc-launcher-maintainers@users.noreply.github.com)',
  })
}

describe.skipIf(!enabled)('real JDK providers (2026-10-21)', () => {
  it('resolves Adoptium Temurin 17 with an official SHA-256 and size', async () => {
    const providers = createJavaProviders(realHttp())
    const pkg = await providers.resolve({
      major: 17,
      source: 'adoptium',
      preferred: 'adoptium',
      platform: 'win32',
      arch: 'x64',
    })
    expect(pkg.source).toBe('adoptium')
    expect(pkg.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(pkg.size).toBeGreaterThan(100 * 1024 * 1024)
    expect(pkg.url).toMatch(/^https:\/\/github\.com\/adoptium\/temurin17-binaries\//)
    expect(pkg.fileName).toMatch(/\.zip$/)
  }, 90_000)

  it('resolves Microsoft OpenJDK 21 from the versioned alias + sha256sum', async () => {
    const providers = createJavaProviders(realHttp())
    const pkg = await providers.resolve({
      major: 21,
      source: 'microsoft',
      preferred: 'microsoft',
      platform: 'win32',
      arch: 'x64',
    })
    expect(pkg.source).toBe('microsoft')
    expect(pkg.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(pkg.version).toMatch(/^21\./)
    expect(pkg.url).toContain('microsoft-jdk-')
  }, 90_000)
})

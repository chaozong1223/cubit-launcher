import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { JavaHttp } from '../core/http'
import { createJavaProviders } from '../core/providers'
import { sha256, startServer, type TestServer } from './support/harness'
import { fakeJdkZip } from './support/zip'

let server: TestServer | null = null

beforeEach(() => {
  server = null
})

afterEach(async () => {
  if (server) await server.close()
  server = null
})

function http(): JavaHttp {
  return new JavaHttp({
    userAgent: 'mc-launcher/0.1.0 (+https://example.test; test@example.test)',
    allowInsecureHosts: ['127.0.0.1'],
  })
}

describe('Adoptium provider', () => {
  it('returns the package link, SHA-256 and size from the official API shape', async () => {
    const local = await startServer()
    server = local
    const zip = fakeJdkZip(17)
    local.serveBytes('/pkg/adoptium17.zip', zip)
    local.serveJson('/v3/assets/latest/17/hotspot', [
      {
        release_name: 'jdk-17.0.9+9',
        version: { semver: '17.0.9+9' },
        binary: {
          os: 'windows',
          architecture: 'x64',
          image_type: 'jdk',
          package: {
            name: 'OpenJDK17U-jdk_x64_windows_hotspot_17.0.9_9.zip',
            link: `${local.baseUrl}/pkg/adoptium17.zip`,
            checksum: sha256(zip),
            size: zip.length,
          },
        },
      },
    ])
    const providers = createJavaProviders(http(), {
      adoptiumApiBase: `${local.baseUrl}/v3/assets/latest`,
    })
    const pkg = await providers.resolve({
      major: 17,
      source: 'adoptium',
      preferred: 'adoptium',
      platform: 'win32',
      arch: 'x64',
    })
    expect(pkg).toMatchObject({
      source: 'adoptium',
      major: 17,
      version: 'jdk-17.0.9+9',
      sha256: sha256(zip),
      size: zip.length,
    })
    expect(pkg.url).toContain('/pkg/adoptium17.zip')
  })

  it('rejects assets without a SHA-256', async () => {
    const local = await startServer()
    server = local
    local.serveJson('/v3/assets/latest/17/hotspot', [
      {
        release_name: 'jdk-17',
        binary: {
          os: 'windows',
          architecture: 'x64',
          image_type: 'jdk',
          package: { link: 'https://x/y.zip', size: 1 },
        },
      },
    ])
    const providers = createJavaProviders(http(), {
      adoptiumApiBase: `${local.baseUrl}/v3/assets/latest`,
    })
    await expect(
      providers.resolve({ major: 17, source: 'adoptium', preferred: 'adoptium', platform: 'win32', arch: 'x64' }),
    ).rejects.toMatchObject({ code: 'JAVA.PROVIDER_METADATA_INVALID' })
  })
})

describe('Microsoft OpenJDK provider', () => {
  it('resolves the versioned zip and its .sha256sum.txt', async () => {
    const local = await startServer()
    server = local
    const zip = fakeJdkZip(21, '21.0.12.1')
    const version = '21.0.12.1'
    local.route('/download-jdk/microsoft-jdk-21-windows-x64.zip', (_req, res) => {
      res.writeHead(301, {
        location: `${local.baseUrl}/download-jdk/microsoft-jdk-${version}-windows-x64.zip`,
      })
      res.end()
    })
    local.route('/download-jdk/microsoft-jdk-21.0.12.1-windows-x64.zip.sha256sum.txt', (_req, res) => {
      const body = `${sha256(zip)}  microsoft-jdk-${version}-windows-x64.zip\n`
      res.writeHead(200, { 'content-length': Buffer.byteLength(body) })
      res.end(body)
    })
    local.serveBytes(`/download-jdk/microsoft-jdk-${version}-windows-x64.zip`, zip)
    const providers = createJavaProviders(http(), {
      microsoftBase: `${local.baseUrl}/download-jdk`,
    })
    const pkg = await providers.resolve({
      major: 21,
      source: 'microsoft',
      preferred: 'microsoft',
      platform: 'win32',
      arch: 'x64',
    })
    expect(pkg).toMatchObject({
      source: 'microsoft',
      major: 21,
      version,
      sha256: sha256(zip),
      size: null,
    })
    expect(pkg.url).toContain(`microsoft-jdk-${version}-windows-x64.zip`)
  })

  it('is unavailable off Windows x64', () => {
    const providers = createJavaProviders(http())
    const list = providers.list('linux', 'x64')
    expect(list.find((provider) => provider.id === 'microsoft')?.available).toBe(false)
    // The managed installer handles ZIPs; Linux/macOS Adoptium tarballs are
    // explicit future work, so the provider must not advertise availability.
    expect(list.find((provider) => provider.id === 'adoptium')?.available).toBe(false)
  })
})

describe('source fallback', () => {
  it('falls back from a broken preferred source to the other one', async () => {
    const local = await startServer()
    server = local
    const zip = fakeJdkZip(17)
    // Adoptium returns no usable asset.
    local.serveJson('/v3/assets/latest/17/hotspot', [])
    const version = '17.0.20.1'
    local.route('/download-jdk/microsoft-jdk-17-windows-x64.zip', (_req, res) => {
      res.writeHead(301, {
        location: `${local.baseUrl}/download-jdk/microsoft-jdk-${version}-windows-x64.zip`,
      })
      res.end()
    })
    local.route(`/download-jdk/microsoft-jdk-${version}-windows-x64.zip.sha256sum.txt`, (_req, res) => {
      const body = `${sha256(zip)}  microsoft-jdk-${version}-windows-x64.zip\n`
      res.writeHead(200, { 'content-length': Buffer.byteLength(body) })
      res.end(body)
    })
    const providers = createJavaProviders(http(), {
      adoptiumApiBase: `${local.baseUrl}/v3/assets/latest`,
      microsoftBase: `${local.baseUrl}/download-jdk`,
    })
    const pkg = await providers.resolve({
      major: 17,
      source: 'auto',
      preferred: 'adoptium',
      platform: 'win32',
      arch: 'x64',
    })
    expect(pkg.source).toBe('microsoft')
  })
})

import type { JavaProviderId, JavaProviderInfo } from '@shared/java'
import { JavaError } from './errors'
import type { JavaHttp } from './http'

/**
 * Official JDK sources (docs/02 SEC-DL-05).
 *
 * Adoptium: `api.adoptium.net/v3/assets/latest/<major>/hotspot` exposes the
 * package URL **and its SHA-256** — the preferred source.
 * Microsoft OpenJDK: `aka.ms/download-jdk/microsoft-jdk-<major>-windows-x64.zip`
 * redirects to a versioned URL; the versioned `.sha256sum.txt` supplies the
 * hash. Microsoft only ships Windows x64 zips through this route.
 *
 * BMCLAPI's `java/list` is never used (no hashes, SRC-08).
 */

export interface JavaPackage {
  source: JavaProviderId
  major: number
  /** Vendor build version, e.g. `17.0.20.1+1` or `21.0.12.1`. */
  version: string
  url: string
  /** Optional faster/mirrored copy tried before `url` (same SHA-256). */
  mirrorUrl?: string
  sha256: string
  size: number | null
  fileName: string
}

export interface JavaProviderConfig {
  /** Test seam. */
  adoptiumApiBase?: string
  microsoftBase?: string
}

export interface ResolveJavaPackageInput {
  major: number
  source: 'auto' | JavaProviderId
  preferred: JavaProviderId
  platform?: NodeJS.Platform
  arch?: string
  signal?: AbortSignal
}

const ADOPTIUM_DEFAULT = 'https://api.adoptium.net/v3/assets/latest'
const MICROSOFT_DEFAULT = 'https://aka.ms/download-jdk'

/**
 * GitHub release downloads fail on machines whose TLS chain cannot verify
 * github.com (the launcher then reports "unable to verify the first
 * certificate"). A public accelerator serves the identical bytes, and the
 * pinned SHA-256 still decides whether the file is accepted.
 * Set MCL_GITHUB_MIRROR=off to disable, or to a custom prefix.
 */
const GITHUB_MIRROR_DEFAULT = 'https://ghfast.top/'

function githubMirror(url: string): string | null {
  const override = process.env.MCL_GITHUB_MIRROR?.trim()
  if (override === 'off' || override === 'none') return null
  if (!/^https:\/\/github\.com\//i.test(url)) return null
  const prefix = override && override.length > 0 ? override : GITHUB_MIRROR_DEFAULT
  return `${prefix.endsWith('/') ? prefix : `${prefix}/`}${url}`
}

function osName(platform: NodeJS.Platform): string | null {
  if (platform === 'win32') return 'windows'
  if (platform === 'darwin') return 'mac'
  if (platform === 'linux') return 'linux'
  return null
}

function archName(arch: string): string | null {
  const value = arch.toLowerCase()
  if (value === 'x64' || value === 'amd64' || value === 'x86_64') return 'x64'
  if (value === 'arm64' || value === 'aarch64') return 'aarch64'
  if (value === 'ia32' || value === 'x86' || value === 'i386') return 'x86'
  return null
}

const SHA256 = /^[a-f0-9]{64}$/i

interface AdoptiumAsset {
  release_name?: unknown
  version?: { semver?: unknown; major?: unknown }
  binary?: {
    os?: unknown
    architecture?: unknown
    image_type?: unknown
    package?: {
      name?: unknown
      link?: unknown
      checksum?: unknown
      size?: unknown
    }
  }
}

export class JavaProviders {
  constructor(
    private readonly http: JavaHttp,
    private readonly config: JavaProviderConfig = {},
  ) {}

  list(platform: NodeJS.Platform = process.platform, arch: string = process.arch): JavaProviderInfo[] {
    const os = osName(platform)
    const cpu = archName(arch)
    // The installer pipeline handles ZIPs only; Adoptium returns .tar.gz on
    // Linux/macOS, so those platforms are explicit future work rather than a
    // misleading "available" badge.
    const adoptiumAvailable = platform === 'win32' && Boolean(cpu)
    const microsoftAvailable = platform === 'win32' && cpu === 'x64'
    return [
      {
        id: 'adoptium',
        displayName: 'Eclipse Adoptium (Temurin)',
        homepage: 'https://adoptium.net/',
        available: adoptiumAvailable,
        note: adoptiumAvailable
          ? '官方 API 提供 SHA-256；推荐默认源（Windows x64 ZIP）'
          : '当前实现只支持 Windows x64 的 Temurin ZIP；其它平台暂未启用安装',
      },
      {
        id: 'microsoft',
        displayName: 'Microsoft Build of OpenJDK',
        homepage: 'https://learn.microsoft.com/java/openjdk/download',
        available: microsoftAvailable,
        note: microsoftAvailable
          ? '官方 .sha256sum.txt 校验；仅 Windows x64'
          : '本实现只支持 Windows x64 的 Microsoft OpenJDK',
      },
    ]
  }

  private available(id: JavaProviderId, platform: NodeJS.Platform, arch: string): boolean {
    return this.list(platform, arch).some((provider) => provider.id === id && provider.available)
  }

  async resolve(input: ResolveJavaPackageInput): Promise<JavaPackage> {
    const platform = input.platform ?? process.platform
    const arch = input.arch ?? process.arch
    const order: JavaProviderId[] =
      input.source === 'auto'
        ? [input.preferred, input.preferred === 'adoptium' ? 'microsoft' : 'adoptium']
        : [input.source]

    const errors: string[] = []
    let lastError: unknown = null
    for (const id of order) {
      if (!this.available(id, platform, arch)) {
        errors.push(`${id}: unavailable on ${platform}/${arch}`)
        continue
      }
      try {
        return id === 'adoptium'
          ? await this.resolveAdoptium(input.major, platform, arch, input.signal)
          : await this.resolveMicrosoft(input.major, input.signal)
      } catch (error) {
        lastError = error
        errors.push(`${id}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    if (order.length === 1 && lastError instanceof JavaError) throw lastError
    throw new JavaError('JAVA.PROVIDER_UNAVAILABLE', {
      message: `no Java ${input.major} package available: ${errors.join(' | ')}`,
      details: { major: input.major, platform, arch, errors },
    })
  }

  private async resolveAdoptium(
    major: number,
    platform: NodeJS.Platform,
    arch: string,
    signal?: AbortSignal,
  ): Promise<JavaPackage> {
    const os = osName(platform)
    const cpu = archName(arch)
    if (!os || !cpu) {
      throw new JavaError('JAVA.PROVIDER_UNAVAILABLE', {
        message: `adoptium unsupported platform: ${platform}/${arch}`,
      })
    }
    const base = (this.config.adoptiumApiBase ?? ADOPTIUM_DEFAULT).replace(/\/+$/, '')
    const url = `${base}/${major}/hotspot?os=${encodeURIComponent(os)}&architecture=${encodeURIComponent(cpu)}&image_type=jdk&vendor=eclipse`
    const assets = await this.http.fetchJson<AdoptiumAsset[]>(url, {
      ...(signal ? { signal } : {}),
      totalTimeoutMs: 30_000,
      maxBytes: 2 * 1024 * 1024,
    })
    if (!Array.isArray(assets)) {
      throw new JavaError('JAVA.PROVIDER_METADATA_INVALID', {
        message: 'Adoptium response is not an array',
        details: { url },
      })
    }

    for (const asset of assets) {
      if (asset?.binary?.image_type !== 'jdk') continue
      if (asset.binary.os !== os || asset.binary.architecture !== cpu) continue
      const pkg = asset.binary.package
      const link = typeof pkg?.link === 'string' ? pkg.link : null
      const checksum = typeof pkg?.checksum === 'string' ? pkg.checksum : null
      const size = typeof pkg?.size === 'number' ? pkg.size : null
      const fileName = typeof pkg?.name === 'string' ? pkg.name : link ? pathBase(link) : null
      if (!link || !checksum || !SHA256.test(checksum) || !fileName) continue
      const release =
        typeof asset.release_name === 'string'
          ? asset.release_name
          : typeof asset.version?.semver === 'string'
            ? asset.version.semver
            : `${major}`
      return {
        source: 'adoptium',
        major,
        version: release,
        url: link,
        ...(githubMirror(link) ? { mirrorUrl: githubMirror(link) as string } : {}),
        sha256: checksum.toLowerCase(),
        size,
        fileName,
      }
    }

    throw new JavaError('JAVA.PROVIDER_METADATA_INVALID', {
      message: `Adoptium has no JDK ${major} package for ${os}/${cpu} with a SHA-256`,
      details: { major, os, cpu, assets: assets.length },
    })
  }

  private async resolveMicrosoft(major: number, signal?: AbortSignal): Promise<JavaPackage> {
    const base = (this.config.microsoftBase ?? MICROSOFT_DEFAULT).replace(/\/+$/, '')
    const aliasUrl = `${base}/microsoft-jdk-${major}-windows-x64.zip`
    const head = await this.http.headLocation(aliasUrl, { ...(signal ? { signal } : {}) })
    const location = head.location
    if (head.status < 300 || head.status >= 400 || !location) {
      throw new JavaError('JAVA.PROVIDER_UNAVAILABLE', {
        message: `Microsoft alias did not redirect for Java ${major}`,
        details: { url: aliasUrl, status: head.status },
      })
    }
    // Older majors (e.g. 8) redirect to bing.com — treat as unavailable.
    let hostname = ''
    try {
      hostname = new URL(location).hostname.toLowerCase()
    } catch {
      hostname = ''
    }
    const baseHost = (() => {
      try {
        return new URL(base).hostname.toLowerCase()
      } catch {
        return ''
      }
    })()
    // Production redirects stay on aka.ms; tests point the base at localhost.
    if (hostname !== 'aka.ms' && hostname !== baseHost) {
      throw new JavaError('JAVA.PROVIDER_UNAVAILABLE', {
        message: `Microsoft has no download for Java ${major} (redirect: ${hostname})`,
        details: { major, location },
      })
    }
    const match = /microsoft-jdk-([0-9.]+)-windows-x64\.zip$/.exec(location)
    if (!match) {
      throw new JavaError('JAVA.PROVIDER_METADATA_INVALID', {
        message: `cannot parse Microsoft JDK version from ${location}`,
      })
    }
    const version = match[1]
    const zipName = `microsoft-jdk-${version}-windows-x64.zip`
    const sumUrl = `${base}/${zipName}.sha256sum.txt`
    const sum = await this.http.fetchText(sumUrl, {
      ...(signal ? { signal } : {}),
      totalTimeoutMs: 20_000,
      maxBytes: 4096,
    })
    const hashMatch = /([a-f0-9]{64})/i.exec(sum.text)
    if (!hashMatch) {
      throw new JavaError('JAVA.PROVIDER_METADATA_INVALID', {
        message: `Microsoft checksum file has no SHA-256: ${sumUrl}`,
      })
    }
    return {
      source: 'microsoft',
      major,
      version,
      url: `${base}/${zipName}`,
      sha256: hashMatch[1].toLowerCase(),
      size: null,
      fileName: zipName,
    }
  }
}

function pathBase(url: string): string {
  try {
    return new URL(url).pathname.split('/').pop() ?? 'jdk.zip'
  } catch {
    return 'jdk.zip'
  }
}

export function createJavaProviders(
  http: JavaHttp,
  config: JavaProviderConfig = {},
): JavaProviders {
  return new JavaProviders(http, config)
}

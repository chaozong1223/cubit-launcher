import path from 'node:path'
import { z } from 'zod'
import type { DownloadTask, ModProviderInfo } from '@shared/download'
import { DownloadError } from '../core/errors'
import { assertSafeRelPath } from '../core/fs-atomic'
import { withRetries } from '../core/retry'
import {
  RequestLimiter,
  type ModDestination,
  type ModProject,
  type ModSearchQuery,
  type ModSourceProvider,
  type ModVersion,
  type ProviderDeps,
} from './types'

/**
 * Modrinth provider (P0's only live mod source, docs/02 API-01~06).
 *
 *  - unique User-Agent comes from the shared `HttpClient` (API-01);
 *  - client-side limiter stays under 240 req/min with 300 allowed (API-02);
 *  - downloads go straight to `cdn.modrinth.com` and require sha512/sha1
 *    (API-03); no re-hosting and no metadata cache beyond memory (API-04).
 */

export const MODRINTH_API_BASE = 'https://api.modrinth.com/v2'
export const MODRINTH_ALLOWED_DOWNLOAD_HOSTS = ['cdn.modrinth.com', '*.modrinth.com']
export const MODRINTH_REQUESTS_PER_MINUTE = 240

const SearchHitSchema = z.object({
  project_id: z.string(),
  slug: z.string(),
  title: z.string(),
  description: z.string(),
  author: z.string(),
  downloads: z.number().int().nonnegative(),
  follows: z.number().int().nonnegative().optional(),
  icon_url: z.string().nullable().optional(),
})

const SearchResponseSchema = z.object({
  hits: z.array(SearchHitSchema),
  offset: z.number().int().nonnegative().optional(),
  limit: z.number().int().nonnegative().optional(),
  total_hits: z.number().int().nonnegative().optional(),
})

const VersionFileSchema = z.object({
  url: z.string().min(1),
  filename: z.string().min(1),
  size: z.number().int().nonnegative(),
  primary: z.boolean().optional(),
  hashes: z.object({
    sha1: z.string().optional(),
    sha512: z.string().optional(),
  }),
})

const VersionSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  name: z.string(),
  version_number: z.string(),
  version_type: z.string().optional(),
  game_versions: z.array(z.string()).optional(),
  loaders: z.array(z.string()).optional(),
  files: z.array(VersionFileSchema).min(1),
})

const VersionsSchema = z.array(VersionSchema)

function hostAllowed(hostname: string, patterns: string[]): boolean {
  const host = hostname.toLowerCase()
  return patterns.some((pattern) => {
    if (pattern.startsWith('*.')) return host.endsWith(pattern.slice(1)) || host === pattern.slice(2)
    return host === pattern
  })
}

function toProject(hit: z.infer<typeof SearchHitSchema>): ModProject {
  return {
    source: 'modrinth',
    id: hit.project_id,
    slug: hit.slug,
    title: hit.title,
    description: hit.description,
    author: hit.author,
    downloads: hit.downloads,
    follows: hit.follows ?? 0,
    iconUrl: hit.icon_url ?? null,
    pageUrl: `https://modrinth.com/mod/${hit.slug}`,
  }
}

function toVersion(raw: z.infer<typeof VersionSchema>): ModVersion {
  return {
    id: raw.id,
    projectId: raw.project_id,
    name: raw.name,
    versionNumber: raw.version_number,
    versionType: raw.version_type ?? 'release',
    gameVersions: raw.game_versions ?? [],
    loaders: raw.loaders ?? [],
    files: raw.files.map((file) => ({
      url: file.url,
      filename: file.filename,
      size: file.size,
      primary: file.primary ?? false,
      hashes: {
        sha1: file.hashes.sha1 ?? null,
        sha512: file.hashes.sha512 ?? null,
      },
    })),
  }
}

export class ModrinthProvider implements ModSourceProvider {
  readonly id = 'modrinth' as const
  readonly info: ModProviderInfo = {
    id: 'modrinth',
    displayName: 'Modrinth',
    homepage: 'https://modrinth.com/',
    available: true,
    requiresKey: false,
    note: 'P0 已接入：只读公开 API，sha1/sha512 校验，不转存文件',
  }

  private readonly limiter: RequestLimiter
  private readonly apiBase: string

  constructor(private readonly deps: ProviderDeps) {
    this.limiter = new RequestLimiter(
      MODRINTH_REQUESTS_PER_MINUTE,
      deps.now ?? Date.now,
      deps.sleep,
    )
    this.apiBase = (deps.apiBase ?? MODRINTH_API_BASE).replace(/\/+$/, '')
  }

  private async getJson(pathname: string, signal?: AbortSignal): Promise<unknown> {
    await this.limiter.acquire()
    const outcome = await withRetries(
      async () => {
        const response = await this.deps.http.fetchText(`${this.apiBase}${pathname}`, {
          signal,
          idleTimeoutMs: 10_000,
          totalTimeoutMs: 20_000,
          headers: { accept: 'application/json' },
        })
        try {
          return JSON.parse(response.text) as unknown
        } catch (error) {
          throw new DownloadError('SOURCE.BAD_RESPONSE', {
            message: `Modrinth returned invalid JSON: ${pathname}`,
            cause: error,
          })
        }
      },
      { retries: 2, signal },
    )
    return outcome.value
  }

  async search(query: ModSearchQuery): Promise<ModProject[]> {
    const params = new URLSearchParams()
    params.set('query', query.query)
    params.set('limit', String(Math.min(50, Math.max(1, query.limit ?? 20))))
    if (query.offset) params.set('offset', String(query.offset))
    if (query.gameVersion || query.loaders?.length || query.categories?.length) {
      const facets: string[][] = []
      if (query.gameVersion) facets.push([`versions:${query.gameVersion}`])
      if (query.loaders?.length) facets.push(query.loaders.map((loader) => `categories:${loader}`))
      if (query.categories?.length) facets.push(query.categories.map((category) => `categories:${category}`))
      params.set('facets', JSON.stringify(facets))
    }

    const raw = await this.getJson(`/search?${params.toString()}`)
    const parsed = SearchResponseSchema.safeParse(raw)
    if (!parsed.success) {
      throw new DownloadError('SOURCE.BAD_RESPONSE', {
        message: 'Modrinth search response does not match the documented shape',
        details: { issues: parsed.error.issues.slice(0, 5).map((issue) => issue.message) },
      })
    }
    return parsed.data.hits.map(toProject)
  }

  async listVersions(projectId: string): Promise<ModVersion[]> {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(projectId)) {
      throw new DownloadError('SOURCE.BAD_RESPONSE', {
        message: `unexpected Modrinth project id: ${projectId}`,
      })
    }
    const raw = await this.getJson(
      `/project/${encodeURIComponent(projectId)}/version?include_changelog=false`,
    )
    const parsed = VersionsSchema.safeParse(raw)
    if (!parsed.success) {
      throw new DownloadError('SOURCE.BAD_RESPONSE', {
        message: 'Modrinth version response does not match the documented shape',
        details: { issues: parsed.error.issues.slice(0, 5).map((issue) => issue.message) },
      })
    }
    return parsed.data.map(toVersion)
  }

  /**
   * One task per file that has an upstream hash. Files without a hash are
   * rejected instead of being downloaded blind (SEC-DL-04 / API-03).
   */
  toDownloadTasks(version: ModVersion, destination: ModDestination): DownloadTask[] {
    const tasks: DownloadTask[] = []
    // Prefer the primary file; source jars must not be installed as a mod.
    const hasPrimary = version.files.some((file) => file.primary)
    const files = hasPrimary ? version.files.filter((file) => file.primary) : version.files
    for (const file of files) {
      const filename = destination.filename ?? file.filename
      const safeName = path.posix.basename(filename)
      if (safeName !== filename) {
        throw new DownloadError('DOWNLOAD.PATH_UNSAFE', {
          message: `Modrinth filename contains a directory: ${file.filename}`,
        })
      }
      assertSafeRelPath(path.posix.join(destination.destDir, safeName), 'mod destRel')

      let host: string
      try {
        host = new URL(file.url).hostname
      } catch {
        throw new DownloadError('SOURCE.BAD_RESPONSE', {
          message: `Modrinth file URL is invalid: ${file.url}`,
        })
      }
      if (!hostAllowed(host, MODRINTH_ALLOWED_DOWNLOAD_HOSTS)) {
        throw new DownloadError('DOWNLOAD.HOST_NOT_ALLOWED', {
          message: `Modrinth file URL host is not the Modrinth CDN: ${host}`,
          details: { url: file.url, host },
        })
      }
      if (!file.hashes.sha512 && !file.hashes.sha1) {
        throw new DownloadError('DOWNLOAD.HASH_REQUIRED', {
          message: `Modrinth file has no hash: ${file.filename}`,
          details: { url: file.url },
        })
      }

      const destRel = path.posix.join(destination.destDir, safeName)
      tasks.push({
        id: `modrinth:${version.projectId}:${file.filename}`,
        url: file.url,
        mirrorUrl: null,
        destRel,
        sha1: file.hashes.sha1 ?? null,
        sha512: file.hashes.sha512 ?? null,
        size: file.size,
        priority: 4,
        sourceHint: 'official',
        unverified: false,
        label: 'mod',
      })
    }
    return tasks
  }

  projectPage(project: string | ModProject): string {
    if (typeof project !== 'string') return project.pageUrl
    return `https://modrinth.com/mod/${encodeURIComponent(project)}`
  }
}

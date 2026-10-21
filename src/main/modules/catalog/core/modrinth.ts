import { AppError } from '@shared/errors'
import type {
  CatalogProject,
  CatalogProjectType,
  CatalogSearchHit,
  CatalogSearchInput,
  CatalogSearchResult,
  CatalogVersion,
  CatalogVersionFile,
} from '@shared/catalog'
import { DownloadError } from '../../download/core/errors'
import { HttpClient } from '../../download/core/http'
import { buildUserAgent } from '../../download/core/sources'

/**
 * Modrinth v2 client for the catalog module.
 *
 * API constraints (docs/02 API-01..):
 *  - one descriptive User-Agent for every request;
 *  - <=300 requests/minute (default 200 ms spacing) with 429/5xx retry;
 *  - no metadata mirroring; responses are cached in memory only.
 */

export interface ModrinthOptions {
  apiBase?: string
  userAgent?: string
  version?: string
  allowInsecureHosts?: string[]
  /** Default 200 ms = 5 req/s = 300/min. Tests set 0. */
  minIntervalMs?: number
  cacheTtlMs?: number
  maxCacheEntries?: number
  retries?: number
  now?: () => number
  log?: {
    info(message: string, fields?: Record<string, unknown>): void
    warn(message: string, fields?: Record<string, unknown>): void
    debug?(message: string, fields?: Record<string, unknown>): void
  }
}

export const MODRINTH_API_BASE = 'https://api.modrinth.com/v2'
export const MODRINTH_CDN_HOST = 'cdn.modrinth.com'
export const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000
export const DEFAULT_CACHE_ENTRIES = 300

interface CacheEntry {
  expires: number
  value: unknown
}

class RateLimiter {
  private nextAt = 0
  private readonly intervalMs: number
  private readonly now: () => number

  constructor(intervalMs: number, now: () => number) {
    this.intervalMs = Math.max(0, intervalMs)
    this.now = now
  }

  async wait(signal?: AbortSignal): Promise<void> {
    if (this.intervalMs === 0) return
    const current = this.now()
    const start = Math.max(current, this.nextAt)
    this.nextAt = start + this.intervalMs
    const delay = start - current
    if (delay <= 0) return
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }, delay)
      const onAbort = (): void => {
        clearTimeout(timer)
        reject(new AppError('CATALOG.CANCELLED', 'catalog request cancelled'))
      }
      if (signal?.aborted) onAbort()
      else signal?.addEventListener('abort', onAbort, { once: true })
    })
  }
}

interface RawHit {
  project_id?: unknown
  slug?: unknown
  title?: unknown
  description?: unknown
  author?: unknown
  downloads?: unknown
  follows?: unknown
  icon_url?: unknown
  project_type?: unknown
  categories?: unknown
  display_categories?: unknown
  versions?: unknown
  game_versions?: unknown
  latest_version?: unknown
  date_modified?: unknown
}

interface RawFile {
  filename?: unknown
  url?: unknown
  size?: unknown
  primary?: unknown
  hashes?: { sha1?: unknown; sha512?: unknown }
}

interface RawVersion {
  id?: unknown
  project_id?: unknown
  name?: unknown
  version_number?: unknown
  changelog?: unknown
  game_versions?: unknown
  loaders?: unknown
  version_type?: unknown
  date_published?: unknown
  downloads?: unknown
  files?: unknown
}

interface RawProject {
  id?: unknown
  slug?: unknown
  title?: unknown
  description?: unknown
  body?: unknown
  project_type?: unknown
  downloads?: unknown
  follows?: unknown
  icon_url?: unknown
  categories?: unknown
  game_versions?: unknown
  loaders?: unknown
}

function stringOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function numberOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0
}

function stringsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function normalizeProjectType(value: unknown): CatalogProjectType {
  if (value === 'resourcepack' || value === 'shader' || value === 'modpack') return value
  return 'mod'
}

function projectPageUrl(type: CatalogProjectType, slug: string): string {
  const segment =
    type === 'resourcepack' ? 'resourcepack' : type === 'shader' ? 'shader' : type === 'modpack' ? 'modpack' : 'mod'
  return `https://modrinth.com/${segment}/${encodeURIComponent(slug)}`
}

function parseVersionFile(raw: RawFile): CatalogVersionFile | null {
  if (typeof raw.filename !== 'string' || typeof raw.url !== 'string') return null
  return {
    filename: raw.filename,
    url: raw.url,
    size: numberOf(raw.size),
    sha1: nullableString(raw.hashes?.sha1)?.toLowerCase() ?? null,
    sha512: nullableString(raw.hashes?.sha512)?.toLowerCase() ?? null,
    primary: raw.primary === true,
  }
}

function parseVersion(raw: RawVersion): CatalogVersion | null {
  if (typeof raw.id !== 'string' || typeof raw.project_id !== 'string') return null
  const files = Array.isArray(raw.files)
    ? raw.files.map((file) => parseVersionFile(file as RawFile)).filter((file): file is CatalogVersionFile => Boolean(file))
    : []
  const versionType = raw.version_type === 'beta' || raw.version_type === 'alpha' ? raw.version_type : 'release'
  return {
    id: raw.id,
    projectId: raw.project_id,
    name: stringOf(raw.name) || stringOf(raw.version_number) || raw.id,
    versionNumber: stringOf(raw.version_number) || stringOf(raw.name) || raw.id,
    changelog: nullableString(raw.changelog),
    gameVersions: stringsOf(raw.game_versions),
    loaders: stringsOf(raw.loaders),
    versionType,
    datePublished: nullableString(raw.date_published),
    downloads: numberOf(raw.downloads),
    files,
  }
}

function parseProject(raw: RawProject): CatalogProject {
  const type = normalizeProjectType(raw.project_type)
  const slug = stringOf(raw.slug) || stringOf(raw.id)
  return {
    id: stringOf(raw.id) || slug,
    slug,
    title: stringOf(raw.title) || slug,
    description: stringOf(raw.description),
    body: stringOf(raw.body),
    projectType: type,
    downloads: numberOf(raw.downloads),
    follows: numberOf(raw.follows),
    iconUrl: nullableString(raw.icon_url),
    categories: stringsOf(raw.categories),
    gameVersions: stringsOf(raw.game_versions),
    loaders: stringsOf(raw.loaders),
    pageUrl: projectPageUrl(type, slug),
  }
}

function parseHit(raw: RawHit): CatalogSearchHit | null {
  if (typeof raw.project_id !== 'string' || typeof raw.slug !== 'string') return null
  const type = normalizeProjectType(raw.project_type)
  const categories = stringsOf(raw.categories)
  const knownLoaders = new Set(['fabric', 'forge', 'neoforge', 'quilt', 'liteloader'])
  const loaders = categories.filter((category) => knownLoaders.has(category))
  return {
    projectId: raw.project_id,
    slug: raw.slug,
    title: stringOf(raw.title) || raw.slug,
    description: stringOf(raw.description),
    author: nullableString(raw.author),
    downloads: numberOf(raw.downloads),
    follows: numberOf(raw.follows),
    iconUrl: nullableString(raw.icon_url),
    projectType: type,
    loaders,
    gameVersions: stringsOf(raw.versions).length > 0 ? stringsOf(raw.versions) : stringsOf(raw.game_versions),
    latestVersion: nullableString(raw.latest_version),
    dateModified: nullableString(raw.date_modified),
    categories,
    pageUrl: projectPageUrl(type, raw.slug),
  }
}

export class ModrinthClient {
  private readonly apiBase: string
  private readonly http: HttpClient
  private readonly limiter: RateLimiter
  private readonly cache = new Map<string, CacheEntry>()
  private readonly cacheTtlMs: number
  private readonly maxCacheEntries: number
  private readonly retries: number
  private readonly now: () => number
  private readonly log?: ModrinthOptions['log']

  constructor(options: ModrinthOptions = {}) {
    this.apiBase = (options.apiBase ?? MODRINTH_API_BASE).replace(/\/+$/, '')
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS
    this.maxCacheEntries = options.maxCacheEntries ?? DEFAULT_CACHE_ENTRIES
    this.retries = options.retries ?? 2
    this.now = options.now ?? Date.now
    this.log = options.log
    this.limiter = new RateLimiter(options.minIntervalMs ?? 200, this.now)
    this.http = new HttpClient({
      userAgent:
        options.userAgent ??
        buildUserAgent({
          version: options.version ?? '0.1.0',
          site: 'https://github.com/mc-launcher',
          contact: 'mc-launcher-maintainers@users.noreply.github.com',
        }),
      ...(options.allowInsecureHosts ? { allowInsecureHosts: options.allowInsecureHosts } : {}),
    })
  }

  get httpClient(): HttpClient {
    return this.http
  }

  private readCache<T>(key: string): T | null {
    const entry = this.cache.get(key)
    if (!entry) return null
    if (entry.expires <= this.now()) {
      this.cache.delete(key)
      return null
    }
    return entry.value as T
  }

  private writeCache(key: string, value: unknown): void {
    while (this.cache.size >= this.maxCacheEntries) {
      const oldest = this.cache.keys().next().value
      if (oldest === undefined) break
      this.cache.delete(oldest)
    }
    this.cache.set(key, { expires: this.now() + this.cacheTtlMs, value })
  }

  private async getJson<T>(path: string, query?: Record<string, string>, signal?: AbortSignal): Promise<T> {
    const key = `${path}?${JSON.stringify(query ?? {})}`
    const cached = this.readCache<T>(key)
    if (cached !== null) return cached
    const url = new URL(`${this.apiBase}${path}`)
    for (const [name, value] of Object.entries(query ?? {})) url.searchParams.set(name, value)

    let lastError: unknown = null
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      await this.limiter.wait(signal)
      try {
        const response = await this.http.fetchText(url.toString(), {
          ...(signal ? { signal } : {}),
          idleTimeoutMs: 20_000,
          totalTimeoutMs: 30_000,
          headers: { accept: 'application/json' },
          isRedirectAllowed: (from, to) =>
            to.protocol === 'https:' &&
            (to.hostname === 'api.modrinth.com' || to.hostname === 'cdn.modrinth.com'),
        })
        let parsed: unknown
        try {
          parsed = JSON.parse(response.text)
        } catch (error) {
          throw new AppError('CATALOG.INVALID_RESPONSE', `Modrinth returned invalid JSON: ${url.pathname}`, {
            cause: error,
          })
        }
        this.writeCache(key, parsed)
        return parsed as T
      } catch (error) {
        lastError = error
        if (error instanceof AppError) throw error
        const status = error instanceof DownloadError ? Number(error.details?.status ?? 0) : 0
        if (status === 404) {
          throw new AppError('CATALOG.NOT_FOUND', `Modrinth 404: ${url.pathname}`, {
            details: { path: url.pathname },
            cause: error,
          })
        }
        const retryable = status === 0 || status === 429 || status >= 500
        if (!retryable || attempt >= this.retries) break
        const delay = status === 429 ? 1000 * (attempt + 1) : 300 * 2 ** attempt
        this.log?.warn('modrinth request retry', { path: url.pathname, status, delay })
        await new Promise((resolve) => setTimeout(resolve, delay))
      }
    }
    throw new AppError('CATALOG.API_UNAVAILABLE', '无法连接 Modrinth，请稍后重试', {
      retryable: true,
      details: { path: url.pathname },
      cause: lastError,
    })
  }

  async search(input: CatalogSearchInput, signal?: AbortSignal): Promise<CatalogSearchResult> {
    const key = `search:${JSON.stringify(input)}`
    const cached = this.readCache<CatalogSearchResult>(key)
    if (cached) return { ...cached, cached: true }

    const facets: string[][] = [[`project_type:${input.projectType}`]]
    for (const loader of input.loaders) facets.push([`categories:${loader}`])
    if (input.gameVersion) facets.push([`versions:${input.gameVersion}`])
    const raw = await this.getJson<{ hits?: RawHit[]; total_hits?: number; offset?: number; limit?: number }>(
      '/search',
      {
        query: input.query,
        facets: JSON.stringify(facets),
        limit: String(input.limit),
        offset: String(input.offset),
        index: 'relevance',
      },
      signal,
    )
    const hits = (raw.hits ?? [])
      .map(parseHit)
      .filter((hit): hit is CatalogSearchHit => Boolean(hit))
    const result: CatalogSearchResult = {
      query: input.query,
      offset: input.offset,
      limit: input.limit,
      total: numberOf(raw.total_hits),
      source: 'modrinth',
      cached: false,
      hits,
    }
    this.writeCache(key, result)
    return result
  }

  async project(idOrSlug: string, signal?: AbortSignal): Promise<CatalogProject> {
    const key = `project:${idOrSlug}`
    const cached = this.readCache<CatalogProject>(key)
    if (cached) return cached
    const raw = await this.getJson<RawProject>(`/project/${encodeURIComponent(idOrSlug)}`, undefined, signal)
    const project = parseProject(raw)
    this.writeCache(key, project)
    return project
  }

  async versions(
    input: { projectId: string; gameVersion?: string; loader?: string },
    signal?: AbortSignal,
  ): Promise<CatalogVersion[]> {
    const key = `versions:${input.projectId}:${input.gameVersion ?? ''}:${input.loader ?? ''}`
    const cached = this.readCache<CatalogVersion[]>(key)
    if (cached) return cached
    const query: Record<string, string> = {}
    if (input.gameVersion) query.game_versions = JSON.stringify([input.gameVersion])
    if (input.loader) query.loaders = JSON.stringify([input.loader])
    const raw = await this.getJson<RawVersion[]>(
      `/project/${encodeURIComponent(input.projectId)}/version`,
      query,
      signal,
    )
    const versions = (Array.isArray(raw) ? raw : [])
      .map(parseVersion)
      .filter((version): version is CatalogVersion => Boolean(version))
    this.writeCache(key, versions)
    return versions
  }

  async version(versionId: string, signal?: AbortSignal): Promise<CatalogVersion> {
    const key = `version:${versionId}`
    const cached = this.readCache<CatalogVersion>(key)
    if (cached) return cached
    const raw = await this.getJson<RawVersion>(`/version/${encodeURIComponent(versionId)}`, undefined, signal)
    const version = parseVersion(raw)
    if (!version) {
      throw new AppError('CATALOG.INVALID_RESPONSE', `Modrinth version ${versionId} has no files`, {
        details: { versionId },
      })
    }
    this.writeCache(key, version)
    return version
  }

  /** Resolve a local jar's SHA-1 to its Modrinth version (404 → null). */
  async versionByHash(sha1: string, signal?: AbortSignal): Promise<CatalogVersion | null> {
    const key = `hash:${sha1}`
    const cached = this.readCache<CatalogVersion | null>(key)
    if (cached !== null) return cached
    try {
      const raw = await this.getJson<RawVersion>(
        `/version_file/${encodeURIComponent(sha1)}`,
        { algorithm: 'sha1' },
        signal,
      )
      const version = parseVersion(raw)
      this.writeCache(key, version)
      return version
    } catch (error) {
      if (error instanceof AppError && error.code === 'CATALOG.NOT_FOUND') {
        this.writeCache(key, null)
        return null
      }
      throw error
    }
  }
}

export function modrinthPageUrl(type: CatalogProjectType, slug: string): string {
  return projectPageUrl(type, slug)
}

export function curseForgePageUrl(slug: string): string {
  return `https://www.curseforge.com/minecraft/mc-mods/${encodeURIComponent(slug)}`
}

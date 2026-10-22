import { AppError } from '@shared/errors'
import type { CurseForgeConfig } from './settings'

/**
 * Minimal CurseForge v1 API client used by the catalog link importer and the
 * modpack file resolver (docs/02 API-07..22).
 *
 * Compliance:
 *   - the user key travels only in the `x-api-key` request header;
 *   - the official endpoint is tried first; a user-configured mirror is only a
 *     fallback for transient failures, never for 404/401/403;
 *   - responses are used in memory only (no disk cache), only the fields below
 *     are parsed, and logs contain host/path/status but never headers or keys.
 */

export const CF_OFFICIAL_API_BASE = 'https://api.curseforge.com/v1'
export const CF_MODPACK_CLASS_ID = 4471
export const CF_GAME_ID = 432

export interface CurseForgeLogger {
  info?(message: string, fields?: Record<string, unknown>): void
  warn?(message: string, fields?: Record<string, unknown>): void
  debug?(message: string, fields?: Record<string, unknown>): void
}

export interface CurseForgeClientOptions {
  config: CurseForgeConfig
  userAgent: string
  fetchImpl?: typeof fetch
  /** Test seam: override the official base (defaults to CurseForge v1). */
  officialBase?: string
  timeoutMs?: number
  /** Test seam: allow an HTTP mirror on this host. */
  allowInsecureHosts?: string[]
  log?: CurseForgeLogger
}

export interface CfProject {
  id: number
  slug: string
  name: string
  summary: string
  websiteUrl: string | null
  downloadCount: number
  classId: number | null
}

export interface CfFile {
  id: number
  modId: number
  displayName: string
  fileName: string
  releaseType: number
  fileDate: string | null
  fileLength: number | null
  /** null when the author disabled third-party distribution (API-10). */
  downloadUrl: string | null
  gameVersions: string[]
  hashes: { sha1?: string; sha256?: string }
}

interface RawProject {
  id?: unknown
  name?: unknown
  slug?: unknown
  summary?: unknown
  downloadCount?: unknown
  classId?: unknown
  links?: { websiteUrl?: unknown }
}

interface RawFile {
  id?: unknown
  modId?: unknown
  displayName?: unknown
  fileName?: unknown
  releaseType?: unknown
  fileDate?: unknown
  fileLength?: unknown
  downloadUrl?: unknown
  gameVersions?: unknown
  hashes?: unknown
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function parseProject(raw: unknown): CfProject | null {
  const entry = asRecord(raw)
  if (!entry) return null
  const id = Number(entry.id)
  if (!Number.isInteger(id) || id <= 0) return null
  const slug = typeof entry.slug === 'string' ? entry.slug : ''
  const links = asRecord(entry.links)
  return {
    id,
    slug,
    name: typeof entry.name === 'string' ? entry.name : slug,
    summary: typeof entry.summary === 'string' ? entry.summary : '',
    websiteUrl:
      links && typeof links.websiteUrl === 'string' && links.websiteUrl.length > 0
        ? links.websiteUrl
        : null,
    downloadCount: Number.isFinite(Number(entry.downloadCount))
      ? Math.max(0, Number(entry.downloadCount))
      : 0,
    classId: Number.isInteger(Number(entry.classId)) ? Number(entry.classId) : null,
  }
}

function parseFile(raw: unknown): CfFile | null {
  const entry = asRecord(raw)
  if (!entry) return null
  const id = Number(entry.id)
  const modId = Number(entry.modId)
  const fileName = typeof entry.fileName === 'string' ? entry.fileName : ''
  if (!Number.isInteger(id) || !Number.isInteger(modId) || !fileName) return null
  const hashes: { sha1?: string; sha256?: string } = {}
  if (Array.isArray(entry.hashes)) {
    for (const item of entry.hashes) {
      const record = asRecord(item)
      if (!record || typeof record.value !== 'string') continue
      // CurseForge hashes: 1=SHA1, 2=MD5, 3=SHA256.
      if (Number(record.algo) === 1) hashes.sha1 = record.value.toLowerCase()
      else if (Number(record.algo) === 3) hashes.sha256 = record.value.toLowerCase()
    }
  }
  return {
    id,
    modId,
    displayName: typeof entry.displayName === 'string' ? entry.displayName : fileName,
    fileName,
    releaseType: Number.isInteger(Number(entry.releaseType)) ? Number(entry.releaseType) : 0,
    fileDate: typeof entry.fileDate === 'string' ? entry.fileDate : null,
    fileLength: Number.isFinite(Number(entry.fileLength))
      ? Math.max(0, Number(entry.fileLength))
      : null,
    downloadUrl:
      typeof entry.downloadUrl === 'string' && entry.downloadUrl.length > 0
        ? entry.downloadUrl
        : null,
    gameVersions: Array.isArray(entry.gameVersions)
      ? entry.gameVersions.filter((value): value is string => typeof value === 'string')
      : [],
    hashes,
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500
}

export class CurseForgeClient {
  private readonly config: CurseForgeConfig
  private readonly userAgent: string
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number
  private readonly allowInsecureHosts: string[]
  private readonly log?: CurseForgeLogger
  private readonly officialBase: string
  /** Host of the most recent successful request (diagnostics only). */
  lastSourceHost: string | null = null

  constructor(options: CurseForgeClientOptions) {
    this.config = options.config
    this.userAgent = options.userAgent
    this.fetchImpl = options.fetchImpl ?? fetch
    this.timeoutMs = options.timeoutMs ?? 20_000
    this.allowInsecureHosts = (options.allowInsecureHosts ?? []).map((host) => host.toLowerCase())
    this.log = options.log
    this.officialBase = options.officialBase ?? CF_OFFICIAL_API_BASE
  }

  get hasApiKey(): boolean {
    return Boolean(this.config.apiKey && this.config.apiKey.length > 0)
  }

  private apiBases(): string[] {
    const bases = [this.officialBase]
    const mirror = this.config.mirrorBase
    if (mirror && mirror !== CF_OFFICIAL_API_BASE) bases.push(mirror)
    return bases
  }

  private assertMirrorAllowed(base: string): void {
    const parsed = new URL(base)
    if (parsed.protocol === 'https:') return
    if (parsed.protocol === 'http:' && this.allowInsecureHosts.includes(parsed.hostname.toLowerCase())) {
      return
    }
    throw new AppError('CATALOG.CF_MIRROR_INVALID', 'CurseForge 镜像必须使用 HTTPS')
  }

  /**
   * One logical request with official→mirror fallback. The key is only attached
   * as a header, and only when the request goes to one of the configured API
   * bases; download URLs are fetched without it.
   */
  private async request<T>(
    pathname: string,
    query: Record<string, string> = {},
    signal?: AbortSignal,
  ): Promise<T> {
    if (!this.hasApiKey) {
      throw new AppError(
        'CATALOG.CF_KEY_MISSING',
        'CurseForge 导入需要自备 CurseForge API key（仅保存在本机主进程）',
        {
          details: {
            hint: '在设置中填入 CurseForge API key；它只会作为 x-api-key 请求头发送到 API 域名，不会写入 URL、日志或分享包。',
          },
        },
      )
    }
    const errors: string[] = []
    for (const base of this.apiBases()) {
      this.assertMirrorAllowed(base)
      const url = new URL(`${base.replace(/\/+$/, '')}${pathname}`)
      for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
      const timeoutSignal = AbortSignal.timeout(this.timeoutMs)
      const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
      try {
        const response = await this.fetchImpl(url, {
          method: 'GET',
          headers: {
            'x-api-key': this.config.apiKey as string,
            accept: 'application/json',
            'user-agent': this.userAgent,
          },
          signal: combined,
        })
        const host = url.hostname
        this.log?.debug?.('curseforge api request', { host, path: pathname, status: response.status })
        if (response.status === 404) {
          throw new AppError('CATALOG.CF_NOT_FOUND', 'CurseForge 上找不到对应的项目或文件')
        }
        if (response.status === 401 || response.status === 403) {
          throw new AppError(
            'CATALOG.CF_ACCESS_DENIED',
            'CurseForge API 拒绝访问：key 无效、无权限或已过期',
            { details: { status: response.status } },
          )
        }
        if (!response.ok) {
          const message = `CurseForge API HTTP ${response.status}`
          if (isRetryableStatus(response.status)) {
            errors.push(`${host}: ${message}`)
            continue
          }
          throw new AppError('CATALOG.CF_API_FAILED', message, {
            retryable: false,
            details: { status: response.status },
          })
        }
        const body = (await response.json()) as { data?: unknown }
        this.lastSourceHost = host
        return body.data as T
      } catch (error) {
        if (error instanceof AppError) throw error
        if (signal?.aborted) {
          throw new AppError('CATALOG.CANCELLED', 'CurseForge 请求已取消')
        }
        errors.push(`${url.hostname}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    throw new AppError('CATALOG.CF_UNAVAILABLE', 'CurseForge API 暂时不可用（官方与镜像均失败）', {
      retryable: true,
      details: {
        attempts: errors,
        hint: this.config.mirrorBase
          ? '已尝试官方与配置的镜像；请检查网络或稍后重试。'
          : '可在设置中配置 CurseForge API 镜像后重试。',
      },
    })
  }

  async searchModpacks(slug: string, signal?: AbortSignal): Promise<CfProject | null> {
    const data = await this.request<unknown>(
      '/mods/search',
      {
        gameId: String(CF_GAME_ID),
        classId: String(CF_MODPACK_CLASS_ID),
        slug,
        pageSize: '20',
      },
      signal,
    )
    if (!Array.isArray(data)) return null
    const wanted = slug.toLowerCase()
    for (const item of data) {
      const project = parseProject(item)
      if (project && project.slug.toLowerCase() === wanted) return project
    }
    return null
  }

  async project(modId: number, signal?: AbortSignal): Promise<CfProject> {
    const data = await this.request<unknown>(`/mods/${modId}`, {}, signal)
    const project = parseProject(data)
    if (!project) throw new AppError('CATALOG.CF_API_FAILED', 'CurseForge 返回的项目数据不完整')
    return project
  }

  async file(modId: number, fileId: number, signal?: AbortSignal): Promise<CfFile> {
    const data = await this.request<unknown>(`/mods/${modId}/files/${fileId}`, {}, signal)
    const file = parseFile(data)
    if (!file) throw new AppError('CATALOG.CF_API_FAILED', 'CurseForge 返回的文件数据不完整')
    return file
  }

  async files(modId: number, signal?: AbortSignal): Promise<CfFile[]> {
    const data = await this.request<unknown>(
      `/mods/${modId}/files`,
      { pageSize: '50', index: '0' },
      signal,
    )
    if (!Array.isArray(data)) return []
    return data
      .map(parseFile)
      .filter((file): file is CfFile => file !== null)
      .sort((a, b) => (b.fileDate ?? '').localeCompare(a.fileDate ?? ''))
  }
}

/** picks the newest release file, falling back to the newest file of any type. */
export function chooseLatestPackFile(files: CfFile[]): CfFile | null {
  if (files.length === 0) return null
  const releases = files.filter((file) => file.releaseType === 1)
  const pool = releases.length > 0 ? releases : files
  return [...pool].sort((a, b) => (b.fileDate ?? '').localeCompare(a.fileDate ?? ''))[0] ?? null
}

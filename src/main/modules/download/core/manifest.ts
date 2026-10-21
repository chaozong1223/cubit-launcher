import path from 'node:path'
import { z } from 'zod'
import type { DownloadSourceId, ManifestResult, ManifestVersion } from '@shared/download'
import { DownloadError, isNetworkTransportError } from './errors'
import { ensureDir, readTextFile, statOrNull, writeTextAtomic } from './fs-atomic'
import { headerValue, type HttpClient, type HttpLogger } from './http'
import { hashBuffer, type HashAlgorithm } from './hash'
import { withRetries, isRetryable } from './retry'
import {
  MIRROR_MANIFEST_URL,
  OFFICIAL_MANIFEST_URL,
  type SourceRegistry,
} from './sources'

/**
 * Mojang `version_manifest_v2.json` (docs/03 §6.2, 01 R1.1).
 *
 * The manifest is cached for 10 minutes on disk; an expired cache is still used
 * as an offline fallback when every source fails, but the result is flagged
 * `cached: true` so the UI can say so. The version JSON is *not* bundled and
 * not cached outside the instance directory (MC-10/11).
 */

export const MANIFEST_TTL_MS = 10 * 60 * 1000

export const ManifestVersionEntrySchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  url: z.string().min(1),
  sha1: z.string().optional(),
  releaseTime: z.string().optional(),
  complianceLevel: z.number().int().optional(),
})

export const ManifestSchema = z.object({
  latest: z.object({
    release: z.string().min(1),
    snapshot: z.string().min(1),
  }),
  versions: z.array(ManifestVersionEntrySchema).min(1),
})

export type ManifestJson = z.infer<typeof ManifestSchema>
export type ManifestEntry = z.infer<typeof ManifestVersionEntrySchema>

export interface ManifestCacheRecord {
  fetchedAt: number
  source: DownloadSourceId
  manifest: ManifestJson
  /** HTTP validators for the next conditional request (same source only). */
  etag?: string | null
  lastModified?: string | null
}

export interface ManifestDeps {
  http: HttpClient
  sources: SourceRegistry
  cacheDir: string
  now?: () => number
  ttlMs?: number
  retries?: number
  signal?: AbortSignal
  log?: HttpLogger
  /** Test seam; production uses the Mojang/BMCLAPI constants. */
  urls?: { official: string; mirror: string }
}

export interface LoadedManifest {
  result: ManifestResult
  raw: ManifestJson
}

function cacheFile(cacheDir: string): string {
  return path.join(cacheDir, 'version_manifest_v2.json')
}

export function toManifestVersions(entries: ManifestEntry[]): ManifestVersion[] {
  return entries.map((entry) => ({
    id: entry.id,
    type: entry.type,
    url: entry.url,
    sha1: entry.sha1 ?? null,
    releaseTime: entry.releaseTime ?? null,
    complianceLevel: entry.complianceLevel ?? null,
  }))
}

function parseManifest(text: string, origin: string): ManifestJson {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new DownloadError('DOWNLOAD.MANIFEST_INVALID', {
      message: `${origin}: invalid JSON`,
      details: { origin },
      cause: error,
    })
  }
  const result = ManifestSchema.safeParse(parsed)
  if (!result.success) {
    throw new DownloadError('DOWNLOAD.MANIFEST_INVALID', {
      message: `${origin}: ${result.error.issues.slice(0, 3).map((issue) => issue.path.join('.')).join(', ')}`,
      details: { origin, issues: result.error.issues.map((issue) => issue.message).slice(0, 10) },
    })
  }
  return result.data
}

async function readCache(deps: ManifestDeps): Promise<ManifestCacheRecord | null> {
  const file = cacheFile(deps.cacheDir)
  const stat = await statOrNull(file)
  if (!stat) return null
  try {
    const parsed = JSON.parse(await readTextFile(file)) as {
      fetchedAt?: unknown
      source?: unknown
      manifest?: unknown
      etag?: unknown
      lastModified?: unknown
    }
    const manifest = ManifestSchema.safeParse(parsed.manifest)
    if (!manifest.success) return null
    const fetchedAt = typeof parsed.fetchedAt === 'number' ? parsed.fetchedAt : 0
    const source: DownloadSourceId = parsed.source === 'mirror' ? 'mirror' : 'official'
    return {
      fetchedAt,
      source,
      manifest: manifest.data,
      etag: typeof parsed.etag === 'string' ? parsed.etag : null,
      lastModified: typeof parsed.lastModified === 'string' ? parsed.lastModified : null,
    }
  } catch {
    return null
  }
}

async function writeCache(deps: ManifestDeps, record: ManifestCacheRecord): Promise<void> {
  await ensureDir(deps.cacheDir)
  await writeTextAtomic(cacheFile(deps.cacheDir), `${JSON.stringify(record, null, 2)}\n`)
}

function manifestCandidates(
  sources: SourceRegistry,
  urls: { official: string; mirror: string } = {
    official: OFFICIAL_MANIFEST_URL,
    mirror: MIRROR_MANIFEST_URL,
  },
): Array<{ source: DownloadSourceId; url: string }> {
  return sources
    // The manifest has no upstream content hash: official-first is the trust
    // anchor (t42). Mirror is still a fallback when official is unavailable.
    .order('metadata')
    .map((source) => ({
      source,
      url: source === 'mirror' ? urls.mirror : urls.official,
    }))
    .filter((entry) => !sources.isDisabled(entry.source))
}

function metadataWarnings(source: DownloadSourceId): string[] {
  return source === 'mirror'
    ? ['版本清单来自镜像（BMCLAPI），该文件没有上游哈希；已记录来源，建议与官方核对']
    : []
}

/** One source attempt may hide N retries; charge the breaker for all of them. */
function failureWeight(error: unknown, retries = 3): number {
  return isRetryable(error) ? Math.max(1, retries + 1) : 1
}

/** t46: distinguish a network outage (all sources cooling) from bad config. */
function sourceUnavailableError(
  sources: SourceRegistry,
  task: { url: string; mirrorUrl: string | null; sourceHint: 'auto' },
  message: string,
  details: Record<string, unknown>,
  cause?: unknown,
): DownloadError {
  const availability = sources.availability(task, 'metadata')
  const network = availability.network || isNetworkTransportError(cause)
  return new DownloadError(network ? 'DOWNLOAD.NETWORK_UNREACHABLE' : 'DOWNLOAD.NO_SOURCE', {
    message: network
      ? `network unreachable: metadata sources failed or are cooling down (${availability.cooling.join(', ') || 'transport error'}); retry in ${availability.retryAfterMs ?? 0} ms`
      : message,
    details: {
      ...details,
      cooling: availability.cooling,
      retryAfterMs: availability.retryAfterMs,
    },
    ...(cause === undefined ? {} : { cause }),
  })
}

export async function loadManifest(deps: ManifestDeps & { force?: boolean }): Promise<LoadedManifest> {
  const now = deps.now ?? Date.now
  const ttl = deps.ttlMs ?? MANIFEST_TTL_MS
  const cached = await readCache(deps)

  if (!deps.force && cached && now() - cached.fetchedAt <= ttl) {
    return {
      raw: cached.manifest,
      result: {
        fetchedAt: cached.fetchedAt,
        source: cached.source,
        cached: true,
        latest: cached.manifest.latest,
        versions: toManifestVersions(cached.manifest.versions),
        warnings: metadataWarnings(cached.source),
      },
    }
  }

  const attempts: string[] = []
  let lastError: unknown = null
  const manifestTask = {
    url: deps.urls?.official ?? OFFICIAL_MANIFEST_URL,
    mirrorUrl: deps.urls?.mirror ?? MIRROR_MANIFEST_URL,
    sourceHint: 'auto' as const,
  }
  const candidates = manifestCandidates(deps.sources, deps.urls)
  if (candidates.length === 0) {
    throw sourceUnavailableError(
      deps.sources,
      manifestTask,
      `manifest unavailable: no eligible source (${attempts.join(', ')})`,
      { urls: attempts },
    )
  }

  for (const candidate of candidates) {
    attempts.push(candidate.url)
    try {
      const conditional = cached && cached.source === candidate.source ? cached : null
      const headers: Record<string, string> = {}
      if (conditional?.etag) headers['if-none-match'] = conditional.etag
      else if (conditional?.lastModified) headers['if-modified-since'] = conditional.lastModified

      const outcome = await withRetries(
        async () => {
          const response = await deps.http.fetchText(candidate.url, {
            signal: deps.signal,
            headers,
            allowNotModified: Boolean(conditional),
            idleTimeoutMs: 10_000,
            totalTimeoutMs: 20_000,
            isRedirectAllowed: (from, to) =>
              deps.sources.isRedirectAllowed(candidate.source, from, to),
          })
          if (response.status === 304) {
            if (!conditional) {
              throw new DownloadError('DOWNLOAD.HTTP_ERROR', {
                message: `unexpected 304 without a cached manifest: ${response.finalUrl}`,
                details: { url: response.finalUrl },
              })
            }
            return { notModified: true as const, manifest: conditional.manifest, response }
          }
          return {
            notModified: false as const,
            manifest: parseManifest(response.text, response.finalUrl),
            response,
          }
        },
        {
          retries: deps.retries ?? 3,
          signal: deps.signal,
          onRetry: ({ attempt, delayMs, error }) => {
            deps.log?.warn('manifest retry', {
              source: candidate.source,
              attempt,
              delayMs,
              message: error instanceof Error ? error.message : String(error),
            })
          },
        },
      )

      deps.sources.recordSuccess(candidate.source)
      const fetchedAt = now()
      const etag = headerValue(outcome.value.response.headers, 'etag') ?? conditional?.etag ?? null
      const lastModified =
        headerValue(outcome.value.response.headers, 'last-modified') ??
        conditional?.lastModified ??
        null
      await writeCache(deps, {
        fetchedAt,
        source: candidate.source,
        manifest: outcome.value.manifest,
        etag,
        lastModified,
      })
      deps.log?.debug('manifest loaded', {
        source: candidate.source,
        versions: outcome.value.manifest.versions.length,
        notModified: outcome.value.notModified,
        etag: Boolean(etag),
      })
      const warnings = metadataWarnings(candidate.source)
      if (warnings.length > 0) {
        deps.log?.warn('manifest trust warning', {
          source: candidate.source,
          cached: outcome.value.notModified,
          message: warnings.join('; '),
        })
      }
      return {
        raw: outcome.value.manifest,
        result: {
          fetchedAt,
          source: candidate.source,
          cached: outcome.value.notModified,
          latest: outcome.value.manifest.latest,
          versions: toManifestVersions(outcome.value.manifest.versions),
          warnings,
        },
      }
    } catch (error) {
      lastError = error
      deps.sources.recordFailure(
        candidate.source,
        error instanceof Error ? error.message : String(error),
        failureWeight(error, deps.retries ?? 3),
      )
      deps.log?.warn('manifest source failed', {
        source: candidate.source,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  // Offline fallback: an expired cache is better than a dead install button.
  if (cached) {
    deps.log?.warn('manifest using stale cache', {
      fetchedAt: cached.fetchedAt,
      ageMs: now() - cached.fetchedAt,
    })
    return {
      raw: cached.manifest,
      result: {
        fetchedAt: cached.fetchedAt,
        source: cached.source,
        cached: true,
        latest: cached.manifest.latest,
        versions: toManifestVersions(cached.manifest.versions),
        warnings: metadataWarnings(cached.source),
      },
    }
  }

  throw sourceUnavailableError(
    deps.sources,
    manifestTask,
    `manifest unavailable; tried ${attempts.join(', ')}; last: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
    { urls: attempts },
    lastError,
  )
}

export function findManifestVersion(
  manifest: ManifestJson | ManifestEntry[],
  versionId: string,
): ManifestEntry | null {
  const entries = Array.isArray(manifest) ? manifest : manifest.versions
  return entries.find((entry) => entry.id === versionId) ?? null
}

export interface VersionJsonDeps {
  http: HttpClient
  sources: SourceRegistry
  signal?: AbortSignal
  retries?: number
  log?: HttpLogger
}

export interface FetchedVersionJson {
  text: string
  json: Record<string, unknown>
  source: DownloadSourceId
  url: string
  /** Trust warnings (mirror metadata without an upstream hash). */
  warnings: string[]
}

/**
 * Fetches a version JSON into memory (used by `plan`, which must stay
 * read-only). `install` downloads it through the queue so it lands atomically.
 */
export async function fetchVersionJson(
  entry: ManifestEntry,
  deps: VersionJsonDeps,
): Promise<FetchedVersionJson> {
  const task = {
    url: entry.url,
    mirrorUrl: null,
    sourceHint: 'auto' as const,
  }
  const candidates = deps.sources.candidates(task, 'metadata')
  if (candidates.length === 0) {
    throw sourceUnavailableError(
      deps.sources,
      task,
      `no source for version JSON ${entry.id}`,
      { url: entry.url, versionId: entry.id },
    )
  }

  let lastError: unknown = null
  const urls: string[] = []
  for (const candidate of candidates) {
    urls.push(candidate.url)
    try {
      const outcome = await withRetries(
        async () => {
          const response = await deps.http.fetchText(candidate.url, {
            signal: deps.signal,
            idleTimeoutMs: 10_000,
            totalTimeoutMs: 20_000,
            isRedirectAllowed: (from, to) =>
              deps.sources.isRedirectAllowed(candidate.source, from, to, {
                hashPinned: Boolean(entry.sha1),
              }),
          })
          if (entry.sha1) {
            const digest = hashBuffer(Buffer.from(response.text, 'utf8'), ['sha1'])
            if (digest.sha1 !== entry.sha1.toLowerCase()) {
              throw new DownloadError('DOWNLOAD.HASH_MISMATCH', {
                message: `version JSON sha1 mismatch: ${response.finalUrl}`,
                details: {
                  url: response.finalUrl,
                  expected: entry.sha1,
                  actual: digest.sha1 ?? null,
                },
              })
            }
          }
          const json = parseVersionJsonText(response.text, response.finalUrl)
          return { text: response.text, json }
        },
        {
          retries: deps.retries ?? 3,
          signal: deps.signal,
        },
      )
      deps.sources.recordSuccess(candidate.source)
      const warnings =
        candidate.source === 'mirror' && !entry.sha1
          ? ['版本 JSON 来自镜像且清单未提供 SHA1；已记录来源，建议核对官方']
          : []
      if (warnings.length > 0) {
        deps.log?.warn('version JSON trust warning', {
          versionId: entry.id,
          source: candidate.source,
          message: warnings.join('; '),
        })
      }
      return {
        text: outcome.value.text,
        json: outcome.value.json,
        source: candidate.source,
        url: candidate.url,
        warnings,
      }
    } catch (error) {
      lastError = error
      deps.sources.recordFailure(
        candidate.source,
        error instanceof Error ? error.message : String(error),
        failureWeight(error, deps.retries ?? 3),
      )
    }
  }

  throw sourceUnavailableError(
    deps.sources,
    task,
    `version JSON unavailable for ${entry.id}; tried ${urls.join(', ')}; last: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
    { urls, versionId: entry.id },
    lastError,
  )
}

export function parseVersionJsonText(text: string, origin: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new DownloadError('DOWNLOAD.VERSION_JSON_INVALID', {
      message: `${origin}: invalid JSON`,
      details: { origin },
      cause: error,
    })
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new DownloadError('DOWNLOAD.VERSION_JSON_INVALID', {
      message: `${origin}: not an object`,
      details: { origin },
    })
  }
  const json = parsed as Record<string, unknown>
  if (typeof json.id !== 'string' || json.id.length === 0) {
    throw new DownloadError('DOWNLOAD.VERSION_JSON_INVALID', {
      message: `${origin}: missing id`,
      details: { origin },
    })
  }
  if (json.libraries !== undefined && !Array.isArray(json.libraries)) {
    throw new DownloadError('DOWNLOAD.VERSION_JSON_INVALID', {
      message: `${origin}: libraries is not an array`,
      details: { origin },
    })
  }
  if (json.downloads !== undefined && (typeof json.downloads !== 'object' || json.downloads === null)) {
    throw new DownloadError('DOWNLOAD.VERSION_JSON_INVALID', {
      message: `${origin}: downloads is not an object`,
      details: { origin },
    })
  }
  return json
}

export interface AssetIndexObject {
  hash: string
  size: number
}

export const AssetIndexSchema = z.object({
  objects: z.record(
    z.string(),
    z.object({
      hash: z.string().regex(/^[a-f0-9]{40}$/i),
      size: z.number().int().nonnegative(),
    }),
  ),
  /** Legacy indexes only; modern ones omit it. */
  map_to_resources: z.boolean().optional(),
  virtual: z.boolean().optional(),
})

export type AssetIndexJson = z.infer<typeof AssetIndexSchema>

export function parseAssetIndex(text: string, origin: string): AssetIndexJson {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new DownloadError('DOWNLOAD.VERSION_JSON_INVALID', {
      message: `${origin}: invalid asset index JSON`,
      details: { origin },
      cause: error,
    })
  }
  const result = AssetIndexSchema.safeParse(parsed)
  if (!result.success) {
    throw new DownloadError('DOWNLOAD.VERSION_JSON_INVALID', {
      message: `${origin}: asset index does not match the expected shape`,
      details: { origin, issues: result.error.issues.slice(0, 5).map((issue) => issue.message) },
    })
  }
  return result.data
}

/** Downloads an asset index into memory with hash verification (plan path). */
export async function fetchAssetIndex(
  input: { id: string; url: string; sha1?: string | null; size?: number | null },
  deps: VersionJsonDeps,
): Promise<{ index: AssetIndexJson; text: string; source: DownloadSourceId; warnings: string[] }> {
  const task = {
    url: input.url,
    mirrorUrl: null,
    sourceHint: 'auto' as const,
  }
  const candidates = deps.sources.candidates(task)
  if (candidates.length === 0) {
    throw sourceUnavailableError(
      deps.sources,
      task,
      `no source for asset index ${input.id}`,
      { url: input.url, indexId: input.id },
    )
  }

  let lastError: unknown = null
  const algorithms: HashAlgorithm[] = ['sha1']
  for (const candidate of candidates) {
    try {
      const outcome = await withRetries(
        async () => {
          const response = await deps.http.fetchText(candidate.url, {
            signal: deps.signal,
            idleTimeoutMs: 10_000,
            totalTimeoutMs: 20_000,
            isRedirectAllowed: (from, to) =>
              deps.sources.isRedirectAllowed(candidate.source, from, to, {
                hashPinned: Boolean(input.sha1),
              }),
          })
          const buffer = Buffer.from(response.text, 'utf8')
          if (typeof input.size === 'number' && buffer.length !== input.size) {
            throw new DownloadError('DOWNLOAD.SIZE_MISMATCH', {
              message: `asset index size ${buffer.length} != ${input.size}`,
              details: { url: response.finalUrl, expected: input.size, actual: buffer.length },
            })
          }
          if (input.sha1) {
            const digest = hashBuffer(buffer, algorithms)
            if (digest.sha1?.toLowerCase() !== input.sha1.toLowerCase()) {
              throw new DownloadError('DOWNLOAD.HASH_MISMATCH', {
                message: `asset index sha1 mismatch: ${response.finalUrl}`,
                details: {
                  url: response.finalUrl,
                  expected: input.sha1,
                  actual: digest.sha1 ?? null,
                },
              })
            }
          }
          return { text: response.text, index: parseAssetIndex(response.text, response.finalUrl) }
        },
        { retries: deps.retries ?? 3, signal: deps.signal },
      )
      deps.sources.recordSuccess(candidate.source)
      const warnings =
        candidate.source === 'mirror' && !input.sha1
          ? ['资源索引来自镜像且版本 JSON 未提供 SHA1；已记录来源，建议核对官方']
          : []
      if (warnings.length > 0) {
        deps.log?.warn('asset index trust warning', {
          id: input.id,
          source: candidate.source,
          message: warnings.join('; '),
        })
      }
      return { ...outcome.value, source: candidate.source, warnings }
    } catch (error) {
      lastError = error
      deps.sources.recordFailure(
        candidate.source,
        error instanceof Error ? error.message : String(error),
        failureWeight(error, deps.retries ?? 3),
      )
    }
  }

  throw sourceUnavailableError(
    deps.sources,
    task,
    `asset index unavailable for ${input.id}; last: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
    { url: input.url, indexId: input.id },
    lastError,
  )
}

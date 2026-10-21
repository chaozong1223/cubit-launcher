import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { InstallerInfo, LoaderType } from '@shared/loader'
import { LoaderError } from './errors'
import { LoaderHttp } from './http'
import { minecraftVersionFromNeoForge } from '../../../core/version/load'

/**
 * Loader metadata (versions + installer URLs).
 *
 * Endpoints (verified 2026-10-21):
 *  - Fabric: BMCLAPI `/fabric-meta` mirrors `meta.fabricmc.net` (fast), official
 *    fallback.
 *  - Quilt: `meta.quiltmc.org` only — BMCLAPI `/quilt-meta` returned 404.
 *  - Forge: BMCLAPI `/forge/minecraft/<mc>` returns versions *and* the installer
 *    sha1 (40 hex); official maven-metadata.xml is the fallback.
 *  - NeoForge 1.20.1 lives under `net.neoforged:forge` (versions
 *    `1.20.1-47.1.x`); 1.20.2+ under `net.neoforged:neoforge` (`20.2.x`…).
 *    `minecraftVersionFromNeoForge()` from the t6 core maps the latter.
 *
 * Nothing here is hardcoded per version: the mapping always comes from the
 * loader's own metadata (task requirement).
 */

export const BMCLAPI_MAVEN = 'https://bmclapi2.bangbang93.com/maven'
export const FORGE_MAVEN = 'https://maven.minecraftforge.net'
export const NEOFORGE_MAVEN = 'https://maven.neoforged.net/releases'
export const FABRIC_META_MIRROR = 'https://bmclapi2.bangbang93.com/fabric-meta'
export const FABRIC_META_OFFICIAL = 'https://meta.fabricmc.net'
export const QUILT_META_OFFICIAL = 'https://meta.quiltmc.org'

export const META_TTL_MS = 10 * 60 * 1000

export interface LoaderEndpoints {
  fabricMeta: string[]
  quiltMeta: string[]
  forgeList: (mcVersion: string) => string[]
  forgeMaven: string[]
  neoList: (mcVersion: string) => string[]
  neoMaven: string[]
}

export function defaultEndpoints(): LoaderEndpoints {
  return {
    fabricMeta: [FABRIC_META_MIRROR, FABRIC_META_OFFICIAL],
    quiltMeta: [QUILT_META_OFFICIAL],
    forgeList: (mc) => [
      `https://bmclapi2.bangbang93.com/forge/minecraft/${encodeURIComponent(mc)}`,
      `${FORGE_MAVEN}/net/minecraftforge/forge/maven-metadata.xml`,
    ],
    forgeMaven: [BMCLAPI_MAVEN, FORGE_MAVEN],
    neoList: (mc) =>
      mc === '1.20.1'
        ? [
            `https://bmclapi2.bangbang93.com/neoforge/list/${encodeURIComponent(mc)}`,
            `${NEOFORGE_MAVEN}/net/neoforged/forge/maven-metadata.xml`,
          ]
        : [
            `${BMCLAPI_MAVEN}/net/neoforged/neoforge/maven-metadata.xml`,
            `${NEOFORGE_MAVEN}/net/neoforged/neoforge/maven-metadata.xml`,
          ],
    neoMaven: [BMCLAPI_MAVEN, NEOFORGE_MAVEN],
  }
}

export interface MetaVersion {
  version: string
  rawVersion: string | null
  stable: boolean
  recommended: boolean
  installer: InstallerInfo | null
}

export interface MetaListResult {
  type: LoaderType
  mcVersion: string
  fetchedAt: number
  source: 'mirror' | 'official' | 'mixed'
  versions: MetaVersion[]
  warnings: string[]
}

export interface MetaDeps {
  http: LoaderHttp
  endpoints: LoaderEndpoints
  cacheDir: string
  now?: () => number
  ttlMs?: number
  signal?: AbortSignal
  log?: { debug(message: string, fields?: Record<string, unknown>): void; warn(message: string, fields?: Record<string, unknown>): void }
}

export const SAFE_VERSION = /^[A-Za-z0-9._+\-]{1,64}$/

export function assertMcVersion(mcVersion: string): string {
  if (!SAFE_VERSION.test(mcVersion)) {
    throw new LoaderError('LOADER.INVALID_INPUT', {
      message: `unsafe mc version: ${mcVersion}`,
      details: { mcVersion },
    })
  }
  return mcVersion
}

export function assertLoaderVersion(version: string): string {
  if (!SAFE_VERSION.test(version)) {
    throw new LoaderError('LOADER.INVALID_INPUT', {
      message: `unsafe loader version: ${version}`,
      details: { version },
    })
  }
  return version
}

function numericParts(value: string): number[] {
  return value
    .split(/[.+-]/)
    .map((part) => Number.parseInt(part, 10))
    .filter((part) => Number.isFinite(part))
}

export function compareLoaderVersions(a: string, b: string): number {
  const left = numericParts(a)
  const right = numericParts(b)
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0)
    if (diff !== 0) return diff
  }
  return a.localeCompare(b)
}

function isStableVersion(version: string): boolean {
  return !/alpha|beta|snapshot|pre|rc/i.test(version)
}

/** Marks the newest stable entry as recommended; stable is a version-string test. */
export function finalizeVersions(entries: MetaVersion[]): MetaVersion[] {
  const sorted = [...entries].sort((a, b) => compareLoaderVersions(b.version, a.version))
  let recommended = false
  return sorted.map((entry) => {
    const stable = entry.stable && isStableVersion(entry.version)
    const mark = stable && !recommended
    if (mark) recommended = true
    return { ...entry, stable, recommended: mark }
  })
}

export function selectVersion(
  entries: MetaVersion[],
  requested: string | undefined,
): MetaVersion | null {
  const list = finalizeVersions(entries)
  if (requested) {
    const wanted = requested.trim().toLowerCase()
    const exact = list.find(
      (entry) =>
        entry.version.toLowerCase() === wanted ||
        (entry.rawVersion ?? '').toLowerCase() === wanted,
    )
    if (!exact) return null
    return { ...exact, recommended: true }
  }
  return (
    list.find((entry) => entry.recommended) ??
    list.find((entry) => entry.stable) ??
    list[0] ??
    null
  )
}

// ---------------------------------------------------------------- parsers

export function parseFabricList(json: unknown): MetaVersion[] {
  if (!Array.isArray(json)) {
    throw new LoaderError('LOADER.PROFILE_INVALID', { message: 'fabric list is not an array' })
  }
  const entries: MetaVersion[] = []
  for (const raw of json) {
    const record = raw as {
      loader?: { version?: unknown; stable?: unknown }
    }
    const version = record?.loader?.version
    if (typeof version !== 'string' || !SAFE_VERSION.test(version)) continue
    entries.push({
      version,
      rawVersion: null,
      stable: record.loader?.stable !== false,
      recommended: false,
      installer: null,
    })
  }
  return entries
}

export function parseQuiltList(json: unknown): MetaVersion[] {
  return parseFabricList(json)
}

export interface ForgeListEntry {
  version: string
  rawVersion: string
  build: number
  installer: InstallerInfo
}

export function parseForgeList(json: unknown, mcVersion: string, endpoints: LoaderEndpoints): MetaVersion[] {
  if (!Array.isArray(json)) {
    throw new LoaderError('LOADER.PROFILE_INVALID', { message: 'forge list is not an array' })
  }
  const entries: MetaVersion[] = []
  for (const raw of json) {
    const record = raw as {
      version?: unknown
      mcversion?: unknown
      build?: unknown
      files?: Array<{ format?: unknown; category?: unknown; hash?: unknown }>
    }
    if (typeof record.version !== 'string' || !SAFE_VERSION.test(record.version)) continue
    if (typeof record.mcversion === 'string' && record.mcversion !== mcVersion) continue
    const rawVersion = `${mcVersion}-${record.version}`
    const files = Array.isArray(record.files) ? record.files : []
    const installerFile = files.find(
      (file) => file.category === 'installer' && file.format === 'jar',
    )
    const sha1 =
      typeof installerFile?.hash === 'string' && /^[a-f0-9]{40}$/i.test(installerFile.hash)
        ? installerFile.hash.toLowerCase()
        : null
    entries.push({
      version: record.version,
      rawVersion,
      stable: true,
      recommended: false,
      installer: buildForgeInstaller(rawVersion, sha1, endpoints, sha1 ? 'list' : 'none'),
    })
  }
  return entries
}

export function parseMavenMetadataVersions(xml: string): string[] {
  const versions: string[] = []
  for (const match of xml.matchAll(/<version>([^<]+)<\/version>/g)) {
    const value = match[1]?.trim()
    if (value && SAFE_VERSION.test(value)) versions.push(value)
  }
  return versions
}

export function parseNeoForgeList(
  json: unknown,
  mcVersion = '1.20.1',
): Array<{ version: string; rawVersion: string }> {
  if (!Array.isArray(json)) {
    throw new LoaderError('LOADER.PROFILE_INVALID', { message: 'neoforge list is not an array' })
  }
  const normalize = (value: string): string | null => {
    // The BMCLAPI list mixes `{"version":"47.1.5"}` with
    // `{"version":"1.20.1-47.1.105","rawVersion":"1.20.1-forge-47.1.105"}`.
    const prefixes = [`${mcVersion}-forge-`, `${mcVersion}-`]
    for (const prefix of prefixes) {
      if (value.startsWith(prefix)) {
        const stripped = value.slice(prefix.length)
        return stripped.length > 0 ? stripped : null
      }
    }
    return SAFE_VERSION.test(value) ? value : null
  }

  const out: Array<{ version: string; rawVersion: string }> = []
  for (const raw of json) {
    const record = raw as { version?: unknown; rawVersion?: unknown; mcversion?: unknown }
    const rawVersion = typeof record.rawVersion === 'string' ? record.rawVersion : null
    const versionRaw = typeof record.version === 'string' ? record.version : null
    const version = normalize(versionRaw ?? rawVersion ?? '') ?? (rawVersion ? normalize(rawVersion) : null)
    if (!version) continue
    if (typeof record.mcversion === 'string' && record.mcversion !== mcVersion) continue
    out.push({ version, rawVersion: rawVersion ?? `${mcVersion}-${version}` })
  }
  return out
}

export function parseNeoForgeMavenVersions(
  versions: string[],
  mcVersion: string,
): Array<{ version: string; rawVersion: string }> {
  return versions
    .filter((version) => SAFE_VERSION.test(version))
    .filter((version) => minecraftVersionFromNeoForge(version) === mcVersion)
    .map((version) => ({ version, rawVersion: version }))
}

// ------------------------------------------------------------- installer urls

export function buildForgeInstaller(
  rawVersion: string,
  sha1: string | null,
  endpoints: LoaderEndpoints,
  hashSource: InstallerInfo['hashSource'],
): InstallerInfo {
  const [mirrorBase, officialBase = FORGE_MAVEN] = endpoints.forgeMaven
  const relative = `net/minecraftforge/forge/${rawVersion}/forge-${rawVersion}-installer.jar`
  return {
    url: `${officialBase.replace(/\/+$/, '')}/${relative}`,
    mirrorUrl: mirrorBase ? `${mirrorBase.replace(/\/+$/, '')}/${relative}` : null,
    fileName: `forge-${rawVersion}-installer.jar`,
    sha1,
    size: null,
    hashSource,
    hashNote:
      hashSource === 'none'
        ? '官方 maven 的 .sha1 未取到；继续安装需要确认风险'
        : null,
  }
}

export function buildNeoForgeInstaller(
  mcVersion: string,
  version: string,
  endpoints: LoaderEndpoints,
  sha1: string | null = null,
  hashSource: InstallerInfo['hashSource'] = 'none',
): InstallerInfo {
  const [mirrorBase, officialBase = NEOFORGE_MAVEN] = endpoints.neoMaven
  let relative: string
  let fileName: string
  if (mcVersion === '1.20.1') {
    const rawVersion = `${mcVersion}-${version}`
    relative = `net/neoforged/forge/${rawVersion}/forge-${rawVersion}-installer.jar`
    fileName = `forge-${rawVersion}-installer.jar`
  } else {
    relative = `net/neoforged/neoforge/${version}/neoforge-${version}-installer.jar`
    fileName = `neoforge-${version}-installer.jar`
  }
  return {
    url: `${officialBase.replace(/\/+$/, '')}/${relative}`,
    mirrorUrl: mirrorBase ? `${mirrorBase.replace(/\/+$/, '')}/${relative}` : null,
    fileName,
    sha1,
    size: null,
    hashSource,
    hashNote:
      hashSource === 'none'
        ? '官方 maven 的 .sha1 未取到；继续安装需要确认风险'
        : null,
  }
}

export function forgeInstallerSha1Url(installer: InstallerInfo): string | null {
  return installer.url ? `${installer.url}.sha1` : null
}

export function neoInstallerSha1Url(installer: InstallerInfo): string | null {
  return installer.url ? `${installer.url}.sha1` : null
}

export function parseSha1Text(text: string): string | null {
  const match = /([a-f0-9]{40})/i.exec(text.trim())
  return match ? match[1].toLowerCase() : null
}

// ------------------------------------------------------------------- cache

function cacheKey(type: LoaderType, mcVersion: string): string {
  return `${type}-${mcVersion}-versions.json`
}

interface CacheRecord {
  fetchedAt: number
  source: 'mirror' | 'official' | 'mixed'
  versions: MetaVersion[]
  warnings: string[]
}

async function readCache(deps: MetaDeps, type: LoaderType, mcVersion: string): Promise<CacheRecord | null> {
  const file = path.join(deps.cacheDir, cacheKey(type, mcVersion))
  try {
    const stat = await fsp.stat(file)
    if (!stat.isFile()) return null
    const parsed = JSON.parse(await fsp.readFile(file, 'utf8')) as CacheRecord
    if (!Array.isArray(parsed.versions)) return null
    return parsed
  } catch {
    return null
  }
}

async function writeCache(
  deps: MetaDeps,
  type: LoaderType,
  mcVersion: string,
  record: CacheRecord,
): Promise<void> {
  try {
    await fsp.mkdir(deps.cacheDir, { recursive: true })
    await fsp.writeFile(
      path.join(deps.cacheDir, cacheKey(type, mcVersion)),
      `${JSON.stringify(record, null, 2)}\n`,
      'utf8',
    )
  } catch {
    /* cache is best effort */
  }
}

export function clearMetaCache(cacheDir: string, type?: LoaderType, mcVersion?: string): void {
  try {
    if (type && mcVersion) {
      fs.rmSync(path.join(cacheDir, cacheKey(type, mcVersion)), { force: true })
      return
    }
    fs.rmSync(cacheDir, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
}

// ---------------------------------------------------------------- fetching

async function fetchFirst(
  deps: MetaDeps,
  urls: string[],
  options: { hashPinned?: boolean; maxBytes?: number } = {},
): Promise<{ text: string; url: string; index: number }> {
  let lastError: unknown = null
  for (let index = 0; index < urls.length; index += 1) {
    const url = urls[index]
    try {
      const response = await deps.http.fetchText(url, {
        signal: deps.signal,
        totalTimeoutMs: 20_000,
        maxBytes: options.maxBytes,
        hashPinned: options.hashPinned,
      })
      return { text: response.text, url: response.finalUrl, index }
    } catch (error) {
      lastError = error
      deps.log?.warn('loader meta source failed', {
        url,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }
  throw new LoaderError('LOADER.META_UNAVAILABLE', {
    message: `all metadata sources failed; last: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
    details: { urls },
    cause: lastError,
  })
}

function sourceLabel(index: number): 'mirror' | 'official' {
  return index === 0 ? 'mirror' : 'official'
}

export async function listLoaderVersions(
  deps: MetaDeps,
  type: LoaderType,
  mcVersionRaw: string,
  options: { force?: boolean } = {},
): Promise<MetaListResult> {
  const mcVersion = assertMcVersion(mcVersionRaw)
  const now = deps.now ?? Date.now
  const ttl = deps.ttlMs ?? META_TTL_MS
  const cached = await readCache(deps, type, mcVersion)
  if (!options.force && cached && now() - cached.fetchedAt <= ttl) {
    return {
      type,
      mcVersion,
      fetchedAt: cached.fetchedAt,
      source: cached.source,
      versions: finalizeVersions(cached.versions),
      warnings: cached.warnings,
    }
  }

  let versions: MetaVersion[] = []
  let source: 'mirror' | 'official' | 'mixed' = 'official'
  const warnings: string[] = []

  if (type === 'fabric' || type === 'quilt') {
    const bases = type === 'fabric' ? deps.endpoints.fabricMeta : deps.endpoints.quiltMeta
    const urls = bases.map(
      (base) => `${base.replace(/\/+$/, '')}/v2/versions/loader/${encodeURIComponent(mcVersion)}`,
    )
    // Quilt uses v3; keep URLs explicit per type.
    const quiltUrls = bases.map(
      (base) => `${base.replace(/\/+$/, '')}/v3/versions/loader/${encodeURIComponent(mcVersion)}`,
    )
    const response = await fetchFirst(deps, type === 'fabric' ? urls : quiltUrls, { maxBytes: 4 * 1024 * 1024 })
    versions =
      type === 'fabric'
        ? parseFabricList(JSON.parse(response.text))
        : parseQuiltList(JSON.parse(response.text))
    source = type === 'fabric' ? sourceLabel(response.index) : 'official'
  } else if (type === 'forge') {
    const urls = deps.endpoints.forgeList(mcVersion)
    let lastError: unknown = null
    for (let index = 0; index < urls.length; index += 1) {
      try {
        const response = await fetchFirst(deps, [urls[index]], { maxBytes: 4 * 1024 * 1024 })
        const text = response.text.trim()
        if (text.startsWith('<')) {
          const mavenVersions = parseMavenMetadataVersions(text)
            .filter((version) => version.startsWith(`${mcVersion}-`))
            .map((rawVersion) => ({
              version: rawVersion.slice(mcVersion.length + 1),
              rawVersion,
              stable: true,
              recommended: false,
              // Hash is resolved at plan time from the official .sha1.
              installer: buildForgeInstaller(rawVersion, null, deps.endpoints, 'none'),
            }))
          versions = mavenVersions
        } else {
          versions = parseForgeList(JSON.parse(text), mcVersion, deps.endpoints)
        }
        source = sourceLabel(index)
        break
      } catch (error) {
        lastError = error
      }
    }
    if (versions.length === 0) {
      throw new LoaderError('LOADER.VERSION_LIST_UNSUPPORTED', {
        message: `no Forge versions for ${mcVersion}: ${
          lastError instanceof Error ? lastError.message : 'empty list'
        }`,
        details: { mcVersion },
      })
    }
  } else {
    const urls = deps.endpoints.neoList(mcVersion)
    let lastError: unknown = null
    for (let index = 0; index < urls.length; index += 1) {
      try {
        const response = await fetchFirst(deps, [urls[index]], { maxBytes: 4 * 1024 * 1024 })
        const text = response.text.trim()
        let pairs: Array<{ version: string; rawVersion: string }>
        if (text.startsWith('<')) {
          pairs = parseNeoForgeMavenVersions(parseMavenMetadataVersions(text), mcVersion)
        } else {
          pairs = parseNeoForgeList(JSON.parse(text), mcVersion)
        }
        versions = pairs.map((pair) => ({
          version: pair.version,
          rawVersion: pair.rawVersion,
          stable: true,
          recommended: false,
          installer: buildNeoForgeInstaller(mcVersion, pair.version, deps.endpoints),
        }))
        source = sourceLabel(index)
        break
      } catch (error) {
        lastError = error
      }
    }
    if (versions.length === 0) {
      throw new LoaderError('LOADER.VERSION_LIST_UNSUPPORTED', {
        message: `no NeoForge versions for ${mcVersion}: ${
          lastError instanceof Error ? lastError.message : 'empty list'
        }`,
        details: { mcVersion },
      })
    }
  }

  if (versions.length === 0) {
    throw new LoaderError('LOADER.VERSION_NOT_FOUND', {
      message: `loader list is empty for ${type} ${mcVersion}`,
      details: { type, mcVersion },
    })
  }

  const finalized = finalizeVersions(versions)
  const fetchedAt = now()
  await writeCache(deps, type, mcVersion, {
    fetchedAt,
    source,
    versions: finalized,
    warnings,
  })

  return { type, mcVersion, fetchedAt, source, versions: finalized, warnings }
}

/** Fetches and validates a Fabric/Quilt profile JSON (version JSON with inheritsFrom). */
export async function fetchLoaderProfile(
  deps: MetaDeps,
  type: 'fabric' | 'quilt',
  mcVersion: string,
  loaderVersion: string,
): Promise<{ json: Record<string, unknown>; source: 'mirror' | 'official' }> {
  const safeMc = assertMcVersion(mcVersion)
  const safeLoader = assertLoaderVersion(loaderVersion)
  const bases = type === 'fabric' ? deps.endpoints.fabricMeta : deps.endpoints.quiltMeta
  const segment = type === 'fabric' ? 'v2' : 'v3'
  const urls = bases.map(
    (base) =>
      `${base.replace(/\/+$/, '')}/${segment}/versions/loader/${encodeURIComponent(safeMc)}/${encodeURIComponent(safeLoader)}/profile/json`,
  )
  const response = await fetchFirst(deps, urls, { maxBytes: 4 * 1024 * 1024 })
  let parsed: unknown
  try {
    parsed = JSON.parse(response.text)
  } catch (error) {
    throw new LoaderError('LOADER.PROFILE_INVALID', {
      message: `profile is not JSON: ${response.url}`,
      cause: error,
    })
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new LoaderError('LOADER.PROFILE_INVALID', { message: `profile is not an object: ${response.url}` })
  }
  const json = parsed as Record<string, unknown>
  if (
    typeof json.id !== 'string' ||
    json.id.length === 0 ||
    json.inheritsFrom !== safeMc ||
    !Array.isArray(json.libraries)
  ) {
    throw new LoaderError('LOADER.PROFILE_INVALID', {
      message: `profile is missing id/inheritsFrom/libraries: ${response.url}`,
      details: { url: response.url, id: json.id ?? null, inheritsFrom: json.inheritsFrom ?? null },
    })
  }
  return { json, source: type === 'fabric' ? sourceLabel(response.index) : 'official' }
}

/** Reads the official `.sha1` for an installer (fallback when the list has none). */
export async function fetchInstallerSha1(
  deps: MetaDeps,
  installer: InstallerInfo,
  options: { allowMirror?: boolean; timeoutMs?: number } = {},
): Promise<{ sha1: string; source: 'official' | 'mirror' } | null> {
  const urls: Array<{ url: string; source: 'official' | 'mirror' }> = []
  urls.push({ url: `${installer.url}.sha1`, source: 'official' })
  if (options.allowMirror && installer.mirrorUrl) {
    urls.push({ url: `${installer.mirrorUrl}.sha1`, source: 'mirror' })
  }
  for (const candidate of urls) {
    try {
      const response = await deps.http.fetchText(candidate.url, {
        signal: deps.signal,
        totalTimeoutMs: options.timeoutMs ?? 2_500,
        maxBytes: 1024,
        hashPinned: true,
      })
      const sha1 = parseSha1Text(response.text)
      if (sha1) return { sha1, source: candidate.source }
    } catch (error) {
      deps.log?.debug('installer sha1 unavailable', {
        url: candidate.url,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return null
}

/** Predicts the version directory id created by an installer (confirmed later). */
export function predictVersionId(type: LoaderType, mcVersion: string, loaderVersion: string): string {
  if (type === 'fabric') return `fabric-loader-${loaderVersion}-${mcVersion}`
  if (type === 'quilt') return `quilt-loader-${loaderVersion}-${mcVersion}`
  if (type === 'forge') return `${mcVersion}-forge-${loaderVersion}`
  return mcVersion === '1.20.1'
    ? `${mcVersion}-neoforge-${loaderVersion}`
    : `neoforge-${loaderVersion}`
}

import path from 'node:path'
import type { DownloadTask, InstallPlanSummary } from '@shared/download'
import type { AssetIndexJson, ManifestEntry } from './manifest'
import { DownloadError } from './errors'
import { mirrorClientJarUrl, mirrorUrlFor } from './sources'
import { createRuleContext, isRuleSetAllowed } from '../../../core/version/rules'
import {
  libraryArtifactPath,
  libraryClassifierPath,
  mavenRelativePath,
  parseLibraryName,
} from '../../../core/version/name'
import type { VersionJson, VersionLibrary } from '../../../core/version/types'

/**
 * Install plan: version JSON + asset index → `DownloadTask[]` (docs/03 §6.2).
 *
 *  - libraries are filtered by the version JSON `rules` for the current
 *    OS/arch, exactly like the launch classpath;
 *  - classic natives use `natives[os]` + `downloads.classifiers[classifier]`;
 *  - modern natives are ordinary libraries whose classifier is `natives-*`;
 *    every OS-matching architecture variant is downloaded (1.20.1 = 21 jars)
 *    but only the current architecture is extracted by the launch chain;
 *  - assets come from `assets/objects/<hash[0..2]>/<hash>` (01 R1.4);
 *  - files without an upstream hash are only accepted from official hosts
 *    (SEC-DL-04) and are marked `unverified`.
 */

export type TaskLabel = 'client' | 'library' | 'logging' | 'asset' | 'version-json' | 'asset-index'

export interface PlannedTask extends DownloadTask {
  id: string
  destRel: string
  label: TaskLabel
}

export interface PlanBuildInput {
  versionId: string
  mcRoot: string
  version: VersionJson
  assetIndex: AssetIndexJson | null
  platform?: NodeJS.Platform
  arch?: string
  features?: Record<string, boolean>
  mirrorBase?: string
  /** Test seam / self-hosted asset mirror; defaults to Mojang's CDN. */
  assetBaseUrl?: string
  /** Async stat injected by the service (keeps the planner fs-agnostic). */
  stat?: (absolutePath: string) => Promise<{ size: number } | null>
}

export interface PlanBuildResult {
  tasks: PlannedTask[]
  summary: InstallPlanSummary
  warnings: string[]
  libraryStats: { total: number; allowed: number; skipped: number; natives: number }
}

export interface LibraryPlanResult {
  tasks: PlannedTask[]
  stats: { total: number; allowed: number; skipped: number; natives: number }
  warnings: string[]
}

const OFFICIAL_HOST_SUFFIXES = ['mojang.com', 'minecraft.net', 'mojang.net']

/**
 * Official loader repositories. P0 only *parses* Forge/Fabric profiles, but a
 * user may still ask for a repair; their version JSON often omits hashes and
 * only ships a `url` base. These hosts are the loaders' own mavens (not an
 * arbitrary mirror), so a hash-less file is accepted as `unverified` and logged
 * (SEC-DL-04's "third-party or custom source" rule still rejects everything
 * else). P1 loader installers will fetch the maven `.sha1` files instead.
 */
const TRUSTED_VENDOR_HOSTS = [
  'maven.minecraftforge.net',
  'files.minecraftforge.net',
  'maven.neoforged.net',
  'maven.fabricmc.net',
  'maven.quiltmc.org',
]

function isTrustedHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  return (
    OFFICIAL_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`)) ||
    TRUSTED_VENDOR_HOSTS.includes(host)
  )
}

export function isOfficialHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  return OFFICIAL_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname
  } catch {
    return null
  }
}

function normalizeSize(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null
}

function downloadTaskId(label: TaskLabel, destRel: string): string {
  return `${label}:${destRel}`
}

function dedupe(tasks: PlannedTask[]): PlannedTask[] {
  const byDest = new Map<string, PlannedTask>()
  for (const task of tasks) {
    const existing = byDest.get(task.destRel)
    if (!existing) {
      byDest.set(task.destRel, task)
      continue
    }
    // Prefer the variant that carries a hash (the same jar can appear as a
    // plain artifact and as a native classifier in hand-edited version JSON).
    if (!existing.sha1 && task.sha1) byDest.set(task.destRel, task)
  }
  return [...byDest.values()]
}

/**
 * Resolves one library into 0..2 tasks (main artifact + native classifier).
 * Exported for focused tests.
 */
export function libraryTasks(
  library: VersionLibrary,
  input: {
    librariesDir: string
    platform: NodeJS.Platform
    arch: string
    features: Record<string, boolean>
    mirrorBase?: string
    warnings: string[]
  },
): { tasks: PlannedTask[]; natives: number; allowed: boolean } {
  const coordinate = parseLibraryName(library.name)
  if (!coordinate) return { tasks: [], natives: 0, allowed: false }

  const context = createRuleContext(input.platform, input.arch, input.features)
  if (!isRuleSetAllowed(library.rules, context)) {
    return { tasks: [], natives: 0, allowed: false }
  }

  const tasks: PlannedTask[] = []
  let natives = 0

  const pushArtifact = (options: {
    destRel: string
    url: string
    sha1?: string | null
    sha256?: string | null
    sha512?: string | null
    size?: number | null
    label: TaskLabel
  }) => {
    const host = hostOf(options.url)
    const hasHash = Boolean(options.sha1 || options.sha256 || options.sha512)
    if (!hasHash && (!host || !isTrustedHost(host))) {
      throw new DownloadError('DOWNLOAD.HASH_REQUIRED', {
        message: `${library.name}: no hash and not a trusted host (${options.url})`,
        details: { library: library.name, url: options.url },
      })
    }
    if (!hasHash) {
      input.warnings.push(`${library.name}: official source has no hash; file is marked unverified`)
    }
    tasks.push({
      id: downloadTaskId(options.label, options.destRel),
      url: options.url,
      mirrorUrl: mirrorUrlFor(options.url, { base: input.mirrorBase }),
      destRel: options.destRel,
      sha1: options.sha1 ?? null,
      ...(options.sha256 ? { sha256: options.sha256 } : {}),
      ...(options.sha512 ? { sha512: options.sha512 } : {}),
      size: normalizeSize(options.size),
      priority: 5,
      sourceHint: 'auto',
      unverified: !hasHash,
      label: options.label,
    })
  }

  // 1. Classic natives: main artifact on the classpath + classifier jar with DLLs.
  const classicTemplate = library.natives?.[context.os.name]
  if (classicTemplate) {
    const classifier = classicTemplate.replaceAll('${arch}', input.arch === 'x86' ? '32' : '64')
    const classifierInfo = library.downloads?.classifiers?.[classifier]
    if (classifierInfo?.url) {
      const rel = libraryClassifierPath(library, classifier)
      if (rel) {
        pushArtifact({
          destRel: path.join('libraries', rel),
          url: classifierInfo.url,
          sha1: classifierInfo.sha1 ?? null,
          size: classifierInfo.size ?? null,
          label: 'library',
        })
        natives += 1
      }
    } else {
      input.warnings.push(
        `${library.name}: version JSON has no download info for natives classifier ${classifier}`,
      )
    }
  }

  // 2. Main artifact (also covers modern native jars whose classifier is natives-*).
  const artifactRel = libraryArtifactPath(library)
  const artifactInfo = library.downloads?.artifact
  if (artifactInfo?.url && artifactRel) {
    pushArtifact({
      destRel: path.join('libraries', artifactRel),
      url: artifactInfo.url,
      sha1: artifactInfo.sha1 ?? null,
      size: artifactInfo.size ?? null,
      label: 'library',
    })
    if (coordinate.classifier?.startsWith('natives-')) natives += 1
  } else if (library.url && artifactRel && !artifactInfo) {
    // Forge-style libraries that only ship a repository base URL.
    const base = library.url.endsWith('/') ? library.url : `${library.url}/`
    const rel = mavenRelativePath(coordinate)
    pushArtifact({
      destRel: path.join('libraries', rel),
      url: `${base}${rel}`,
      sha1: null,
      size: null,
      label: 'library',
    })
  } else if (artifactRel && !artifactInfo?.url) {
    input.warnings.push(`${library.name}: no usable download URL, skipped`)
  }

  return { tasks, natives, allowed: true }
}

export function buildLibraryTasks(input: {
  version: VersionJson
  mcRoot: string
  platform?: NodeJS.Platform
  arch?: string
  features?: Record<string, boolean>
  mirrorBase?: string
}): LibraryPlanResult {
  const libraries = Array.isArray(input.version.libraries) ? input.version.libraries : []
  const platform = input.platform ?? process.platform
  const arch = input.arch ?? process.arch
  const warnings: string[] = []
  const tasks: PlannedTask[] = []
  let allowed = 0
  let natives = 0

  for (const library of libraries) {
    if (!library || typeof library.name !== 'string') continue
    const result = libraryTasks(library, {
      librariesDir: path.join(input.mcRoot, 'libraries'),
      platform,
      arch,
      features: input.features ?? {},
      ...(input.mirrorBase ? { mirrorBase: input.mirrorBase } : {}),
      warnings,
    })
    if (result.allowed) allowed += 1
    natives += result.natives
    tasks.push(...result.tasks)
  }

  return {
    tasks: dedupe(tasks),
    stats: { total: libraries.length, allowed, skipped: libraries.length - allowed, natives },
    warnings,
  }
}

export function buildClientTask(input: {
  versionId: string
  version: VersionJson
  mirrorBase?: string
  warnings: string[]
}): PlannedTask | null {
  const client = input.version.downloads?.client
  if (!client?.url) {
    input.warnings.push('version JSON has no client jar download info (loader profiles inherit it)')
    return null
  }
  const destRel = path.posix.join('versions', input.versionId, `${input.versionId}.jar`)
  return {
    id: downloadTaskId('client', destRel),
    url: client.url,
    mirrorUrl: mirrorClientJarUrl(input.versionId, { base: input.mirrorBase }),
    destRel,
    sha1: client.sha1 ?? null,
    size: normalizeSize(client.size),
    priority: 9,
    sourceHint: 'auto',
    unverified: !client.sha1,
    label: 'client',
  }
}

export function buildLoggingTask(input: {
  version: VersionJson
  mirrorBase?: string
  warnings: string[]
}): PlannedTask | null {
  const file = input.version.logging?.client?.file
  if (!file?.url || !file.id) return null
  const base = path.posix.basename(file.id)
  const destRel = path.posix.join('assets', 'log_configs', base)
  return {
    id: downloadTaskId('logging', destRel),
    url: file.url,
    // BMCLAPI returns 404 for piston-data objects (verified 2026-10-21); no override.
    mirrorUrl: mirrorUrlFor(file.url, { base: input.mirrorBase }),
    destRel,
    sha1: file.sha1 ?? null,
    size: normalizeSize(file.size),
    priority: 8,
    sourceHint: 'auto',
    unverified: !file.sha1,
    label: 'logging',
  }
}

export function assetObjectRel(hash: string): string {
  return path.posix.join('assets', 'objects', hash.slice(0, 2), hash)
}

export const DEFAULT_ASSET_BASE_URL = 'https://resources.download.minecraft.net'

export function assetObjectUrl(hash: string, base = DEFAULT_ASSET_BASE_URL): string {
  const root = base.replace(/\/+$/, '')
  return `${root}/${hash.slice(0, 2)}/${hash}`
}

export function buildAssetTasks(input: {
  assetIndex: AssetIndexJson | null
  mirrorBase?: string
  /** Test seam / self-hosted asset mirror; defaults to Mojang's CDN. */
  assetBaseUrl?: string
}): PlannedTask[] {
  if (!input.assetIndex) return []
  const tasks: PlannedTask[] = []
  for (const object of Object.values(input.assetIndex.objects)) {
    const hash = object.hash.toLowerCase()
    const rel = assetObjectRel(hash)
    const url = assetObjectUrl(hash, input.assetBaseUrl)
    tasks.push({
      id: downloadTaskId('asset', rel),
      url,
      mirrorUrl: mirrorUrlFor(url, { base: input.mirrorBase }),
      destRel: rel,
      sha1: hash,
      size: normalizeSize(object.size),
      priority: 3,
      sourceHint: 'auto',
      unverified: false,
      label: 'asset',
    })
  }
  return tasks
}

export function buildVersionJsonTask(input: {
  entry: ManifestEntry
  mirrorBase?: string
}): PlannedTask {
  const destRel = path.posix.join('versions', input.entry.id, `${input.entry.id}.json`)
  return {
    id: downloadTaskId('version-json', destRel),
    url: input.entry.url,
    mirrorUrl: mirrorUrlFor(input.entry.url, { base: input.mirrorBase }),
    destRel,
    sha1: input.entry.sha1 ?? null,
    size: null,
    priority: 10,
    sourceHint: 'auto',
    sourcePolicy: 'metadata',
    unverified: !input.entry.sha1,
    label: 'version-json',
  }
}

export function buildAssetIndexTask(input: {
  version: VersionJson
  mirrorBase?: string
}): PlannedTask | null {
  const index = input.version.assetIndex
  if (!index?.url || !index.id) return null
  const destRel = path.posix.join('assets', 'indexes', `${index.id}.json`)
  return {
    id: downloadTaskId('asset-index', destRel),
    url: index.url,
    mirrorUrl: mirrorUrlFor(index.url, { base: input.mirrorBase }),
    destRel,
    sha1: index.sha1 ?? null,
    size: normalizeSize(index.size),
    priority: 9,
    sourceHint: 'auto',
    unverified: !index.sha1,
    label: 'asset-index',
  }
}

export async function buildInstallPlan(input: PlanBuildInput): Promise<PlanBuildResult> {
  const warnings: string[] = []
  const tasks: PlannedTask[] = []

  const client = buildClientTask({
    versionId: input.versionId,
    version: input.version,
    ...(input.mirrorBase ? { mirrorBase: input.mirrorBase } : {}),
    warnings,
  })
  if (client) tasks.push(client)

  const libraries = buildLibraryTasks({
    version: input.version,
    mcRoot: input.mcRoot,
    ...(input.platform ? { platform: input.platform } : {}),
    ...(input.arch ? { arch: input.arch } : {}),
    ...(input.features ? { features: input.features } : {}),
    ...(input.mirrorBase ? { mirrorBase: input.mirrorBase } : {}),
  })
  warnings.push(...libraries.warnings)
  tasks.push(...libraries.tasks)

  const logging = buildLoggingTask({
    version: input.version,
    ...(input.mirrorBase ? { mirrorBase: input.mirrorBase } : {}),
    warnings,
  })
  if (logging) tasks.push(logging)

  const assets = buildAssetTasks({
    assetIndex: input.assetIndex,
    ...(input.mirrorBase ? { mirrorBase: input.mirrorBase } : {}),
    ...(input.assetBaseUrl ? { assetBaseUrl: input.assetBaseUrl } : {}),
  })
  tasks.push(...assets)

  const finalTasks = dedupe(tasks)

  let missingFiles = 0
  let missingBytes = 0
  const stat = input.stat
  if (stat) {
    for (const task of finalTasks) {
      const absolute = path.join(input.mcRoot, task.destRel)
      const info = await stat(absolute)
      if (!info || (typeof task.size === 'number' && info.size !== task.size)) {
        missingFiles += 1
        missingBytes += task.size ?? 0
      }
    }
  }

  const sumBytes = (list: PlannedTask[]) =>
    list.reduce((total, task) => total + (task.size ?? 0), 0)

  const libraryTaskList = finalTasks.filter((task) => task.label === 'library')
  const assetTaskList = finalTasks.filter((task) => task.label === 'asset')

  const summary: InstallPlanSummary = {
    versionId: input.versionId,
    type: typeof input.version.type === 'string' ? input.version.type : null,
    clientJar: client ? { destRel: client.destRel, size: client.size ?? null } : null,
    libraries: {
      total: libraries.stats.total,
      allowed: libraries.stats.allowed,
      skipped: libraries.stats.skipped,
      natives: libraries.stats.natives,
      files: libraryTaskList.length,
      bytes: sumBytes(libraryTaskList),
    },
    assets: {
      indexId:
        typeof input.version.assetIndex?.id === 'string' ? input.version.assetIndex.id : null,
      objects: assetTaskList.length,
      bytes: sumBytes(assetTaskList),
    },
    logging: finalTasks.filter((task) => task.label === 'logging').length,
    files: finalTasks.length,
    bytes: sumBytes(finalTasks),
    missingFiles,
    missingBytes,
    warnings,
  }

  return { tasks: finalTasks, summary, warnings, libraryStats: libraries.stats }
}

/** Stage shown in the progress payload for a task. */
export function stageForLabel(label: TaskLabel): string {
  switch (label) {
    case 'version-json':
      return 'version-json'
    case 'asset-index':
      return 'assets-index'
    case 'client':
      return 'client'
    case 'library':
      return 'libraries'
    case 'logging':
      return 'logging'
    case 'asset':
      return 'assets'
    default:
      return 'files'
  }
}

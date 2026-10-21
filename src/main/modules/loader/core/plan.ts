import path from 'node:path'
import type { InstallerInfo, LoaderPlan, LoaderType } from '@shared/loader'
import type { FsPort } from '../../../core/ports'
import { javaMajorForMinecraft } from '../../../core/java/version'
import { requiredJavaMajor } from '../../../core/java/select'
import { LoaderError } from './errors'
import {
  assertLoaderVersion,
  assertMcVersion,
  buildForgeInstaller,
  buildNeoForgeInstaller,
  fetchInstallerSha1,
  fetchLoaderProfile,
  listLoaderVersions,
  predictVersionId,
  selectVersion,
  type MetaDeps,
  type MetaVersion,
} from './meta'

/**
 * Builds the pre-install plan shown to the user (SEC-EXE-05 requires showing
 * version/source/hash before the installer is executed).
 *
 * `plan` never writes to the game root, never downloads the installer and never
 * spawns Java; `install` reuses this plan.
 */

export interface LoaderPlanInput {
  type: LoaderType
  mcVersion: string
  loaderVersion?: string
}

export interface LoaderPlanResult {
  plan: LoaderPlan
  entry: MetaVersion
  /** Fabric/Quilt profile JSON (the exact version JSON to write). */
  profile: Record<string, unknown> | null
  hasExplicitLoaderVersion: boolean
}

export interface ParentInfo {
  installed: boolean
  javaMajor: number | null
  warnings: string[]
}

export function readParentInfo(fs: FsPort, mcRoot: string, mcVersion: string): ParentInfo {
  const warnings: string[] = []
  const jsonPath = path.join(mcRoot, 'versions', mcVersion, `${mcVersion}.json`)
  if (!fs.exists(jsonPath)) {
    return { installed: false, javaMajor: null, warnings }
  }
  try {
    const parsed = JSON.parse(fs.readText(jsonPath)) as {
      javaVersion?: { majorVersion?: unknown }
    }
    const major =
      typeof parsed.javaVersion?.majorVersion === 'number'
        ? parsed.javaVersion.majorVersion
        : null
    return { installed: true, javaMajor: major, warnings }
  } catch {
    warnings.push('原版版本 JSON 无法解析，加载器可能无法启动')
    return { installed: false, javaMajor: null, warnings }
  }
}

async function resolveInstallerHash(
  deps: MetaDeps,
  installer: InstallerInfo,
  type: LoaderType,
): Promise<{ installer: InstallerInfo; warnings: string[] }> {
  const warnings: string[] = []
  const current = { ...installer }

  if (type === 'forge') {
    // The mirror list already carries an upstream sha1; prefer the official
    // sidecar when it is reachable and cross-check the two.
    const official = await fetchInstallerSha1(deps, current, { timeoutMs: 2_500 })
    if (official) {
      if (current.sha1 && current.sha1.toLowerCase() !== official.sha1) {
        warnings.push('官方安装器哈希与镜像列表不一致，已采用官方 .sha1')
      }
      return {
        installer: { ...current, sha1: official.sha1, hashSource: 'official', hashNote: null },
        warnings,
      }
    }
    return { installer: current, warnings }
  }

  const resolved = await fetchInstallerSha1(deps, current, { allowMirror: true, timeoutMs: 2_500 })
  if (resolved) {
    return {
      installer: {
        ...current,
        sha1: resolved.sha1,
        hashSource: resolved.source === 'mirror' ? 'mirror' : 'official',
        hashNote: null,
      },
      warnings,
    }
  }
  warnings.push(
    '无法获取安装器的官方 .sha1（NeoForge maven 在当前网络不可达）；继续安装需要用户明确确认风险',
  )
  return { installer: { ...current, sha1: null, hashSource: 'none' }, warnings }
}

export async function buildLoaderPlan(
  deps: MetaDeps,
  fs: FsPort,
  mcRoot: string,
  input: LoaderPlanInput,
): Promise<LoaderPlanResult> {
  const mcVersion = assertMcVersion(input.mcVersion)
  if (!['fabric', 'quilt', 'forge', 'neoforge'].includes(input.type)) {
    throw new LoaderError('LOADER.INVALID_INPUT', {
      message: `unsupported loader: ${String(input.type)}`,
    })
  }
  const parent = readParentInfo(fs, mcRoot, mcVersion)
  const warnings = [...parent.warnings]
  const parentJavaMajor = requiredJavaMajor(parent.javaMajor, mcVersion)
  const fallbackJavaMajor = javaMajorForMinecraft(mcVersion)
  const javaMajor = parentJavaMajor ?? fallbackJavaMajor

  const list = await listLoaderVersions(deps, input.type, mcVersion)
  warnings.push(...list.warnings)
  const entry = selectVersion(list.versions, input.loaderVersion)
  if (!entry) {
    const samples = list.versions.slice(0, 6).map((version) => version.version)
    throw new LoaderError('LOADER.VERSION_NOT_FOUND', {
      message: `loader version ${input.loaderVersion ?? '(latest)'} not found for ${input.type} ${mcVersion}; available: ${samples.join(', ')}`,
      details: { type: input.type, mcVersion, requested: input.loaderVersion ?? null, samples },
    })
  }

  if (!parent.installed) {
    warnings.push(`原版 ${mcVersion} 尚未安装：加载器配置文件会写入，但启动前必须补装原版`)
  }

  if (input.type === 'fabric' || input.type === 'quilt') {
    const profile = await fetchLoaderProfile(deps, input.type, mcVersion, entry.version)
    const id = profile.json.id
    if (typeof id !== 'string' || !/^[A-Za-z0-9._+\-]{1,80}$/.test(id)) {
      throw new LoaderError('LOADER.PROFILE_INVALID', {
        message: `profile id is not path safe: ${String(id)}`,
      })
    }
    const libraries = Array.isArray(profile.json.libraries) ? profile.json.libraries.length : 0
    return {
      plan: {
        type: input.type,
        mcVersion,
        loaderVersion: entry.version,
        versionId: id,
        method: 'meta-json',
        installer: null,
        requiredJavaMajor: javaMajor,
        parentInstalled: parent.installed,
        libraries,
        warnings,
      },
      entry,
      profile: profile.json,
      hasExplicitLoaderVersion: Boolean(input.loaderVersion),
    }
  }

  const baseInstaller =
    input.type === 'forge'
      ? (entry.installer ??
        buildForgeInstaller(entry.rawVersion ?? `${mcVersion}-${entry.version}`, null, deps.endpoints, 'none'))
      : (entry.installer ?? buildNeoForgeInstaller(mcVersion, entry.version, deps.endpoints))
  const resolved = await resolveInstallerHash(deps, baseInstaller, input.type)
  warnings.push(...resolved.warnings)

  return {
    plan: {
      type: input.type,
      mcVersion,
      loaderVersion: entry.version,
      versionId: predictVersionId(input.type, mcVersion, entry.version),
      method: 'installer',
      installer: resolved.installer,
      requiredJavaMajor: javaMajor,
      parentInstalled: parent.installed,
      libraries: null,
      warnings,
    },
    entry,
    profile: null,
    hasExplicitLoaderVersion: Boolean(input.loaderVersion),
  }
}

export function assertVersionIdSafe(versionId: string): string {
  if (!/^[A-Za-z0-9._+\-]{1,80}$/.test(versionId)) {
    throw new LoaderError('LOADER.PROFILE_INVALID', {
      message: `unsafe version id: ${versionId}`,
      details: { versionId },
    })
  }
  return versionId
}

export { assertLoaderVersion }

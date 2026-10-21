import path from 'node:path'
import type { FsPort } from '../ports'
import { resolveVersion, versionsDirectory } from './load'
import { resolveLibraries } from './classpath'
import type { FlattenedVersionJson, LoaderInfo } from './types'

export interface VersionInspection {
  id: string
  dirName: string
  state: 'ready' | 'missing-jar'
  reason: string | null
  type: string | null
  mainClass: string | null
  mcVersion: string | null
  loader: LoaderInfo
  javaMajor: number | null
  chain: string[]
  clientJar: string | null
  clientJarExists: boolean
  flattened: boolean
  warnings: string[]
  libraries: { total: number; allowed: number; classpath: number; natives: number; nativesExtract: number }
  assetIndex: { id: string; totalSize: number | null } | null
  directories: {
    versionDir: string
    gameDir: string
    librariesDir: string
    assetsDir: string
    nativesDir: string
  }
  /** Convenience for dry-run/bat generation; never sent over IPC by default. */
  classpath: string[]
}

export interface InspectOptions {
  versionsDir?: string
  platform?: NodeJS.Platform
  arch?: string
}

export function inspectVersion(
  fs: FsPort,
  mcRoot: string,
  versionId: string,
  options: InspectOptions = {},
): VersionInspection {
  const resolved = resolveVersion(fs, mcRoot, versionId, {
    versionsDir: options.versionsDir,
  })
  const librariesDir = path.join(mcRoot, 'libraries')
  const assetsDir = path.join(mcRoot, 'assets')
  const versionDir = path.join(
    options.versionsDir ?? versionsDirectory(mcRoot),
    resolved.dirName,
  )
  const nativesDir = path.join(versionDir, `${resolved.dirName}-natives`)

  const libraries = resolveLibraries(resolved.json, {
    librariesDir,
    clientJar: resolved.clientJar,
    platform: options.platform,
    arch: options.arch,
    exists: (target) => fs.exists(target),
  })

  const leafNode = resolved.chain[resolved.chain.length - 1]
  const assetIndex = resolved.json.assetIndex
    ? {
        id: resolved.json.assetIndex.id,
        totalSize:
          typeof resolved.json.assetIndex.totalSize === 'number'
            ? resolved.json.assetIndex.totalSize
            : null,
      }
    : null

  const warnings = [...resolved.warnings]
  if (libraries.missing.length > 0) {
    warnings.push(`${libraries.missing.length} library file(s) missing`)
  }
  if (!resolved.clientJarExists) {
    warnings.push('client jar missing; repair before launching')
  }

  return {
    id: resolved.id,
    dirName: resolved.dirName,
    state: resolved.clientJarExists ? 'ready' : 'missing-jar',
    reason: resolved.clientJarExists ? null : 'client jar not found',
    type: typeof resolved.json.type === 'string' ? resolved.json.type : null,
    mainClass: typeof resolved.json.mainClass === 'string' ? resolved.json.mainClass : null,
    mcVersion: resolved.mcVersion,
    loader: resolved.loader,
    javaMajor: resolved.javaMajor,
    chain: resolved.chainIds,
    clientJar: resolved.clientJar,
    clientJarExists: resolved.clientJarExists,
    flattened: !Object.prototype.hasOwnProperty.call(leafNode?.json ?? {}, 'inheritsFrom'),
    warnings,
    libraries: {
      total: (resolved.json.libraries ?? []).length,
      allowed: libraries.allowed.length,
      classpath: libraries.classpath.length,
      natives: libraries.nativeDownloads.length,
      nativesExtract: libraries.natives.length,
    },
    assetIndex,
    directories: {
      versionDir,
      gameDir: versionDir,
      librariesDir,
      assetsDir,
      nativesDir,
    },
    classpath: libraries.classpath,
  }
}

export interface FlattenVersionFileResult {
  id: string
  chain: string[]
  written: boolean
  file: string | null
  json: FlattenedVersionJson
}

/**
 * Flattens `inheritsFrom` into a self-contained JSON. Writes only when asked;
 * a backup is kept once (`<name>.json.bak`) and repeated runs are byte-stable
 * because the caller can inject the clock.
 */
export function flattenVersionFile(
  fs: FsPort,
  mcRoot: string,
  versionId: string,
  options: { write?: boolean; now?: () => number; versionsDir?: string } = {},
): FlattenVersionFileResult {
  const resolved = resolveVersion(fs, mcRoot, versionId, {
    versionsDir: options.versionsDir,
    now: options.now,
    producer: 'mc-launcher',
  })

  if (!options.write) {
    return {
      id: resolved.id,
      chain: resolved.chainIds,
      written: false,
      file: null,
      json: resolved.json,
    }
  }

  const jsonPath = path.join(
    options.versionsDir ?? versionsDirectory(mcRoot),
    resolved.dirName,
    `${resolved.dirName}.json`,
  )
  const backup = `${jsonPath}.bak`
  if (fs.exists(jsonPath) && !fs.exists(backup)) {
    fs.copyFile(jsonPath, backup)
  }
  fs.writeTextAtomic(jsonPath, `${JSON.stringify(resolved.json, null, 2)}\n`)

  return {
    id: resolved.id,
    chain: resolved.chainIds,
    written: true,
    file: jsonPath,
    json: resolved.json,
  }
}

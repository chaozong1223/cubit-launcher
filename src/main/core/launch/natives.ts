import path from 'node:path'
import { winLongPath } from '../../kernel/paths'
import { CoreError } from '../errors'
import { nodeFsPort, type FsPort } from '../ports'
import { extractZip, openZipFile } from '../zip/reader'
import { resolveLibraries } from '../version/classpath'
import type { FlattenedVersionJson } from '../version/types'

export interface NativePlan {
  nativesDir: string
  sources: Array<{ library: string; jarPath: string; exclude: string[] }>
  missing: string[]
  warnings: string[]
}

export interface PlanNativesOptions {
  mcRoot: string
  nativesDir: string
  platform?: NodeJS.Platform
  arch?: string
  exists?: (target: string) => boolean
  clientJar?: string | null
}

/** Builds the extraction plan without touching the native directory. */
export function planNatives(
  version: FlattenedVersionJson,
  options: PlanNativesOptions,
): NativePlan {
  const libraries = resolveLibraries(version, {
    librariesDir: path.join(options.mcRoot, 'libraries'),
    clientJar: options.clientJar ?? null,
    platform: options.platform,
    arch: options.arch,
    exists: options.exists,
  })

  const warnings: string[] = []
  const sources = libraries.natives.filter((source) => {
    const missing = options.exists ? !options.exists(source.jarPath) : false
    if (missing) warnings.push(`native jar missing: ${path.basename(source.jarPath)}`)
    return !missing
  })

  return {
    nativesDir: options.nativesDir,
    sources,
    missing: options.exists
      ? libraries.natives.filter((source) => !options.exists?.(source.jarPath)).map((s) => s.jarPath)
      : [],
    warnings,
  }
}

export interface NativesMarker {
  schemaVersion: 1
  extractedAt: number
  sources: Array<{ library: string; jarPath: string; size: number; mtimeMs: number }>
  files: number
}

export interface ExtractNativesOptions {
  fs?: FsPort
  force?: boolean
  now?: () => number
}

export interface ExtractNativesResult {
  extracted: number
  jars: number
  skipped: string[]
  cacheHit: boolean
  markerFile: string
  missing: string[]
}

function markerFile(nativesDir: string): string {
  return path.join(nativesDir, '.mcl-natives.json')
}

function currentFingerprint(
  fs: FsPort,
  sources: NativePlan['sources'],
): NativesMarker['sources'] {
  return sources.map((source) => {
    const stat = fs.stat(source.jarPath)
    return {
      library: source.library,
      jarPath: source.jarPath,
      size: stat?.size ?? -1,
      mtimeMs: stat?.mtimeMs ?? -1,
    }
  })
}

function cacheMatches(fs: FsPort, nativesDir: string, plan: NativePlan): boolean {
  const file = markerFile(nativesDir)
  if (!fs.exists(file) || !fs.stat(nativesDir)?.isDirectory()) return false
  try {
    const marker = JSON.parse(fs.readText(file)) as NativesMarker
    if (!marker || marker.schemaVersion !== 1 || !Array.isArray(marker.sources)) return false
    const expected = currentFingerprint(fs, plan.sources)
    if (marker.sources.length !== expected.length) return false
    return marker.sources.every((entry, index) => {
      const next = expected[index]
      return (
        entry.library === next.library &&
        entry.jarPath === next.jarPath &&
        entry.size === next.size &&
        entry.mtimeMs === next.mtimeMs
      )
    })
  } catch {
    return false
  }
}

/**
 * Extracts natives into the instance folder. The marker makes relaunches cheap;
 * a changed jar or a forced call rebuilds the whole directory so stale DLLs
 * cannot survive a version update.
 */
export function extractNatives(
  plan: NativePlan,
  options: ExtractNativesOptions = {},
): ExtractNativesResult {
  const fs = options.fs ?? nodeFsPort()
  const markerPath = markerFile(plan.nativesDir)

  if (plan.sources.length === 0) {
    return {
      extracted: 0,
      jars: 0,
      skipped: [],
      cacheHit: false,
      markerFile: markerPath,
      missing: plan.missing,
    }
  }

  if (!options.force && cacheMatches(fs, plan.nativesDir, plan)) {
    return {
      extracted: 0,
      jars: plan.sources.length,
      skipped: [],
      cacheHit: true,
      markerFile: markerPath,
      missing: plan.missing,
    }
  }

  fs.remove(winLongPath(plan.nativesDir))
  fs.mkdirp(winLongPath(plan.nativesDir))

  let extracted = 0
  const skipped: string[] = []

  for (const source of plan.sources) {
    if (!fs.exists(source.jarPath)) {
      plan.missing.push(source.jarPath)
      continue
    }
    let archive
    try {
      archive = openZipFile(fs, source.jarPath)
    } catch (error) {
      throw new CoreError('ARCHIVE.INVALID', {
        message: `native jar is not a valid archive: ${source.jarPath}`,
        details: { jarPath: source.jarPath },
        cause: error,
      })
    }
    const excludes = ['META-INF/', ...source.exclude]
    const result = extractZip(fs, archive, winLongPath(plan.nativesDir), { excludePrefixes: excludes })
    extracted += result.written.length
    skipped.push(...result.skipped)
  }

  const marker: NativesMarker = {
    schemaVersion: 1,
    extractedAt: options.now?.() ?? Date.now(),
    sources: currentFingerprint(fs, plan.sources),
    files: extracted,
  }
  fs.writeTextAtomic(markerPath, `${JSON.stringify(marker, null, 2)}\n`)

  return {
    extracted,
    jars: plan.sources.length,
    skipped,
    cacheHit: false,
    markerFile: markerPath,
    missing: plan.missing,
  }
}

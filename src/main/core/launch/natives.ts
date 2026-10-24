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
  /** 3 = flat DLLs plus a `java/` mirror for modern java.library.path. */
  schemaVersion: 3
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
  /** Effective directory; differs from plan.nativesDir when EPERM/EBUSY forced a fallback. */
  nativesDir: string
  fallback: boolean
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
    if (!marker || marker.schemaVersion !== 3 || !Array.isArray(marker.sources)) return false
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
  let targetDir = plan.nativesDir
  let markerPath = markerFile(targetDir)

  if (plan.sources.length === 0) {
    return {
      extracted: 0,
      jars: 0,
      skipped: [],
      cacheHit: false,
      markerFile: markerPath,
      missing: plan.missing,
      nativesDir: targetDir,
      fallback: false,
    }
  }

  if (!options.force && cacheMatches(fs, targetDir, plan)) {
    return {
      extracted: 0,
      jars: plan.sources.length,
      skipped: [],
      cacheHit: true,
      markerFile: markerPath,
      missing: plan.missing,
      nativesDir: targetDir,
      fallback: false,
    }
  }

  let fallback = false
  let lastRemoveError: unknown = null
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.remove(winLongPath(targetDir))
      lastRemoveError = null
      break
    } catch (error) {
      lastRemoveError = error
    }
  }
  if (lastRemoveError) {
    // Windows keeps DLLs locked while the previous JVM is still shutting down.
    // A unique sibling directory lets the new launch proceed without deleting
    // the old (still mapped) files.
    const stamp = options.now?.() ?? Date.now()
    let candidate = `${targetDir}-${stamp}`
    let suffix = 1
    while (fs.exists(winLongPath(candidate))) {
      candidate = `${targetDir}-${stamp}-${suffix}`
      suffix += 1
    }
    targetDir = candidate
    markerPath = markerFile(targetDir)
    fallback = true
  }
  fs.mkdirp(winLongPath(targetDir))

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
    // Flatten: modern LWJGL jars store DLLs under `windows/x64/org/lwjgl/…`,
    // and java.library.path on Windows does not recurse into subdirectories.
    const result = extractZip(fs, archive, winLongPath(targetDir), {
      excludePrefixes: excludes,
      flatten: true,
      flattenExtensions: ['.dll', '.so', '.dylib'],
    })
    extracted += result.written.length
    skipped.push(...result.skipped)
  }

  // Mojang's modern JSON (26.x/1.21+) points java.library.path at
  // `<natives>/java` and routes JNA/LWJGL/Netty scratch dirs to sibling
  // folders, so the DLLs must ALSO exist under `java/`. The flat copy stays for
  // older versions whose java.library.path is the natives root itself.
  const javaDir = path.join(targetDir, 'java')
  try {
    fs.mkdirp(winLongPath(javaDir))
    for (const entry of fs.readDir(targetDir)) {
      if (!/\.(dll|so|dylib)$/i.test(entry)) continue
      const source = path.join(targetDir, entry)
      const target = path.join(javaDir, entry)
      if (!fs.exists(target)) fs.copyFile(source, target)
    }
  } catch {
    // A missing mirror only matters for modern versions; the launch will
    // surface the real error if the DLL cannot be found.
  }

  const marker: NativesMarker = {
    schemaVersion: 3,
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
    nativesDir: targetDir,
    fallback,
  }
}

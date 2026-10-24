import path from 'node:path'
import { CoreError } from '../errors'
import type { FsPort } from '../ports'
import { flattenVersionChain, type FlattenOptions } from './inherit'
import { javaMajorForMinecraft } from '../java/version'
import { parseLibraryName } from './name'
import type {
  FlattenedVersionJson,
  LoaderInfo,
  ResolvedVersion,
  VersionChainNode,
  VersionJson,
  VersionLibrary,
} from './types'

const NUMERIC_MINECRAFT = /^\d+\.\d+(?:\.\d+)?$/

export interface VersionLoadOptions extends FlattenOptions {
  /** Defaults to `versions/<id>/<id>.json`; useful for tests with temp roots. */
  versionsDir?: string
}

export function versionsDirectory(mcRoot: string): string {
  return path.join(mcRoot, 'versions')
}

/** Finds a version directory by directory name, then by JSON `id`. */
export function findVersionDir(fs: FsPort, mcRoot: string, versionId: string): string | null {
  const versions = versionsDirectory(mcRoot)
  const direct = path.join(versions, versionId)
  if (fs.stat(direct)?.isDirectory()) return direct

  for (const name of fs.readDir(versions)) {
    const candidate = path.join(versions, name)
    if (!fs.stat(candidate)?.isDirectory()) continue
    const jsonPath = path.join(candidate, `${name}.json`)
    if (!fs.exists(jsonPath)) continue
    try {
      const parsed = JSON.parse(fs.readText(jsonPath)) as VersionJson
      if (parsed && parsed.id === versionId) return candidate
    } catch {
      // A corrupt sibling is reported by the scan, not while resolving another id.
    }
  }
  return null
}

export function parseVersionJson(text: string, jsonPath: string): VersionJson {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new CoreError('VERSION.JSON_CORRUPT', {
      message: `invalid JSON: ${jsonPath}`,
      details: { jsonPath },
      cause: error,
    })
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CoreError('VERSION.JSON_CORRUPT', {
      message: `version JSON is not an object: ${jsonPath}`,
      details: { jsonPath },
    })
  }

  const json = parsed as VersionJson
  if (typeof json.id !== 'string' || json.id.length === 0) {
    throw new CoreError('VERSION.JSON_CORRUPT', {
      message: `version JSON has no id: ${jsonPath}`,
      details: { jsonPath },
    })
  }

  if (json.libraries !== undefined && !Array.isArray(json.libraries)) {
    throw new CoreError('VERSION.JSON_CORRUPT', {
      message: `libraries is not an array: ${jsonPath}`,
      details: { jsonPath },
    })
  }

  return json
}

function sanitizeLibraries(json: VersionJson): VersionLibrary[] {
  const libraries = Array.isArray(json.libraries) ? json.libraries : []
  return libraries.filter(
    (library): library is VersionLibrary =>
      Boolean(library) && typeof library.name === 'string' && parseLibraryName(library.name) !== null,
  )
}

/**
 * Loads a version and its ancestors. Root→leaf order is what the merge step
 * expects; the visited set turns cycles into a precise error instead of a hang.
 */
export function loadVersionChain(
  fs: FsPort,
  mcRoot: string,
  versionId: string,
  options: VersionLoadOptions = {},
): VersionChainNode[] {
  const versions = options.versionsDir ?? versionsDirectory(mcRoot)
  const maxDepth = options.maxDepth ?? 16
  const nodes: VersionChainNode[] = []
  const visited = new Set<string>()
  let currentId: string | null = versionId

  while (currentId) {
    if (visited.has(currentId)) {
      throw new CoreError('VERSION.INHERIT_CYCLE', {
        message: `inheritance cycle at ${currentId}`,
        details: { chain: [...visited, currentId] },
      })
    }
    if (nodes.length >= maxDepth) {
      throw new CoreError('VERSION.INHERIT_CYCLE', {
        message: `inheritance chain deeper than ${maxDepth}`,
        details: { chain: [...visited, currentId] },
      })
    }
    visited.add(currentId)

    const dir = path.join(versions, currentId)
    const dirStat = fs.stat(dir)
    if (!dirStat?.isDirectory()) {
      throw new CoreError(
        nodes.length === 0 ? 'VERSION.NOT_FOUND' : 'VERSION_PARENT_NOT_FOUND',
        {
          message:
            nodes.length === 0
              ? `version not found: ${currentId}`
              : `parent version not found: ${currentId}`,
          details: { versionId: currentId, versionsDir: versions },
        },
      )
    }

    const jsonPath = path.join(dir, `${currentId}.json`)
    if (!fs.exists(jsonPath)) {
      throw new CoreError(
        nodes.length === 0 ? 'VERSION.NOT_FOUND' : 'VERSION.JSON_CORRUPT',
        {
          message: `version JSON missing: ${jsonPath}`,
          details: { versionId: currentId, jsonPath },
        },
      )
    }

    const json = parseVersionJson(fs.readText(jsonPath), jsonPath)
    json.libraries = sanitizeLibraries(json)

    nodes.unshift({
      id: json.id,
      dirName: currentId,
      dir,
      jsonPath,
      json,
    })

    currentId = typeof json.inheritsFrom === 'string' && json.inheritsFrom.length > 0
      ? json.inheritsFrom
      : null
  }

  return nodes
}

export interface ClientJarResolution {
  clientJar: string | null
  jarVersionId: string | null
  /** True when the jar exists on disk. Dry-run may proceed without it. */
  exists: boolean
}

/**
 * Resolves the client jar exactly like the vanilla launcher:
 *  - a `jar` field names the owning version explicitly;
 *  - otherwise the nearest version in the chain (leaf first) with `<dir>.jar`.
 *
 * Mismatched ids (copied instances) still use the directory name for the file.
 */
export function resolveClientJar(
  fs: FsPort,
  mcRoot: string,
  chain: VersionChainNode[],
  versionsDir: string = versionsDirectory(mcRoot),
): ClientJarResolution {
  const versions = versionsDir
  const leaf = chain[chain.length - 1]
  const base = chain[0] ?? leaf

  // An explicit `jar` pointer always wins (some profiles rename the client jar).
  if (leaf?.json.jar) {
    const jarId = leaf.json.jar
    const jarPath = path.join(versions, jarId, `${jarId}.jar`)
    return { clientJar: jarPath, jarVersionId: jarId, exists: fs.exists(jarPath) }
  }

  // The real client jar belongs to the BASE version. A loader profile's own
  // `<dirName>.jar` is the Forge/NeoForge universal (no Minecraft classes):
  // picking it made 1.12.2 die with ClassNotFoundException net.minecraft.client.Minecraft.
  const baseJar = path.join(versions, base.dirName, `${base.dirName}.jar`)
  if (fs.exists(baseJar)) {
    return { clientJar: baseJar, jarVersionId: base.dirName, exists: true }
  }

  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const node = chain[index]
    const jarPath = path.join(versions, node.dirName, `${node.dirName}.jar`)
    if (fs.exists(jarPath)) {
      return { clientJar: jarPath, jarVersionId: node.dirName, exists: true }
    }
  }

  // Expected location so an installer can repair it; `exists` stays false.
  const dirName = leaf?.dirName ?? chain[0].dirName
  return {
    clientJar: path.join(versions, dirName, `${dirName}.jar`),
    jarVersionId: dirName,
    exists: false,
  }
}

function loaderVersionFromLibraries(json: VersionJson, predicate: (name: string) => boolean): string | null {
  for (const library of json.libraries ?? []) {
    if (!predicate(library.name)) continue
    const parsed = parseLibraryName(library.name)
    if (parsed) return parsed.version
  }
  return null
}

/** Modpack folders often encode the loader version in the id. */
function loaderVersionFromId(id: string, pattern: RegExp): string | null {
  const match = pattern.exec(id)
  return match?.[1] ?? null
}

/** `1.20.1-47.2.0` → `47.2.0`; legacy `1.7.10-10.13.4.1614-1.7.10` keeps its suffix. */
export function normalizeForgeVersion(raw: string | null): string | null {
  if (!raw) return null
  const match = /^\d+\.\d+(?:\.\d+)?-(.+)$/.exec(raw)
  return match ? match[1] : raw
}

/**
 * Loader detection is deliberately library/mainClass based: modpacks often
 * rename the version folder and keep an unrelated `id`, so the name is weak
 * evidence.
 */
export function detectLoader(json: VersionJson): LoaderInfo {
  const mainClass = json.mainClass ?? ''
  const libraries = json.libraries ?? []
  const names = libraries.map((library) => library.name)

  const hasNeoForge =
    /neoforge/i.test(mainClass) ||
    names.some((name) => /^net\.neoforged[:.]/i.test(name)) ||
    names.some((name) => /^cpw\.mods\.bootstraplauncher/i.test(name) && names.some((n) => /neoforged/i.test(n)))

  if (hasNeoForge) {
    const version =
      loaderVersionFromLibraries(json, (name) => /^net\.neoforged:neoforge:/i.test(name)) ??
      loaderVersionFromId(json.id, /neoforge[_-]?(\d+(?:\.\d+)+)/i)
    return { type: 'neoforge', version }
  }

  if (
    /forge/i.test(mainClass) ||
    names.some((name) => /^net\.minecraftforge[:.]/i.test(name)) ||
    names.some((name) => /^cpw\.mods\.bootstraplauncher/i.test(name))
  ) {
    const version =
      loaderVersionFromLibraries(json, (name) => /^net\.minecraftforge:forge:/i.test(name)) ??
      loaderVersionFromId(json.id, /forge[_-]?(\d+(?:\.\d+)+)/i)
    return { type: 'forge', version: normalizeForgeVersion(version) }
  }

  if (
    /quilt/i.test(mainClass) ||
    names.some((name) => /^org\.quiltmc[:.]/i.test(name))
  ) {
    const version =
      loaderVersionFromLibraries(json, (name) => /^org\.quiltmc:quilt-loader:/i.test(name)) ??
      loaderVersionFromId(json.id, /quilt[-_]?loader[-_]?(\d+(?:\.\d+)+)/i)
    return { type: 'quilt', version }
  }

  if (
    /fabric/i.test(mainClass) ||
    names.some((name) => /^net\.fabricmc[:.]/i.test(name))
  ) {
    const version =
      loaderVersionFromLibraries(json, (name) => /^net\.fabricmc:fabric-loader:/i.test(name)) ??
      loaderVersionFromId(json.id, /fabric[-_]?loader[-_]?(\d+(?:\.\d+)+)/i)
    return { type: 'fabric', version }
  }

  return { type: 'vanilla', version: null }
}

/** NeoForge 21.1.233 → 1.21.1 (20.4.x → 1.20.4). */
export function minecraftVersionFromNeoForge(loaderVersion: string | null): string | null {
  if (!loaderVersion) return null
  const match = /^(\d+)\.(\d+)(?:\.\d+)?/.exec(loaderVersion)
  if (!match) return null
  const major = Number(match[1])
  const minor = Number(match[2])
  if (major < 20) return null
  return minor === 0 ? `1.${major}` : `1.${major}.${minor}`
}

/**
 * Best-effort Minecraft version. Order matters: a real inheritance root is the
 * strongest signal, then the leaf id, then loader metadata.
 */
export function detectMinecraftVersion(
  chain: VersionChainNode[],
  loader: LoaderInfo,
  flattened: VersionJson,
): string | null {
  const root = chain[0]
  const leaf = chain[chain.length - 1]

  if (chain.length > 1 && NUMERIC_MINECRAFT.test(root.id)) return root.id
  if (NUMERIC_MINECRAFT.test(leaf.id)) return leaf.id
  if (leaf.json.jar && NUMERIC_MINECRAFT.test(leaf.json.jar)) return leaf.json.jar

  for (const library of flattened.libraries ?? []) {
    const match = /^net\.minecraftforge:forge:(\d+\.\d+(?:\.\d+)?)-/.exec(library.name)
    if (match) return match[1]
  }

  for (const library of flattened.libraries ?? []) {
    const match = /^net\.minecraftforge:forge:(\d+\.\d+(?:\.\d+)?)$/.exec(library.name)
    if (match) return match[1]
  }

  const neoForge = minecraftVersionFromNeoForge(
    loader.type === 'neoforge' ? loader.version : null,
  )
  if (neoForge) return neoForge

  return null
}

export interface ResolveVersionOptions extends VersionLoadOptions {
  /** Platform used only for warnings; merge is platform independent. */
  platform?: NodeJS.Platform
}

export function resolveVersion(
  fs: FsPort,
  mcRoot: string,
  versionId: string,
  options: ResolveVersionOptions = {},
): ResolvedVersion {
  const chain = loadVersionChain(fs, mcRoot, versionId, options)
  const flattened = flattenVersionChain(
    chain.map((node) => node.json),
    options,
  )
  const loader = detectLoader(flattened.json)
  const mcVersion = detectMinecraftVersion(chain, loader, flattened.json)
  const clientJar = resolveClientJar(
    fs,
    mcRoot,
    chain,
    options.versionsDir ?? versionsDirectory(mcRoot),
  )
  const javaMajor =
    typeof flattened.json.javaVersion?.majorVersion === 'number'
      ? flattened.json.javaVersion.majorVersion
      : javaMajorForMinecraft(mcVersion)

  const warnings: string[] = []
  if (Object.prototype.hasOwnProperty.call(flattened.json, 'inheritsFrom')) {
    warnings.push('inheritsFrom survived flattening')
  }
  if (flattened.json.mainClass === undefined) {
    warnings.push('version JSON has no mainClass')
  }
  if (!clientJar.exists) {
    warnings.push('client jar not found')
  }
  if (mcVersion === null) {
    warnings.push('unknown Minecraft version; Java selection falls back to the newest runtime')
  }

  return {
    id: flattened.json.id,
    dirName: chain[chain.length - 1].dirName,
    dir: chain[chain.length - 1].dir,
    chain,
    chainIds: flattened.chainIds,
    json: flattened.json,
    jarVersionId: clientJar.jarVersionId,
    clientJar: clientJar.clientJar,
    clientJarExists: clientJar.exists,
    mcVersion,
    loader,
    javaMajor,
    warnings,
  }
}

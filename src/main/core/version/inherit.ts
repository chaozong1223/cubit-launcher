import { CoreError } from '../errors'
import { libraryMergeKey } from './name'
import type {
  FlattenedVersionJson,
  VersionArgument,
  VersionJson,
  VersionLibrary,
} from './types'

/** Fields where a child version replaces the parent verbatim. */
const OVERRIDE_FIELDS = [
  'type',
  'mainClass',
  'minecraftArguments',
  'jar',
  'assets',
  'assetIndex',
  'downloads',
  'javaVersion',
  'logging',
  'complianceLevel',
  'releaseTime',
  'time',
  'minimumLauncherVersion',
] as const

export interface FlattenOptions {
  /** Injected clock keeps tests byte-stable. */
  now?: () => number
  /** Hard limit protects against hostile inheritance chains. */
  maxDepth?: number
  /** Marker written to `x-mc-launcher.flattenedBy`. */
  producer?: string
}

export interface FlattenResult {
  json: FlattenedVersionJson
  chainIds: string[]
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function mergeLibraries(
  chain: VersionJson[],
): VersionLibrary[] {
  const merged: VersionLibrary[] = []
  const indexByKey = new Map<string, number>()

  for (const version of chain) {
    for (const library of version.libraries ?? []) {
      if (!library || typeof library.name !== 'string' || library.name.length === 0) continue
      const key = libraryMergeKey(library.name)
      const existing = indexByKey.get(key)
      if (existing === undefined) {
        indexByKey.set(key, merged.length)
        merged.push(cloneJson(library))
      } else {
        // Child wins but keeps the position it inherited, so classpath order is
        // stable across repeated flattening (ADR-011 idempotence).
        merged[existing] = cloneJson(library)
      }
    }
  }

  return merged
}

function mergeArguments(
  chain: VersionJson[],
): { game: VersionArgument[]; jvm: VersionArgument[] } | undefined {
  let game: VersionArgument[] = []
  let jvm: VersionArgument[] = []
  let seen = false

  for (const version of chain) {
    if (!version.arguments) continue
    seen = true
    game = game.concat(cloneJson(version.arguments.game ?? []))
    jvm = jvm.concat(cloneJson(version.arguments.jvm ?? []))
  }

  return seen ? { game, jvm } : undefined
}

/**
 * Expands a root→leaf chain into a self-contained version JSON.
 *
 * Merge rules (docs/03 §6.2):
 *  - child overrides scalar fields;
 *  - libraries are merged by coordinate (group:artifact:classifier), child wins,
 *    first-seen position is kept;
 *  - structured `arguments.game` / `arguments.jvm` are concatenated parent→child;
 *  - legacy `minecraftArguments` is a scalar override;
 *  - output has no `inheritsFrom` and carries `x-mc-launcher` provenance.
 */
export function flattenVersionChain(
  chain: VersionJson[],
  options: FlattenOptions = {},
): FlattenResult {
  if (chain.length === 0) {
    throw new CoreError('VERSION.NOT_FOUND', { message: 'empty version chain' })
  }

  const maxDepth = options.maxDepth ?? 16
  if (chain.length > maxDepth) {
    throw new CoreError('VERSION.INHERIT_CYCLE', {
      message: `version chain exceeds ${maxDepth} entries`,
      details: { depth: chain.length },
    })
  }

  const leaf = chain[chain.length - 1]
  const result: Record<string, unknown> = {}

  for (const version of chain) {
    for (const field of OVERRIDE_FIELDS) {
      if (version[field] !== undefined) result[field] = cloneJson(version[field])
    }
  }

  result.id = leaf.id

  const libraries = mergeLibraries(chain)
  if (libraries.length > 0) result.libraries = libraries

  const arguments_ = mergeArguments(chain)
  if (arguments_) result.arguments = arguments_

  delete result.inheritsFrom

  const now = options.now?.() ?? Date.now()
  const existingMetadata = chain.length === 1 ? chain[0]['x-mc-launcher'] : undefined
  result['x-mc-launcher'] = existingMetadata
    ? cloneJson(existingMetadata)
    : {
        flattenedAt: new Date(now).toISOString(),
        flattenedFrom: chain.map((version) => version.id),
        ...(options.producer ? { flattenedBy: options.producer } : {}),
      }

  return {
    json: result as unknown as FlattenedVersionJson,
    chainIds: chain.map((version) => version.id),
  }
}

/**
 * Detects a cycle before loading the next parent. `resolveVersionChain` keeps
 * its own visited set; tests call this directly for the error code.
 */
export function assertNoInheritCycle(ids: string[], next: string): void {
  if (ids.includes(next)) {
    throw new CoreError('VERSION.INHERIT_CYCLE', {
      message: `inheritance cycle: ${[...ids, next].join(' -> ')}`,
      details: { chain: [...ids, next] },
    })
  }
}

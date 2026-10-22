import path from 'node:path'

/**
 * Shared conflict policy for directory/file imports (instance share packs,
 * save copies between versions, ...).
 *
 * `overwrite` keeps the target name and replaces existing content, `skip`
 * leaves everything untouched, and `rename` allocates the first free
 * `name-2`, `name-3`, ... variant. Callers own the actual replace/backup and
 * pair it with a `RollbackStack` so a failed overwrite can be undone.
 */

export type ConflictStrategy = 'overwrite' | 'skip' | 'rename'

export const CONFLICT_STRATEGIES: readonly ConflictStrategy[] = [
  'overwrite',
  'skip',
  'rename',
]

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i

/** Filesystem-safe, human-readable name segment (no traversal, no devices). */
export function sanitizePathName(input: string, fallback = 'share'): string {
  const cleaned = input
    .replace(/[\\/:*?"<>|]/g, '_')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/[. ]+$/, '')
    .trim()
    .slice(0, 64)
  if (!cleaned || cleaned === '.' || cleaned === '..') return fallback
  return WINDOWS_RESERVED.test(cleaned) ? `${fallback}-${cleaned}` : cleaned
}

/** First free `base`, `base-2`, `base-3` … name inside `parentDir`. */
export function uniquePathName(
  parentDir: string,
  base: string,
  exists: (target: string) => boolean,
): string {
  const safe = sanitizePathName(base)
  let candidate = safe
  let counter = 2
  while (exists(path.join(parentDir, candidate))) {
    candidate = `${safe}-${counter}`
    counter += 1
  }
  return candidate
}

export interface ConflictResolution {
  strategy: ConflictStrategy
  /** Resolved target path (unchanged for overwrite/skip, new for rename). */
  target: string
  /** True when the import must do nothing because the target already exists. */
  skip: boolean
  /** True when a fresh name was allocated. */
  renamed: boolean
}

export interface ResolveConflictInput {
  target: string
  strategy: ConflictStrategy
  exists: (target: string) => boolean
  /** Allocates a fresh path; only called for `rename` on a conflict. */
  uniqueTarget: () => string
}

export function resolvePathConflict(input: ResolveConflictInput): ConflictResolution {
  const occupied = input.exists(input.target)
  if (!occupied) {
    return { strategy: input.strategy, target: input.target, skip: false, renamed: false }
  }
  switch (input.strategy) {
    case 'skip':
      return { strategy: input.strategy, target: input.target, skip: true, renamed: false }
    case 'rename':
      return {
        strategy: input.strategy,
        target: input.uniqueTarget(),
        skip: false,
        renamed: true,
      }
    case 'overwrite':
    default:
      return { strategy: input.strategy, target: input.target, skip: false, renamed: false }
  }
}

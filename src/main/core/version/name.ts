import { CoreError } from '../errors'

/**
 * Maven coordinate helpers for version libraries.
 *
 * Format: `group:artifact:version[:classifier][@extension]`.
 * A classifier is part of the identity: `org.lwjgl:lwjgl:3.3.1` and
 * `org.lwjgl:lwjgl:3.3.1:natives-windows` are different files and both must
 * survive inheritance merging.
 */
export interface LibraryCoordinate {
  group: string
  artifact: string
  version: string
  classifier: string | null
  extension: string
  /** `group:artifact:version:classifier` — inheritance merge key. */
  key: string
}

export interface ParsedLibraryName {
  group: string
  artifact: string
  version: string
  classifier: string | null
  extension: string
}

export function parseLibraryName(name: string): ParsedLibraryName | null {
  if (typeof name !== 'string' || name.trim().length === 0) return null
  const at = name.indexOf('@')
  const coordinates = at >= 0 ? name.slice(0, at) : name
  const extension = at >= 0 ? name.slice(at + 1) : 'jar'
  const parts = coordinates.split(':')
  if (parts.length < 3) return null
  const [group, artifact, version, ...rest] = parts
  if (!group || !artifact || !version) return null
  const classifier = rest.length > 0 ? rest.join(':') : null
  return {
    group,
    artifact,
    version,
    classifier: classifier && classifier.length > 0 ? classifier : null,
    extension: extension || 'jar',
  }
}

export function libraryCoordinate(name: string): LibraryCoordinate | null {
  const parsed = parseLibraryName(name)
  if (!parsed) return null
  return {
    ...parsed,
    // The VERSION must be part of the key. 1.12.2 lists LWJGL 2.9.4 (windows) and
    // 2.9.2 (macOS-only) side by side; without the version they collapsed into one
    // entry, the macOS one often won, and the classpath lost its LWJGL entirely —
    // every launch then died with ClassNotFoundException org.lwjgl.opengl.ContextAttribs.
    key: `${parsed.group}:${parsed.artifact}:${parsed.version}:${parsed.classifier ?? ''}`,
  }
}

/**
 * Merge key. Classifier is retained deliberately: collapsing it would drop the
 * 21 natives jars shipped by 1.20.1 or overwrite its main artifact.
 */
export function libraryMergeKey(name: string): string {
  return libraryCoordinate(name)?.key ?? name
}

/** Maven path below `libraries/`, e.g. `org/lwjgl/lwjgl/3.3.1/lwjgl-3.3.1-natives-windows.jar`. */
export function mavenRelativePath(
  coordinate: ParsedLibraryName,
  classifierOverride?: string | null,
): string {
  const classifier = classifierOverride === undefined ? coordinate.classifier : classifierOverride
  const groupPath = coordinate.group.replaceAll('.', '/')
  const suffix = classifier ? `-${classifier}` : ''
  return `${groupPath}/${coordinate.artifact}/${coordinate.version}/${coordinate.artifact}-${coordinate.version}${suffix}.${coordinate.extension}`
}

/**
 * Path of a library artifact relative to `libraries/`.
 * Prefers `downloads.artifact.path` (hashed, authoritative) and falls back to
 * the maven layout used by old Forge files that only ship a repository URL.
 */
export function libraryArtifactPath(library: {
  name: string
  downloads?: { artifact?: { path?: string } }
}): string | null {
  const explicit = library.downloads?.artifact?.path
  if (typeof explicit === 'string' && explicit.length > 0) return explicit
  const parsed = parseLibraryName(library.name)
  if (!parsed) return null
  return mavenRelativePath(parsed)
}

export function libraryClassifierPath(
  library: {
    name: string
    downloads?: { classifiers?: Record<string, { path?: string }> }
  },
  classifier: string,
): string | null {
  const explicit = library.downloads?.classifiers?.[classifier]?.path
  if (typeof explicit === 'string' && explicit.length > 0) return explicit
  const parsed = parseLibraryName(library.name)
  if (!parsed) return null
  return mavenRelativePath(parsed, classifier)
}

export function requireLibraryCoordinate(name: string): LibraryCoordinate {
  const coordinate = libraryCoordinate(name)
  if (!coordinate) {
    throw new CoreError('VERSION.JSON_CORRUPT', {
      message: `invalid library name: ${name}`,
      details: { name },
    })
  }
  return coordinate
}

import path from 'node:path'
import {
  createRuleContext,
  isRuleSetAllowed,
} from './rules'
import {
  libraryArtifactPath,
  libraryClassifierPath,
  parseLibraryName,
} from './name'
import type {
  FlattenedVersionJson,
  PlatformArch,
  PlatformName,
  RuleContext as RuleContextType,
  VersionLibrary,
} from './types'

export interface NativeSource {
  /** Maven name of the jar that contains the natives. */
  library: string
  /** Absolute jar path. */
  jarPath: string
  /** Entry prefixes that must not be extracted (e.g. `META-INF/`). */
  exclude: string[]
}

export interface ClasspathEntry {
  name: string
  path: string
  exists: boolean
  /** Native-only jars never belong on the classpath. */
  kind: 'library' | 'client'
}

export interface ResolvedLibraries {
  classpath: string[]
  entries: ClasspathEntry[]
  /** Native jars to extract for the current OS/arch. */
  natives: NativeSource[]
  /** Every native jar allowed by rules, including other architectures. */
  nativeDownloads: NativeSource[]
  /** Maven names of every library accepted by the rules (classpath or natives). */
  allowed: string[]
  /** Allowed libraries whose files are missing (repair candidates). */
  missing: string[]
  /** Libraries filtered out by OS/feature rules. */
  skipped: string[]
}

export interface ResolveLibrariesOptions {
  librariesDir: string
  /** Absolute client jar path, appended last. */
  clientJar?: string | null
  platform?: NodeJS.Platform
  arch?: string
  features?: Record<string, boolean>
  /** Inject `fs.exists` in pure tests; defaults to "assume present". */
  exists?: (target: string) => boolean
}

const OS_CLASSIFIER: Record<PlatformName, string> = {
  windows: 'windows',
  linux: 'linux',
  osx: 'macos',
}

function archBits(arch: PlatformArch): string {
  return arch === 'x86' ? '32' : '64'
}

/** Resolves a classic `natives` template (`natives-windows-${arch}`). */
export function resolveNativeClassifier(template: string, arch: PlatformArch): string {
  return template.replaceAll('${arch}', archBits(arch))
}

/**
 * `natives-windows-arm64` → { os: windows, arch: arm64 }.
 * `natives-macos` → { os: macos, arch: null }.
 */
export function parseNativeClassifier(
  classifier: string,
): { os: PlatformName | null; arch: PlatformArch | null } | null {
  if (!classifier.startsWith('natives-')) return null
  const rest = classifier.slice('natives-'.length)
  const [osPart, archPart] = rest.split('-')
  const os: PlatformName | null =
    osPart === 'windows' ? 'windows' : osPart === 'linux' ? 'linux' : osPart === 'macos' || osPart === 'osx' ? 'osx' : null
  let arch: PlatformArch | null = null
  if (archPart === 'arm64') arch = 'arm64'
  else if (archPart === 'x86_64' || archPart === 'amd64') arch = 'x86_64'
  else if (archPart === 'x86' || archPart === 'i386') arch = 'x86'
  return { os, arch }
}

function duplicateKey(source: NativeSource): string {
  const coordinate = parseLibraryName(source.library)
  if (!coordinate) return source.library
  const classifier = coordinate.classifier ?? ''
  const native = parseNativeClassifier(classifier)
  return `${coordinate.group}:${coordinate.artifact}:${native?.os ?? classifier}`
}

/**
 * True when the library actually ships a plain (non-classifier) jar. Natives-only
 * entries such as `net.java.jinput:jinput-platform:2.0.5` declare just
 * `downloads.classifiers`, and deriving a path from the maven name inventing a
 * jar that does not exist upstream would make every launch report it missing.
 */
function declaresArtifact(library: VersionLibrary): boolean {
  if (library.downloads?.artifact) return true
  // Maven-style profiles (Fabric/Quilt/Forge installers) carry a base `url` and
  // always resolve to `<url>/<path>`.
  if (!library.downloads && typeof library.url === 'string' && library.url.length > 0) {
    return true
  }
  return false
}

/**
 * Modern LWJGL natives are ordinary libraries whose classifier starts with
 * `natives-`; the classifier jar itself is the extraction source (1.19+).
 */
function isModernNative(library: VersionLibrary): boolean {
  const coordinate = parseLibraryName(library.name)
  return Boolean(coordinate?.classifier?.startsWith('natives-'))
}

export function resolveLibraries(
  version: FlattenedVersionJson,
  options: ResolveLibrariesOptions,
): ResolvedLibraries {
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const context = createRuleContext(platform, arch, options.features ?? {})
  const exists = options.exists ?? (() => true)

  const entries: ClasspathEntry[] = []
  const natives: NativeSource[] = []
  const nativeDownloads: NativeSource[] = []
  const allowed: string[] = []
  const missing: string[] = []
  const skipped: string[] = []

  for (const library of version.libraries ?? []) {
    const name = library.name
    const coordinate = parseLibraryName(name)
    if (!coordinate) {
      skipped.push(name)
      continue
    }

    if (!isRuleSetAllowed(library.rules, context)) {
      skipped.push(name)
      continue
    }
    allowed.push(name)

    const archive = libraryArtifactPath(library)
    const archiveAbsolute = archive ? path.join(options.librariesDir, archive) : null
    const exclude = library.extract?.exclude ?? ['META-INF/']

    const classicTemplate = library.natives?.[context.os.name]
    if (classicTemplate) {
      // Classic layout: the plain artifact is on the classpath, a classifier jar
      // carries the native libraries.
      const classifier = resolveNativeClassifier(classicTemplate, context.os.arch)
      const classifierRelative = libraryClassifierPath(library, classifier)
      if (classifierRelative) {
        const jarPath = path.join(options.librariesDir, classifierRelative)
        if (!exists(jarPath)) missing.push(jarPath)
        natives.push({ library: name, jarPath, exclude })
        nativeDownloads.push({ library: name, jarPath, exclude })
      }
      // Some natives-only libraries declare no plain artifact at all (e.g.
      // `net.java.jinput:jinput-platform:2.0.5` on 1.12.2 — the jar simply does
      // not exist upstream). Inventing the path from the maven name turned
      // those into bogus "missing file" failures that blocked every launch.
      if (declaresArtifact(library) && archive && archiveAbsolute) {
        const present = exists(archiveAbsolute)
        if (!present) missing.push(archiveAbsolute)
        entries.push({ name, path: archiveAbsolute, exists: present, kind: 'library' })
      }
      continue
    }

    if (isModernNative(library)) {
      const nativeInfo = parseNativeClassifier(coordinate.classifier ?? '')
      if (!nativeInfo || nativeInfo.os !== context.os.name) {
        skipped.push(name)
        continue
      }
      if (archive && archiveAbsolute) {
        if (!exists(archiveAbsolute)) missing.push(archiveAbsolute)
        const source = { library: name, jarPath: archiveAbsolute, exclude }
        // The download footprint includes every architecture variant; only the
        // matching one may be extracted (arm64/x86 jars would add wrong DLLs).
        nativeDownloads.push(source)
        if (!nativeInfo.arch || nativeInfo.arch === context.os.arch) {
          natives.push(source)
        }
      }
      continue
    }

    if (archive && archiveAbsolute) {
      const present = exists(archiveAbsolute)
      if (!present) missing.push(archiveAbsolute)
      entries.push({ name, path: archiveAbsolute, exists: present, kind: 'library' })
    }
  }

  // If a modpack carries both `natives-windows` and `natives-windows-arm64`,
  // prefer the architecture-specific jar and drop the generic duplicate.
  const preferredArch = new Map<string, NativeSource>()
  for (const source of natives) {
    const coordinate = parseLibraryName(source.library)
    const native = parseNativeClassifier(coordinate?.classifier ?? '')
    if (native?.arch) preferredArch.set(duplicateKey(source), source)
  }
  const filteredNatives = natives.filter((source) => {
    const coordinate = parseLibraryName(source.library)
    const native = parseNativeClassifier(coordinate?.classifier ?? '')
    if (native?.arch) return true
    const preferred = preferredArch.get(duplicateKey(source))
    return preferred === undefined
  })

  const classpath = entries.map((entry) => entry.path)

  if (options.clientJar) {
    const present = exists(options.clientJar)
    if (!present) missing.push(options.clientJar)
    entries.push({ name: '__client__', path: options.clientJar, exists: present, kind: 'client' })
    classpath.push(options.clientJar)
  }

  return {
    classpath,
    entries,
    natives: filteredNatives,
    nativeDownloads,
    allowed,
    missing,
    skipped,
  }
}

/** Windows uses `;`, everything else `:`. Paths stay unquoted (argv array). */
export function classpathSeparator(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? ';' : ':'
}

export function joinClasspath(
  classpath: string[],
  platform: NodeJS.Platform = process.platform,
): string {
  return classpath.join(classpathSeparator(platform))
}

export function createContextFor(
  platform: NodeJS.Platform,
  arch: string,
  features: Record<string, boolean> = {},
): RuleContextType {
  return createRuleContext(platform, arch, features)
}

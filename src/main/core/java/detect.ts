import path from 'node:path'
import type { JavaCandidate, JavaDetectResult, JavaRejected, JavaSource } from '@shared/java'
import { nodeFsPort, nodeProcessPort, type FsPort, type ProcessPort } from '../ports'
import { deriveJavaHome, probeJavaExecutable } from './probe'

export interface RawJavaCandidate {
  path: string
  source: JavaSource
}

export interface DetectJavaOptions {
  fs?: FsPort
  ports?: ProcessPort
  platform?: NodeJS.Platform
  arch?: string
  env?: NodeJS.ProcessEnv
  dataRoot?: string | null
  mcRoot?: string | null
  exeDir?: string | null
  appDataDir?: string | null
  /** User-selected Java files/folders (highest priority). */
  extraPaths?: string[]
  /** Per-instance forced path (source = instance). */
  instancePaths?: string[]
  probeTimeoutMs?: number
  concurrency?: number
  cacheTtlMs?: number
  cache?: JavaDetectionCache
  now?: () => number
  force?: boolean
  maxCandidates?: number
}

interface CachedDetection {
  result: JavaDetectResult
  expiresAt: number
}

/** 10-minute scan cache (docs/01 R3.3). */
export class JavaDetectionCache {
  private cached: CachedDetection | null = null

  get(now: number): JavaDetectResult | null {
    if (!this.cached) return null
    if (now >= this.cached.expiresAt) {
      this.cached = null
      return null
    }
    return this.cached.result
  }

  set(result: JavaDetectResult, now: number, ttlMs: number): void {
    this.cached = { result, expiresAt: now + ttlMs }
  }

  clear(): void {
    this.cached = null
  }
}

const DEFAULT_CONCURRENCY = 4
const DEFAULT_TIMEOUT = 8_000
const MAX_SCAN_DIRS = 500

function javaExecutableName(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'java.exe' : 'java'
}

function platformKey(platform: NodeJS.Platform): 'windows' | 'linux' | 'osx' {
  return platform === 'win32' ? 'windows' : platform === 'darwin' ? 'osx' : 'linux'
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)]
}

function pathKey(fs: FsPort, target: string, platform: NodeJS.Platform): string {
  const real = fs.realpath(target)
  return platform === 'win32' ? real.toLowerCase() : real
}

/**
 * Accepts an executable, a JDK home, or a `bin` directory. `javaw.exe` is
 * swapped for `java.exe` because a window-less binary produces no log stream.
 */
export function resolveJavaExecutable(
  fs: FsPort,
  candidate: string,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (!candidate) return null
  const cleaned = candidate.replace(/[\\/]+$/, '')
  const base = path.basename(cleaned).toLowerCase()
  const javaName = javaExecutableName(platform)

  if (base === 'javaw.exe') {
    const consoleExe = path.join(path.dirname(cleaned), 'java.exe')
    return fs.exists(consoleExe) ? consoleExe : null
  }

  if (/^java(\.exe)?$/i.test(base)) {
    return fs.exists(cleaned) && fs.stat(cleaned)?.isFile() ? cleaned : null
  }

  const fromHome = path.join(cleaned, 'bin', javaName)
  if (fs.exists(fromHome) && fs.stat(fromHome)?.isFile()) return fromHome
  const flat = path.join(cleaned, javaName)
  if (fs.exists(flat) && fs.stat(flat)?.isFile()) return flat
  return null
}

/**
 * Bounded search for `bin/java(.exe)` below a root. Four levels cover the Mojang
 * layout (`runtime/<name>/windows-x64/<name>/bin`) and the usual JDK folders.
 */
export function findJavaExecutablesUnder(
  fs: FsPort,
  root: string,
  platform: NodeJS.Platform = process.platform,
  maxDepth = 4,
  limit = 64,
): string[] {
  const javaName = javaExecutableName(platform)
  const results: string[] = []
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }]
  let visited = 0

  while (queue.length > 0 && results.length < limit && visited < MAX_SCAN_DIRS) {
    const current = queue.shift()
    if (!current) break
    visited += 1

    const direct = path.join(current.dir, 'bin', javaName)
    if (fs.exists(direct) && fs.stat(direct)?.isFile()) {
      results.push(direct)
      continue
    }

    if (current.depth >= maxDepth) continue
    for (const name of fs.readDir(current.dir)) {
      if (results.length >= limit) break
      if (name.startsWith('.') || name === 'bin' || name === 'legal' || name === 'lib') continue
      const child = path.join(current.dir, name)
      const stat = fs.stat(child)
      if (stat?.isDirectory()) queue.push({ dir: child, depth: current.depth + 1 })
    }
  }

  return results
}

function commonJavaRoots(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): string[] {
  const home = env.USERPROFILE ?? env.HOME ?? ''
  if (platform === 'win32') {
    const programFiles = env.ProgramFiles ?? 'C:\\Program Files'
    const programFilesX86 = env['ProgramFiles(x86)']
    const localAppData = env.LOCALAPPDATA
    const roots = [
      path.join(programFiles, 'Java'),
      path.join(programFiles, 'Eclipse Adoptium'),
      path.join(programFiles, 'Eclipse Foundation'),
      path.join(programFiles, 'AdoptOpenJDK'),
      path.join(programFiles, 'Zulu'),
      path.join(programFiles, 'Microsoft'),
      path.join(programFiles, 'BellSoft'),
      path.join(programFiles, 'Amazon Corretto'),
      path.join(programFiles, 'Semeru'),
      path.join(programFiles, 'Android', 'Android Studio', 'jbr'),
      localAppData ? path.join(localAppData, 'Programs', 'Eclipse Adoptium') : '',
      localAppData ? path.join(localAppData, 'Programs', 'Microsoft') : '',
      localAppData ? path.join(localAppData, 'Programs', 'Zulu') : '',
      home ? path.join(home, '.jdks') : '',
      programFilesX86 ? path.join(programFilesX86, 'Java') : '',
    ]
    return unique(roots.filter(Boolean))
  }

  if (platform === 'darwin') {
    return unique(
      [
        '/Library/Java/JavaVirtualMachines',
        '/System/Library/Java/JavaVirtualMachines',
        '/Applications/Android Studio.app/Contents/jbr/Contents/Home',
        home ? path.join(home, '.sdkman', 'candidates', 'java') : '',
      ].filter(Boolean),
    )
  }

  return unique(
    [
      '/usr/lib/jvm',
      '/usr/java',
      '/opt/java',
      '/opt/android-studio/jbr',
      home ? path.join(home, '.sdkman', 'candidates', 'java') : '',
    ].filter(Boolean),
  )
}

function mojangRuntimeRoots(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  mcRoot: string | null,
  appDataDir: string | null,
): string[] {
  const roots: string[] = []
  if (mcRoot) roots.push(path.join(mcRoot, 'runtime'))

  const appData =
    appDataDir ??
    (platform === 'win32'
      ? env.APPDATA ?? null
      : platform === 'darwin'
        ? env.HOME
          ? path.join(env.HOME, 'Library', 'Application Support')
          : null
        : env.HOME
          ? path.join(env.HOME, '.local', 'share')
          : null)

  if (appData) {
    const minecraftDir = platform === 'win32' ? '.minecraft' : 'minecraft'
    roots.push(path.join(appData, minecraftDir, 'runtime'))
  }
  return unique(roots.filter(Boolean))
}

function launcherRuntimeRoots(
  dataRoot: string | null,
  exeDir: string | null,
): string[] {
  const roots: string[] = []
  if (exeDir) {
    roots.push(path.join(exeDir, 'runtime'), path.join(exeDir, 'jre'), path.join(exeDir, 'java'))
  }
  if (dataRoot) {
    roots.push(
      path.join(dataRoot, 'runtime'),
      path.join(dataRoot, 'jre'),
      path.join(dataRoot, 'java'),
    )
  }
  return unique(roots.filter(Boolean))
}

function parseRegistryJavaHomes(output: string): string[] {
  const homes: string[] = []
  const pattern = /^\s*JavaHome\s+REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/gm
  for (const match of output.matchAll(pattern)) {
    const value = match[1].trim().replace(/^"|"$/g, '')
    if (value.length > 0) homes.push(value)
  }
  return homes
}

/** Reads JavaSoft keys (32/64-bit + HKLM/HKCU) via reg.exe. Windows only. */
export async function detectRegistryJavaHomes(
  ports: ProcessPort,
  platform: NodeJS.Platform,
  timeoutMs = 4_000,
): Promise<string[]> {
  if (platform !== 'win32') return []
  const keys = [
    'HKLM\\SOFTWARE\\JavaSoft\\Java Development Kit',
    'HKLM\\SOFTWARE\\JavaSoft\\Java Runtime Environment',
    'HKLM\\SOFTWARE\\WOW6432Node\\JavaSoft\\Java Development Kit',
    'HKLM\\SOFTWARE\\WOW6432Node\\JavaSoft\\Java Runtime Environment',
    'HKCU\\SOFTWARE\\JavaSoft\\Java Development Kit',
    'HKCU\\SOFTWARE\\JavaSoft\\Java Runtime Environment',
  ]

  const homes: string[] = []
  for (const key of keys) {
    const result = await ports.exec('reg.exe', ['query', key, '/s', '/v', 'JavaHome'], {
      timeoutMs,
    })
    if (result.code === 0) homes.push(...parseRegistryJavaHomes(result.stdout))
  }
  return unique(homes)
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0

  async function run(): Promise<void> {
    while (true) {
      const index = next
      next += 1
      if (index >= items.length) return
      results[index] = await worker(items[index], index)
    }
  }

  const workers = Array.from({ length: Math.min(Math.max(limit, 1), items.length) }, () => run())
  await Promise.all(workers)
  return results
}

function vendorFromPath(javaPath: string): string | null {
  const value = javaPath.toLowerCase()
  if (value.includes('adoptium') || value.includes('temurin')) return 'Eclipse Adoptium'
  if (value.includes('adoptopenjdk')) return 'AdoptOpenJDK'
  if (value.includes('zulu')) return 'Azul Zulu'
  if (value.includes('microsoft') || value.includes('jdk-')) return 'Microsoft'
  if (value.includes('corretto') || value.includes('amazon')) return 'Amazon Corretto'
  if (value.includes('bellsoft') || value.includes('liberica')) return 'BellSoft'
  if (value.includes('semeru') || value.includes('ibm')) return 'IBM Semeru'
  if (value.includes('android studio') || value.includes('jbr')) return 'JetBrains Runtime'
  return null
}

function sortCandidates(candidates: JavaCandidate[]): JavaCandidate[] {
  return [...candidates].sort((a, b) => {
    if (a.version.major !== b.version.major) return b.version.major - a.version.major
    if (a.version.minor !== b.version.minor) return b.version.minor - a.version.minor
    if (a.version.patch !== b.version.patch) return b.version.patch - a.version.patch
    return a.path.localeCompare(b.path)
  })
}

/**
 * Enumerates, probes and deduplicates Java runtimes.
 *
 * Source order is the documented priority: manual/instance → JAVA_HOME →
 * Mojang runtime → launcher runtime → registry → common install paths → PATH.
 * Probing failures are returned, never thrown (a broken JDK must not block a
 * good one).
 */
export async function detectJava(options: DetectJavaOptions = {}): Promise<JavaDetectResult> {
  const fs = options.fs ?? nodeFsPort()
  const ports = options.ports ?? nodeProcessPort()
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const now = options.now ?? Date.now
  const ttlMs = options.cacheTtlMs ?? 10 * 60_000
  const cache = options.cache
  const currentTime = now()

  if (!options.force && cache) {
    const cached = cache.get(currentTime)
    if (cached) return { ...cached, cached: true, durationMs: 0 }
  }

  const startedAt = now()
  const sources: string[] = []
  const raw: RawJavaCandidate[] = []

  const addFiles = (paths: string[] | undefined, source: JavaSource): void => {
    for (const candidate of paths ?? []) {
      const exe = resolveJavaExecutable(fs, candidate, platform)
      if (exe) raw.push({ path: exe, source })
    }
  }

  sources.push('manual')
  addFiles(options.extraPaths, 'manual')

  sources.push('instance')
  addFiles(options.instancePaths, 'instance')

  sources.push('java-home')
  if (env.JAVA_HOME) addFiles([env.JAVA_HOME], 'java-home')

  const mojangRoots = mojangRuntimeRoots(platform, env, options.mcRoot ?? null, options.appDataDir ?? null)
  if (mojangRoots.length > 0) {
    sources.push('mojang-runtime')
    for (const root of mojangRoots) {
      for (const exe of findJavaExecutablesUnder(fs, root, platform, 4)) {
        raw.push({ path: exe, source: 'mojang-runtime' })
      }
    }
  }

  const launcherRoots = launcherRuntimeRoots(options.dataRoot ?? null, options.exeDir ?? null)
  if (launcherRoots.length > 0) {
    sources.push('launcher-runtime')
    for (const root of launcherRoots) {
      for (const exe of findJavaExecutablesUnder(fs, root, platform, 4)) {
        raw.push({ path: exe, source: 'launcher-runtime' })
      }
    }
  }

  if (platform === 'win32') {
    sources.push('registry')
    for (const home of await detectRegistryJavaHomes(ports, platform)) {
      const exe = resolveJavaExecutable(fs, home, platform)
      if (exe) raw.push({ path: exe, source: 'registry' })
    }
  }

  sources.push('common-path')
  for (const root of commonJavaRoots(platform, env)) {
    for (const exe of findJavaExecutablesUnder(fs, root, platform, 4)) {
      raw.push({ path: exe, source: 'common-path' })
    }
  }

  sources.push('path')
  const pathEntries = (env.PATH ?? env.Path ?? '')
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
  for (const dir of pathEntries) {
    const exe = resolveJavaExecutable(fs, path.join(dir, javaExecutableName(platform)), platform)
    if (exe) raw.push({ path: exe, source: 'path' })
  }

  // Deduplicate by real path, keeping the first (highest priority) source.
  const seen = new Set<string>()
  const deduped: RawJavaCandidate[] = []
  for (const candidate of raw) {
    const key = pathKey(fs, candidate.path, platform)
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(candidate)
    if (deduped.length >= (options.maxCandidates ?? 64)) break
  }

  const probeResults = await mapWithConcurrency(
    deduped,
    options.concurrency ?? DEFAULT_CONCURRENCY,
    async (candidate) => {
      const probe = await probeJavaExecutable(ports, candidate.path, {
        timeoutMs: options.probeTimeoutMs ?? DEFAULT_TIMEOUT,
        env: { ...env, JAVA_TOOL_OPTIONS: '', _JAVA_OPTIONS: '', JDK_JAVA_OPTIONS: '' },
      })
      if (!probe.ok) {
        const rejected: JavaRejected = {
          path: candidate.path,
          source: candidate.source,
          reason: probe.reason,
        }
        return { rejected, candidate: null }
      }

      const candidateInfo: JavaCandidate = {
        path: candidate.path,
        home: probe.home ?? deriveJavaHome(candidate.path),
        source: candidate.source,
        version: probe.version,
        vendor: probe.vendor ?? vendorFromPath(candidate.path),
        arch: probe.arch,
        bits: probe.bits,
        probedAt: now(),
      }
      return { candidate: candidateInfo, rejected: null }
    },
  )

  const candidates: JavaCandidate[] = []
  const rejected: JavaRejected[] = []
  for (const result of probeResults) {
    if (result.candidate) candidates.push(result.candidate)
    if (result.rejected) rejected.push(result.rejected)
  }

  const finishedAt = now()
  const result: JavaDetectResult = {
    candidates: sortCandidates(candidates),
    rejected,
    durationMs: Math.max(0, finishedAt - startedAt),
    cached: false,
    scannedAt: finishedAt,
    sources,
  }

  cache?.set(result, finishedAt, ttlMs)
  return result
}

export { platformKey, javaExecutableName, sortCandidates }

import fs from 'node:fs'
import path from 'node:path'
import type { InstanceCandidateSource, MinecraftCandidate } from '@shared/instance'

export interface DiscoveryOptions {
  env?: NodeJS.ProcessEnv
  execPath?: string
  cwd?: string
  platform?: NodeJS.Platform
  /** Test seam; on Windows defaults to every existing drive letter. */
  driveRoots?: string[]
  /** Extra explicit paths (e.g. the currently configured root). */
  extraPaths?: string[]
  maxChildrenPerDrive?: number
}

export interface DiscoveryScan {
  candidates: MinecraftCandidate[]
  errors: string[]
}

const SKIP_CHILD_NAMES = new Set([
  '$recycle.bin',
  'system volume information',
  'windows',
  'program files',
  'program files (x86)',
  'programdata',
  'recovery',
  'perflogs',
  'msocache',
  'config.msi',
])

const PRIORITY: Record<InstanceCandidateSource, number> = {
  configured: 0,
  appdata: 1,
  userprofile: 2,
  install: 3,
  manual: 4,
  drive: 5,
}

function safeError(errors: string[], message: string): void {
  if (errors.length < 8 && !errors.includes(message)) errors.push(message)
}

function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory()
  } catch {
    return false
  }
}

function isSymlink(target: string): boolean {
  try {
    return fs.lstatSync(target).isSymbolicLink()
  } catch {
    return false
  }
}

function safeReaddir(target: string, errors: string[]): fs.Dirent[] {
  try {
    fs.accessSync(target, fs.constants.R_OK)
    return fs.readdirSync(target, { withFileTypes: true })
  } catch (error) {
    safeError(
      errors,
      `无法读取 ${target}: ${error instanceof Error ? error.message : String(error)}`,
    )
    return []
  }
}

function inspect(
  target: string,
  source: InstanceCandidateSource,
  errors: string[],
): MinecraftCandidate | null {
  if (!isDirectory(target) || isSymlink(target)) return null
  const versionsDir = path.join(target, 'versions')
  const versionNames = isDirectory(versionsDir)
    ? safeReaddir(versionsDir, errors)
        .filter(
          (entry) =>
            entry.isDirectory() &&
            !entry.isSymbolicLink() &&
            fs.existsSync(path.join(versionsDir, entry.name, `${entry.name}.json`)),
        )
        .map((entry) => entry.name)
    : []
  const hasMods = isDirectory(path.join(target, 'mods'))
  const hasSaves = isDirectory(path.join(target, 'saves'))
  let lastModified: number | null = null
  for (const candidate of [target, versionsDir, path.join(target, 'mods'), path.join(target, 'saves')]) {
    try {
      const stat = fs.statSync(candidate)
      lastModified = Math.max(lastModified ?? 0, Math.floor(stat.mtimeMs))
    } catch {
      /* a missing subdirectory is not an error */
    }
  }
  const hasVersions = versionNames.length > 0
  return {
    path: path.resolve(target),
    source,
    hasVersions,
    versionCount: versionNames.length,
    hasMods,
    hasSaves,
    lastModified,
    recommended: hasVersions,
    warning: hasVersions
      ? null
      : '目录存在但没有可识别的 versions/<id>/<id>.json；导入后需要先安装一个版本',
  }
}

function addPath(
  target: string,
  source: InstanceCandidateSource,
  candidates: Map<string, MinecraftCandidate>,
  errors: string[],
  requireMinecraftContent = false,
): void {
  if (!target || target.trim().length === 0) return
  const candidate = inspect(target, source, errors)
  if (!candidate) return
  if (requireMinecraftContent && !candidate.hasVersions && !candidate.hasMods && !candidate.hasSaves) {
    return
  }
  let key = candidate.path.toLowerCase()
  try {
    key = fs.realpathSync.native(candidate.path).toLowerCase()
  } catch {
    /* keep resolved path as identity */
  }
  const existing = candidates.get(key)
  if (!existing || PRIORITY[candidate.source] < PRIORITY[existing.source]) {
    candidates.set(key, candidate)
  }
}

function windowsDriveRoots(): string[] {
  if (process.platform !== 'win32') return ['/']
  const roots: string[] = []
  for (let code = 65; code <= 90; code += 1) {
    const root = `${String.fromCharCode(code)}:\\`
    if (fs.existsSync(root)) roots.push(root)
  }
  return roots
}

/**
 * Finds existing `.minecraft` roots without ever throwing. Discovery is an
 * onboarding aid, not a source of truth: every inaccessible directory is
 * recorded as a non-fatal error and scanning continues.
 */
export function discoverMinecraftRoots(options: DiscoveryOptions = {}): DiscoveryScan {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const execPath = options.execPath ?? process.execPath
  const cwd = options.cwd ?? process.cwd()
  const errors: string[] = []
  const candidates = new Map<string, MinecraftCandidate>()

  // Common user locations.
  for (const [home, source] of [
    [env.APPDATA, 'appdata'],
    [env.USERPROFILE, 'userprofile'],
  ] as const) {
    if (home) addPath(path.join(home, '.minecraft'), source, candidates, errors)
  }

  // Portable/install-adjacent layouts.
  const execDir = path.dirname(execPath)
  for (const base of [execDir, path.dirname(execDir), cwd]) {
    addPath(path.join(base, '.minecraft'), 'install', candidates, errors)
    addPath(path.join(base, 'minecraft'), 'install', candidates, errors)
    addPath(base, 'install', candidates, errors, true)
  }

  for (const extra of options.extraPaths ?? []) addPath(extra, 'configured', candidates, errors)

  // Drive roots, depth 0 + one child level only.
  const drives = options.driveRoots ?? (platform === 'win32' ? windowsDriveRoots() : ['/'])
  const maxChildren = options.maxChildrenPerDrive ?? 80
  for (const drive of drives) {
    if (!isDirectory(drive)) continue
    addPath(path.join(drive, '.minecraft'), 'drive', candidates, errors)
    addPath(path.join(drive, 'minecraft'), 'drive', candidates, errors)

    const children = safeReaddir(drive, errors)
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .filter((entry) => !SKIP_CHILD_NAMES.has(entry.name.toLowerCase()))
      .slice(0, maxChildren)
    for (const child of children) {
      const childPath = path.join(drive, child.name)
      addPath(path.join(childPath, '.minecraft'), 'drive', candidates, errors)
      addPath(path.join(childPath, 'minecraft'), 'drive', candidates, errors)
    }
  }

  const sorted = [...candidates.values()].sort(
    (left, right) =>
      Number(right.recommended) - Number(left.recommended) ||
      Number(right.hasVersions) - Number(left.hasVersions) ||
      right.versionCount - left.versionCount ||
      PRIORITY[left.source] - PRIORITY[right.source] ||
      left.path.localeCompare(right.path, 'zh-CN'),
  )
  return { candidates: sorted, errors }
}

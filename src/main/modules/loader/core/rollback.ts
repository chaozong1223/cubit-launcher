import path from 'node:path'
import type { FsPort } from '../../../core/ports'

/**
 * Installer rollback (MC-12, acceptance "不留下半成品目录").
 *
 * The game root is shared with the user's existing installations, so rollback
 * must be surgical:
 *  - only version directories that appeared during this run are deleted;
 *  - `launcher_profiles.json` is restored byte-for-byte (or removed when it did
 *    not exist before) because the installer rewrites it;
 *  - libraries/assets that the installer downloaded are kept: they are shared,
 *    content-addressed caches and deleting them could break other instances.
 */

export interface McRootSnapshot {
  versionDirs: string[]
  profilesBytes: Buffer | null
  profilesExisted: boolean
}

export function profilesPath(mcRoot: string): string {
  return path.join(mcRoot, 'launcher_profiles.json')
}

export function snapshotMcRoot(fs: FsPort, mcRoot: string): McRootSnapshot {
  const versionsDir = path.join(mcRoot, 'versions')
  const versionDirs = fs
    .readDir(versionsDir)
    .filter((name) => fs.stat(path.join(versionsDir, name))?.isDirectory())
  const profiles = profilesPath(mcRoot)
  const profilesExisted = fs.exists(profiles)
  return {
    versionDirs,
    profilesExisted,
    profilesBytes: profilesExisted ? fs.readBytes(profiles) : null,
  }
}

const MINIMAL_PROFILES = `${JSON.stringify(
  {
    profiles: {},
    settings: {},
    version: 3,
  },
  null,
  2,
)}\n`

/** Forge/NeoForge installers expect launcher_profiles.json to exist (MC-12). */
export function ensureLauncherProfiles(fs: FsPort, mcRoot: string): boolean {
  const file = profilesPath(mcRoot)
  if (fs.exists(file)) return false
  fs.mkdirp(mcRoot)
  fs.writeTextAtomic(file, MINIMAL_PROFILES)
  return true
}

export function restoreLauncherProfiles(fs: FsPort, mcRoot: string, snapshot: McRootSnapshot): void {
  const file = profilesPath(mcRoot)
  if (snapshot.profilesExisted && snapshot.profilesBytes) {
    fs.writeBytes(file, snapshot.profilesBytes)
    return
  }
  if (fs.exists(file)) fs.remove(file)
}

export interface RollbackResult {
  removedVersionDirs: string[]
  restoredProfiles: boolean
  removedWorkDir: boolean
  errors: string[]
}

/**
 * Removes everything this run created. `workDir` is the temp cwd; failures are
 * reported (never thrown) so the original error stays the primary message.
 */
export function rollbackLoaderInstall(
  fs: FsPort,
  mcRoot: string,
  snapshot: McRootSnapshot,
  options: { workDir?: string | null } = {},
): RollbackResult {
  const result: RollbackResult = {
    removedVersionDirs: [],
    restoredProfiles: false,
    removedWorkDir: false,
    errors: [],
  }
  const versionsDir = path.join(mcRoot, 'versions')
  const before = new Set(snapshot.versionDirs)

  for (const name of fs.readDir(versionsDir)) {
    if (before.has(name)) continue
    const target = path.join(versionsDir, name)
    if (!fs.stat(target)?.isDirectory()) continue
    try {
      fs.remove(target)
      result.removedVersionDirs.push(name)
    } catch (error) {
      result.errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  try {
    restoreLauncherProfiles(fs, mcRoot, snapshot)
    result.restoredProfiles = true
  } catch (error) {
    result.errors.push(
      `launcher_profiles.json: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  if (options.workDir) {
    try {
      fs.remove(options.workDir)
      result.removedWorkDir = true
    } catch (error) {
      result.errors.push(
        `workDir: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  return result
}

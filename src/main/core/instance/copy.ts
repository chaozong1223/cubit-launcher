import fsSync from 'node:fs'
import path from 'node:path'
import type { FsPort } from '../ports'
import type { InstanceSettings } from '@shared/instance'
import {
  defaultInstanceSettings,
  readInstanceSettings,
  writeInstanceSettings,
} from './settings'

export interface CopyInstanceInput {
  /** Display name for the copy; also used to derive the directory name. */
  newName?: string
  /** Copy saves/ as well (defaults to true). */
  includeWorlds?: boolean
  /** Source directory name (versions/<dirName>). */
  sourceDirName: string
  /** Source instance settings, when the caller already scanned them. */
  sourceSettings: InstanceSettings
  mcRoot: string
  exists: (target: string) => boolean
  now?: () => number
}

export interface CopyInstanceResult {
  dirName: string
  copied: boolean
  skippedWorlds: boolean
}

/** `Foo`, `Foo-2`, `Foo-3` … the first directory name that is still free. */
export function uniqueDirName(
  base: string,
  exists: (target: string) => boolean,
  versionsDir: string,
): string {
  const safe = base.replace(/[\\/:*?"<>|]/g, '_').trim() || 'copy'
  let candidate = safe
  let counter = 2
  while (exists(path.join(versionsDir, candidate))) {
    candidate = `${safe}-${counter}`
    counter += 1
  }
  return candidate
}

/**
 * Duplicates an isolated instance directory. Shared-isolation instances have no
 * dedicated directory (their game files live in the .minecraft root), so there
 * is nothing safe to copy and the caller must reject them first.
 */
export function copyInstanceDirectory(
  fs: FsPort,
  input: CopyInstanceInput,
): CopyInstanceResult {
  if (input.sourceSettings.isolation !== 'isolated') {
    throw new Error('shared isolation instances have no directory to copy')
  }

  const versionsDir = path.join(input.mcRoot, 'versions')
  const sourceDir = path.join(versionsDir, input.sourceDirName)
  const displayName = input.newName?.trim() || `${input.sourceSettings.name} 副本`
  const dirName = uniqueDirName(displayName, input.exists, versionsDir)
  const targetDir = path.join(versionsDir, dirName)
  const includeWorlds = input.includeWorlds !== false

  fs.mkdirp(targetDir)
  const skipWorldsSegment = `${path.sep}saves`
  fsSync.cpSync(sourceDir, targetDir, {
    recursive: true,
    force: false,
    errorOnExist: false,
    filter: (source) => includeWorlds || !source.includes(skipWorldsSegment),
  })

  const now = input.now?.() ?? Date.now()

  // Minecraft resolves a version by `<dirName>.json`; a copy under a new
  // directory name must therefore carry a renamed JSON with a matching "id".
  const sourceJson = path.join(targetDir, `${input.sourceDirName}.json`)
  const targetJson = path.join(targetDir, `${dirName}.json`)
  if (fs.exists(sourceJson)) {
    try {
      const parsed = JSON.parse(fsSync.readFileSync(sourceJson, 'utf8')) as Record<string, unknown>
      parsed.id = dirName
      fsSync.writeFileSync(targetJson, JSON.stringify(parsed, null, 2), 'utf8')
      if (sourceJson !== targetJson) fsSync.rmSync(sourceJson, { force: true })
    } catch {
      // Leave the original file in place; the instance will surface as corrupt
      // instead of being silently rewritten.
    }
  }

  // The client jar is resolved as `<dirName>.jar` as well.
  const sourceJar = path.join(targetDir, `${input.sourceDirName}.jar`)
  const targetJar = path.join(targetDir, `${dirName}.jar`)
  if (fs.exists(sourceJar) && !fs.exists(targetJar)) {
    try {
      fsSync.renameSync(sourceJar, targetJar)
    } catch {
      // Keep the old jar; the instance reports missing-jar instead of failing hard.
    }
  }
  const settings = defaultInstanceSettings({
    dirName,
    name: displayName,
    mcVersion: input.sourceSettings.mcVersion,
    loader: input.sourceSettings.loader,
    isolation: 'isolated',
    source: input.sourceSettings.source,
    now,
  })
  writeInstanceSettings(fs, targetDir, {
    ...settings,
    java: input.sourceSettings.java,
    memory: input.sourceSettings.memory,
    memoryMode: input.sourceSettings.memoryMode,
    window: input.sourceSettings.window,
    jvmArgs: [...input.sourceSettings.jvmArgs],
    serverAuth: input.sourceSettings.serverAuth,
    autoJoin: input.sourceSettings.autoJoin,
    icon: input.sourceSettings.icon,
    lastPlayedAt: null,
    playTimeSec: 0,
    createdAt: now,
  })

  return { dirName, copied: true, skippedWorlds: !includeWorlds }
}

export { readInstanceSettings }

import path from 'node:path'
import type { InstanceSettings, InstanceSummary } from '@shared/instance'
import type { FsPort } from '../ports'
import { scanVersionDirs, type VersionScanEntry } from '../version/scan'
import {
  defaultInstanceSettings,
  gameDirectory,
  instanceDirectory,
  readInstanceSettings,
} from './settings'

export interface ScannedInstance extends InstanceSummary {
  /** Absolute version directory (always `versions/<dirName>`). */
  dir: string
  chain: string[]
  clientJar: string | null
  settingsError: string | null
}

function toSummary(
  fs: FsPort,
  mcRoot: string,
  entry: VersionScanEntry,
): ScannedInstance {
  const dir = entry.dir
  const { settings, error } = readInstanceSettings(fs, dir)
  const fallback = defaultInstanceSettings({
    dirName: entry.dirName,
    id: entry.id,
    mcVersion: entry.mcVersion,
    loader: entry.loader,
  })
  const effective: InstanceSettings = settings ?? fallback

  return {
    id: effective.id,
    dirName: entry.dirName,
    name: effective.name,
    mcVersion: entry.mcVersion ?? effective.mcVersion,
    loader: entry.loader,
    state: entry.state,
    reason: error ? `${entry.reason ?? 'instance.json invalid'}; ${error}` : entry.reason,
    isolation: effective.isolation,
    lastPlayedAt: effective.lastPlayedAt,
    icon: effective.icon,
    javaMajor: entry.javaMajor,
    dir,
    chain: entry.chain,
    clientJar: entry.clientJar,
    settingsError: error,
  }
}

/**
 * Instance list = version scan + per-instance settings. Sorted by last played
 * (desc) then name, so the home page is stable without a UI-side sort.
 */
export function scanInstances(fs: FsPort, mcRoot: string): ScannedInstance[] {
  const instances = scanVersionDirs(fs, mcRoot).map((entry) => toSummary(fs, mcRoot, entry))
  return instances.sort((a, b) => {
    const played = (b.lastPlayedAt ?? 0) - (a.lastPlayedAt ?? 0)
    if (played !== 0) return played
    return a.dirName.localeCompare(b.dirName, 'zh-CN')
  })
}

export function findInstance(
  fs: FsPort,
  mcRoot: string,
  idOrDirName: string,
): ScannedInstance | null {
  const direct = path.join(instanceDirectory(mcRoot, idOrDirName))
  const directJson = path.join(direct, `${idOrDirName}.json`)
  if (fs.exists(directJson)) {
    const entry = scanVersionDirs(fs, mcRoot).find((item) => item.dirName === idOrDirName)
    if (entry) return toSummary(fs, mcRoot, entry)
  }

  return (
    scanInstances(fs, mcRoot).find(
      (item) => item.id === idOrDirName || item.dirName === idOrDirName,
    ) ?? null
  )
}

export { gameDirectory, instanceDirectory }

import path from 'node:path'
import { isCoreError } from '../errors'
import type { FsPort } from '../ports'
import {
  parseVersionJson,
  resolveVersion,
  versionsDirectory,
} from './load'
import type { LoaderInfo } from './types'

export type VersionStateName =
  | 'ready'
  | 'missing-json'
  | 'corrupt-json'
  | 'missing-jar'
  | 'unsupported'

export interface VersionScanEntry {
  id: string
  dirName: string
  dir: string
  state: VersionStateName
  reason: string | null
  type: string | null
  mainClass: string | null
  mcVersion: string | null
  loader: LoaderInfo
  javaMajor: number | null
  chain: string[]
  clientJar: string | null
  clientJarExists: boolean
  flattened: boolean
}

const UNKNOWN_LOADER: LoaderInfo = { type: 'unknown', version: null }

function baseEntry(dir: string, dirName: string): VersionScanEntry {
  return {
    id: dirName,
    dirName,
    dir,
    state: 'missing-json',
    reason: null,
    type: null,
    mainClass: null,
    mcVersion: null,
    loader: UNKNOWN_LOADER,
    javaMajor: null,
    chain: [],
    clientJar: null,
    clientJarExists: false,
    flattened: false,
  }
}

/**
 * Scans `versions/*` once and classifies every directory. Never throws: a
 * broken instance must not hide the healthy ones (docs/01 §5.1).
 */
export function scanVersionDirs(fs: FsPort, mcRoot: string): VersionScanEntry[] {
  const versionsDir = versionsDirectory(mcRoot)
  const names = fs
    .readDir(versionsDir)
    .filter((name) => fs.stat(path.join(versionsDir, name))?.isDirectory())
    .sort((a, b) => a.localeCompare(b, 'zh-CN'))

  const entries: VersionScanEntry[] = []

  for (const dirName of names) {
    const dir = path.join(versionsDir, dirName)
    const entry = baseEntry(dir, dirName)
    const jsonPath = path.join(dir, `${dirName}.json`)

    if (!fs.exists(jsonPath)) {
      entry.reason = 'missing version json'
      entries.push(entry)
      continue
    }

    let leaf
    try {
      leaf = parseVersionJson(fs.readText(jsonPath), jsonPath)
    } catch (error) {
      entry.state = 'corrupt-json'
      entry.reason = error instanceof Error ? error.message : String(error)
      entries.push(entry)
      continue
    }

    if (leaf.id !== dirName) {
      entry.state = 'unsupported'
      entry.reason = `id mismatch: json id "${leaf.id}" != directory "${dirName}"`
      entry.id = leaf.id
      entries.push(entry)
      continue
    }

    try {
      const resolved = resolveVersion(fs, mcRoot, dirName)
      const leafNode = resolved.chain[resolved.chain.length - 1]
      entry.id = resolved.id
      entry.state = resolved.clientJarExists ? 'ready' : 'missing-jar'
      entry.reason =
        entry.state === 'missing-jar'
          ? `client jar not found: ${resolved.clientJar ?? '(unknown)'}`
          : null
      entry.type = typeof resolved.json.type === 'string' ? resolved.json.type : null
      entry.mainClass = typeof resolved.json.mainClass === 'string' ? resolved.json.mainClass : null
      entry.mcVersion = resolved.mcVersion
      entry.loader = resolved.loader
      entry.javaMajor = resolved.javaMajor
      entry.chain = resolved.chainIds
      entry.clientJar = resolved.clientJar
      entry.clientJarExists = resolved.clientJarExists
      entry.flattened = !Object.prototype.hasOwnProperty.call(leafNode?.json ?? {}, 'inheritsFrom')
      entries.push(entry)
    } catch (error) {
      if (isCoreError(error)) {
        if (error.code === 'VERSION.JSON_CORRUPT') entry.state = 'corrupt-json'
        else if (error.code === 'VERSION.NOT_FOUND') entry.state = 'missing-json'
        else entry.state = 'unsupported'
        entry.reason = `${error.code}: ${error.message}`
      } else {
        entry.state = 'unsupported'
        entry.reason = error instanceof Error ? error.message : String(error)
      }
      entries.push(entry)
    }
  }

  return entries
}

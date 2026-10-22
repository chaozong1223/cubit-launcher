import fsp from 'node:fs/promises'
import path from 'node:path'
import type { InstanceSettings } from '@shared/instance'
import type { FsPort } from '../ports'
import { JobCancelledError } from '../job/kernel'
import { copyFileStreaming } from '../fs/stream-copy'
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
  /**
   * Pre-computed target directory name. The caller (a job service) resolves it
   * before starting the copy so a cancel/failure can remove exactly that path.
   */
  targetDirName?: string
}

export interface CopyProgress {
  stage: 'scan' | 'copy' | 'finalize'
  filesDone: number
  filesTotal: number
  bytesDone: number
  bytesTotal: number
  currentFile: string | null
}

export interface CopyInstanceOptions {
  /** Abort signal: cancels the streaming copy and leaves no target directory. */
  signal?: AbortSignal
  /** Cooperative pause gate (the job kernel supplies `checkpoint()`). */
  waitWhilePaused?: () => Promise<void>
  onStage?: (stage: CopyProgress['stage']) => void
  onProgress?: (progress: CopyProgress) => void
}

export interface CopyInstanceResult {
  dirName: string
  copied: boolean
  skippedWorlds: boolean
  files: number
  bytes: number
}

interface PendingFile {
  relative: string
  size: number
}

function cancelled(): never {
  throw new JobCancelledError()
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

/** Display name of the copy (`Foo 副本`, or the user-supplied name). */
export function copyTargetName(
  sourceSettings: InstanceSettings,
  newName?: string,
): string {
  return newName?.trim() || `${sourceSettings.name} 副本`
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) cancelled()
}

async function collectDirectory(
  root: string,
  relative: string,
  includeWorlds: boolean,
  files: PendingFile[],
  directories: string[],
  checkpoint: () => Promise<void>,
): Promise<void> {
  await checkpoint()
  const absolute = relative ? path.join(root, relative) : root
  const entries = await fsp.readdir(absolute, { withFileTypes: true })
  for (const entry of entries) {
    const child = relative ? `${relative}/${entry.name}` : entry.name
    if (!includeWorlds && (child === 'saves' || child.startsWith('saves/'))) continue
    // Symlinks could point outside the instance; they are not game data and
    // following them would let a copy escape its own directory.
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) {
      directories.push(child)
      await collectDirectory(root, child, includeWorlds, files, directories, checkpoint)
      continue
    }
    if (!entry.isFile()) continue
    const stat = await fsp.stat(path.join(root, child))
    if (!stat.isFile()) continue
    files.push({ relative: child, size: stat.size })
  }
}

/** Streams one file, reporting bytes as they move (cancel-safe). */
async function copyOneFile(
  source: string,
  target: string,
  options: { signal?: AbortSignal; onBytes(delta: number): void },
): Promise<void> {
  await copyFileStreaming(source, target, options)
}

/**
 * Duplicates an isolated instance directory. Shared-isolation instances have no
 * dedicated directory (their game files live in the .minecraft root), so there
 * is nothing safe to copy and the caller must reject them first.
 *
 * Replaces the old `fs.cpSync` implementation: the copy is a streaming async
 * walk so an 8 GB instance neither blocks the main process nor the IPC bridge,
 * and `signal` makes it cancellable file-by-file (and mid-file).
 */
export async function copyInstanceDirectory(
  fs: FsPort,
  input: CopyInstanceInput,
  options: CopyInstanceOptions = {},
): Promise<CopyInstanceResult> {
  if (input.sourceSettings.isolation !== 'isolated') {
    throw new Error('shared isolation instances have no directory to copy')
  }

  const { signal } = options
  const checkpoint = async (): Promise<void> => {
    throwIfAborted(signal)
    if (options.waitWhilePaused) await options.waitWhilePaused()
    throwIfAborted(signal)
  }

  const versionsDir = path.join(input.mcRoot, 'versions')
  const sourceDir = path.join(versionsDir, input.sourceDirName)
  const displayName = copyTargetName(input.sourceSettings, input.newName)
  const dirName = input.targetDirName ?? uniqueDirName(displayName, input.exists, versionsDir)
  const targetDir = path.join(versionsDir, dirName)
  const includeWorlds = input.includeWorlds !== false

  let filesDone = 0
  let bytesDone = 0
  let filesTotal = 0
  let bytesTotal = 0
  let currentFile: string | null = null
  const report = (stage: CopyProgress['stage']): void => {
    options.onProgress?.({
      stage,
      filesDone,
      filesTotal,
      bytesDone,
      bytesTotal,
      currentFile,
    })
  }

  await checkpoint()
  options.onStage?.('scan')
  report('scan')
  await fsp.mkdir(targetDir, { recursive: true })

  const files: PendingFile[] = []
  const directories: string[] = []
  await collectDirectory(sourceDir, '', includeWorlds, files, directories, checkpoint)
  filesTotal = files.length
  bytesTotal = files.reduce((total, file) => total + file.size, 0)
  report('scan')

  await checkpoint()
  options.onStage?.('copy')
  for (const relative of directories) {
    await checkpoint()
    await fsp.mkdir(path.join(targetDir, relative), { recursive: true })
  }
  let bytesBefore = 0
  for (const file of files) {
    await checkpoint()
    currentFile = file.relative
    let fileBytes = 0
    await copyOneFile(path.join(sourceDir, file.relative), path.join(targetDir, file.relative), {
      ...(signal ? { signal } : {}),
      onBytes: (delta) => {
        fileBytes += delta
        bytesDone = bytesBefore + fileBytes
        report('copy')
      },
    })
    filesDone += 1
    // The stream may report a slightly different byte count than stat(); the
    // settled filename value is authoritative for the progress bar.
    bytesDone = bytesBefore + file.size
    bytesBefore = bytesDone
    report('copy')
  }

  await checkpoint()
  currentFile = null
  options.onStage?.('finalize')
  report('finalize')

  const now = input.now?.() ?? Date.now()

  // Minecraft resolves a version by `<dirName>.json`; a copy under a new
  // directory name must therefore carry a renamed JSON with a matching "id".
  const sourceJson = path.join(targetDir, `${input.sourceDirName}.json`)
  const targetJson = path.join(targetDir, `${dirName}.json`)
  if (fs.exists(sourceJson)) {
    try {
      const parsed = JSON.parse(await fsp.readFile(sourceJson, 'utf8')) as Record<string, unknown>
      parsed.id = dirName
      await fsp.writeFile(targetJson, JSON.stringify(parsed, null, 2), 'utf8')
      if (sourceJson !== targetJson) await fsp.rm(sourceJson, { force: true })
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
      await fsp.rename(sourceJar, targetJar)
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

  return {
    dirName,
    copied: true,
    skippedWorlds: !includeWorlds,
    files: files.length,
    bytes: bytesTotal,
  }
}

export { readInstanceSettings }

import path from 'node:path'
import { createHash } from 'node:crypto'
import type { RepairIssue, RepairReport, RepairVerifyMode } from '@shared/repair'
import type { FsPort } from '../../../core/ports'
import { resolveVersion } from '../../../core/version/load'
import {
  buildAssetIndexTask,
  buildAssetTasks,
  buildClientTask,
  buildLibraryTasks,
  type PlannedTask,
} from '../../download/core/plan'
import { parseAssetIndex, type AssetIndexJson } from '../../download/core/manifest'
import { RepairError, asRepairError } from './errors'

/**
 * Integrity scanner.
 *
 * Uses the t8 install-plan builders so the expected files/URLs/hashes are the
 * exact same ones the downloader uses. Only `client`, `libraries` and `assets`
 * are inspected; mods/saves/config are never enumerated.
 */

export interface ScanInput {
  fs: FsPort
  mcRoot: string
  versionId: string
  verify: RepairVerifyMode
  platform?: NodeJS.Platform
  arch?: string
  features?: Record<string, boolean>
  mirrorBase?: string
  signal?: AbortSignal
  onProgress?: (done: number, total: number, currentFile: string | null) => void
}

export interface ScanInternal {
  report: RepairReport
  /** All expected install tasks (client + libraries + index + assets). */
  tasks: PlannedTask[]
  /** Missing/corrupt tasks only; exactly what a repair should re-download. */
  badTasks: PlannedTask[]
  /** Corrupt tasks must be removed before enqueue (t8's batch check skips by size). */
  corruptTasks: PlannedTask[]
  assetIndexUsable: boolean
}

const EXTRA_LIMIT = 200
const HASH_ALGORITHM_PRIORITY = ['sha512', 'sha256', 'sha1'] as const

function hashAlgorithm(task: PlannedTask): 'sha512' | 'sha256' | 'sha1' | null {
  for (const algorithm of HASH_ALGORITHM_PRIORITY) {
    if (typeof task[algorithm] === 'string' && task[algorithm]) return algorithm
  }
  return null
}

function expectedHash(task: PlannedTask, algorithm: string): string | null {
  const value = (task as unknown as Record<string, unknown>)[algorithm]
  return typeof value === 'string' ? value.toLowerCase() : null
}

function safeAbsolute(root: string, destRel: string): string {
  const absolute = path.resolve(root, ...destRel.split('/'))
  const relative = path.relative(root, absolute)
  if (relative.length === 0 || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new RepairError('REPAIR.UNSAFE_TARGET', {
      message: `target escapes mcRoot: ${destRel}`,
      details: { destRel },
    })
  }
  return absolute
}

function hashBytes(fs: FsPort, absolute: string, algorithm: 'sha512' | 'sha256' | 'sha1'): string {
  const hash = createHash(algorithm)
  hash.update(fs.readBytes(absolute))
  return hash.digest('hex')
}

function issueBase(task: PlannedTask): Pick<
  RepairIssue,
  'kind' | 'destRel' | 'shared' | 'expectedSize' | 'expectedHash' | 'hashAlgorithm' | 'url'
> {
  const algorithm = hashAlgorithm(task)
  const kind: RepairIssue['kind'] =
    task.label === 'client'
      ? 'client'
      : task.label === 'asset-index'
        ? 'asset-index'
        : task.label === 'asset'
          ? 'asset'
          : 'library'
  return {
    kind,
    destRel: task.destRel,
    shared: kind !== 'client',
    expectedSize: task.size ?? null,
    expectedHash: algorithm ? expectedHash(task, algorithm) : null,
    hashAlgorithm: algorithm,
    url: task.url ?? null,
  }
}

function verifyTask(
  fs: FsPort,
  root: string,
  task: PlannedTask,
  mode: RepairVerifyMode,
): RepairIssue | null {
  const base = issueBase(task)
  const absolute = safeAbsolute(root, task.destRel)
  const stat = fs.stat(absolute)
  if (!stat?.isFile()) {
    return {
      ...base,
      type: 'missing',
      actualSize: null,
      actualHash: null,
      reason: '文件缺失',
    }
  }
  if (base.expectedSize !== null && stat.size !== base.expectedSize) {
    return {
      ...base,
      type: 'corrupt',
      actualSize: stat.size,
      actualHash: null,
      reason: `大小不符（期望 ${base.expectedSize}，实际 ${stat.size}）`,
    }
  }
  if (mode === 'hash' && base.hashAlgorithm && base.expectedHash) {
    let actual: string
    try {
      actual = hashBytes(fs, absolute, base.hashAlgorithm)
    } catch (error) {
      return {
        ...base,
        type: 'corrupt',
        actualSize: stat.size,
        actualHash: null,
        reason: `读取失败：${error instanceof Error ? error.message : String(error)}`,
      }
    }
    if (actual !== base.expectedHash) {
      return {
        ...base,
        type: 'corrupt',
        actualSize: stat.size,
        actualHash: actual,
        reason: 'SHA 哈希不符',
      }
    }
  }
  return null
}

function listFilesRecursive(
  fs: FsPort,
  root: string,
  relativeDir: string,
  limit: number,
  signal?: AbortSignal,
): string[] {
  const out: string[] = []
  const first = safeAbsolute(root, relativeDir)
  if (!fs.stat(first)?.isDirectory()) return out
  const queue: string[] = [relativeDir]
  while (queue.length > 0 && out.length < limit) {
    if (signal?.aborted) break
    const current = queue.shift()
    if (!current) break
    for (const name of fs.readDir(safeAbsolute(root, current))) {
      if (out.length >= limit) break
      const rel = `${current}/${name}`
      const stat = fs.stat(safeAbsolute(root, rel))
      if (stat?.isDirectory()) queue.push(rel)
      else if (stat?.isFile()) out.push(rel)
    }
  }
  return out
}

function collectExtras(
  fs: FsPort,
  root: string,
  versionDirName: string,
  expectedDestRels: Set<string>,
  index: AssetIndexJson | null,
  signal?: AbortSignal,
): RepairIssue[] {
  const extras: RepairIssue[] = []
  const push = (issue: RepairIssue): void => {
    if (extras.length < EXTRA_LIMIT) extras.push(issue)
  }

  // 1. Files in the instance version directory that the install did not create.
  const expectedVersionTop = new Set([
    `${versionDirName}.json`,
    `${versionDirName}.jar`,
    'instance.json',
    'natives',
  ])
  const versionRel = `versions/${versionDirName}`
  for (const name of fs.readDir(safeAbsolute(root, versionRel))) {
    if (expectedVersionTop.has(name)) continue
    if (name.endsWith('.part')) continue
    const stat = fs.stat(safeAbsolute(root, `${versionRel}/${name}`))
    if (!stat) continue
    push({
      kind: 'client',
      type: 'extra',
      destRel: `${versionRel}/${name}`,
      shared: false,
      expectedSize: null,
      actualSize: stat.isFile() ? stat.size : null,
      expectedHash: null,
      actualHash: null,
      hashAlgorithm: null,
      reason: '实例目录中不属于该版本的文件（不会自动删除）',
      url: null,
    })
  }

  // 2. Libraries not referenced by this version (shared cache; report only).
  const libraryFiles = listFilesRecursive(fs, root, 'libraries', EXTRA_LIMIT, signal)
  for (const destRel of libraryFiles) {
    if (expectedDestRels.has(destRel)) continue
    if (destRel.endsWith('.part')) continue
    const stat = fs.stat(safeAbsolute(root, destRel))
    push({
      kind: 'library',
      type: 'extra',
      destRel,
      shared: true,
      expectedSize: null,
      actualSize: stat?.size ?? null,
      expectedHash: null,
      actualHash: null,
      hashAlgorithm: null,
      reason: '库缓存中不被当前版本引用的文件（共享，不会自动删除）',
      url: null,
    })
  }

  // 3. Asset objects not referenced by this version's index (shared cache).
  if (index) {
    const expectedHashes = new Set(
      Object.values(index.objects).map((object) => object.hash.toLowerCase()),
    )
    const assetFiles = listFilesRecursive(fs, root, 'assets/objects', EXTRA_LIMIT, signal)
    for (const destRel of assetFiles) {
      const name = destRel.split('/').pop() ?? ''
      if (expectedHashes.has(name.toLowerCase())) continue
      const stat = fs.stat(safeAbsolute(root, destRel))
      push({
        kind: 'asset',
        type: 'extra',
        destRel,
        shared: true,
        expectedSize: null,
        actualSize: stat?.size ?? null,
        expectedHash: null,
        actualHash: null,
        hashAlgorithm: null,
        reason: '资源缓存中不被当前版本索引引用的文件（共享，不会自动删除）',
        url: null,
      })
    }
  }

  return extras
}

function loadLocalAssetIndex(
  fs: FsPort,
  root: string,
  versionJson: ReturnType<typeof resolveVersion>['json'],
  mode: RepairVerifyMode,
): { index: AssetIndexJson | null; issue: RepairIssue | null; task: PlannedTask | null } {
  const task = buildAssetIndexTask({ version: versionJson })
  if (!task) return { index: null, issue: null, task: null }
  const base = issueBase(task)
  const absolute = safeAbsolute(root, task.destRel)
  const stat = fs.stat(absolute)
  if (!stat?.isFile()) {
    return {
      index: null,
      issue: {
        ...base,
        type: 'missing',
        actualSize: null,
        actualHash: null,
        reason: '资源索引缺失，无法核对 assets 对象',
      },
      task,
    }
  }
  if (base.expectedSize !== null && stat.size !== base.expectedSize) {
    return {
      index: null,
      issue: {
        ...base,
        type: 'corrupt',
        actualSize: stat.size,
        actualHash: null,
        reason: `资源索引大小不符（期望 ${base.expectedSize}，实际 ${stat.size}）`,
      },
      task,
    }
  }
  if (mode === 'hash' && base.hashAlgorithm && base.expectedHash) {
    let actual: string
    try {
      actual = hashBytes(fs, absolute, base.hashAlgorithm)
    } catch (error) {
      return {
        index: null,
        issue: {
          ...base,
          type: 'corrupt',
          actualSize: stat.size,
          actualHash: null,
          reason: `资源索引读取失败：${error instanceof Error ? error.message : String(error)}`,
        },
        task,
      }
    }
    if (actual !== base.expectedHash) {
      return {
        index: null,
        issue: {
          ...base,
          type: 'corrupt',
          actualSize: stat.size,
          actualHash: actual,
          reason: '资源索引哈希不符',
        },
        task,
      }
    }
  }
  let index: AssetIndexJson
  try {
    index = parseAssetIndex(fs.readText(absolute), absolute)
  } catch (error) {
    return {
      index: null,
      issue: {
        ...base,
        type: 'corrupt',
        actualSize: stat.size,
        actualHash: null,
        reason: `资源索引无法解析：${error instanceof Error ? error.message : String(error)}`,
      },
      task,
    }
  }
  return { index, issue: null, task }
}

export async function scanVersion(input: ScanInput): Promise<ScanInternal> {
  const started = Date.now()
  const warnings: string[] = []
  let resolved: ReturnType<typeof resolveVersion>
  try {
    resolved = resolveVersion(input.fs, input.mcRoot, input.versionId)
  } catch (error) {
    throw new RepairError('REPAIR.VERSION_NOT_FOUND', {
      message: error instanceof Error ? error.message : String(error),
      details: { versionId: input.versionId },
      cause: error,
    })
  }

  const tasks = new Map<string, PlannedTask>()
  const normalizeTask = (task: PlannedTask): PlannedTask => ({
    ...task,
    // t8's library builder uses path.join (backslashes on Windows); the repair
    // report/contract is POSIX-relative like the rest of the shared contracts.
    destRel: task.destRel.replaceAll('\\', '/'),
  })
  const clientTask = buildClientTask({
    versionId: resolved.dirName,
    version: resolved.json,
    ...(input.mirrorBase ? { mirrorBase: input.mirrorBase } : {}),
    warnings,
  })
  if (clientTask) {
    const normalized = normalizeTask(clientTask)
    tasks.set(normalized.destRel, normalized)
  }

  try {
    const libraries = buildLibraryTasks({
      version: resolved.json,
      mcRoot: input.mcRoot,
      ...(input.platform ? { platform: input.platform } : {}),
      ...(input.arch ? { arch: input.arch } : {}),
      ...(input.features ? { features: input.features } : {}),
      ...(input.mirrorBase ? { mirrorBase: input.mirrorBase } : {}),
    })
    warnings.push(...libraries.warnings)
    for (const task of libraries.tasks) {
      if (task.label !== 'library') continue
      const normalized = normalizeTask(task)
      tasks.set(normalized.destRel, normalized)
    }
  } catch (error) {
    throw new RepairError('REPAIR.PLAN_FAILED', {
      message: error instanceof Error ? error.message : String(error),
      details: { versionId: input.versionId },
      cause: error,
    })
  }

  const { index, issue: indexIssue, task: indexTask } = loadLocalAssetIndex(
    input.fs,
    input.mcRoot,
    resolved.json,
    input.verify,
  )
  if (indexTask) {
    const normalized = normalizeTask(indexTask)
    tasks.set(normalized.destRel, normalized)
  }
  if (index) {
    for (const task of buildAssetTasks({
      assetIndex: index,
      ...(input.mirrorBase ? { mirrorBase: input.mirrorBase } : {}),
    })) {
      const normalized = normalizeTask(task)
      tasks.set(normalized.destRel, normalized)
    }
  }

  const allTasks = [...tasks.values()].sort((a, b) => a.destRel.localeCompare(b.destRel))
  const missing: RepairIssue[] = []
  const corrupt: RepairIssue[] = []
  const badTasks: PlannedTask[] = []
  const corruptTasks: PlannedTask[] = []
  let bytesChecked = 0
  let processed = 0

  const record = (task: PlannedTask, issue: RepairIssue | null): void => {
    if (!issue) return
    if (issue.type === 'missing') missing.push(issue)
    else if (issue.type === 'corrupt') {
      corrupt.push(issue)
      corruptTasks.push(task)
    }
    if (issue.type === 'missing' || issue.type === 'corrupt') badTasks.push(task)
  }

  // The asset index is handled separately: if it is unusable, its issue is
  // recorded and no asset objects are guessed.
  if (indexIssue && indexTask) record(indexTask, indexIssue)
  for (const task of allTasks) {
    if (input.signal?.aborted) {
      throw new RepairError('REPAIR.CANCELLED', { message: 'scan cancelled' })
    }
    if (indexTask && task.destRel === indexTask.destRel) {
      processed += 1
      input.onProgress?.(processed, allTasks.length, task.destRel)
      continue
    }
    const stat = input.fs.stat(safeAbsolute(input.mcRoot, task.destRel))
    if (stat?.isFile()) bytesChecked += stat.size
    const issue = verifyTask(input.fs, input.mcRoot, task, input.verify)
    record(task, issue)
    processed += 1
    input.onProgress?.(processed, allTasks.length, task.destRel)
  }

  const expectedDestRels = new Set(allTasks.map((task) => task.destRel))
  const extras = collectExtras(
    input.fs,
    input.mcRoot,
    resolved.dirName,
    expectedDestRels,
    index,
    input.signal,
  )
  if (extras.length >= EXTRA_LIMIT) {
    warnings.push(`多余文件超过 ${EXTRA_LIMIT} 个，报告只显示前 ${EXTRA_LIMIT} 条`)
  }

  if (indexIssue && !index) {
    warnings.push('资源索引不可用，assets 对象未核对；修复会先下载索引再核对')
  }

  const durationMs = Date.now() - started
  const report: RepairReport = {
    versionId: resolved.id,
    dirName: resolved.dirName,
    verify: input.verify,
    checkedAt: started,
    durationMs,
    counts: {
      checked: allTasks.length,
      bytesChecked,
      missing: missing.length,
      corrupt: corrupt.length,
      extra: extras.length,
      missingBytes: missing.reduce((sum, issue) => sum + (issue.expectedSize ?? 0), 0),
      corruptBytes: corrupt.reduce((sum, issue) => sum + (issue.actualSize ?? 0), 0),
    },
    missing,
    corrupt,
    extra: extras,
    warnings,
    ok: missing.length === 0 && corrupt.length === 0,
  }
  return { report, tasks: allTasks, badTasks, corruptTasks, assetIndexUsable: Boolean(index) || !indexTask }
}

export function scanError(error: unknown): RepairError {
  return asRepairError(error, 'REPAIR.SCAN_FAILED')
}

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { AppError } from '@shared/errors'
import type {
  MemoryRecommendation,
  PerfApplyInput,
  PerfApplyResult,
  PerfCacheCategory,
  PerfCacheCleanInput,
  PerfCacheCleanResult,
  PerfCacheScan,
  PerfHardware,
  PerfProcessResult,
  PerfRecommendInput,
} from '@shared/perf'
import type { ScopedLogger } from '../../kernel/logger'
import { nodeFsPort, type FsPort } from '../../core/ports'
import { scanInstances, type ScannedInstance } from '../../core/instance/scan'
import {
  defaultInstanceSettings,
  gameDirectory,
  readInstanceSettings,
  writeInstanceSettings,
} from '../../core/instance/settings'

const execFileAsync = promisify(execFile)

/**
 * Memory/performance panel service.
 *
 * Deliberately probe-based: every hardware field is nullable and failed probes
 * produce a warning instead of a made-up number. Cache cleanup only ever touches
 * the whitelist below (never user game folders).
 */

export interface PerfOsProbe {
  platform: string | null
  arch: string | null
  cpuModel: string | null
  cpuCores: number | null
  totalMemBytes: number | null
  freeMemBytes: number | null
  warnings: string[]
}

export interface PerfServiceOptions {
  dataRoot: string
  log: ScopedLogger
  /** Resolved lazily so a changed Minecraft root applies without a restart. */
  getMcRoot?: () => string | null
  fs?: FsPort
  now?: () => number
  isInstanceRunning?: (instanceId: string, dirName: string) => boolean
  /** Test seams. */
  probeOs?: () => PerfOsProbe
  runTasklist?: () => Promise<string>
  platform?: NodeJS.Platform
}

interface ResolvedInstance {
  instance: ScannedInstance
  gameDir: string
}

interface CacheCategoryDef {
  id: string
  label: string
  path: string
}

const CACHE_CATEGORIES: Array<{ id: string; label: string; segments: string[] }> = [
  { id: 'launcher-cache', label: '启动器缓存', segments: ['cache'] },
  { id: 'crash-dumps', label: '崩溃转储', segments: ['crashDumps'] },
  { id: 'download-cache', label: '下载缓存', segments: ['modules', 'download', 'cache'] },
  { id: 'catalog-packs', label: '整合包下载缓存', segments: ['modules', 'catalog', 'packs'] },
]

function defaultProbe(): PerfOsProbe {
  const warnings: string[] = []
  let totalMemBytes: number | null = null
  let freeMemBytes: number | null = null
  let cpuModel: string | null = null
  let cpuCores: number | null = null
  try {
    const total = os.totalmem()
    if (Number.isFinite(total) && total > 0) totalMemBytes = Math.floor(total)
    else warnings.push('无法读取物理内存总量')
    const free = os.freemem()
    if (Number.isFinite(free) && free >= 0) freeMemBytes = Math.floor(free)
  } catch {
    warnings.push('无法读取物理内存')
  }
  try {
    const cpus = os.cpus()
    cpuCores = cpus.length > 0 ? cpus.length : null
    const model = cpus[0]?.model?.trim()
    cpuModel = model && model.length > 0 ? model.slice(0, 200) : null
    if (cpuCores === null) warnings.push('无法读取 CPU 信息')
  } catch {
    warnings.push('无法读取 CPU 信息')
  }
  return {
    platform: safeString(os.platform()),
    arch: safeString(os.arch()),
    cpuModel,
    cpuCores,
    totalMemBytes,
    freeMemBytes,
    warnings,
  }
}

function safeString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function parseTasklistCsv(text: string): Array<{ pid: number; name: string; memBytes: number }> {
  const rows: Array<{ pid: number; name: string; memBytes: number }> = []
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const fields: string[] = []
    let current = ''
    let quoted = false
    for (let index = 0; index < trimmed.length; index += 1) {
      const char = trimmed[index]
      if (char === '"') {
        if (quoted && trimmed[index + 1] === '"') {
          current += '"'
          index += 1
        } else {
          quoted = !quoted
        }
      } else if (char === ',' && !quoted) {
        fields.push(current)
        current = ''
      } else {
        current += char
      }
    }
    fields.push(current)
    if (fields.length < 5) continue
    const name = fields[0]?.trim() ?? ''
    if (!/^javaw?\.exe$/i.test(name)) continue
    const pid = Number.parseInt(fields[1]?.trim() ?? '', 10)
    const memoryKb = Number.parseInt(fields[4]?.replace(/[^0-9]/g, '') ?? '', 10)
    if (!Number.isInteger(pid) || pid <= 0 || !Number.isFinite(memoryKb)) continue
    rows.push({ pid, name, memBytes: Math.max(0, memoryKb) * 1024 })
  }
  return rows.sort((a, b) => b.memBytes - a.memBytes)
}

function measurePath(target: string): { files: number; bytes: number; present: boolean } {
  if (!fs.existsSync(target)) return { files: 0, bytes: 0, present: false }
  let files = 0
  let bytes = 0
  const stack = [target]
  while (stack.length > 0) {
    const current = stack.pop() as string
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const child = path.join(current, entry.name)
      if (entry.isSymbolicLink()) {
        // Never follow links: the cache cleaner must not escape the whitelist.
        files += 1
        continue
      }
      if (entry.isDirectory()) {
        stack.push(child)
      } else if (entry.isFile()) {
        files += 1
        try {
          bytes += fs.statSync(child).size
        } catch {
          /* raced with another cleanup */
        }
      }
    }
  }
  return { files, bytes, present: true }
}

export class PerfService {
  private readonly log: ScopedLogger
  private readonly now: () => number
  private readonly fs: FsPort

  constructor(private readonly options: PerfServiceOptions) {
    this.log = options.log
    this.now = options.now ?? Date.now
    this.fs = options.fs ?? nodeFsPort()
  }

  hardware(): PerfHardware {
    const probe = (this.options.probeOs ?? defaultProbe)()
    return {
      platform: probe.platform,
      arch: probe.arch,
      cpuModel: probe.cpuModel,
      cpuCores: probe.cpuCores,
      totalMemBytes: probe.totalMemBytes,
      freeMemBytes: probe.freeMemBytes,
      warnings: probe.warnings,
      detectedAt: this.now(),
    }
  }

  private resolve(instanceId: string): ResolvedInstance {
    const mcRoot = this.options.getMcRoot?.() ?? null
    if (!mcRoot) {
      throw new AppError('PERF.NO_MC_ROOT', '还没有选择 Minecraft 目录')
    }
    const instance = scanInstances(this.fs, mcRoot).find(
      (item) => item.id === instanceId || item.dirName === instanceId,
    )
    if (!instance) {
      throw new AppError('PERF.INSTANCE_NOT_FOUND', `找不到实例: ${instanceId}`, {
        details: { instanceId },
      })
    }
    return {
      instance,
      gameDir: gameDirectory(mcRoot, instance.dirName, instance.isolation),
    }
  }

  private countMods(gameDir: string): number {
    const modsDir = path.join(gameDir, 'mods')
    try {
      return fs
        .readdirSync(modsDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.jar')).length
    } catch {
      return 0
    }
  }

  recommend(input: PerfRecommendInput = {}): MemoryRecommendation {
    const hardware = this.hardware()
    if (hardware.totalMemBytes === null || hardware.totalMemBytes <= 0) {
      throw new AppError('PERF.HARDWARE_UNKNOWN', '无法读取物理内存，不能安全推荐 -Xmx', {
        details: { hint: '请手动在实例设置里指定内存，或检查系统信息读取权限。' },
      })
    }
    let instance: ResolvedInstance | null = null
    if (input.instanceId) instance = this.resolve(input.instanceId)
    const modCount = input.modCount ?? (instance ? this.countMods(instance.gameDir) : 0)
    const totalMb = Math.floor(hardware.totalMemBytes / (1024 * 1024))
    const baseMb = Math.min(8192, Math.max(2048, Math.round(totalMb * 0.25)))
    const bonusMb = Math.floor(modCount / 50) * 512
    const capMb = Math.max(0, Math.floor(totalMb * 0.75))
    const recommendedMb = Math.max(1, Math.min(capMb, baseMb + bonusMb))
    const warnings: string[] = []
    if (baseMb + bonusMb > capMb) {
      warnings.push(
        `按 mod 数计算 ${baseMb + bonusMb} MB，但不超过物理内存 75%（${capMb} MB），已下调。`,
      )
    }
    if (capMb < baseMb) {
      warnings.push('物理内存较小，推荐值低于 2 GB 基础值。')
    }
    const running = instance
      ? Boolean(
          this.options.isInstanceRunning?.(
            instance.instance.id,
            instance.instance.dirName,
          ),
        )
      : false
    if (running) warnings.push('实例正在运行；内存设置将在下次启动时生效。')
    if (hardware.warnings.length > 0) warnings.push(...hardware.warnings)
    return {
      instanceId: instance?.instance.dirName ?? null,
      modCount,
      totalMemBytes: hardware.totalMemBytes,
      baseMb,
      bonusMb,
      capMb,
      recommendedMb,
      clamped: baseMb + bonusMb > capMb,
      running,
      warnings,
    }
  }

  apply(input: PerfApplyInput): PerfApplyResult {
    const resolved = this.resolve(input.instanceId)
    const { instance, gameDir } = resolved
    const hardware = this.hardware()
    const totalMb =
      hardware.totalMemBytes && hardware.totalMemBytes > 0
        ? Math.floor(hardware.totalMemBytes / (1024 * 1024))
        : null
    const mb = input.mb ?? this.recommend({ instanceId: input.instanceId }).recommendedMb
    if (totalMb !== null && mb > Math.floor(totalMb * 0.75)) {
      throw new AppError(
        'PERF.MEMORY_TOO_HIGH',
        `内存 ${mb} MB 超过物理内存的 75%（${Math.floor(totalMb * 0.75)} MB）`,
        { details: { mb, capMb: Math.floor(totalMb * 0.75) } },
      )
    }
    const read = readInstanceSettings(this.fs, gameDir).settings
    const current =
      read ??
      defaultInstanceSettings({
        dirName: instance.dirName,
        name: instance.name,
        mcVersion: instance.mcVersion,
        loader: instance.loader,
        isolation: 'isolated',
        source: 'ours',
      })
    const previousMb =
      current.memoryMode === 'custom' ? Math.round(current.memory.maxMb) : null
    writeInstanceSettings(this.fs, gameDir, {
      ...current,
      memoryMode: 'custom',
      memory: { minMb: Math.min(current.memory.minMb, mb), maxMb: mb },
    })
    const running = Boolean(
      this.options.isInstanceRunning?.(instance.id, instance.dirName),
    )
    this.log.info('memory applied to instance', {
      instanceId: instance.dirName,
      mb,
      previousMb,
      running,
    })
    return {
      instanceId: instance.dirName,
      dirName: instance.dirName,
      previousMb,
      mb,
      mode: 'custom',
      appliesNextLaunch: running,
    }
  }

  async processes(): Promise<PerfProcessResult> {
    const platform = this.options.platform ?? process.platform
    if (platform !== 'win32') {
      return {
        supported: false,
        source: 'unavailable',
        processes: [],
        totalBytes: 0,
        error: '只有 Windows 支持 tasklist 进程占用读取',
      }
    }
    try {
      const output = this.options.runTasklist
        ? await this.options.runTasklist()
        : (await execFileAsync('tasklist', ['/FO', 'CSV', '/NH'], {
            windowsHide: true,
            maxBuffer: 4 * 1024 * 1024,
          })).stdout
      const processes = parseTasklistCsv(output)
      return {
        supported: true,
        source: 'tasklist',
        processes,
        totalBytes: processes.reduce((total, item) => total + item.memBytes, 0),
        error: null,
      }
    } catch {
      return {
        supported: true,
        source: 'tasklist',
        processes: [],
        totalBytes: 0,
        error: 'TASKLIST_FAILED',
      }
    }
  }

  private cacheCategories(): CacheCategoryDef[] {
    return CACHE_CATEGORIES.map((entry) => ({
      id: entry.id,
      label: entry.label,
      path: path.join(this.options.dataRoot, ...entry.segments),
    }))
  }

  scanCache(): PerfCacheScan {
    const categories: PerfCacheCategory[] = this.cacheCategories().map((entry) => {
      const measured = measurePath(entry.path)
      return {
        id: entry.id,
        label: entry.label,
        path: entry.path,
        files: measured.files,
        bytes: measured.bytes,
        present: measured.present,
      }
    })
    return {
      categories,
      totalFiles: categories.reduce((total, item) => total + item.files, 0),
      totalBytes: categories.reduce((total, item) => total + item.bytes, 0),
      generatedAt: this.now(),
    }
  }

  cleanCache(input: PerfCacheCleanInput = {}): PerfCacheCleanResult {
    const all = this.cacheCategories()
    const requested = input.categories ? new Set(input.categories) : null
    const unknown = requested ? [...requested].filter((id) => !all.some((item) => item.id === id)) : []
    if (unknown.length > 0) {
      throw new AppError('PERF.CACHE_UNKNOWN', `未知的缓存类别: ${unknown.join(', ')}`, {
        details: { categories: unknown },
      })
    }
    const selected = all.filter((entry) => !requested || requested.has(entry.id))
    const errors: string[] = []
    let removedFiles = 0
    let removedBytes = 0
    for (const entry of selected) {
      const measured = measurePath(entry.path)
      removedFiles += measured.files
      removedBytes += measured.bytes
      let children: string[] = []
      try {
        children = fs.readdirSync(entry.path)
      } catch {
        continue
      }
      for (const child of children) {
        try {
          fs.rmSync(path.join(entry.path, child), { recursive: true, force: true })
        } catch (error) {
          errors.push(
            `${entry.id}: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }
    }
    const after = this.cacheCategories().map((entry) => {
      const measured = measurePath(entry.path)
      return {
        id: entry.id,
        label: entry.label,
        path: entry.path,
        files: measured.files,
        bytes: measured.bytes,
        present: measured.present,
      }
    })
    this.log.info('performance cache cleaned', {
      categories: selected.map((entry) => entry.id),
      removedFiles,
      removedBytes,
      errors: errors.length,
    })
    return { removedFiles, removedBytes, categories: after, errors }
  }
}

export function createPerfService(options: PerfServiceOptions): PerfService {
  return new PerfService(options)
}

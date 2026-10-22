import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { perfContract } from '@shared/perf'
import type { ScopedLogger } from '../../../kernel/logger'
import { nodeFsPort } from '../../../core/ports'
import { defaultInstanceSettings, readInstanceSettings, writeInstanceSettings } from '../../../core/instance/settings'
import { makeHandlers } from '../handlers'
import { createPerfService, type PerfOsProbe, type PerfService } from '../service'

const cleanup: string[] = []
afterEach(() => {
  for (const dir of cleanup.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

const logger = {
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
} as unknown as ScopedLogger

function writeFile(target: string, contents: string | Buffer): void {
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, contents)
}

function probe(overrides: Partial<PerfOsProbe> = {}): PerfOsProbe {
  return {
    platform: 'win32',
    arch: 'x64',
    cpuModel: 'Test CPU @ 3.50GHz',
    cpuCores: 8,
    totalMemBytes: 32 * 1024 * 1024 * 1024,
    freeMemBytes: 16 * 1024 * 1024 * 1024,
    warnings: [],
    ...overrides,
  }
}

interface Fixture {
  root: string
  dataRoot: string
  mcRoot: string
  gameDir: string
  service: PerfService
}

function fixture(
  options: {
    mods?: number
    probeOs?: () => PerfOsProbe
    runTasklist?: () => Promise<string>
    platform?: NodeJS.Platform
    running?: boolean
  } = {},
): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcl-perf-'))
  cleanup.push(root)
  const dataRoot = path.join(root, 'data')
  const mcRoot = path.join(root, 'mc')
  const gameDir = path.join(mcRoot, 'versions', 'A')
  writeFile(path.join(gameDir, 'A.json'), JSON.stringify({ id: 'A', type: 'release', mainClass: 'x', libraries: [] }))
  writeFile(path.join(gameDir, 'A.jar'), 'jar')
  writeInstanceSettings(
    nodeFsPort(),
    gameDir,
    defaultInstanceSettings({
      dirName: 'A',
      name: 'A',
      mcVersion: '1.20.1',
      loader: { type: 'fabric', version: '0.15.0' },
      isolation: 'isolated',
      now: 1,
    }),
  )
  for (let index = 0; index < (options.mods ?? 0); index += 1) {
    writeFile(path.join(gameDir, 'mods', `mod-${index}.jar`), 'mod')
  }
  const service = createPerfService({
    dataRoot,
    log: logger,
    getMcRoot: () => mcRoot,
    now: () => 1_700_000_000_000,
    ...(options.probeOs ? { probeOs: options.probeOs } : {}),
    ...(options.runTasklist ? { runTasklist: options.runTasklist } : {}),
    platform: options.platform ?? 'win32',
    isInstanceRunning: () => Boolean(options.running),
  })
  return { root, dataRoot, mcRoot, gameDir, service }
}

describe('perf hardware & recommendation', () => {
  it('keeps unknown probes null instead of inventing values', () => {
    const h = fixture({
      probeOs: () =>
        probe({
          platform: null,
          arch: null,
          cpuModel: null,
          cpuCores: null,
          totalMemBytes: null,
          freeMemBytes: null,
          warnings: ['无法读取物理内存'],
        }),
    })
    const hardware = h.service.hardware()
    expect(hardware).toMatchObject({
      platform: null,
      arch: null,
      cpuModel: null,
      cpuCores: null,
      totalMemBytes: null,
      freeMemBytes: null,
    })
    expect(hardware.warnings).toContain('无法读取物理内存')
    expect(() => h.service.recommend({ modCount: 10 })).toThrowError(
      expect.objectContaining({ code: 'PERF.HARDWARE_UNKNOWN' }),
    )
  })

  it('recommends clamp(25% RAM, 2048, 8192) + 512 MB per 50 mods', () => {
    const h = fixture({ mods: 120, probeOs: () => probe() })
    const base = h.service.recommend({})
    expect(base).toMatchObject({ baseMb: 8192, bonusMb: 0, capMb: 24576, recommendedMb: 8192 })
    const withInstance = h.service.recommend({ instanceId: 'A' })
    expect(withInstance).toMatchObject({
      modCount: 120,
      baseMb: 8192,
      bonusMb: 1024,
      recommendedMb: 9216,
      instanceId: 'A',
    })
    expect(withInstance.clamped).toBe(false)
    expect(perfContract.methods.recommend.output.safeParse(withInstance).success).toBe(true)
  })

  it('caps the recommendation at 75% of low RAM and reports the clamp', () => {
    const h = fixture({
      probeOs: () => probe({ totalMemBytes: 4 * 1024 * 1024 * 1024 }),
    })
    const recommendation = h.service.recommend({ modCount: 200 })
    expect(recommendation).toMatchObject({
      totalMemBytes: 4 * 1024 * 1024 * 1024,
      baseMb: 2048,
      bonusMb: 2048,
      capMb: 3072,
      recommendedMb: 3072,
      clamped: true,
    })
    expect(recommendation.warnings.join(' ')).toContain('75%')
  })
})

describe('perf apply', () => {
  it('writes memoryMode=custom and maxMb into the instance settings', () => {
    const h = fixture()
    const result = h.service.apply({ instanceId: 'A', mb: 6144 })
    expect(result).toMatchObject({
      instanceId: 'A',
      previousMb: null,
      mb: 6144,
      mode: 'custom',
      appliesNextLaunch: false,
    })
    const settings = readInstanceSettings(nodeFsPort(), h.gameDir).settings!
    expect(settings.memoryMode).toBe('custom')
    expect(settings.memory.maxMb).toBe(6144)
    expect(settings.memory.minMb).toBeLessThanOrEqual(6144)
    expect(perfContract.methods.apply.output.safeParse(result).success).toBe(true)
  })

  it('uses the recommendation by default and marks running instances as next-launch', () => {
    const h = fixture({ running: true, mods: 120, probeOs: () => probe() })
    const result = h.service.apply({ instanceId: 'A' })
    expect(result.mb).toBe(9216)
    expect(result.appliesNextLaunch).toBe(true)
    const recommendation = h.service.recommend({ instanceId: 'A' })
    expect(recommendation.running).toBe(true)
    expect(recommendation.warnings.join(' ')).toContain('下次启动')
  })

  it('rejects memory above 75% and unknown instances', () => {
    const h = fixture({ probeOs: () => probe({ totalMemBytes: 4 * 1024 * 1024 * 1024 }) })
    expect(() => h.service.apply({ instanceId: 'A', mb: 4096 })).toThrowError(
      expect.objectContaining({ code: 'PERF.MEMORY_TOO_HIGH' }),
    )
    expect(() => h.service.apply({ instanceId: 'missing', mb: 2048 })).toThrowError(
      expect.objectContaining({ code: 'PERF.INSTANCE_NOT_FOUND' }),
    )
  })
})

describe('perf processes', () => {
  it('parses tasklist CSV and keeps Java game processes', async () => {
    const h = fixture({
      runTasklist: async () =>
        [
          '"javaw.exe","1234","Console","1","1,024,000 K"',
          '"java.exe","2222","Console","1","512,000 K"',
          '"notepad.exe","3333","Console","1","1,000 K"',
          '',
        ].join('\r\n'),
    })
    const result = await h.service.processes()
    expect(result).toMatchObject({ supported: true, source: 'tasklist', error: null })
    expect(result.processes.map((item) => item.pid)).toEqual([1234, 2222])
    expect(result.processes[0].memBytes).toBe(1_024_000 * 1024)
    expect(result.totalBytes).toBe((1_024_000 + 512_000) * 1024)
    expect(perfContract.methods.processes.output.safeParse(result).success).toBe(true)
  })

  it('reports tasklist failure and unsupported platforms without throwing', async () => {
    const failing = fixture({
      runTasklist: async () => {
        throw new Error('tasklist missing')
      },
    })
    expect(await failing.service.processes()).toMatchObject({
      supported: true,
      processes: [],
      error: 'TASKLIST_FAILED',
    })
    const linux = fixture({ platform: 'linux' })
    expect(await linux.service.processes()).toMatchObject({
      supported: false,
      source: 'unavailable',
      processes: [],
    })
  })
})

describe('perf cache whitelist', () => {
  it('dry-run counts only whitelisted caches and clean removes the selected one', () => {
    const h = fixture()
    writeFile(path.join(h.dataRoot, 'cache', 'a.bin'), Buffer.alloc(100))
    writeFile(path.join(h.dataRoot, 'cache', 'sub', 'b.bin'), Buffer.alloc(50))
    writeFile(path.join(h.dataRoot, 'crashDumps', 'crash.dmp'), Buffer.alloc(200))
    writeFile(path.join(h.dataRoot, 'modules', 'catalog', 'packs', 'pack.zip'), Buffer.alloc(300))
    writeFile(path.join(h.dataRoot, 'keep.txt'), 'must not be counted or deleted')

    const scan = h.service.scanCache()
    expect(scan.totalFiles).toBe(4)
    expect(scan.totalBytes).toBe(650)
    const cache = scan.categories.find((entry) => entry.id === 'launcher-cache')
    expect(cache).toMatchObject({ files: 2, bytes: 150, present: true })
    // Dry-run writes nothing.
    expect(fs.existsSync(path.join(h.dataRoot, 'cache', 'a.bin'))).toBe(true)
    expect(perfContract.methods.scanCache.output.safeParse(scan).success).toBe(true)

    const cleaned = h.service.cleanCache({ categories: ['launcher-cache'] })
    expect(cleaned).toMatchObject({ removedFiles: 2, removedBytes: 150 })
    expect(fs.existsSync(path.join(h.dataRoot, 'cache', 'a.bin'))).toBe(false)
    expect(fs.existsSync(path.join(h.dataRoot, 'crashDumps', 'crash.dmp'))).toBe(true)
    expect(fs.readFileSync(path.join(h.dataRoot, 'keep.txt'), 'utf8')).toBe(
      'must not be counted or deleted',
    )
    expect(perfContract.methods.cleanCache.output.safeParse(cleaned).success).toBe(true)
  })

  it('rejects unknown cache categories', () => {
    const h = fixture()
    expect(() => h.service.cleanCache({ categories: ['launcher-cache', 'minecraft-saves'] })).toThrowError(
      expect.objectContaining({ code: 'PERF.CACHE_UNKNOWN' }),
    )
  })
})

describe('perf IPC handlers', () => {
  it('exposes one handler per contract method', () => {
    const handlers = makeHandlers({} as unknown as PerfService) as Record<string, unknown>
    for (const method of Object.keys(perfContract.methods)) {
      expect(typeof handlers[method]).toBe('function')
    }
  })
})

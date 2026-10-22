import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ScopedLogger } from '../../../kernel/logger'
import type { InstanceCopyProgress } from '@shared/instance'
import { contract } from '@shared/instance'
import { makeHandlers } from '../handlers'
import { createInstanceService, type InstanceModuleService } from '../service'

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

function versionJson(id: string): string {
  return JSON.stringify({
    id,
    type: 'release',
    mainClass: 'net.minecraft.client.main.Main',
    assets: id,
    libraries: [],
    arguments: { game: [], jvm: [] },
  })
}

interface Fixture {
  root: string
  mcRoot: string
  dataRoot: string
  instanceDir: string
  service: ReturnType<typeof createInstanceService>
}

function fixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcl-copy-'))
  cleanup.push(root)
  const mcRoot = path.join(root, 'mc')
  const dataRoot = path.join(root, 'data')
  const instanceDir = path.join(mcRoot, 'versions', '1.20.1')
  writeFile(path.join(instanceDir, '1.20.1.json'), versionJson('1.20.1'))
  writeFile(path.join(instanceDir, '1.20.1.jar'), 'client-jar')
  writeFile(path.join(instanceDir, 'instance.json'), JSON.stringify({
    schemaVersion: 1,
    id: '1.20.1',
    dirName: '1.20.1',
    name: 'Test Instance',
    mcVersion: '1.20.1',
    loader: { type: 'fabric', version: '0.15.0' },
    isolation: 'isolated',
    createdAt: 1,
  }))
  writeFile(path.join(instanceDir, 'mods', 'example.jar'), 'mod-bytes')
  writeFile(path.join(instanceDir, 'config', 'example.toml'), 'enabled=true')
  writeFile(path.join(instanceDir, 'saves', 'world', 'level.dat'), 'world-bytes')
  const service = createInstanceService(
    { dataRoot, mcRoot },
    logger,
    { now: () => 1_700_000_000_000 },
  )
  return { root, mcRoot, dataRoot, instanceDir, service }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const began = Date.now()
  while (!predicate()) {
    if (Date.now() - began > timeoutMs) throw new Error('condition not met in time')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function listPartFiles(root: string): string[] {
  const entries = fs.readdirSync(root, { recursive: true }) as string[]
  return entries.filter((name) => name.endsWith('.part'))
}

describe('instance copy job', () => {
  it('exposes one handler per copy contract method', () => {
    const handlers = makeHandlers({} as unknown as InstanceModuleService) as Record<string, unknown>
    for (const method of Object.keys(contract.methods)) {
      expect(typeof handlers[method]).toBe('function')
    }
    for (const event of ['copyProgress', 'copyFinished']) {
      expect(contract.events).toHaveProperty(event)
    }
  })

  it('returns a jobId and duplicates the isolated instance asynchronously', async () => {
    const h = fixture()
    const progress: InstanceCopyProgress[] = []
    const finished: unknown[] = []
    const service = createInstanceService({ dataRoot: h.dataRoot, mcRoot: h.mcRoot }, logger, {
      now: () => 1_700_000_000_000,
      onCopyProgress: (event) => progress.push(event),
      onCopyFinished: (event) => finished.push(event),
    })

    const started = await service.copyInstance('1.20.1')
    expect(started.jobId).toBeTruthy()
    expect(started.instanceId).toBe(started.dirName)
    expect(started.name).toBe('Test Instance 副本')

    const outcome = await service.waitForCopy(started.jobId, 30_000)
    expect(outcome.ok).toBe(true)
    const summary = outcome.result!
    expect(summary).toMatchObject({
      id: started.dirName,
      dirName: started.dirName,
      name: 'Test Instance 副本',
      isolation: 'isolated',
      mcVersion: '1.20.1',
    })

    const targetDir = path.join(h.mcRoot, 'versions', started.dirName)
    expect(fs.existsSync(path.join(targetDir, 'mods', 'example.jar'))).toBe(true)
    expect(fs.existsSync(path.join(targetDir, 'config', 'example.toml'))).toBe(true)
    expect(fs.existsSync(path.join(targetDir, 'saves', 'world', 'level.dat'))).toBe(true)
    // The version JSON / jar carry the new id so Minecraft can resolve them.
    const renamed = JSON.parse(
      fs.readFileSync(path.join(targetDir, `${started.dirName}.json`), 'utf8'),
    ) as { id: string }
    expect(renamed.id).toBe(started.dirName)
    expect(fs.existsSync(path.join(targetDir, `${started.dirName}.jar`))).toBe(true)
    expect(fs.existsSync(path.join(targetDir, '1.20.1.json'))).toBe(false)
    // The source instance is untouched.
    expect(fs.existsSync(path.join(h.instanceDir, '1.20.1.json'))).toBe(true)

    expect(progress.some((event) => event.stage === 'copy')).toBe(true)
    expect(progress.some((event) => event.stage === 'finalize')).toBe(true)
    const last = progress[progress.length - 1]
    expect(contract.events.copyProgress.payload.safeParse(last).success).toBe(true)
    expect(finished).toHaveLength(1)
    const finishedEvent = finished[0] as { ok: boolean; state: string; instanceId: string }
    expect(finishedEvent).toMatchObject({
      ok: true,
      state: 'done',
      instanceId: started.instanceId,
    })
    expect(contract.events.copyFinished.payload.safeParse(finished[0]).success).toBe(true)
    expect(service.copyResult(started.jobId)?.result?.id).toBe(started.dirName)
  })

  it('can exclude saves/', async () => {
    const h = fixture()
    const started = await h.service.copyInstance('1.20.1', { includeWorlds: false })
    const outcome = await h.service.waitForCopy(started.jobId, 30_000)
    expect(outcome.ok).toBe(true)
    const targetDir = path.join(h.mcRoot, 'versions', started.dirName)
    expect(fs.existsSync(path.join(targetDir, 'saves'))).toBe(false)
    expect(fs.existsSync(path.join(targetDir, 'mods', 'example.jar'))).toBe(true)
  })

  it('cancels a large copy within 3 s and removes the partial target', async () => {
    const h = fixture()
    // 96 MB gives the cancel a comfortable mid-file window without slowing CI.
    writeFile(
      path.join(h.instanceDir, 'datapacks', 'big.bin'),
      Buffer.alloc(96 * 1024 * 1024, 7),
    )
    const started = await h.service.copyInstance('1.20.1')
    await waitUntil(() => {
      const status = h.service.copyStatus(started.jobId)
      return status?.stage === 'copy' && status.bytesDone > 1024 * 1024
    })

    const cancelledAt = Date.now()
    expect(h.service.cancelCopy(started.jobId)).toEqual({ cancelled: true })
    const outcome = await h.service.waitForCopy(started.jobId, 10_000)
    expect(Date.now() - cancelledAt).toBeLessThan(3_000)
    expect(outcome.state).toBe('cancelled')
    expect(outcome.result).toBeNull()

    const targetDir = path.join(h.mcRoot, 'versions', started.dirName)
    expect(fs.existsSync(targetDir)).toBe(false)
    expect(listPartFiles(h.mcRoot)).toEqual([])
    // The source instance still has its 96 MB file and nothing else changed.
    expect(fs.statSync(path.join(h.instanceDir, 'datapacks', 'big.bin')).size).toBe(
      96 * 1024 * 1024,
    )
    expect(fs.existsSync(path.join(h.instanceDir, '1.20.1.json'))).toBe(true)

    // Retry after a cancel succeeds and reuses the freed directory name.
    const retried = await h.service.copyInstance('1.20.1')
    expect(retried.dirName).toBe(started.dirName)
    const retryOutcome = await h.service.waitForCopy(retried.jobId, 60_000)
    expect(retryOutcome.ok).toBe(true)
    expect(
      fs.existsSync(path.join(h.mcRoot, 'versions', retried.dirName, 'datapacks', 'big.bin')),
    ).toBe(true)
  }, 60_000)

  it('keeps the event loop responsive while streaming a large file', async () => {
    const h = fixture()
    const big = path.join(h.instanceDir, 'datapacks', 'responsive.bin')
    writeFile(big, Buffer.alloc(24 * 1024 * 1024, 3))

    const started = await h.service.copyInstance('1.20.1')
    let last = Date.now()
    let maxGap = 0
    const timer = setInterval(() => {
      const now = Date.now()
      maxGap = Math.max(maxGap, now - last)
      last = now
    }, 10)
    try {
      const outcome = await h.service.waitForCopy(started.jobId, 60_000)
      expect(outcome.ok).toBe(true)
    } finally {
      clearInterval(timer)
    }
    // The old fs.cpSync implementation blocked the loop for the whole copy;
    // streaming keeps the heartbeat gap in the low milliseconds.
    expect(maxGap).toBeLessThan(750)
  }, 60_000)
})

/**
 * Opt-in real-size benchmark for the acceptance criterion "copying an 8 GB
 * instance does not block the main process":
 *
 *   MCL_BIG_COPY=1 npx vitest run src/main/modules/instance/__tests__/copy-job.test.ts
 *
 * Skipped by default because it allocates ~16 GB of temp space. The heartbeat
 * measures the longest event-loop stall while the copy runs.
 */
describe.skipIf(process.env.MCL_BIG_COPY !== '1')('instance copy 8 GB benchmark', () => {
  it('copies an 8 GB instance with a responsive event loop', async () => {
    const h = fixture()
    const big = path.join(h.instanceDir, 'datapacks', 'huge.bin')
    fs.mkdirSync(path.dirname(big), { recursive: true })
    const chunk = Buffer.alloc(1024 * 1024, 9)
    const fd = fs.openSync(big, 'w')
    try {
      for (let index = 0; index < 8 * 1024; index += 1) fs.writeSync(fd, chunk)
    } finally {
      fs.closeSync(fd)
    }
    expect(fs.statSync(big).size).toBe(8 * 1024 * 1024 * 1024)

    const began = Date.now()
    const started = await h.service.copyInstance('1.20.1')
    let last = Date.now()
    let maxGap = 0
    const timer = setInterval(() => {
      const now = Date.now()
      maxGap = Math.max(maxGap, now - last)
      last = now
    }, 10)
    let outcome
    try {
      outcome = await h.service.waitForCopy(started.jobId, 15 * 60_000)
    } finally {
      clearInterval(timer)
    }
    const durationMs = Date.now() - began
    const target = path.join(h.mcRoot, 'versions', started.dirName, 'datapacks', 'huge.bin')
    expect(outcome.ok).toBe(true)
    expect(fs.statSync(target).size).toBe(8 * 1024 * 1024 * 1024)
    console.log(
      `[copy-benchmark] bytes=${fs.statSync(target).size} durationMs=${durationMs} maxEventLoopGapMs=${maxGap}`,
    )
    expect(maxGap).toBeLessThan(1_000)
  }, 20 * 60_000)
})

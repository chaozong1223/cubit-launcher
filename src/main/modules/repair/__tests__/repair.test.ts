import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { repairContract } from '@shared/repair'
import { Logger } from '../../../kernel/logger'
import { nodeFsPort } from '../../../core/ports'
import { RepairModuleService } from '../service'
import { cleanupFixture, createFixture, FakeDownloader, type Fixture } from './support/harness'

let fixture: Fixture
let dataRoot: string
let service: RepairModuleService
let downloader: FakeDownloader
let events: Array<{ event: string; payload: unknown }>

beforeEach(() => {
  fixture = createFixture('mcl-repair-fix-')
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcl-repair-data-'))
  downloader = new FakeDownloader(fixture.root, fixture.payloads)
  events = []
  service = new RepairModuleService(
    { dataRoot, mcRoot: fixture.root },
    new Logger({ dataRoot, console: false }).child('module:repair'),
    {
      fs: nodeFsPort(),
      downloader,
      platform: 'win32',
      arch: 'x64',
      emit: (event, payload) => events.push({ event, payload }),
    },
  )
})

afterEach(() => {
  service.dispose()
  cleanupFixture(fixture.root)
  fs.rmSync(dataRoot, { recursive: true, force: true })
})

async function repair() {
  const { jobId } = await service.repair({ versionId: fixture.versionId, verify: 'hash' })
  await service.waitForJob(jobId)
  return { jobId, report: service.report(jobId) }
}

describe('one-click repair', () => {
  it('downloads only missing/corrupt files and verifies cleanly afterwards', async () => {
    const { report } = await repair()
    expect(report).not.toBeNull()
    expect(report!.ok).toBe(true)
    expect(report!.missing).toEqual([])
    expect(report!.corrupt).toEqual([])
    // Extras are reported but never deleted.
    expect(report!.extra.length).toBeGreaterThanOrEqual(3)
    expect(fs.existsSync(path.join(fixture.root, 'versions/1.20.1/extra.txt'))).toBe(true)

    const repaired = downloader.enqueued.map((task) => task.destRel)
    expect(repaired).toHaveLength(4)
    expect(repaired).toContain('libraries/com/example/lib-b/1.0/lib-b-1.0.jar')
    expect(repaired).toContain('libraries/com/example/lib-c/1.0/lib-c-1.0.jar')
    expect(repaired.filter((rel) => rel.startsWith('assets/objects/'))).toHaveLength(2)
    for (const rel of repaired) {
      expect(rel.startsWith('mods/') || rel.startsWith('saves/') || rel.startsWith('config/')).toBe(false)
      expect(rel.includes('/extra')).toBe(false)
    }

    for (const file of fixture.userFiles) {
      expect(fs.readFileSync(path.join(fixture.root, ...file.rel.split('/')), 'utf8')).toBe(file.content)
    }
    expect(events.some((entry) => entry.event === 'repairFinished')).toBe(true)
    const finished = events.filter((entry) => entry.event === 'repairFinished').at(-1)?.payload as {
      ok: boolean
    }
    expect(finished.ok).toBe(true)
  })

  it('emits scan and repair progress events', async () => {
    const scan = await service.scan({ versionId: fixture.versionId, verify: 'hash' })
    await service.waitForJob(scan.jobId)
    expect(events.some((entry) => entry.event === 'scanProgress')).toBe(true)
    expect(events.some((entry) => entry.event === 'scanFinished')).toBe(true)

    const { jobId } = await service.repair({ versionId: fixture.versionId, verify: 'hash' })
    await service.waitForJob(jobId)
    const repairProgress = events.filter((entry) => entry.event === 'repairProgress')
    expect(repairProgress.length).toBeGreaterThan(0)
    expect(repairProgress.some((entry) => (entry.payload as { stage: string }).stage === 'scan')).toBe(true)
    expect(repairProgress.some((entry) => (entry.payload as { stage: string }).stage === 'download')).toBe(true)
    expect(repairProgress.some((entry) => (entry.payload as { stage: string }).stage === 'verify')).toBe(true)
    for (const entry of events) {
      const eventName = entry.event as keyof typeof repairContract.events
      const parsed = repairContract.events[eventName].payload.safeParse(entry.payload)
      expect(parsed.success, `${entry.event}: ${parsed.success ? '' : parsed.error.message}`).toBe(true)
    }
  })

  it('repairs a corrupt client jar through the same download queue', async () => {
    const clientPath = path.join(fixture.root, 'versions', '1.20.1', '1.20.1.jar')
    const corrupted = Buffer.from(fixture.clientBytes)
    corrupted[0] = corrupted[0] ^ 0xff
    fs.writeFileSync(clientPath, corrupted)

    const { report } = await repair()
    expect(report!.ok).toBe(true)
    expect(fs.readFileSync(clientPath)).toEqual(fixture.clientBytes)
    expect(downloader.enqueued.map((task) => task.destRel)).toContain(
      'versions/1.20.1/1.20.1.jar',
    )
  })

  it('repairs a missing asset index first, then the assets it lists', async () => {
    fs.rmSync(path.join(fixture.root, 'assets', 'indexes', 'test.json'))
    const { report } = await repair()
    expect(report!.ok).toBe(true)
    expect(fs.existsSync(path.join(fixture.root, 'assets', 'indexes', 'test.json'))).toBe(true)
    const repaired = downloader.enqueued.map((task) => task.destRel)
    expect(repaired).toContain('assets/indexes/test.json')
    expect(repaired.some((rel) => rel.startsWith('assets/objects/'))).toBe(true)
  })

  it('returns a readable failure when the download module is unavailable', async () => {
    const noDownloader = new RepairModuleService(
      { dataRoot, mcRoot: fixture.root },
      new Logger({ dataRoot, console: false }).child('module:repair'),
      {
        fs: nodeFsPort(),
        downloader: null,
        platform: 'win32',
        arch: 'x64',
        emit: (event, payload) => events.push({ event, payload }),
      },
    )
    const { jobId } = await noDownloader.repair({ versionId: fixture.versionId, verify: 'hash' })
    const final = await noDownloader.waitForJob(jobId)
    expect(final.state).toBe('failed')
    const finished = events.filter((entry) => entry.event === 'repairFinished').at(-1)?.payload as {
      error: { code: string } | null
    }
    expect(finished.error?.code).toBe('REPAIR.DOWNLOADER_UNAVAILABLE')
    noDownloader.dispose()
  })
})

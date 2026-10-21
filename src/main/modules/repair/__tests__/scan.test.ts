import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Logger } from '../../../kernel/logger'
import { nodeFsPort } from '../../../core/ports'
import { RepairModuleService } from '../service'
import { cleanupFixture, createFixture, FakeDownloader, type Fixture } from './support/harness'

let fixture: Fixture
let service: RepairModuleService
let dataRoot: string

beforeEach(() => {
  fixture = createFixture('mcl-repair-scan-')
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcl-repair-data-'))
  service = new RepairModuleService(
    { dataRoot, mcRoot: fixture.root },
    new Logger({ dataRoot, console: false }).child('module:repair'),
    {
      fs: nodeFsPort(),
      downloader: new FakeDownloader(fixture.root, fixture.payloads),
      platform: 'win32',
      arch: 'x64',
    },
  )
})

afterEach(() => {
  service.dispose()
  cleanupFixture(fixture.root)
  fs.rmSync(dataRoot, { recursive: true, force: true })
})

async function scan(verify: 'hash' | 'size' = 'hash') {
  const { jobId } = await service.scan({ versionId: fixture.versionId, verify })
  await service.waitForJob(jobId)
  const report = service.report(jobId)
  expect(report).not.toBeNull()
  return report!
}

describe('instance integrity scan', () => {
  it('finds missing, corrupt and extra files with hashes', async () => {
    const report = await scan('hash')
    expect(report.versionId).toBe('1.20.1')
    expect(report.dirName).toBe('1.20.1')
    expect(report.ok).toBe(false)

    const missing = new Set(report.missing.map((issue) => issue.destRel))
    expect(missing).toContain('libraries/com/example/lib-b/1.0/lib-b-1.0.jar')
    expect([...missing].some((rel) => rel.startsWith('assets/objects/'))).toBe(true)

    const corrupt = new Set(report.corrupt.map((issue) => issue.destRel))
    expect(corrupt).toContain('libraries/com/example/lib-c/1.0/lib-c-1.0.jar')
    expect([...corrupt].some((rel) => rel.startsWith('assets/objects/'))).toBe(true)
    expect(corrupt.has('versions/1.20.1/1.20.1.jar')).toBe(false)

    expect(report.missing.length).toBeGreaterThanOrEqual(2)
    expect(report.corrupt.length).toBeGreaterThanOrEqual(2)
    expect(report.counts.checked).toBe(8) // client + 3 libs + index + 3 assets
    expect(report.counts.missing).toBe(report.missing.length)
    expect(report.counts.corrupt).toBe(report.corrupt.length)
    expect(report.counts.missingBytes).toBeGreaterThan(0)
  })

  it('reports extra version/libraries/assets files without touching user data', async () => {
    const report = await scan('hash')
    const extras = new Set(report.extra.map((issue) => issue.destRel))
    expect(extras).toContain('versions/1.20.1/extra.txt')
    expect(extras).toContain('libraries/com/example/extra/1.0/extra.jar')
    expect([...extras].some((rel) => rel.startsWith('assets/objects/ff/'))).toBe(true)

    for (const issue of [...report.missing, ...report.corrupt, ...report.extra]) {
      expect(issue.destRel.startsWith('mods/')).toBe(false)
      expect(issue.destRel.startsWith('saves/')).toBe(false)
      expect(issue.destRel.startsWith('config/')).toBe(false)
      expect(issue.destRel.startsWith('resourcepacks/')).toBe(false)
      expect(issue.destRel.startsWith('shaderpacks/')).toBe(false)
    }
    for (const file of fixture.userFiles) {
      expect(fs.readFileSync(path.join(fixture.root, ...file.rel.split('/')), 'utf8')).toBe(file.content)
    }
  })

  it('hash mode detects same-size corruption that size mode cannot', async () => {
    const hashReport = await scan('hash')
    const sizeReport = await scan('size')
    const assetCorrupt = (report: typeof hashReport) =>
      report.corrupt.some((issue) => issue.kind === 'asset')
    expect(assetCorrupt(hashReport)).toBe(true)
    expect(assetCorrupt(sizeReport)).toBe(false)
    // Both modes report the missing files and the size-mismatched library.
    expect(sizeReport.missing.length).toBe(hashReport.missing.length)
    expect(sizeReport.corrupt.some((issue) => issue.kind === 'library')).toBe(true)
  })

  it('reports a missing asset index without guessing asset objects', async () => {
    fs.rmSync(path.join(fixture.root, 'assets', 'indexes', 'test.json'))
    const report = await scan('hash')
    expect(report.missing.some((issue) => issue.kind === 'asset-index')).toBe(true)
    expect(report.missing.some((issue) => issue.kind === 'asset')).toBe(false)
    expect(report.warnings.join('\n')).toContain('资源索引不可用')
    expect(report.counts.checked).toBe(5) // client + 3 libs + index
  })

  it('reports a corrupt client jar', async () => {
    const clientPath = path.join(fixture.root, 'versions', '1.20.1', '1.20.1.jar')
    const bytes = fs.readFileSync(clientPath)
    bytes[0] = bytes[0] ^ 0xff // same length, different content
    fs.writeFileSync(clientPath, bytes)
    const report = await scan('hash')
    const issue = report.corrupt.find((entry) => entry.kind === 'client')
    expect(issue?.destRel).toBe('versions/1.20.1/1.20.1.jar')
    expect(issue?.reason).toContain('哈希')
  })
})

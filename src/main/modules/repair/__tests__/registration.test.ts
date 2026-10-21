import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { repairContract } from '@shared/repair'
import { Logger } from '../../../kernel/logger'
import { makeHandlers } from '../handlers'
import { createRepairService } from '../service'
import { cleanupFixture, createFixture, FakeDownloader, type Fixture } from './support/harness'

let fixture: Fixture
let dataRoot: string

beforeEach(() => {
  fixture = createFixture('mcl-repair-reg-')
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcl-repair-data-'))
})

afterEach(() => {
  cleanupFixture(fixture.root)
  fs.rmSync(dataRoot, { recursive: true, force: true })
})

describe('repair module registration', () => {
  it('provides one handler for every contract method', () => {
    const service = createRepairService(
      { dataRoot, mcRoot: fixture.root },
      new Logger({ dataRoot, console: false }).child('module:repair'),
      {
        downloader: new FakeDownloader(fixture.root, fixture.payloads),
        platform: 'win32',
        arch: 'x64',
      },
    )
    const handlers = makeHandlers(service)
    expect(Object.keys(handlers).sort()).toEqual(Object.keys(repairContract.methods).sort())
    for (const method of Object.keys(repairContract.methods)) {
      expect(typeof (handlers as Record<string, unknown>)[method]).toBe('function')
    }
    service.dispose()
  })

  it('declares the four async events used by the UI', () => {
    expect(Object.keys(repairContract.events).sort()).toEqual([
      'repairFinished',
      'repairProgress',
      'scanFinished',
      'scanProgress',
    ])
  })
})

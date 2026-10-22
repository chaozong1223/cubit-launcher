import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { catalogContract } from '@shared/catalog'
import { Logger } from '../../../kernel/logger'
import { makeHandlers } from '../handlers'
import { CatalogModuleService } from '../service'
import { FakeModsService, modFile, startServer, tempDir, type TestServer } from './support/harness'

let server: TestServer | null = null
let mcRoot = ''
let dataRoot = ''

beforeEach(async () => {
  server = await startServer()
  mcRoot = tempDir('mcl-cat-reg-mc-')
  dataRoot = tempDir('mcl-cat-reg-data-')
})

afterEach(async () => {
  if (server) await server.close()
  fs.rmSync(mcRoot, { recursive: true, force: true })
  fs.rmSync(dataRoot, { recursive: true, force: true })
  server = null
})

describe('catalog registration', () => {
  it('provides one handler for every contract method', () => {
    const service = new CatalogModuleService({
      roots: { dataRoot, mcRoot },
      log: new Logger({ dataRoot, console: false }).child('module:catalog'),
      mods: () => new FakeModsService(path.join(mcRoot, 'versions', '1.20.1'), [modFile('a.jar')]),
      modrinthOptions: {
        apiBase: `${server!.baseUrl}/v2`,
        minIntervalMs: 0,
        allowInsecureHosts: ['127.0.0.1'],
      },
      allowInsecureHosts: ['127.0.0.1'],
    })
    const handlers = makeHandlers(service)
    expect(Object.keys(handlers).sort()).toEqual(Object.keys(catalogContract.methods).sort())
    for (const method of Object.keys(catalogContract.methods)) {
      expect(typeof (handlers as Record<string, unknown>)[method]).toBe('function')
    }
  })

  it('declares search/install/update/link events for the UI', () => {
    expect(Object.keys(catalogContract.events).sort()).toEqual([
      'checkProgress',
      'installProgress',
      'linkDownloadProgress',
      'linkImportFinished',
      'updated',
    ])
  })
})

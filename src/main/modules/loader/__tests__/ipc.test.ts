import fs from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ContractDef } from '@shared/kernel'
import { loaderContract } from '@shared/loader'
import { Logger } from '../../../kernel/logger'
import { getService } from '../../_services'
import { createRegister, moduleId } from '../module'
import type { LoaderHandlers } from '../handlers'
import type { LoaderService } from '../service'
import { tempDir } from './support/harness'

let dataRoot = ''

beforeEach(() => {
  dataRoot = tempDir('mcl-loader-ipc-')
})

afterEach(() => {
  fs.rmSync(dataRoot, { recursive: true, force: true })
})

describe('loader module registration', () => {
  it('publishes the service and binds exactly one handler per contract method', () => {
    const calls: Array<{ contract: ContractDef; handlers: LoaderHandlers }> = []
    const fakeService = { marker: 'loader-service' } as unknown as LoaderService
    const log = new Logger({ dataRoot, console: false }).child('module:loader')

    const register = createRegister({
      service: fakeService,
      bindIpc: (contract, handlers) => calls.push({ contract, handlers }),
    })
    register({ log, dataRoot })

    expect(getService('loader')).toBe(fakeService)
    expect(moduleId).toBe('loader')
    expect(calls).toHaveLength(1)
    expect(calls[0].contract.id).toBe('loader')
    expect(calls[0].contract).toBe(loaderContract)
    expect(Object.keys(calls[0].handlers).sort()).toEqual(
      Object.keys(loaderContract.methods).sort(),
    )
    // Every contract method has a function handler.
    for (const method of Object.keys(loaderContract.methods)) {
      expect(typeof (calls[0].handlers as Record<string, unknown>)[method]).toBe('function')
    }
  })

  it('creates a real service when none is injected (no network at register)', () => {
    const fakeLog = new Logger({ dataRoot, console: false }).child('module:loader')
    let captured: LoaderHandlers | null = null
    const register = createRegister({
      bindIpc: (_contract, handlers) => {
        captured = handlers
      },
    })
    register({ log: fakeLog, dataRoot })
    const service = getService<LoaderService>('loader')
    expect(service).not.toBeNull()
    expect(captured).not.toBeNull()
    expect(service?.listJobs()).toEqual([])
  })

  it('passes calls through to the service', async () => {
    const calls: string[] = []
    const fakeService = {
      async list(input: unknown) {
        calls.push(`list:${JSON.stringify(input)}`)
        return { type: 'fabric', mcVersion: '1.20.1', fetchedAt: 0, source: 'mirror', versions: [], warnings: [] }
      },
      async plan(input: unknown) {
        calls.push(`plan:${JSON.stringify(input)}`)
        return {
          type: 'fabric',
          mcVersion: '1.20.1',
          loaderVersion: '0.16.10',
          versionId: 'fabric-loader-0.16.10-1.20.1',
          method: 'meta-json',
          installer: null,
          requiredJavaMajor: 17,
          parentInstalled: true,
          libraries: 2,
          warnings: [],
        }
      },
      async install(input: unknown) {
        calls.push(`install:${JSON.stringify(input)}`)
        return {
          jobId: 'job-1',
          type: 'fabric',
          mcVersion: '1.20.1',
          loaderVersion: '0.16.10',
          versionId: 'fabric-loader-0.16.10-1.20.1',
          plan: {},
        }
      },
      async cancel(jobId: string) {
        calls.push(`cancel:${jobId}`)
        return { cancelled: true }
      },
      status(jobId: string) {
        calls.push(`status:${jobId}`)
        return null
      },
      listJobs() {
        calls.push('listJobs')
        return []
      },
      async verify(input: { versionId: string }) {
        calls.push(`verify:${input.versionId}`)
        return {
          versionId: input.versionId,
          chain: [],
          mainClass: null,
          loader: { type: 'fabric', version: null },
          libraries: 0,
          classpathCount: 0,
          javaMajor: null,
          warnings: [],
        }
      },
      async dryRun(input: { versionId: string }) {
        calls.push(`dryRun:${input.versionId}`)
        return {
          versionId: input.versionId,
          mainClass: null,
          argv: [],
          classpathCount: 0,
          syntheticAccount: true,
          hasPlaceholders: false,
          warnings: [],
        }
      },
    } as unknown as LoaderService

    let handlers: LoaderHandlers | null = null
    const register = createRegister({
      service: fakeService,
      bindIpc: (_contract, value) => {
        handlers = value
      },
    })
    register({ log: new Logger({ dataRoot, console: false }).child('module:loader'), dataRoot })
    expect(handlers).not.toBeNull()
    await handlers!.list({ type: 'fabric', mcVersion: '1.20.1', force: false })
    await handlers!.plan({ type: 'fabric', mcVersion: '1.20.1' })
    await handlers!.status({ jobId: 'job-1' })
    await handlers!.cancel({ jobId: 'job-1' })
    await handlers!.listJobs()
    await handlers!.verify({ versionId: 'x' })
    await handlers!.dryRun({ versionId: 'x' })
    expect(calls).toEqual([
      'list:{"type":"fabric","mcVersion":"1.20.1","force":false}',
      'plan:{"type":"fabric","mcVersion":"1.20.1"}',
      'status:job-1',
      'cancel:job-1',
      'listJobs',
      'verify:x',
      'dryRun:x',
    ])
  })
})

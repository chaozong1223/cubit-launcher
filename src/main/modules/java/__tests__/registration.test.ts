import fs from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { javaContract } from '@shared/java'
import { Logger } from '../../../kernel/logger'
import type { ModuleRoots } from '../../_context'
import { makeHandlers } from '../handlers'
import { createJavaService } from '../service'
import { tempDir } from './support/harness'

let dataRoot = ''
let mcRoot = ''

beforeEach(() => {
  dataRoot = tempDir('mcl-java-reg-')
  mcRoot = tempDir('mcl-java-reg-mc-')
})

afterEach(() => {
  fs.rmSync(dataRoot, { recursive: true, force: true })
  fs.rmSync(mcRoot, { recursive: true, force: true })
})

const roots: ModuleRoots = {
  get dataRoot() {
    return dataRoot
  },
  get mcRoot() {
    return mcRoot
  },
} as ModuleRoots

describe('java module registration', () => {
  it('provides exactly one handler for every contract method', () => {
    const service = createJavaService(roots, new Logger({ dataRoot, console: false }).child('module:java'), {
      detectImpl: async () => ({
        candidates: [],
        rejected: [],
        durationMs: 0,
        cached: false,
        scannedAt: 0,
        sources: [],
      }),
    })
    const handlers = makeHandlers(service)
    expect(Object.keys(handlers).sort()).toEqual(Object.keys(javaContract.methods).sort())
    for (const method of Object.keys(javaContract.methods)) {
      expect(typeof (handlers as Record<string, unknown>)[method]).toBe('function')
    }
    service.dispose()
  })

  it('creates a service with defaults and no network at register', () => {
    const service = createJavaService(
      roots,
      new Logger({ dataRoot, console: false }).child('module:java'),
      {
        detectImpl: async () => ({
          candidates: [],
          rejected: [],
          durationMs: 0,
          cached: false,
          scannedAt: 0,
          sources: [],
        }),
      },
    )
    expect(service.settings()).toEqual({
      schemaVersion: 1,
      defaultJava: { mode: 'auto', value: null },
      preferredSource: 'adoptium',
      autoDownload: true,
    })
    const providers = service.providers()
    expect(providers.map((provider) => provider.id)).toEqual(['adoptium', 'microsoft'])
    service.dispose()
  })

  it('exposes install events declared by the contract', () => {
    const eventNames = Object.keys(javaContract.events).sort()
    expect(eventNames).toEqual(['detectProgress', 'installFinished', 'installProgress'])
  })
})

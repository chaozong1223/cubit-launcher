import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DOWNLOAD_CHANNELS,
  DOWNLOAD_EVENTS,
  downloadContract,
  type DownloadProgress,
} from '@shared/download'
import { Logger } from '../../../kernel/logger'
import { toHandlerErrorShape } from '../../../kernel/error-shape'
import { registerDownloadIpcCore, type IpcEventLike, type IpcMainLike } from '../ipc-core'
import { DEFAULT_CONCURRENCY } from '../core/settings'
import { DownloadError } from '../core/errors'
import { DownloadService as RealDownloadService, type DownloadService } from '../service'

/**
 * The download module owns its IPC channels. These tests exercise the exact
 * registration table used by `ipc.ts` (which only adds Electron's globals):
 * Result envelopes, sender trust, contract validation, duplicate-registration
 * tolerance and progress/finished forwarding to the windows.
 */

class FakeIpcMain implements IpcMainLike {
  readonly handlers = new Map<string, (event: IpcEventLike, payload?: unknown) => unknown>()

  handle(channel: string, listener: (event: IpcEventLike, payload?: unknown) => unknown): void {
    if (this.handlers.has(channel)) {
      throw new Error(`Attempted to register a second handler for '${channel}'`)
    }
    this.handlers.set(channel, listener)
  }

  removeHandler(channel: string): void {
    this.handlers.delete(channel)
  }

  invoke(channel: string, payload: unknown, url = 'app://mc-launcher/index.html'): Promise<unknown> {
    const listener = this.handlers.get(channel)
    if (!listener) throw new Error(`no handler for ${channel}`)
    return Promise.resolve(
      listener({ senderFrame: { url }, sender: { getURL: () => url } }, payload),
    ) as Promise<unknown>
  }
}

interface Harness {
  ipc: FakeIpcMain
  broadcasts: Array<{ channel: string; payload: unknown }>
  service: RealDownloadService
  dataRoot: string
  channels: string[]
  dispose: () => void
}

let harness: Harness | null = null

function makeLogger(dataRoot: string) {
  return new Logger({ dataRoot, console: false }).child('module:download')
}

function setup(
  options: { withMcRoot?: boolean; service?: DownloadService } = {},
): Harness {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcl-ipc-data-'))
  const mcRoot = options.withMcRoot ? fs.mkdtempSync(path.join(os.tmpdir(), 'mcl-ipc-mc-')) : null
  const log = makeLogger(dataRoot)
  const service =
    options.service ??
    new RealDownloadService({
      roots: { dataRoot, mcRoot },
      log,
      appVersion: '0.1.0',
    })

  const ipc = new FakeIpcMain()
  const broadcasts: Array<{ channel: string; payload: unknown }> = []

  const handle = registerDownloadIpcCore({
    ipc,
    broadcast: (channel, payload) => broadcasts.push({ channel, payload }),
    service,
    log: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
    isTrustedSenderUrl: (url) => url.startsWith('app://mc-launcher/'),
    toErrorShape: toHandlerErrorShape,
    validateOutput: true,
  })

  harness = {
    ipc,
    broadcasts,
    service,
    dataRoot,
    channels: handle.channels,
    dispose: handle.dispose,
  }
  return harness
}

beforeEach(() => {
  harness = null
})

afterEach(() => {
  if (harness) {
    harness.dispose()
    fs.rmSync(harness.dataRoot, { recursive: true, force: true })
  }
  harness = null
})

describe('download IPC registration', () => {
  it('registers exactly one handler per contract method', () => {
    const h = setup()
    const contractMethods = Object.keys(downloadContract.methods)
    expect(h.channels).toHaveLength(contractMethods.length)
    expect(new Set(h.channels).size).toBe(h.channels.length)
    for (const channel of h.channels) {
      expect(channel.startsWith('mc:download:')).toBe(true)
      expect(channel.includes(':evt:')).toBe(false)
    }
    expect(h.channels).toEqual(Object.values(DOWNLOAD_CHANNELS))
  })

  it('returns a Result envelope for a valid call', async () => {
    const h = setup()
    const result = (await h.ipc.invoke(DOWNLOAD_CHANNELS.getSettings, undefined)) as {
      ok: boolean
      data: { concurrency: number; maxRetries: number }
    }
    expect(result.ok).toBe(true)
    expect(result.data.concurrency).toBe(DEFAULT_CONCURRENCY)
    expect(result.data.maxRetries).toBe(3)
  })

  it('rejects an untrusted sender (IPC.UNTRUSTED_SENDER)', async () => {
    const h = setup()
    const result = (await h.ipc.invoke(
      DOWNLOAD_CHANNELS.listSources,
      undefined,
      'https://evil.example/',
    )) as { ok: boolean; error: { code: string } }
    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('IPC.UNTRUSTED_SENDER')
  })

  it('rejects invalid input (IPC.INVALID_INPUT)', async () => {
    const h = setup()
    const result = (await h.ipc.invoke(DOWNLOAD_CHANNELS.status, {})) as {
      ok: boolean
      error: { code: string }
    }
    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('IPC.INVALID_INPUT')
  })

  it('passes declared domain errors through unchanged', async () => {
    const h = setup({ withMcRoot: false })
    const result = (await h.ipc.invoke(DOWNLOAD_CHANNELS.plan, { versionId: '1.20.1' })) as {
      ok: boolean
      error: { code: string; message: string }
    }
    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('DOWNLOAD.MC_ROOT_MISSING')
    expect(result.error.message.length).toBeGreaterThan(0)
  })

  it('keeps DOWNLOAD.* codes through the install channel (H3b)', async () => {
    const fake = {
      install: async () => {
        throw new DownloadError('DOWNLOAD.VERSION_NOT_FOUND', {
          message: 'missing version',
        })
      },
      onProgress: () => () => undefined,
      onFinished: () => () => undefined,
    } as unknown as DownloadService
    const h = setup({ service: fake })
    const result = (await h.ipc.invoke(DOWNLOAD_CHANNELS.install, { versionId: 'not-installed' })) as {
      ok: boolean
      error: { code: string; message: string }
    }
    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('DOWNLOAD.VERSION_NOT_FOUND')
    expect(result.error.code).not.toBe('IPC.HANDLER_FAILED')
    expect(result.error.message).toContain('版本清单里没有这个版本')
  })

  it('forwards progress and finished events to the broadcast function', () => {
    const h = setup()
    // Re-register only the event half using a tiny stub service so the payload
    // can be injected directly.
    const broadcasts: Array<{ channel: string; payload: unknown }> = []
    const registered: { progress?: (progress: DownloadProgress) => void } = {}
    const stub = {
      onProgress(listener: (progress: DownloadProgress) => void) {
        registered.progress = listener
        return () => undefined
      },
      onFinished() {
        return () => undefined
      },
    } as unknown as RealDownloadService
    registerDownloadIpcCore({
      ipc: new FakeIpcMain(),
      broadcast: (channel, payload) => broadcasts.push({ channel, payload }),
      service: stub,
      log: { info: () => undefined, warn: () => undefined, error: () => undefined },
      isTrustedSenderUrl: () => true,
      toErrorShape: (error) => ({ code: 'X', message: String(error), retryable: false }),
    })

    const progress: DownloadProgress = {
      jobId: 'job-1',
      kind: 'install',
      state: 'running',
      stage: 'libraries',
      done: 2,
      failed: 0,
      total: 9,
      bytesDone: 200,
      bytesTotal: 1000,
      currentFile: 'libraries/a.jar',
      bytesPerSec: 123,
      source: 'mirror',
      versionId: '1.20.1',
      startedAt: 1,
      updatedAt: 2,
      message: null,
    }
    registered.progress?.(progress)
    expect(broadcasts).toEqual([{ channel: DOWNLOAD_EVENTS.progress, payload: progress }])
    expect(h.channels).toHaveLength(16)
  })

  it('tolerates a second registration of the same channels', () => {
    const h = setup()
    const second = registerDownloadIpcCore({
      ipc: h.ipc,
      broadcast: () => undefined,
      service: h.service,
      log: { info: () => undefined, warn: () => undefined, error: () => undefined },
      isTrustedSenderUrl: () => true,
      toErrorShape: (error) => ({ code: 'X', message: String(error), retryable: false }),
    })
    expect(second.channels).toEqual([])
    h.ipc.invoke(DOWNLOAD_CHANNELS.getSettings, undefined)
    expect(h.ipc.handlers.size).toBe(16)
  })

  it('removes every handler on dispose', () => {
    const h = setup()
    expect(h.ipc.handlers.size).toBe(16)
    h.dispose()
    expect(h.ipc.handlers.size).toBe(0)
  })
})

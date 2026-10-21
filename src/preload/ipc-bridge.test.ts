import { beforeAll, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, (event: unknown, input: unknown) => Promise<unknown>>()
  return {
    handlers,
    ipcMain: {
      handle: vi.fn(
        (channel: string, handler: (event: unknown, input: unknown) => Promise<unknown>) => {
          handlers.set(channel, handler)
        },
      ),
    },
    app: { isPackaged: false, getVersion: vi.fn(() => '0.1.0') },
    BrowserWindow: {
      getAllWindows: vi.fn((): unknown[] => []),
      fromWebContents: vi.fn(() => null),
    },
    dialog: {
      showOpenDialog: vi.fn(async (): Promise<{ canceled: boolean; filePaths: string[] }> => ({
        canceled: true,
        filePaths: [],
      })),
      showSaveDialog: vi.fn(async (): Promise<{ canceled: boolean; filePath: string | undefined }> => ({
        canceled: true,
        filePath: undefined,
      })),
    },
  }
})

vi.mock('electron', () => ({
  app: mocks.app,
  BrowserWindow: mocks.BrowserWindow,
  dialog: mocks.dialog,
  ipcMain: mocks.ipcMain,
}))

import type { Logger } from '../main/kernel/logger'
import { moduleIpc, registerIpc, registeredModuleChannels } from '../main/kernel/ipc'
import { publishService } from '../main/modules/_services'
import {
  isAllowedEventChannel,
  isAllowedInvokeChannel,
  isModuleEventChannel,
  isModuleInvokeChannel,
} from '../shared/channels'

const logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
} as unknown as Logger

interface TestEvent {
  senderFrame: { url: string }
  sender: { getURL: () => string }
}

function event(url = 'app://mc-launcher/index.html'): TestEvent {
  return { senderFrame: { url }, sender: { getURL: () => url } }
}

async function invoke(channel: string, input?: unknown, url?: string): Promise<unknown> {
  const handler = mocks.handlers.get(channel)
  if (!handler) throw new Error(`channel not registered: ${channel}`)
  return handler(event(url), input)
}

beforeAll(() => {
  publishService('instance', { list: async () => [] })
  publishService('version', { listVersions: async () => [] })
  publishService('java', { candidates: async () => [] })
  publishService('launch', {
    status: (instanceId: string) => ({
      instanceId,
      state: 'idle',
      sessionId: null,
      startedAt: null,
      exitCode: null,
      durationMs: null,
      reportReady: false,
    }),
  })

  registerIpc({
    getInfo: () => ({}) as never,
    openDataDir: async () => ({ opened: false }),
    onRendererReady: () => undefined,
    log: logger,
  })
})

describe('module IPC bridge (t20)', () => {
  it('registers every module contract method without editing preload', () => {
    expect(mocks.handlers.has('mc:instance:list')).toBe(true)
    expect(mocks.handlers.has('mc:version:listVersions')).toBe(true)
    expect(mocks.handlers.has('mc:java:candidates')).toBe(true)
    expect(mocks.handlers.has('mc:launch:status')).toBe(true)

    const channels = registeredModuleChannels()
    expect(channels.invoke).toEqual(
      expect.arrayContaining([
        'mc:instance:list',
        'mc:version:listVersions',
        'mc:java:candidates',
        'mc:launch:status',
      ]),
    )
    expect(channels.events).toContain('mc:launch:evt:output')
    expect(moduleIpc.has('instance')).toBe(true)
    expect(mocks.handlers.has('mc:system:info')).toBe(true)
    expect(mocks.handlers.has('app:getVersion')).toBe(true)
  })

  it('returns the Result envelope for all four t6 modules', async () => {
    expect(await invoke('mc:instance:list')).toEqual({ ok: true, data: [] })
    expect(await invoke('mc:version:listVersions', {})).toEqual({ ok: true, data: [] })
    expect(await invoke('mc:java:candidates')).toEqual({ ok: true, data: [] })
    const status = (await invoke('mc:launch:status', { instanceId: 'inst-1' })) as {
      ok: boolean
      data: { instanceId: string; state: string }
    }
    expect(status.ok).toBe(true)
    expect(status.data).toMatchObject({ instanceId: 'inst-1', state: 'idle' })
  })

  it('keeps sender validation on module channels', async () => {
    const result = (await invoke('mc:instance:list', undefined, 'https://evil.example/')) as {
      ok: boolean
      error: { code: string }
    }
    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('IPC.UNTRUSTED_SENDER')
  })

  it('validates module inputs with the contract schema', async () => {
    const result = (await invoke('mc:launch:status', {})) as {
      ok: boolean
      error: { code: string }
    }
    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('IPC.INVALID_INPUT')
  })

  it('does not register unregistered or non-module channels', () => {
    expect(mocks.handlers.has('mc:nope:list')).toBe(false)
    expect(mocks.handlers.has('fs:readFile')).toBe(false)
    expect(mocks.handlers.has('child_process:spawn')).toBe(false)
  })

  it('returns an explicit cancelled result for file dialogs', async () => {
    expect(await invoke('mc:system:pickFiles', {})).toEqual({
      ok: true,
      data: { cancelled: true, paths: [] },
    })
    expect(await invoke('mc:system:pickSaveFile', {})).toEqual({
      ok: true,
      data: { cancelled: true, path: null },
    })
  })

  it('returns the selected file paths without wrapping cancel as an error', async () => {
    mocks.dialog.showOpenDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: ['D:\\mods\\example.jar'],
    })
    mocks.dialog.showSaveDialog.mockResolvedValueOnce({
      canceled: false,
      filePath: 'D:\\mods\\example.mrpack',
    })
    expect(await invoke('mc:system:pickFiles', {})).toEqual({
      ok: true,
      data: { cancelled: false, paths: ['D:\\mods\\example.jar'] },
    })
    expect(await invoke('mc:system:pickSaveFile', {})).toEqual({
      ok: true,
      data: { cancelled: false, path: 'D:\\mods\\example.mrpack' },
    })
  })

  it('emits declared contract events to live windows', () => {
    const send = vi.fn()
    mocks.BrowserWindow.getAllWindows.mockReturnValue([
      { isDestroyed: () => false, webContents: { isDestroyed: () => false, send } },
    ])

    const payload = {
      instanceId: 'inst-1',
      state: 'idle',
      sessionId: null,
      startedAt: null,
      exitCode: null,
    }
    expect(moduleIpc.emit('launch', 'status', payload)).toBe(1)
    expect(send).toHaveBeenCalledWith('mc:launch:evt:status', payload)

    expect(moduleIpc.emit('launch', 'status', { bad: true })).toBe(0)
    expect(moduleIpc.emit('nope', 'status', payload)).toBe(0)
    expect(moduleIpc.emit('launch', 'notDeclared', payload)).toBe(0)

    mocks.BrowserWindow.getAllWindows.mockReturnValue([])
  })

  it('rejects an invalid contract registration', () => {
    expect(() => moduleIpc.handle({} as never, {})).toThrowError(/invalid module contract/i)
  })
})

describe('module channel gate (t20)', () => {
  it('allows every contract-shaped module invoke channel without a whitelist edit', () => {
    const channels = [
      'mc:instance:list',
      'mc:version:listVersions',
      'mc:java:candidates',
      'mc:launch:plan',
      'mc:launch:lastReport',
      'mc:mods:scan',
      'mc:auth:createOffline',
      'mc:link:create',
    ]
    for (const channel of channels) {
      expect(isModuleInvokeChannel(channel)).toBe(true)
      expect(isAllowedInvokeChannel(channel)).toBe(true)
    }
  })

  it('allows contract-shaped module event channels', () => {
    for (const channel of [
      'mc:instance:evt:changed',
      'mc:launch:evt:output',
      'mc:launch:evt:exited',
      'mc:link:evt:state',
    ]) {
      expect(isModuleEventChannel(channel)).toBe(true)
      expect(isAllowedEventChannel(channel)).toBe(true)
      expect(isAllowedInvokeChannel(channel)).toBe(false)
    }
  })

  it('rejects Node primitives and malformed module channels', () => {
    for (const channel of [
      'fs:readFile',
      'child_process:spawn',
      'mc:instance',
      'mc:Instance:list',
      'mc:instance:',
      'mc::list',
      'mc:instance:list:extra',
      'app:getVersion:extra',
      '',
    ]) {
      expect(isAllowedInvokeChannel(channel)).toBe(false)
      expect(isAllowedEventChannel(channel)).toBe(false)
    }
  })

  it('keeps the static kernel channels allow-listed', () => {
    expect(isAllowedInvokeChannel('app:getVersion')).toBe(true)
    expect(isAllowedInvokeChannel('mc:system:info')).toBe(true)
    expect(isAllowedInvokeChannel('mc:window:minimize')).toBe(true)
    expect(isAllowedInvokeChannel(42)).toBe(false)
    expect(isAllowedEventChannel(null)).toBe(false)
  })
})

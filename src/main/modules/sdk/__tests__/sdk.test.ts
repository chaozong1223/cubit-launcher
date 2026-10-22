import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import type { ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { sdkContract } from '@shared/sdk'
import type { ScopedLogger } from '../../../kernel/logger'
import { makeHandlers } from '../handlers'
import { createSdkService, type SdkService } from '../service'

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

function writeFile(target: string, data: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, data)
}

function sha256(data: string): string {
  return createHash('sha256').update(data).digest('hex')
}

function fakeChild(pid = 4242): ChildProcess {
  const emitter = new EventEmitter() as unknown as ChildProcess & EventEmitter
  Object.defineProperty(emitter, 'pid', { value: pid, configurable: true })
  emitter.kill = (() => {
    emitter.emit('exit', 0, null)
    return true
  }) as ChildProcess['kill']
  return emitter
}

interface Fixture {
  root: string
  dataRoot: string
  sdkRoot: string
  service: SdkService
  spawnCalls: Array<{ command: string; args: string[]; cwd: string | undefined }>
}

function fixture(options: { fakeSpawn?: boolean } = {}): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcl-sdk-'))
  cleanup.push(root)
  const dataRoot = path.join(root, 'data')
  const sdkRoot = path.join(dataRoot, 'multiplayer-sdk')
  const spawnCalls: Array<{ command: string; args: string[]; cwd: string | undefined }> = []
  const spawnImpl = ((command: string, args: string[], spawnOptions: { cwd?: string }) => {
    spawnCalls.push({ command, args, cwd: spawnOptions.cwd })
    return fakeChild()
  }) as unknown as typeof import('node:child_process').spawn
  const service = createSdkService({
    dataRoot,
    log: logger,
    now: () => 1_700_000_000_000,
    ...(options.fakeSpawn ? { spawnImpl } : {}),
  })
  return { root, dataRoot, sdkRoot, service, spawnCalls }
}

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: 'demo',
    name: 'Demo SDK',
    version: '1.0.0',
    command: 'demo.exe',
    args: ['--port', '11010'],
    ...overrides,
  }
}

function installSdk(h: Fixture, id = 'demo', overrides: Record<string, unknown> = {}, binary = 'demo-binary'): string {
  const dir = path.join(h.sdkRoot, id)
  writeFile(path.join(dir, 'demo.exe'), binary)
  writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest({ id, command: 'demo.exe', ...overrides })))
  return dir
}

describe('SDK manifest validation', () => {
  it('loads a valid manifest and exposes hash/running metadata', async () => {
    const h = fixture()
    const binary = 'demo-binary'
    installSdk(h, 'demo', { sha256: sha256(binary) })
    const list = await h.service.list()
    expect(list.directory).toBe(path.join(h.dataRoot, 'multiplayer-sdk'))
    expect(list.rejected).toEqual([])
    expect(list.entries).toHaveLength(1)
    expect(list.entries[0]).toMatchObject({
      id: 'demo',
      name: 'Demo SDK',
      command: 'demo.exe',
      valid: true,
      hashVerified: true,
      running: false,
      pid: null,
    })
    expect(sdkContract.methods.list.output.safeParse(list).success).toBe(true)
  })

  it('rejects missing fields, command injection, shell args, bad hash and path escapes', async () => {
    const h = fixture()
    installSdk(h, 'bad-command', { command: 'cmd.exe' })
    installSdk(h, 'bad-semicolon', { command: 'demo.exe;calc' })
    installSdk(h, 'bad-args', { args: ['--x', '& calc'] })
    installSdk(h, 'bad-hash', { sha256: '0'.repeat(64) })
    installSdk(h, 'missing-name', { name: undefined })
    const dir = path.join(h.sdkRoot, 'escape')
    writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest({ id: 'escape', command: '..\\evil.exe' })))
    const list = await h.service.list()
    expect(list.entries).toEqual([])
    const reasons = list.rejected.map((entry) => entry.errors.join(' ')).join('\n')
    expect(reasons).toContain('命令被拒绝')
    expect(reasons).toContain('白名单字符集')
    expect(reasons).toContain('shell 元字符')
    expect(reasons).toContain('SHA-256 不匹配')
    expect(reasons).toContain('name')
  })

  it('rejects id/directory mismatch, duplicates and supports root-level manifests', async () => {
    const h = fixture()
    installSdk(h, 'demo', { id: 'other' })
    writeFile(
      path.join(h.sdkRoot, 'root-sdk.json'),
      JSON.stringify(manifest({ id: 'root-sdk', command: 'root.exe' })),
    )
    writeFile(path.join(h.sdkRoot, 'root.exe'), 'root-binary')
    const list = await h.service.list()
    expect(list.entries.map((entry) => entry.id)).toEqual(['root-sdk'])
    expect(list.rejected.some((entry) => entry.errors.join(' ').includes('id 必须与目录名一致'))).toBe(true)

    const duplicate = fixture()
    writeFile(
      path.join(duplicate.sdkRoot, 'one', 'manifest.json'),
      JSON.stringify(manifest({ id: 'one', command: 'demo.exe' })),
    )
    writeFile(path.join(duplicate.sdkRoot, 'one', 'demo.exe'), 'a')
    writeFile(
      path.join(duplicate.sdkRoot, 'two', 'manifest.json'),
      JSON.stringify(manifest({ id: 'two', command: 'demo.exe' })),
    )
    writeFile(path.join(duplicate.sdkRoot, 'two', 'demo.exe'), 'b')
    writeFile(
      path.join(duplicate.sdkRoot, 'dupe.json'),
      JSON.stringify(manifest({ id: 'one', command: 'demo.exe' })),
    )
    writeFile(path.join(duplicate.sdkRoot, 'demo.exe'), 'root-copy')
    const duplicated = await duplicate.service.list()
    expect(duplicated.rejected.some((entry) => entry.errors.includes('id 重复'))).toBe(true)
  })
})

describe('SDK sidecar lifecycle', () => {
  it('starts a validated sidecar, lists it running and stops it', async () => {
    const h = fixture({ fakeSpawn: true })
    installSdk(h, 'demo')
    const started = await h.service.start({ id: 'demo', args: ['--extra', 'value'] })
    expect(started).toMatchObject({ id: 'demo', pid: 4242, command: 'demo.exe' })
    expect(sdkContract.methods.start.output.safeParse(started).success).toBe(true)
    expect(h.spawnCalls[0]).toMatchObject({
      command: path.join(h.sdkRoot, 'demo', 'demo.exe'),
      args: ['--port', '11010', '--extra', 'value'],
      cwd: path.join(h.sdkRoot, 'demo'),
    })
    expect((await h.service.list()).entries[0]).toMatchObject({ running: true, pid: 4242 })

    const stopped = h.service.stop({ id: 'demo' })
    expect(stopped).toEqual({ id: 'demo', stopped: true })
    expect((await h.service.list()).entries[0].running).toBe(false)
    expect(sdkContract.methods.stop.output.safeParse(stopped).success).toBe(true)
  })

  it('refuses invalid manifests, injected start args and duplicate starts', async () => {
    const h = fixture({ fakeSpawn: true })
    installSdk(h, 'demo')
    await expect(h.service.start({ id: 'missing' })).rejects.toMatchObject({ code: 'SDK.NOT_FOUND' })
    await expect(h.service.start({ id: 'demo', args: ['x', '& calc'] })).rejects.toMatchObject({
      code: 'SDK.INVALID_ARGS',
    })
    await h.service.start({ id: 'demo' })
    await expect(h.service.start({ id: 'demo' })).rejects.toMatchObject({
      code: 'SDK.ALREADY_RUNNING',
    })
    h.service.stop({ id: 'demo' })
  })

  it('creates the manifest folder and exposes one handler per method', async () => {
    const h = fixture()
    const folder = await h.service.openFolder()
    expect(folder).toEqual({ path: path.join(h.dataRoot, 'multiplayer-sdk'), opened: false })
    expect(fs.existsSync(folder.path)).toBe(true)
    const handlers = makeHandlers({} as unknown as SdkService) as Record<string, unknown>
    for (const method of Object.keys(sdkContract.methods)) {
      expect(typeof handlers[method]).toBe('function')
    }
  })
})

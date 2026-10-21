import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ScopedLogger } from '../../../kernel/logger'
import { loadConfig } from '../../../kernel/config'
import { createInstanceService } from '../service'

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

function writeFile(target: string, contents: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, contents)
}

function versionJson(id: string): string {
  return JSON.stringify({
    id,
    type: 'release',
    mainClass: 'net.minecraft.client.main.Main',
    assets: id,
    assetIndex: {
      id,
      sha1: '0'.repeat(40),
      size: 0,
      totalSize: 0,
      url: 'https://example.invalid/assets.json',
    },
    downloads: {
      client: { sha1: '0'.repeat(40), size: 0, url: 'https://example.invalid/client.jar' },
    },
    libraries: [],
    arguments: { game: [], jvm: [] },
  })
}

interface Fixture {
  root: string
  dataRoot: string
  appdata: string
  home: string
  installDir: string
  drive: string
}

function createFixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcl-instance-'))
  cleanup.push(root)
  const dataRoot = path.join(root, 'data')
  const appdata = path.join(root, 'appdata')
  const home = path.join(root, 'home')
  const installDir = path.join(root, 'launcher')
  const drive = path.join(root, 'drive')
  fs.mkdirSync(path.join(appdata, '.minecraft', 'versions', '1.20.1'), { recursive: true })
  writeFile(path.join(appdata, '.minecraft', 'versions', '1.20.1', '1.20.1.json'), versionJson('1.20.1'))
  writeFile(path.join(appdata, '.minecraft', 'versions', '1.20.1', '1.20.1.jar'), 'jar')
  fs.mkdirSync(path.join(appdata, '.minecraft', 'mods'), { recursive: true })
  fs.mkdirSync(path.join(appdata, '.minecraft', 'saves'), { recursive: true })

  fs.mkdirSync(path.join(home, '.minecraft'), { recursive: true })
  fs.mkdirSync(path.join(installDir, '.minecraft', 'versions', '1.19.2'), { recursive: true })
  writeFile(path.join(installDir, '.minecraft', 'versions', '1.19.2', '1.19.2.json'), versionJson('1.19.2'))

  fs.mkdirSync(path.join(drive, 'Games', '.minecraft', 'versions', '1.18.2'), { recursive: true })
  writeFile(
    path.join(drive, 'Games', '.minecraft', 'versions', '1.18.2', '1.18.2.json'),
    versionJson('1.18.2'),
  )
  fs.mkdirSync(installDir, { recursive: true })
  writeFile(path.join(installDir, 'mc-launcher.exe'), 'exe')
  return { root, dataRoot, appdata, home, installDir, drive }
}

function makeService(fixture: Fixture, onRootChanged?: (root: string) => void) {
  return createInstanceService(
    { dataRoot: fixture.dataRoot, mcRoot: null },
    logger,
    {
      env: {
        APPDATA: fixture.appdata,
        USERPROFILE: fixture.home,
      } as NodeJS.ProcessEnv,
      execPath: path.join(fixture.installDir, 'mc-launcher.exe'),
      cwd: path.join(fixture.root, 'cwd'),
      platform: 'win32',
      driveRoots: [fixture.drive],
      onRootChanged,
      now: () => 1_700_000_000_000,
    },
  )
}

describe('first-run minecraft discovery', () => {
  it('lists appdata, install-adjacent and drive-root candidates with metadata', async () => {
    const fixture = createFixture()
    const service = makeService(fixture)
    const result = await service.discover()
    expect(result.configured).toBe(false)
    expect(result.firstRun).toBe(true)
    expect(result.currentRoot).toBeNull()
    expect(result.candidates.length).toBeGreaterThanOrEqual(3)

    const appdata = result.candidates.find((candidate) => candidate.path.endsWith('.minecraft') && candidate.versionCount === 1)
    expect(appdata).toMatchObject({
      hasVersions: true,
      hasMods: true,
      hasSaves: true,
      recommended: true,
    })
    expect(result.candidates.some((candidate) => candidate.versionCount === 1 && candidate.source === 'drive')).toBe(true)
    expect(result.guidance.join(' ')).toContain('导入')
    expect(result.errors).toEqual([])
  })

  it('returns actionable guidance and never throws when nothing is found', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcl-empty-'))
    cleanup.push(root)
    const service = createInstanceService({ dataRoot: path.join(root, 'data'), mcRoot: null }, logger, {
      env: {
        APPDATA: path.join(root, 'empty-appdata'),
        USERPROFILE: path.join(root, 'empty-home'),
      } as NodeJS.ProcessEnv,
      execPath: path.join(root, 'launcher', 'mc-launcher.exe'),
      cwd: path.join(root, 'cwd'),
      platform: 'win32',
      driveRoots: [],
      now: () => 1,
    })
    const result = await service.discover()
    expect(result.candidates).toEqual([])
    expect(result.guidance.length).toBeGreaterThanOrEqual(3)
    expect(result.guidance.join(' ')).toContain('手动选择目录')
    expect((await service.list())).toEqual([])
  })

  it('does not let a broken scan crash discovery', async () => {
    const fixture = createFixture()
    const file = path.join(fixture.root, 'not-a-directory')
    writeFile(file, 'x')
    const service = createInstanceService(
      { dataRoot: fixture.dataRoot, mcRoot: null },
      logger,
      {
        env: { APPDATA: file, USERPROFILE: file } as NodeJS.ProcessEnv,
        execPath: path.join(fixture.root, 'missing', 'launcher.exe'),
        cwd: file,
        platform: 'win32',
        driveRoots: [path.join(fixture.root, 'missing-drive')],
      },
    )
    await expect(service.discover()).resolves.toMatchObject({ candidates: [] })
  })
})

describe('importing an existing .minecraft', () => {
  it('imports a parent directory, lists instances immediately and persists the root', async () => {
    const fixture = createFixture()
    const onRootChanged = vi.fn()
    const service = makeService(fixture, onRootChanged)
    const imported = await service.setGameDir({ path: fixture.appdata })
    const real = fs.realpathSync.native(path.join(fixture.appdata, '.minecraft'))
    expect(imported.mcRoot).toBe(real)
    expect(imported.instanceCount).toBe(1)
    expect(imported.hasVersions).toBe(true)
    expect(imported.restartRequired).toBe(false)
    expect(onRootChanged).toHaveBeenCalledWith(real)

    const instances = await service.list()
    expect(instances.map((instance) => instance.id)).toContain('1.20.1')

    const loaded = loadConfig(fixture.dataRoot)
    expect(loaded.config.paths.minecraftRoot).toBe(real)

    // Restart simulation: a new service reads the persisted config root.
    const restarted = createInstanceService(
      { dataRoot: fixture.dataRoot, mcRoot: loaded.config.paths.minecraftRoot },
      logger,
    )
    expect((await restarted.list()).map((instance) => instance.id)).toContain('1.20.1')
  })

  it('exposes import as an alias and rejects missing/file paths with an AppError', async () => {
    const fixture = createFixture()
    const service = makeService(fixture)
    const imported = await service.importRoot({ path: path.join(fixture.appdata, '.minecraft') })
    expect(imported.instanceCount).toBe(1)

    await expect(service.setGameDir({ path: path.join(fixture.root, 'nope') })).rejects.toMatchObject({
      code: 'INSTANCE.DIRECTORY_UNAVAILABLE',
    })
    const file = path.join(fixture.root, 'file')
    writeFile(file, 'x')
    await expect(service.setGameDir({ path: file })).rejects.toMatchObject({
      code: 'INSTANCE.DIRECTORY_UNAVAILABLE',
    })
  })
})

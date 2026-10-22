import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ScopedLogger } from '../../../kernel/logger'
import { nodeFsPort, type FsPort } from '../../../core/ports'
import { assetsContract } from '@shared/assets'
import { makeHandlers } from '../handlers'
import { createAssetsService, type AssetsModuleService } from '../service'

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
    assetIndex: { id, sha1: '0'.repeat(40), size: 0, totalSize: 0, url: 'https://x.invalid/a' },
    downloads: { client: { sha1: '0'.repeat(40), size: 0, url: 'https://x.invalid/c' } },
    libraries: [],
    arguments: { game: [], jvm: [] },
  })
}

function instanceSettings(dirName: string, mcVersion: string): string {
  return JSON.stringify({
    schemaVersion: 1,
    id: dirName,
    dirName,
    name: dirName,
    mcVersion,
    loader: { type: 'vanilla', version: null },
    isolation: 'isolated',
    createdAt: 1,
  })
}

interface Fixture {
  root: string
  mcRoot: string
  dataRoot: string
  service: AssetsModuleService
  saveDirA: string
  saveDirB: string
}

function fixture(
  options: {
    running?: boolean
    fs?: FsPort
    serviceFactory?: (roots: { dataRoot: string; mcRoot: string }) => AssetsModuleService
  } = {},
): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcl-save-copy-'))
  cleanup.push(root)
  const mcRoot = path.join(root, 'mc')
  const dataRoot = path.join(root, 'data')
  const a = path.join(mcRoot, 'versions', 'A')
  const b = path.join(mcRoot, 'versions', 'B')
  writeFile(path.join(a, 'A.json'), versionJson('A'))
  writeFile(path.join(a, 'A.jar'), 'jar')
  writeFile(path.join(a, 'instance.json'), instanceSettings('A', '1.20.1'))
  writeFile(path.join(b, 'B.json'), versionJson('B'))
  writeFile(path.join(b, 'B.jar'), 'jar')
  writeFile(path.join(b, 'instance.json'), instanceSettings('B', '1.21'))
  writeFile(path.join(a, 'saves', 'World One', 'level.dat'), 'level-a')
  writeFile(path.join(a, 'saves', 'World One', 'region', 'r.0.0.mca'), 'region-a')
  writeFile(path.join(a, 'saves', 'World One', 'session.lock'), 'stale-lock')
  // Hidden launcher-internal dirs must not show up as saves.
  writeFile(path.join(a, 'saves', '.mcl-save-copy-old', 'level.dat'), 'stale')
  const service =
    options.serviceFactory?.({ dataRoot, mcRoot }) ??
    createAssetsService({
      roots: { dataRoot, mcRoot },
      log: logger,
      now: () => 1_700_000_000_000,
      ...(options.running ? { isInstanceRunning: () => true } : {}),
      ...(options.fs ? { fs: options.fs } : {}),
    })
  return { root, mcRoot, dataRoot, service, saveDirA: a, saveDirB: b }
}

describe('cross-version save copy', () => {
  it('exposes one handler per contract method (kernel binding would fail otherwise)', () => {
    const handlers = makeHandlers({} as unknown as AssetsModuleService) as Record<string, unknown>
    for (const method of Object.keys(assetsContract.methods)) {
      expect(typeof handlers[method]).toBe('function')
    }
    expect(Object.keys(assetsContract.methods)).toContain('copySave')
  })

  it('copies a world into another instance and reports cross-version risk', async () => {
    const h = fixture()
    const result = await h.service.copySave({
      instanceId: 'A',
      name: 'World One',
      targetInstanceId: 'B',
    })
    expect(assetsContract.methods.copySave.output.safeParse(result).success).toBe(true)
    expect(result).toMatchObject({
      status: 'copied',
      sourceInstanceId: 'A',
      sourceName: 'World One',
      targetInstanceId: 'B',
      targetName: 'World One',
      overwritten: false,
      renamed: false,
      crossVersion: true,
    })
    expect(result.warnings.some((warning) => warning.includes('跨版本'))).toBe(true)
    const copied = path.join(h.saveDirB, 'saves', 'World One')
    expect(fs.readFileSync(path.join(copied, 'level.dat'), 'utf8')).toBe('level-a')
    expect(fs.readFileSync(path.join(copied, 'region', 'r.0.0.mca'), 'utf8')).toBe('region-a')
    // A stale session lock must not travel with the copy.
    expect(fs.existsSync(path.join(copied, 'session.lock'))).toBe(false)
    // Source remains intact.
    expect(fs.readFileSync(path.join(h.saveDirA, 'saves', 'World One', 'level.dat'), 'utf8')).toBe(
      'level-a',
    )
  })

  it('reports a conflict without writing and supports skip/rename/overwrite', async () => {
    const h = fixture()
    await h.service.copySave({ instanceId: 'A', name: 'World One', targetInstanceId: 'B' })
    fs.writeFileSync(path.join(h.saveDirA, 'saves', 'World One', 'level.dat'), 'level-a2')

    const conflict = await h.service.copySave({
      instanceId: 'A',
      name: 'World One',
      targetInstanceId: 'B',
    })
    expect(conflict).toMatchObject({ status: 'conflict', targetName: null })
    expect(
      fs.readFileSync(path.join(h.saveDirB, 'saves', 'World One', 'level.dat'), 'utf8'),
    ).toBe('level-a')

    const skipped = await h.service.copySave({
      instanceId: 'A',
      name: 'World One',
      targetInstanceId: 'B',
      conflict: 'skip',
    })
    expect(skipped.status).toBe('skipped')

    const renamed = await h.service.copySave({
      instanceId: 'A',
      name: 'World One',
      targetInstanceId: 'B',
      conflict: 'rename',
    })
    expect(renamed).toMatchObject({ status: 'copied', targetName: 'World One-2', renamed: true })
    expect(
      fs.readFileSync(path.join(h.saveDirB, 'saves', 'World One-2', 'level.dat'), 'utf8'),
    ).toBe('level-a2')

    const overwritten = await h.service.copySave({
      instanceId: 'A',
      name: 'World One',
      targetInstanceId: 'B',
      conflict: 'overwrite',
    })
    expect(overwritten).toMatchObject({
      status: 'copied',
      targetName: 'World One',
      overwritten: true,
    })
    expect(
      fs.readFileSync(path.join(h.saveDirB, 'saves', 'World One', 'level.dat'), 'utf8'),
    ).toBe('level-a2')
    const leftovers = fs
      .readdirSync(path.join(h.saveDirB, 'saves'))
      .filter((name) => name.startsWith('.'))
    expect(leftovers).toEqual([])
  })

  it('refuses running instances and self-overwrite', async () => {
    const running = fixture({ running: true })
    await expect(
      running.service.copySave({ instanceId: 'A', name: 'World One', targetInstanceId: 'B' }),
    ).rejects.toMatchObject({ code: 'ASSETS.INSTANCE_RUNNING' })

    const h = fixture()
    await expect(
      h.service.copySave({
        instanceId: 'A',
        name: 'World One',
        targetInstanceId: 'A',
        conflict: 'overwrite',
      }),
    ).rejects.toMatchObject({ code: 'ASSETS.SAVE_SELF_OVERWRITE' })
  })

  it('restores the previous world when the commit rename fails', async () => {
    const h = fixture()
    // Seed the target with a world that has a marker we can look for.
    writeFile(path.join(h.saveDirB, 'saves', 'World One', 'level.dat'), 'old-level')
    writeFile(path.join(h.saveDirB, 'saves', 'World One', 'marker.txt'), 'old-marker')

    const base = nodeFsPort()
    let renames = 0
    const failingFs: FsPort = {
      ...base,
      rename: (from, to) => {
        renames += 1
        // 1st rename = move old world to backup; 2nd = move staging into place.
        if (renames === 2) throw new Error('commit blocked')
        base.rename(from, to)
      },
    }
    const service = createAssetsService({
      roots: { dataRoot: h.dataRoot, mcRoot: h.mcRoot },
      log: logger,
      fs: failingFs,
      now: () => 1_700_000_000_000,
    })
    let caught: unknown
    try {
      await service.copySave({
        instanceId: 'A',
        name: 'World One',
        targetInstanceId: 'B',
        conflict: 'overwrite',
      })
    } catch (error) {
      caught = error
    }
    expect(caught).toMatchObject({ code: 'ASSETS.SAVE_COPY_FAILED' })
    expect(
      fs.readFileSync(path.join(h.saveDirB, 'saves', 'World One', 'level.dat'), 'utf8'),
    ).toBe('old-level')
    expect(
      fs.readFileSync(path.join(h.saveDirB, 'saves', 'World One', 'marker.txt'), 'utf8'),
    ).toBe('old-marker')
    const leftovers = fs
      .readdirSync(path.join(h.saveDirB, 'saves'))
      .filter((name) => name.startsWith('.'))
    expect(leftovers).toEqual([])
  })

  it('hides internal staging/backup dirs from the save list', async () => {
    const h = fixture()
    const before = await h.service.listSaves({ instanceId: 'A' })
    expect(before.saves.map((save) => save.name)).toEqual(['World One'])
    writeFile(path.join(h.saveDirA, 'saves', '.mcl-save-backup-test', 'level.dat'), 'x')
    const after = await h.service.listSaves({ instanceId: 'A' })
    expect(after.saves.map((save) => save.name)).toEqual(['World One'])
  })
})

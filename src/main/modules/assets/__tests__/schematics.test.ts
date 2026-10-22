import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assetsContract } from '@shared/assets'
import type { ScopedLogger } from '../../../kernel/logger'
import { makeHandlers } from '../handlers'
import { createAssetsService, type AssetsModuleService } from '../service'
import {
  buildNbt,
  compress,
  tagByteArray,
  tagCompound,
  tagInt,
  tagLong,
  tagString,
  type FixtureTag,
} from '../../../core/__tests__/nbt-fixtures'

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

function writeFile(target: string, data: string | Buffer): void {
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, data)
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

function settingsJson(dirName: string, mcVersion: string): string {
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

function vec(x: number, y: number, z: number): FixtureTag {
  return tagCompound([
    ['x', tagInt(x)],
    ['y', tagInt(y)],
    ['z', tagInt(z)],
  ])
}

/** 14×24×3 litematic (four regions, negative Size.y, volume 365). */
function litematicBytes(): Buffer {
  const regions = tagCompound([
    ['R1', tagCompound([['Size', vec(5, 11, 3)], ['Position', vec(0, 0, 0)]])],
    ['R2', tagCompound([['Size', vec(4, -8, 3)], ['Position', vec(5, 0, 0)]])],
    ['R3', tagCompound([['Size', vec(3, -14, 2)], ['Position', vec(9, 0, 0)]])],
    ['R4', tagCompound([['Size', vec(2, -10, 1)], ['Position', vec(12, 0, 0)]])],
  ])
  const metadata = tagCompound([
    ['EnclosingSize', vec(14, 24, 3)],
    ['TotalVolume', tagInt(999)],
    ['RegionCount', tagInt(99)],
    ['Name', tagString('Castle')],
    ['TimeCreated', tagLong(1_700_000_000_000n)],
  ])
  return compress(
    buildNbt([
      ['Version', tagInt(6)],
      ['Metadata', metadata],
      ['Regions', regions],
    ]),
    'gzip',
  )
}

interface Fixture {
  root: string
  mcRoot: string
  dataRoot: string
  games: { A: string; B: string }
  service: AssetsModuleService
  shown: string[]
}

function fixture(options: { running?: boolean } = {}): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcl-schematics-'))
  cleanup.push(root)
  const mcRoot = path.join(root, 'mc')
  const dataRoot = path.join(root, 'data')
  const games = {
    A: path.join(mcRoot, 'versions', 'A'),
    B: path.join(mcRoot, 'versions', 'B'),
  }
  writeFile(path.join(games.A, 'A.json'), versionJson('A'))
  writeFile(path.join(games.A, 'A.jar'), 'jar')
  writeFile(path.join(games.A, 'instance.json'), settingsJson('A', '1.20.1'))
  writeFile(path.join(games.B, 'B.json'), versionJson('B'))
  writeFile(path.join(games.B, 'B.jar'), 'jar')
  writeFile(path.join(games.B, 'instance.json'), settingsJson('B', '1.21'))

  writeFile(path.join(games.A, 'schematics', 'Castle.litematic'), litematicBytes())
  writeFile(path.join(games.A, 'schematics', 'Broken.nbt'), 'definitely not an nbt file')
  writeFile(path.join(games.A, 'schematics', 'notes.txt'), 'ignored')
  writeFile(path.join(games.A, 'schematics', '.mcl-schematic-copy-stale'), 'hidden')
  writeFile(
    path.join(games.B, 'schematics', 'Existing.schem'),
    compress(
      buildNbt(
        [
          ['Version', tagInt(2)],
          ['Width', tagInt(2)],
          ['Height', tagInt(3)],
          ['Length', tagInt(4)],
          ['Palette', tagCompound([])],
          ['BlockData', tagByteArray(Buffer.from([0]))],
        ],
        'Schematic',
      ),
      'gzip',
    ),
  )
  writeFile(path.join(root, 'import-me.litematic'), litematicBytes())
  writeFile(path.join(root, 'bad-base64.litematic'), 'not a schematic')

  const shown: string[] = []
  const service = createAssetsService({
    roots: { dataRoot, mcRoot },
    log: logger,
    now: () => 1_700_000_000_000,
    showItemInFolder: (target) => shown.push(target),
    openPath: async () => '',
    ...(options.running ? { isInstanceRunning: () => true } : {}),
  })
  return { root, mcRoot, dataRoot, games, service, shown }
}

describe('schematic management service', () => {
  it('exposes one handler per assets contract method', () => {
    const handlers = makeHandlers({} as unknown as AssetsModuleService) as Record<string, unknown>
    for (const method of Object.keys(assetsContract.methods)) {
      expect(typeof handlers[method]).toBe('function')
    }
    for (const method of ['listSchematics', 'importSchematic', 'deleteSchematics', 'copySchematic']) {
      expect(Object.keys(assetsContract.methods)).toContain(method)
    }
  })

  it('lists projections with header dimensions and keeps corrupt rows readable', async () => {
    const h = fixture()
    const result = await h.service.listSchematics({ instanceId: 'A' })
    expect(result.gameDir).toBe(path.join(h.games.A, 'schematics'))
    const byName = new Map(result.schematics.map((entry) => [entry.name, entry]))
    expect([...byName.keys()].sort()).toEqual(['Broken.nbt', 'Castle.litematic'])
    expect(byName.get('Castle.litematic')).toMatchObject({
      format: 'litematic',
      dimensions: { x: 14, y: 24, z: 3 },
      volume: 365,
      regionCount: 4,
      error: null,
    })
    expect(byName.get('Broken.nbt')?.format).toBe('unknown')
    expect(byName.get('Broken.nbt')?.error).toBeTruthy()
    expect(assetsContract.methods.listSchematics.output.safeParse(result).success).toBe(true)
  })

  it('imports valid files (renaming collisions) and rejects corrupt ones', async () => {
    const h = fixture()
    const events: string[] = []
    h.service.onEvent('changed', (payload) => events.push((payload as { area: string }).area))

    const first = await h.service.importSchematic({
      instanceId: 'A',
      filePath: path.join(h.root, 'import-me.litematic'),
    })
    expect(first.imported).toBe(1)
    expect(first.fileName).toBe('import-me.litematic')
    expect(first.entry.format).toBe('litematic')
    expect(fs.existsSync(first.targetPath)).toBe(true)
    expect(assetsContract.methods.importSchematic.output.safeParse(first).success).toBe(true)

    const second = await h.service.importSchematic({
      instanceId: 'A',
      filePath: path.join(h.root, 'import-me.litematic'),
      targetName: 'Renamed',
    })
    expect(second.fileName).toBe('Renamed.litematic')

    const collision = await h.service.importSchematic({
      instanceId: 'A',
      filePath: path.join(h.root, 'import-me.litematic'),
    })
    expect(collision.fileName).toBe('import-me-2.litematic')
    expect(fs.existsSync(collision.targetPath)).toBe(true)

    await expect(
      h.service.importSchematic({
        instanceId: 'A',
        filePath: path.join(h.root, 'bad-base64.litematic'),
      }),
    ).rejects.toMatchObject({ code: 'SCHEMATIC.INVALID' })
    await expect(
      h.service.importSchematic({ instanceId: 'A', filePath: path.join(h.root, 'missing.png') }),
    ).rejects.toMatchObject({ code: 'ASSETS.FILE_NOT_FOUND' })
    expect(events).toContain('schematics')
  })

  it('deletes to the shared trash and restores the file', async () => {
    const h = fixture()
    const events: string[] = []
    h.service.onEvent('changed', (payload) => events.push((payload as { area: string }).area))
    const deleted = await h.service.deleteSchematics({
      instanceId: 'A',
      names: ['Castle.litematic', 'nope.litematic'],
    })
    expect(deleted.items).toHaveLength(1)
    expect(deleted.items[0]).toMatchObject({ kind: 'schematic', name: 'Castle.litematic' })
    expect(deleted.errors[0].name).toBe('nope.litematic')
    expect(fs.existsSync(path.join(h.games.A, 'schematics', 'Castle.litematic'))).toBe(false)
    expect(events).toContain('schematics')

    const restored = await h.service.restoreTrash({ ids: [deleted.items[0].id] })
    expect(restored.restored).toHaveLength(1)
    expect(fs.existsSync(path.join(h.games.A, 'schematics', 'Castle.litematic'))).toBe(true)
  })

  it('copies/moves a projection with conflict handling', async () => {
    const h = fixture()
    const first = await h.service.copySchematic({
      instanceId: 'A',
      name: 'Castle.litematic',
      targetInstanceId: 'B',
    })
    expect(first).toMatchObject({ status: 'copied', targetName: 'Castle.litematic', overwritten: false })
    expect(fs.existsSync(path.join(h.games.B, 'schematics', 'Castle.litematic'))).toBe(true)

    const conflict = await h.service.copySchematic({
      instanceId: 'A',
      name: 'Castle.litematic',
      targetInstanceId: 'B',
    })
    expect(conflict).toMatchObject({ status: 'conflict', targetName: null })

    const skipped = await h.service.copySchematic({
      instanceId: 'A',
      name: 'Castle.litematic',
      targetInstanceId: 'B',
      conflict: 'skip',
    })
    expect(skipped.status).toBe('skipped')

    const renamed = await h.service.copySchematic({
      instanceId: 'A',
      name: 'Castle.litematic',
      targetInstanceId: 'B',
      conflict: 'rename',
    })
    expect(renamed).toMatchObject({ status: 'copied', targetName: 'Castle-2.litematic', renamed: true })

    const overwritten = await h.service.copySchematic({
      instanceId: 'A',
      name: 'Castle.litematic',
      targetInstanceId: 'B',
      conflict: 'overwrite',
    })
    expect(overwritten).toMatchObject({ status: 'copied', overwritten: true })
    expect(assetsContract.methods.copySchematic.output.safeParse(overwritten).success).toBe(true)

    const moved = await h.service.copySchematic({
      instanceId: 'A',
      name: 'Castle.litematic',
      targetInstanceId: 'B',
      mode: 'move',
      conflict: 'rename',
    })
    expect(moved.status).toBe('moved')
    expect(fs.existsSync(path.join(h.games.A, 'schematics', 'Castle.litematic'))).toBe(false)
    const trash = await h.service.listTrash()
    expect(trash.items.some((item) => item.kind === 'schematic' && item.name === 'Castle.litematic')).toBe(true)
    const leftovers = fs
      .readdirSync(path.join(h.games.B, 'schematics'))
      .filter((name) => name.startsWith('.mcl-schematic-'))
    expect(leftovers).toEqual([])
  })

  it('validates targets, running instances and same-instance copies', async () => {
    const h = fixture()
    await expect(
      h.service.copySchematic({
        instanceId: 'A',
        name: 'Castle.litematic',
        targetInstanceId: 'A',
      }),
    ).rejects.toMatchObject({ code: 'ASSETS.SAME_INSTANCE' })
    await expect(
      h.service.copySchematic({
        instanceId: 'A',
        name: '../Castle.litematic',
        targetInstanceId: 'B',
      }),
    ).rejects.toMatchObject({ code: 'ASSETS.UNSAFE_NAME' })

    const running = fixture({ running: true })
    await expect(
      running.service.copySchematic({
        instanceId: 'A',
        name: 'Castle.litematic',
        targetInstanceId: 'B',
        mode: 'move',
      }),
    ).rejects.toMatchObject({ code: 'ASSETS.INSTANCE_RUNNING' })
  })

  it('reveals the file in the OS file manager and opens the schematics folder', async () => {
    const h = fixture()
    const shown = await h.service.showInFolder({
      instanceId: 'A',
      kind: 'schematic',
      name: 'Castle.litematic',
    })
    expect(shown.path).toBe(path.join(h.games.A, 'schematics', 'Castle.litematic'))
    expect(h.shown).toContain(shown.path)
    const folder = await h.service.openFolder({ instanceId: 'A', area: 'schematics' })
    expect(folder.path).toBe(path.join(h.games.A, 'schematics'))
  })
})

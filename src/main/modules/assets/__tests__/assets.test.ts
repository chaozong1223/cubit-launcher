import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ScopedLogger } from '../../../kernel/logger'
import { nodeFsPort } from '../../../core/ports'
import { openZipFile } from '../../../core/zip/reader'
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

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)

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

interface Fixture {
  root: string
  mcRoot: string
  dataRoot: string
  gameDir: string
  service: AssetsModuleService
  openPath: ReturnType<typeof vi.fn>
  showItem: ReturnType<typeof vi.fn>
}

function fixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcl-assets-'))
  cleanup.push(root)
  const mcRoot = path.join(root, 'mc')
  const dataRoot = path.join(root, 'data')
  const versionDir = path.join(mcRoot, 'versions', '1.20.1')
  const gameDir = versionDir
  writeFile(path.join(versionDir, '1.20.1.json'), versionJson('1.20.1'))
  writeFile(path.join(versionDir, '1.20.1.jar'), 'jar')
  writeFile(path.join(versionDir, 'instance.json'), JSON.stringify({
    schemaVersion: 1,
    id: '1.20.1',
    dirName: '1.20.1',
    name: 'Test',
    mcVersion: '1.20.1',
    loader: { type: 'vanilla', version: null },
    isolation: 'isolated',
    createdAt: 1,
  }))
  writeFile(path.join(gameDir, 'saves', 'World One', 'level.dat'), 'level')
  writeFile(path.join(gameDir, 'saves', 'World One', 'region', 'r.0.0.mca'), Buffer.alloc(2048))
  writeFile(path.join(gameDir, 'saves', 'World One', 'icon.png'), PNG)
  writeFile(path.join(gameDir, 'screenshots', 'shot.png'), PNG)
  writeFile(path.join(gameDir, 'screenshots', 'shot2.jpg'), Buffer.from('fake-jpeg'))
  writeFile(
    path.join(gameDir, 'logs', 'latest.log'),
    '[10:02:00] [Render thread/INFO]: started\n[10:02:01] [Render thread/ERROR]: boom\n',
  )
  writeFile(
    path.join(dataRoot, 'logs', 'launcher.log'),
    '2026-10-21T10:00:00.000Z INFO  [module] hello\n2026-10-21T10:00:01.000Z ERROR [ipc] failed\n',
  )
  writeFile(
    path.join(dataRoot, 'logs', 'app-20261021.jsonl'),
    `${JSON.stringify({ ts: '2026-10-21T10:01:00.000Z', level: 'warn', scope: 'ipc', msg: 'careful' })}\n`,
  )
  const openPath = vi.fn(async () => '')
  const showItem = vi.fn()
  const service = createAssetsService({
    roots: { dataRoot, mcRoot },
    log: logger,
    fs: nodeFsPort(),
    openPath,
    showItemInFolder: showItem,
    appVersion: '0.1.0',
    now: () => 1_700_000_000_000,
  })
  return { root, mcRoot, dataRoot, gameDir, service, openPath, showItem }
}

describe('saves', () => {
  it('lists worlds with size/mtime and backs one up as a zip', async () => {
    const f = fixture()
    const listing = await f.service.listSaves({ instanceId: '1.20.1' })
    expect(listing.saves).toHaveLength(1)
    expect(listing.saves[0]).toMatchObject({ name: 'World One', hasIcon: true })
    expect(listing.saves[0].size).toBeGreaterThan(2000)

    const out = path.join(f.root, 'world.zip')
    const backup = await f.service.backupSave({
      instanceId: '1.20.1',
      name: 'World One',
      outPath: out,
    })
    expect(backup.files).toBe(3)
    const archive = openZipFile(nodeFsPort(), out)
    expect(archive.has('World One/level.dat')).toBe(true)
    expect(archive.has('World One/region/r.0.0.mca')).toBe(true)
    expect(archive.has('mc-launcher-backup.json')).toBe(true)
  })

  it('deletes to trash, restores, and never silently overwrites', async () => {
    const f = fixture()
    const deleted = await f.service.deleteSaves({ instanceId: '1.20.1', names: ['World One'] })
    expect(deleted.items).toHaveLength(1)
    expect(fs.existsSync(path.join(f.gameDir, 'saves', 'World One'))).toBe(false)
    const trash = await f.service.listTrash()
    expect(trash.items[0]).toMatchObject({ kind: 'save', name: 'World One', canRestore: true })
    expect(trash.items[0].originalPath).toContain(path.join('saves', 'World One'))

    const restored = await f.service.restoreTrash()
    expect(restored.restored).toHaveLength(1)
    expect(fs.existsSync(path.join(f.gameDir, 'saves', 'World One', 'level.dat'))).toBe(true)

    // Restore conflict: put a new world at the original path, then delete and
    // recreate before restoring; the restore must fail rather than overwrite.
    await f.service.deleteSaves({ instanceId: '1.20.1', names: ['World One'] })
    writeFile(path.join(f.gameDir, 'saves', 'World One', 'level.dat'), 'new')
    const conflict = await f.service.restoreTrash()
    expect(conflict.restored).toHaveLength(0)
    expect(conflict.failed[0].message).toContain('未覆盖')
    expect(fs.readFileSync(path.join(f.gameDir, 'saves', 'World One', 'level.dat'), 'utf8')).toBe('new')
  })
})

describe('screenshots', () => {
  it('lists images, returns a preview data URL, opens and shows in folder', async () => {
    const f = fixture()
    const listing = await f.service.listScreenshots({ instanceId: '1.20.1' })
    expect(listing.screenshots.map((shot) => shot.name).sort()).toEqual(['shot.png', 'shot2.jpg'])
    const preview = await f.service.previewScreenshot({ instanceId: '1.20.1', name: 'shot.png' })
    expect(preview.mime).toBe('image/png')
    expect(preview.dataUrl.startsWith('data:image/png;base64,')).toBe(true)

    await f.service.openFile({ instanceId: '1.20.1', kind: 'screenshot', name: 'shot.png' })
    await f.service.showInFolder({ instanceId: '1.20.1', kind: 'screenshot', name: 'shot.png' })
    expect(f.openPath).toHaveBeenCalled()
    expect(f.showItem).toHaveBeenCalled()

    await expect(
      f.service.previewScreenshot({ instanceId: '1.20.1', name: '../escape.png' }),
    ).rejects.toMatchObject({ code: 'ASSETS.UNSAFE_NAME' })
  })

  it('batch deletes screenshots into restorable trash', async () => {
    const f = fixture()
    const deleted = await f.service.deleteScreenshots({
      instanceId: '1.20.1',
      names: ['shot.png', 'shot2.jpg'],
    })
    expect(deleted.items).toHaveLength(2)
    expect(fs.existsSync(path.join(f.gameDir, 'screenshots', 'shot.png'))).toBe(false)
    const trash = await f.service.listTrash()
    expect(trash.items.filter((item) => item.kind === 'screenshot')).toHaveLength(2)
    const restored = await f.service.restoreTrash({ ids: trash.items.map((item) => item.id) })
    expect(restored.restored).toHaveLength(2)
    expect(fs.existsSync(path.join(f.gameDir, 'screenshots', 'shot.png'))).toBe(true)
  })
})

describe('logs and diagnostics', () => {
  it('aggregates launcher and game logs and filters by level/search/time', async () => {
    const f = fixture()
    const sources = await f.service.listLogs({ instanceId: '1.20.1' })
    expect(sources.sources.some((source) => source.area === 'launcher')).toBe(true)
    expect(sources.sources.some((source) => source.area === 'game' && source.fileName === 'latest.log')).toBe(true)

    const errors = await f.service.queryLogs({ instanceId: '1.20.1', level: 'error' })
    expect(errors.entries).toHaveLength(2)
    expect(errors.entries.every((entry) => entry.level === 'error')).toBe(true)

    const search = await f.service.queryLogs({ instanceId: '1.20.1', search: 'boom' })
    expect(search.entries).toHaveLength(1)
    expect(search.entries[0].source).toBe('game:latest.log')

    const warnUp = await f.service.queryLogs({ instanceId: '1.20.1', minLevel: 'warn' })
    expect(warnUp.entries.length).toBeGreaterThanOrEqual(3)
    expect(warnUp.entries.every((entry) => ['warn', 'error', 'fatal'].includes(entry.level ?? ''))).toBe(true)

    const since = await f.service.queryLogs({
      instanceId: '1.20.1',
      since: Date.parse('2026-10-21T10:00:30.000Z'),
    })
    expect(since.entries.every((entry) => (entry.timestamp ?? 0) >= Date.parse('2026-10-21T10:00:30.000Z'))).toBe(true)

    const out = path.join(f.root, 'logs.zip')
    const exported = await f.service.exportLogs({ instanceId: '1.20.1', outPath: out })
    expect(exported.files).toBeGreaterThanOrEqual(2)
    const archive = openZipFile(nodeFsPort(), out)
    expect(archive.has('logs/launcher/launcher.log')).toBe(true)
    expect(archive.has('logs/game/latest.log')).toBe(true)
  })

  it('exports a diagnostics zip with logs and system metadata', async () => {
    const f = fixture()
    const out = path.join(f.root, 'diag.zip')
    const exported = await f.service.exportDiagnostics({ instanceId: '1.20.1', outPath: out })
    expect(exported.files).toBeGreaterThan(1)
    const archive = openZipFile(nodeFsPort(), out)
    expect(archive.has('diagnostics.json')).toBe(true)
    const diagnostics = JSON.parse(archive.read('diagnostics.json').toString('utf8')) as {
      appVersion: string
      mcRoot: string
    }
    expect(diagnostics.appVersion).toBe('0.1.0')
    expect(diagnostics.mcRoot).toBe(f.mcRoot)
    expect(archive.has('logs/game/latest.log')).toBe(true)
  })

  it('opens the requested asset folders and creates missing ones', async () => {
    const f = fixture()
    const saves = await f.service.openFolder({ instanceId: '1.20.1', area: 'saves' })
    expect(saves.path).toBe(path.join(f.gameDir, 'saves'))
    const logs = await f.service.openFolder({ area: 'launcher-logs' })
    expect(logs.path).toBe(path.join(f.dataRoot, 'logs'))
    expect(f.openPath).toHaveBeenCalled()
  })
})

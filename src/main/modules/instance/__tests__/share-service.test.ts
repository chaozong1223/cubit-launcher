import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ScopedLogger } from '../../../kernel/logger'
import { defaultInstanceSettings } from '../../../core/instance/settings'
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
    libraries: [],
    arguments: { game: [], jvm: [] },
  })
}

function fabricJson(id: string): string {
  return JSON.stringify({
    id,
    type: 'release',
    inheritsFrom: '1.20.1',
    mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotClient',
    libraries: [{ name: 'net.fabricmc:fabric-loader:0.15.0' }],
    arguments: { game: [], jvm: [] },
  })
}

function fixture(running = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcl-share-service-'))
  cleanup.push(root)
  const mcRoot = path.join(root, 'mc')
  const dataRoot = path.join(root, 'data')
  writeFile(path.join(mcRoot, 'versions', '1.20.1', '1.20.1.json'), versionJson('1.20.1'))
  writeFile(path.join(mcRoot, 'versions', '1.20.1', '1.20.1.jar'), 'jar')
  writeFile(
    path.join(mcRoot, 'versions', 'fabric-loader-0.15.0-1.20.1', 'fabric-loader-0.15.0-1.20.1.json'),
    fabricJson('fabric-loader-0.15.0-1.20.1'),
  )
  writeFile(
    path.join(mcRoot, 'libraries', 'net', 'fabricmc', 'fabric-loader', '0.15.0', 'fabric-loader-0.15.0.jar'),
    'loader',
  )
  const instanceDir = path.join(mcRoot, 'versions', 'Example')
  writeFile(path.join(instanceDir, 'Example.json'), fabricJson('Example'))
  writeFile(
    path.join(instanceDir, 'instance.json'),
    JSON.stringify(
      defaultInstanceSettings({
        dirName: 'Example',
        name: 'Example',
        mcVersion: '1.20.1',
        loader: { type: 'fabric', version: '0.15.0' },
        isolation: 'isolated',
        now: 1,
      }),
    ),
  )
  writeFile(path.join(instanceDir, 'mods', 'a.jar'), 'mod')
  writeFile(path.join(instanceDir, 'config', 'x.json'), '{"token":"SERVICE-SECRET"}')
  const changed: Array<string | null> = []
  const events: string[] = []
  const service = createInstanceService({ dataRoot, mcRoot }, logger, {
    now: () => 1_700_000_000_000,
    isInstanceRunning: () => running,
    onChanged: (instanceId) => changed.push(instanceId),
    onShareExportProgress: (progress) => {
      expect(progress.files).toBeGreaterThanOrEqual(0)
      expect(progress.bytes).toBeGreaterThanOrEqual(0)
      expect(progress.phase.length).toBeGreaterThan(0)
      events.push(`export:${progress.phase}`)
    },
    onShareImportProgress: (progress) => {
      expect(progress.files).toBeGreaterThanOrEqual(0)
      expect(progress.bytes).toBeGreaterThanOrEqual(0)
      events.push(`import:${progress.phase}`)
    },
    onShareExportFinished: (finished) => events.push(`export-finished:${finished.state}`),
    onShareImportFinished: (finished) => events.push(`import-finished:${finished.state}`),
  })
  return { root, mcRoot, dataRoot, instanceDir, service, changed, events }
}

describe('instance service share pack API', () => {
  it('exports and re-imports through the service, emitting changed', async () => {
    const h = fixture()
    const exportStart = h.service.exportSharePackJob({
      instanceId: 'Example',
      outPath: path.join(h.root, 'share.cubitpack'),
      include: { saves: true },
    })
    const exported = (await h.service.waitForShareExport(exportStart.jobId)).result!
    expect(exported.format).toBe('cubitpack')
    expect(fs.existsSync(exported.path)).toBe(true)
    expect(exported.redactions.some((record) => record.path === 'game/config/x.json')).toBe(true)

    const conflictStart = h.service.importSharePackJob({
      filePath: exported.path,
      name: 'Example',
    })
    expect(conflictStart.kind).toBe('conflict')
    if (conflictStart.kind === 'conflict') expect(conflictStart.result.status).toBe('conflict')

    const importStart = h.service.importSharePackJob({
      filePath: exported.path,
      name: 'Example',
      conflict: 'rename',
    })
    expect(importStart.kind).toBe('started')
    if (importStart.kind !== 'started') throw new Error('import did not start')
    const imported = (await h.service.waitForShareImport(importStart.jobId)).result!
    expect(imported).toMatchObject({
      status: 'imported',
      instanceId: 'Example-2',
      renamed: true,
      launchable: true,
    })
    expect(h.changed).toContain('Example-2')
    const settings = JSON.parse(
      fs.readFileSync(path.join(h.mcRoot, 'versions', 'Example-2', 'instance.json'), 'utf8'),
    ) as { name: string; isolation: string }
    expect(settings.name).toBe('Example')
    expect(settings.isolation).toBe('isolated')
    expect(h.events).toContain('export-finished:done')
    expect(h.events).toContain('import-finished:done')
    expect(h.events.some((event) => event.startsWith('export:scan'))).toBe(true)
    expect(h.events.some((event) => event.startsWith('import:import'))).toBe(true)
  })

  it('cancels export/import jobs without leaving artifacts or staging dirs', async () => {
    const h = fixture()
    const exportStart = h.service.exportSharePackJob({
      instanceId: 'Example',
      outPath: path.join(h.root, 'cancelled.cubitpack'),
    })
    expect(h.service.cancelShareExport(exportStart.jobId).cancelled).toBe(true)
    const exportOutcome = await h.service.waitForShareExport(exportStart.jobId)
    expect(exportOutcome.state).toBe('cancelled')
    expect(fs.existsSync(path.join(h.root, 'cancelled.cubitpack'))).toBe(false)

    const exported = (
      await h.service.waitForShareExport(
        h.service.exportSharePackJob({
          instanceId: 'Example',
          outPath: path.join(h.root, 'source.cubitpack'),
        }).jobId,
      )
    ).result!
    const importStart = h.service.importSharePackJob({
      filePath: exported.path,
      conflict: 'rename',
    })
    if (importStart.kind !== 'started') throw new Error('import did not start')
    expect(h.service.cancelShareImport(importStart.jobId).cancelled).toBe(true)
    const importOutcome = await h.service.waitForShareImport(importStart.jobId)
    expect(importOutcome.state).toBe('cancelled')
    const versions = fs.readdirSync(path.join(h.mcRoot, 'versions'))
    expect(versions.filter((name) => name.startsWith('.share-'))).toEqual([])
    expect(versions).not.toContain('Example-2')
  })

  it('refuses to export shared-isolation or running instances', () => {
    const shared = fixture()
    const sharedDir = path.join(shared.mcRoot, 'versions', 'Shared')
    writeFile(path.join(sharedDir, 'Shared.json'), versionJson('Shared'))
    const sharedSettings = defaultInstanceSettings({
      dirName: 'Shared',
      name: 'Shared',
      mcVersion: '1.20.1',
      loader: { type: 'vanilla', version: null },
      isolation: 'shared',
      now: 1,
    })
    writeFile(path.join(sharedDir, 'instance.json'), JSON.stringify(sharedSettings))
    expect(() => shared.service.exportSharePackJob({ instanceId: 'Shared' })).toThrowError(
      expect.objectContaining({ code: 'INSTANCE.SHARE_EXPORT_UNSUPPORTED' }),
    )

    const running = fixture(true)
    expect(() => running.service.exportSharePackJob({ instanceId: 'Example' })).toThrowError(
      expect.objectContaining({ code: 'INSTANCE.RUNNING' }),
    )
  })
})

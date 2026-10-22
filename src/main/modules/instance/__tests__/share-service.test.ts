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
  const service = createInstanceService({ dataRoot, mcRoot }, logger, {
    now: () => 1_700_000_000_000,
    isInstanceRunning: () => running,
    onChanged: (instanceId) => changed.push(instanceId),
  })
  return { root, mcRoot, dataRoot, instanceDir, service, changed }
}

describe('instance service share pack API', () => {
  it('exports and re-imports through the service, emitting changed', async () => {
    const h = fixture()
    const exported = await h.service.exportSharePack({
      instanceId: 'Example',
      outPath: path.join(h.root, 'share.cubitpack'),
      include: { saves: true },
    })
    expect(exported.format).toBe('cubitpack')
    expect(fs.existsSync(exported.path)).toBe(true)
    expect(exported.redactions.some((record) => record.path === 'game/config/x.json')).toBe(true)

    const conflict = await h.service.importSharePack({
      filePath: exported.path,
      name: 'Example',
    })
    expect(conflict.status).toBe('conflict')

    const imported = await h.service.importSharePack({
      filePath: exported.path,
      name: 'Example',
      conflict: 'rename',
    })
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
  })

  it('refuses to export shared-isolation or running instances', async () => {
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
    await expect(
      shared.service.exportSharePack({ instanceId: 'Shared' }),
    ).rejects.toMatchObject({ code: 'INSTANCE.SHARE_EXPORT_UNSUPPORTED' })

    const running = fixture(true)
    await expect(
      running.service.exportSharePack({ instanceId: 'Example' }),
    ).rejects.toMatchObject({ code: 'INSTANCE.RUNNING' })
  })
})

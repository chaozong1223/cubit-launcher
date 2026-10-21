import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { nodeFsPort } from '../ports'
import { scanVersionDirs } from '../version/scan'
import { scanInstances, findInstance } from '../instance/scan'
import {
  defaultInstanceSettings,
  gameDirectory,
  nativesDirectory,
  readInstanceSettings,
  writeInstanceSettings,
} from '../instance/settings'
import {
  forgeVersion,
  makeTempRoot,
  vanillaVersion,
  writeRawVersion,
  writeVersion,
} from '../__tests__/helpers'

const cleanup: string[] = []
afterEach(() => {
  for (const dir of cleanup.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})
function tempRoot(): string {
  const root = makeTempRoot('mcl-inst-')
  cleanup.push(root)
  return root
}

function cloneVanilla(id: string) {
  return { ...structuredClone(vanillaVersion()), id }
}

describe('scanVersionDirs / scanInstances', () => {
  function fixtureRoot(): string {
    const root = tempRoot()

    writeVersion(root, '1.20.1', vanillaVersion(), { jarBytes: 64 })
    writeVersion(root, '1.20.1-forge-47.2.0', forgeVersion())

    fs.mkdirSync(path.join(root, 'versions', 'missing-json'), { recursive: true })
    writeRawVersion(root, 'corrupt', '{ this is not json')
    writeRawVersion(root, 'id-mismatch', JSON.stringify({ id: 'other', mainClass: 'x.Y' }))
    writeVersion(root, 'orphan', cloneVanilla('orphan'))
    writeVersion(root, '中文 实例', cloneVanilla('中文 实例'), { jarBytes: 8 })
    return root
  }

  it('classifies ready/missing/corrupt/mismatch states without throwing', () => {
    const root = fixtureRoot()
    const entries = scanVersionDirs(nodeFsPort(), root)
    const byName = new Map(entries.map((entry) => [entry.dirName, entry]))

    expect(byName.get('1.20.1')?.state).toBe('ready')
    expect(byName.get('1.20.1')?.flattened).toBe(true)
    expect(byName.get('1.20.1')?.javaMajor).toBe(17)

    // Forge child has no jar of its own; the parent jar is used.
    expect(byName.get('1.20.1-forge-47.2.0')?.state).toBe('ready')
    expect(byName.get('1.20.1-forge-47.2.0')?.loader.type).toBe('forge')
    expect(byName.get('1.20.1-forge-47.2.0')?.flattened).toBe(false)
    expect(byName.get('1.20.1-forge-47.2.0')?.chain).toEqual([
      '1.20.1',
      '1.20.1-forge-47.2.0',
    ])

    expect(byName.get('missing-json')?.state).toBe('missing-json')
    expect(byName.get('corrupt')?.state).toBe('corrupt-json')
    expect(byName.get('id-mismatch')?.state).toBe('unsupported')
    expect(byName.get('id-mismatch')?.reason).toContain('id mismatch')
    expect(byName.get('orphan')?.state).toBe('missing-jar')
    expect(byName.get('中文 实例')?.state).toBe('ready')
    expect(entries).toHaveLength(7)
  })

  it('merges instance.json metadata and resolves isolation', () => {
    const root = fixtureRoot()
    const versionDir = path.join(root, 'versions', '1.20.1')
    writeInstanceSettings(
      nodeFsPort(),
      versionDir,
      defaultInstanceSettings({
        dirName: '1.20.1',
        id: 'inst-main',
        name: '主实例',
        mcVersion: '1.20.1',
        loader: { type: 'vanilla', version: null },
        isolation: 'shared',
        now: 1000,
      }),
    )

    const instances = scanInstances(nodeFsPort(), root)
    expect(instances).toHaveLength(7)
    const main = instances.find((instance) => instance.dirName === '1.20.1')
    expect(main).toMatchObject({
      id: 'inst-main',
      name: '主实例',
      isolation: 'shared',
      state: 'ready',
    })
    expect(findInstance(nodeFsPort(), root, 'inst-main')?.dirName).toBe('1.20.1')
    expect(findInstance(nodeFsPort(), root, '1.20.1')?.name).toBe('主实例')
    expect(gameDirectory(root, '1.20.1', 'shared')).toBe(root)
    expect(gameDirectory(root, '1.20.1', 'isolated')).toBe(versionDir)
    expect(nativesDirectory(root, '1.20.1')).toBe(path.join(versionDir, '1.20.1-natives'))
  })

  it('falls back to a default instance summary when instance.json is absent', () => {
    const root = fixtureRoot()
    const instance = scanInstances(nodeFsPort(), root).find(
      (item) => item.dirName === '1.20.1',
    )
    expect(instance?.id).toBe('1.20.1')
    expect(instance?.name).toBe('1.20.1')
    expect(instance?.isolation).toBe('isolated')
    expect(instance?.settingsError).toBeNull()
  })

  it('reports a corrupt instance.json instead of failing the scan', () => {
    const root = fixtureRoot()
    fs.writeFileSync(path.join(root, 'versions', '1.20.1', 'instance.json'), '{ bad', 'utf8')
    const instance = scanInstances(nodeFsPort(), root).find(
      (item) => item.dirName === '1.20.1',
    )
    expect(instance?.state).toBe('ready')
    expect(instance?.settingsError).toContain('unreadable instance.json')
    expect(instance?.reason).toContain('instance.json')
  })

  it('round-trips instance.json with explicit fields only', () => {
    const root = tempRoot()
    const dir = path.join(root, 'versions', 'x')
    fs.mkdirSync(dir, { recursive: true })
    const fsPort = nodeFsPort()
    const settings = defaultInstanceSettings({
      dirName: 'x',
      id: 'x-id',
      mcVersion: '1.20.1',
      loader: { type: 'fabric', version: '0.15.11' },
      now: 42,
    })
    settings.memory = { minMb: 2048, maxMb: 8192 }
    settings.window = { width: 1920, height: 1080, fullscreen: true }
    writeInstanceSettings(fsPort, dir, settings)

    const read = readInstanceSettings(fsPort, dir)
    expect(read.error).toBeNull()
    expect(read.settings?.memory).toEqual({ minMb: 2048, maxMb: 8192 })
    expect(read.settings?.memoryMode).toBe('auto')
    expect(read.settings?.window).toEqual({ width: 1920, height: 1080, fullscreen: true })
    expect(read.explicit).toEqual({ memory: true, window: true, java: true })
  })
})

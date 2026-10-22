import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ScopedLogger } from '../../../kernel/logger'
import { createInstanceService } from '../service'
import { AssetsModuleService } from '../../assets/service'
import type { TrashStore } from '../../assets/trash'

const cleanup: string[] = []
const logger = {
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
} as unknown as ScopedLogger

afterEach(() => {
  for (const dir of cleanup.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function fixture(running = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcl-remove-'))
  cleanup.push(root)
  const mcRoot = path.join(root, 'mc')
  const dataRoot = path.join(root, 'data')
  const versionDir = path.join(mcRoot, 'versions', '1.20.1')
  fs.mkdirSync(versionDir, { recursive: true })
  fs.writeFileSync(
    path.join(versionDir, '1.20.1.json'),
    JSON.stringify({
      id: '1.20.1',
      type: 'release',
      mainClass: 'net.minecraft.client.main.Main',
      libraries: [],
      arguments: { game: [], jvm: [] },
    }),
  )
  fs.mkdirSync(path.join(mcRoot, 'libraries'), { recursive: true })
  fs.writeFileSync(path.join(mcRoot, 'libraries', 'shared.jar'), 'library')
  fs.mkdirSync(path.join(mcRoot, 'assets', 'objects'), { recursive: true })
  fs.writeFileSync(path.join(mcRoot, 'assets', 'objects', 'shared'), 'asset')
  const service = createInstanceService(
    { dataRoot, mcRoot },
    logger,
    { isInstanceRunning: () => running },
  )
  return { root, mcRoot, dataRoot, versionDir, service }
}

describe('instance removal to trash', () => {
  it('moves only versions/<dir> into trash and restores it', async () => {
    const h = fixture()
    expect(await h.service.list()).toHaveLength(1)
    const removed = await h.service.removeInstance('1.20.1')
    expect(removed.trashId).toBeTruthy()
    expect(fs.existsSync(h.versionDir)).toBe(false)
    expect(fs.existsSync(path.join(h.dataRoot, 'trash', removed.trashId, 'item.json'))).toBe(true)
    // Shared libraries/assets are untouched.
    expect(fs.existsSync(path.join(h.mcRoot, 'libraries', 'shared.jar'))).toBe(true)
    expect(fs.existsSync(path.join(h.mcRoot, 'assets', 'objects', 'shared'))).toBe(true)
    expect(await h.service.list()).toHaveLength(0)

    const restored = await h.service.restoreInstance(removed.trashId)
    expect(restored.originalPath).toBe(h.versionDir)
    expect(fs.existsSync(path.join(h.versionDir, '1.20.1.json'))).toBe(true)
    expect(await h.service.list()).toHaveLength(1)
  })

  it('restores through the shared assets trash API', async () => {
    const h = fixture()
    const removed = await h.service.removeInstance('1.20.1')
    const assets = new AssetsModuleService({
      roots: { dataRoot: h.dataRoot, mcRoot: h.mcRoot },
      log: logger,
    })
    expect((await assets.listTrash()).items.map((item) => item.id)).toContain(removed.trashId)
    const restored = await assets.restoreTrash({ ids: [removed.trashId] })
    expect(restored.restored).toHaveLength(1)
    expect(fs.existsSync(path.join(h.versionDir, '1.20.1.json'))).toBe(true)
    expect(await h.service.list()).toHaveLength(1)
  })

  it('refuses to remove a running instance with a stable error code', async () => {
    const h = fixture(true)
    let caught: unknown
    try {
      await h.service.removeInstance('1.20.1')
    } catch (error) {
      caught = error
    }
    expect(caught).toMatchObject({ code: 'INSTANCE.RUNNING' })
    expect(fs.existsSync(path.join(h.versionDir, '1.20.1.json'))).toBe(true)
  })

  it('rolls back if the trash move fails after moving the directory', async () => {
    const h = fixture()
    let moved = false
    const fakeTrash = {
      delete: (input: { originalPath: string }) => {
        const itemDir = path.join(h.dataRoot, 'trash', 'fake-failure')
        fs.mkdirSync(itemDir, { recursive: true })
        fs.renameSync(input.originalPath, path.join(itemDir, 'payload'))
        moved = true
        throw new Error('simulated manifest failure')
      },
      restore: () => ({ restored: [], failed: [] }),
      list: () => [],
    } as unknown as TrashStore
    const service = createInstanceService(
      { dataRoot: h.dataRoot, mcRoot: h.mcRoot },
      logger,
      { isInstanceRunning: () => false, trash: fakeTrash },
    )
    let caught: unknown
    try {
      await service.removeInstance('1.20.1')
    } catch (error) {
      caught = error
    }
    expect(caught).toMatchObject({ code: 'INSTANCE.DELETE_FAILED' })
    expect(moved).toBe(true)
    expect(fs.existsSync(path.join(h.versionDir, '1.20.1.json'))).toBe(true)
    expect(fs.existsSync(path.join(h.dataRoot, 'trash', 'fake-failure'))).toBe(false)
  })
})

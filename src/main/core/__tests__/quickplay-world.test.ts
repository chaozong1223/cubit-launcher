import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { contract as launchContract } from '@shared/launch'
import { nodeFsPort } from '../ports'
import { resolveQuickPlayWorld } from '../launch/orchestrator'

const cleanup: string[] = []
afterEach(() => {
  for (const dir of cleanup.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcl-quickplay-'))
  cleanup.push(root)
  fs.mkdirSync(path.join(root, 'saves', 'World One'), { recursive: true })
  fs.writeFileSync(path.join(root, 'saves', 'World One', 'level.dat'), 'level')
  return root
}

describe('resolveQuickPlayWorld', () => {
  it('is exposed by the launch contract as an optional world field', () => {
    const withoutWorld = launchContract.methods.start.input.parse({ instanceId: 'x' })
    expect(withoutWorld).toMatchObject({ world: null })
    const withWorld = launchContract.methods.plan.input.parse({
      instanceId: 'x',
      world: 'World One',
      dryRun: true,
    })
    expect(withWorld.world).toBe('World One')
  })

  it('returns the folder name of an existing world', () => {
    const gameDir = fixture()
    expect(resolveQuickPlayWorld(nodeFsPort(), gameDir, 'World One')).toBe('World One')
    expect(resolveQuickPlayWorld(nodeFsPort(), gameDir, '  World One  ')).toBe('World One')
  })

  it('returns null when no world was requested', () => {
    const gameDir = fixture()
    expect(resolveQuickPlayWorld(nodeFsPort(), gameDir, null)).toBeNull()
    expect(resolveQuickPlayWorld(nodeFsPort(), gameDir, undefined)).toBeNull()
    expect(resolveQuickPlayWorld(nodeFsPort(), gameDir, '   ')).toBeNull()
  })

  it('rejects traversal and multi-segment names', () => {
    const gameDir = fixture()
    for (const bad of ['..', '.', '../World One', 'a/b', 'a\\b', 'bad\0name']) {
      expect(() => resolveQuickPlayWorld(nodeFsPort(), gameDir, bad)).toThrowError(
        expect.objectContaining({ code: 'LAUNCH.WORLD_UNSAFE' }),
      )
    }
  })

  it('rejects a world that does not exist on disk', () => {
    const gameDir = fixture()
    expect(() => resolveQuickPlayWorld(nodeFsPort(), gameDir, 'Missing')).toThrowError(
      expect.objectContaining({ code: 'LAUNCH.WORLD_NOT_FOUND' }),
    )
  })
})

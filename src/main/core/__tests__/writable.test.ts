import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { nodeFsPort, type FsPort } from '../ports'
import {
  fallbackNativesDirectory,
  LaunchOrchestrator,
  probeWritableDirectory,
  rewriteNativesPath,
} from '../launch/orchestrator'

const cleanup: string[] = []
afterEach(() => {
  for (const dir of cleanup.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcl-writable-'))
  cleanup.push(dir)
  return dir
}

describe('instance directory writability fallback', () => {
  it('does not fall back when the instance and gameDir are writable', () => {
    const dir = tempDir()
    expect(probeWritableDirectory(nodeFsPort(), dir)).toBe(true)
    expect(fs.readdirSync(dir)).toEqual([])
  })

  it('detects EPERM and chooses a temp natives dir outside the instance', () => {
    const dir = tempDir()
    const readOnly: FsPort = {
      ...nodeFsPort(),
      writeTextAtomic() {
        const error = new Error('EPERM: operation not permitted') as Error & { code: string }
        error.code = 'EPERM'
        throw error
      },
    }
    expect(probeWritableDirectory(readOnly, dir)).toBe(false)
    const fallback = fallbackNativesDirectory('C:/data', '1.20.1', 3)
    expect(fallback).toBe(path.join('C:/data', 'tmp', 'natives', '1.20.1-3'))
    expect(fallback).not.toContain(dir)
    expect(rewriteNativesPath(['-Djava.library.path=old', '--x=old'], 'old', fallback)).toEqual([
      `-Djava.library.path=${fallback}`,
      `--x=${fallback}`,
    ])
  })

  it('moves natives and argv to dataRoot/tmp when the instance is not writable', () => {
    const dataRoot = tempDir()
    const instanceDir = path.join(tempDir(), 'versions', '1.20.1')
    const oldNatives = path.join(instanceDir, '1.20.1-natives')
    const readOnly: FsPort = {
      ...nodeFsPort(),
      writeTextAtomic() {
        const error = new Error('EPERM: operation not permitted') as Error & { code: string }
        error.code = 'EPERM'
        throw error
      },
    }
    const orchestrator = new LaunchOrchestrator({
      dataRoot,
      mcRoot: path.dirname(path.dirname(instanceDir)),
      appVersion: 'test',
      fs: readOnly,
    })
    const prepared = {
      instance: { id: '1.20.1', dir: instanceDir },
      resolved: { dirName: '1.20.1' },
      plan: {
        cwd: instanceDir,
        nativesDir: oldNatives,
        argv: ['-Djava.library.path=' + oldNatives],
        env: { NATIVES: oldNatives },
        warnings: [],
      },
      publicPlan: {
        nativesDir: oldNatives,
        argv: ['-Djava.library.path=' + oldNatives],
        env: { NATIVES: oldNatives },
        warnings: [],
      },
    }
    ;(
      orchestrator as unknown as {
        ensureWritableNativesDirectory(value: unknown): void
      }
    ).ensureWritableNativesDirectory(prepared)
    expect(prepared.plan.nativesDir).toBe(path.join(dataRoot, 'tmp', 'natives', '1.20.1-1'))
    expect(prepared.plan.argv[0]).toContain(prepared.plan.nativesDir)
    expect(prepared.publicPlan.argv[0]).toContain(prepared.plan.nativesDir)
    expect(prepared.publicPlan.warnings.join('\n')).toContain('模组安装/存档备份')
    expect(prepared.publicPlan.warnings.join('\n')).toContain('杀毒软件信任')
  })

  it('keeps the instance natives path when the gameDir is writable', () => {
    const dataRoot = tempDir()
    const instanceDir = tempDir()
    const oldNatives = path.join(instanceDir, '1.20.1-natives')
    const orchestrator = new LaunchOrchestrator({
      dataRoot,
      mcRoot: instanceDir,
      appVersion: 'test',
    })
    const prepared = {
      instance: { id: '1.20.1', dir: instanceDir },
      resolved: { dirName: '1.20.1' },
      plan: {
        cwd: instanceDir,
        nativesDir: oldNatives,
        argv: ['-Djava.library.path=' + oldNatives],
        env: {},
        warnings: [],
      },
      publicPlan: {
        nativesDir: oldNatives,
        argv: ['-Djava.library.path=' + oldNatives],
        env: {},
        warnings: [],
      },
    }
    ;(
      orchestrator as unknown as {
        ensureWritableNativesDirectory(value: unknown): void
      }
    ).ensureWritableNativesDirectory(prepared)
    expect(prepared.plan.nativesDir).toBe(oldNatives)
    expect(prepared.publicPlan.warnings).toHaveLength(0)
  })
})

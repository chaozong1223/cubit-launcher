import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig } from './config'

const roots: string[] = []

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcl-config-'))
  roots.push(root)
  return root
}

function writeConfig(root: string, value: unknown): void {
  fs.writeFileSync(path.join(root, 'config.json'), `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    try {
      fs.rmSync(root, { recursive: true, force: true })
    } catch {
      // Best effort after temporary config/log files.
    }
  }
})

describe('legacy data root handling', () => {
  it('never trusts a missing absolute legacy dataRoot and logs the portable fallback', () => {
    const root = tempRoot()
    const legacy = path.join(root, 'removed-install', 'data')
    writeConfig(root, {
      schemaVersion: 1,
      paths: { dataRoot: legacy, minecraftRoot: null },
    })

    const loaded = loadConfig(root)
    expect(loaded.legacyDataRoot).toBe(legacy)
    expect(loaded.legacyDataRootMissing).toBe(true)
    expect(loaded.config.paths.minecraftRoot).toBeNull()
    expect(loaded.file).toBe(path.join(root, 'config.json'))

    const log = fs.readFileSync(path.join(root, 'logs', 'launcher.log'), 'utf8')
    expect(log).toContain('legacy data root missing; using portable data root')
  })

  it('ignores an existing legacy root rather than adopting it as the new default', () => {
    const root = tempRoot()
    const legacy = path.join(root, 'old-install', 'data')
    fs.mkdirSync(legacy, { recursive: true })
    writeConfig(root, {
      schemaVersion: 1,
      dataDir: legacy,
    })

    const loaded = loadConfig(root)
    expect(loaded.legacyDataRoot).toBe(legacy)
    expect(loaded.legacyDataRootMissing).toBe(false)
    expect(loaded.config.paths.minecraftRoot).toBeNull()
    expect(fs.existsSync(path.join(root, 'logs', 'launcher.log'))).toBe(false)
  })

  it('keeps a normal config free of legacy metadata', () => {
    const root = tempRoot()
    writeConfig(root, {
      schemaVersion: 1,
      app: { theme: 'dark', window: { width: 1280, height: 800 } },
      paths: { minecraftRoot: 'E:\\MC\\.minecraft' },
    })

    const loaded = loadConfig(root)
    expect(loaded.legacyDataRoot).toBeNull()
    expect(loaded.legacyDataRootMissing).toBe(false)
    expect(loaded.config.paths.minecraftRoot).toBe('E:\\MC\\.minecraft')
  })
})

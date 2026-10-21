import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ScopedLogger } from '../../../kernel/logger'
import { LaunchModuleService } from '../service'
import { loadLaunchSettings, saveLaunchSettings } from '../settings'

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

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcl-launch-settings-'))
  cleanup.push(root)
  return root
}

describe('launch language setting', () => {
  it('defaults to zh_cn, persists changes and returns a settings note', () => {
    const dataRoot = tempRoot()
    expect(loadLaunchSettings(dataRoot).language).toBe('zh_cn')
    expect(saveLaunchSettings(dataRoot, { language: 'en_us' }).language).toBe('en_us')
    expect(loadLaunchSettings(dataRoot).language).toBe('en_us')
    expect(loadLaunchSettings(dataRoot).note).toContain('options.txt')
    expect(saveLaunchSettings(dataRoot, { language: null }).language).toBeNull()
    expect(loadLaunchSettings(dataRoot).language).toBeNull()
  })

  it('validates language codes through the service', () => {
    const dataRoot = tempRoot()
    const service = new LaunchModuleService({ dataRoot, mcRoot: null }, logger)
    expect(service.getSettings().language).toBe('zh_cn')
    expect(service.setLanguage({ language: 'ja_jp' }).language).toBe('ja_jp')
    let caught: unknown
    try {
      service.setLanguage({ language: 'not a language' })
    } catch (error) {
      caught = error
    }
    expect(caught).toMatchObject({ code: 'LAUNCH.INVALID_LANGUAGE' })
  })
})

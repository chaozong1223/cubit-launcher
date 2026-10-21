import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { nodeFsPort } from '../ports'
import { applyGameLanguage } from '../launch/options'

const cleanup: string[] = []
afterEach(() => {
  for (const dir of cleanup.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcl-lang-'))
  cleanup.push(dir)
  return dir
}

describe('game language options.txt', () => {
  it('sets lang while preserving other keys and backs up once', () => {
    const gameDir = tempDir()
    const options = path.join(gameDir, 'options.txt')
    const original = 'version:3465\nlang:en_us\nfov:0.5\nrenderDistance:12\n'
    fs.writeFileSync(options, original)

    const first = applyGameLanguage(nodeFsPort(), gameDir, 'zh_cn')
    expect(first).toMatchObject({ language: 'zh_cn', changed: true })
    expect(fs.readFileSync(options, 'utf8')).toBe(
      'version:3465\nlang:zh_cn\nfov:0.5\nrenderDistance:12\n',
    )
    expect(fs.readFileSync(`${options}.bak`, 'utf8')).toBe(original)

    // An in-game change is overridden on the next launch, but the backup is
    // not overwritten (it stays the original pre-launcher file).
    fs.writeFileSync(options, 'version:3465\nlang:ja_jp\nfov:0.5\n')
    const second = applyGameLanguage(nodeFsPort(), gameDir, 'zh_cn')
    expect(second.changed).toBe(true)
    expect(fs.readFileSync(options, 'utf8')).toContain('lang:zh_cn')
    expect(fs.readFileSync(`${options}.bak`, 'utf8')).toBe(original)
  })

  it('creates options.txt with the requested language and keeps CRLF', () => {
    const gameDir = tempDir()
    const created = applyGameLanguage(nodeFsPort(), gameDir, 'en_us')
    expect(created.backupPath).toBeNull()
    expect(fs.readFileSync(path.join(gameDir, 'options.txt'), 'utf8')).toBe('lang:en_us\n')

    const gameDir2 = tempDir()
    fs.writeFileSync(path.join(gameDir2, 'options.txt'), 'version:3465\r\nlang:en_us\r\n')
    applyGameLanguage(nodeFsPort(), gameDir2, 'zh_cn')
    expect(fs.readFileSync(path.join(gameDir2, 'options.txt'), 'utf8')).toBe(
      'version:3465\r\nlang:zh_cn\r\n',
    )
  })

  it('follow-game (null) leaves options.txt untouched and accepts other languages', () => {
    const gameDir = tempDir()
    const options = path.join(gameDir, 'options.txt')
    fs.writeFileSync(options, 'lang:de_de\n')
    const skipped = applyGameLanguage(nodeFsPort(), gameDir, null)
    expect(skipped.changed).toBe(false)
    expect(fs.readFileSync(options, 'utf8')).toBe('lang:de_de\n')
    applyGameLanguage(nodeFsPort(), gameDir, 'fr_fr')
    expect(fs.readFileSync(options, 'utf8')).toBe('lang:fr_fr\n')
  })
})

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { nodeFsPort } from '../../ports'
import { applyGameFullscreen } from '../options'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function tempGameDir(options?: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcl-options-'))
  dirs.push(dir)
  if (options !== undefined) fs.writeFileSync(path.join(dir, 'options.txt'), options, 'utf8')
  return dir
}

describe('applyGameFullscreen', () => {
  it('turns an in-game F11 back into the launcher setting', () => {
    const dir = tempGameDir('version:1343\nfullscreen:true\nguiScale:2\n')
    const result = applyGameFullscreen(nodeFsPort(), dir, false)

    expect(result).toMatchObject({ changed: true, previous: true, fullscreen: false })
    const text = fs.readFileSync(path.join(dir, 'options.txt'), 'utf8')
    expect(text).toContain('fullscreen:false')
    expect(text).toContain('version:1343')
    expect(text).toContain('guiScale:2')
    // Other keys and order survive.
    expect(text.indexOf('version:1343')).toBeLessThan(text.indexOf('fullscreen:false'))
  })

  it('does nothing when the file already matches', () => {
    const dir = tempGameDir('fullscreen:false\n')
    expect(applyGameFullscreen(nodeFsPort(), dir, false).changed).toBe(false)
  })

  it('appends the key when the file has none', () => {
    const dir = tempGameDir('guiScale:2\n')
    const result = applyGameFullscreen(nodeFsPort(), dir, false)
    expect(result.changed).toBe(true)
    expect(result.previous).toBeNull()
    expect(fs.readFileSync(path.join(dir, 'options.txt'), 'utf8')).toContain('fullscreen:false')
  })

  it('leaves a missing options.txt alone', () => {
    const dir = tempGameDir()
    expect(applyGameFullscreen(nodeFsPort(), dir, false).changed).toBe(false)
    expect(fs.existsSync(path.join(dir, 'options.txt'))).toBe(false)
  })

  it('can also turn fullscreen on when the launcher setting says so', () => {
    const dir = tempGameDir('fullscreen:false\n')
    const result = applyGameFullscreen(nodeFsPort(), dir, true)
    expect(result).toMatchObject({ changed: true, previous: false, fullscreen: true })
  })
})

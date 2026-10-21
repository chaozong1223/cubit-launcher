import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  acquireJobLock,
  assertSafeRelPath,
  checkExistingFile,
  cleanStalePart,
  freeSpaceBytes,
  partPath,
  readTextFile,
  resolveInside,
  writeTextAtomic,
} from '../core/fs-atomic'
import { sha1 } from './support/http-server'

let root = ''

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcl-fs-'))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('assertSafeRelPath (SEC-DL-09)', () => {
  it('accepts normal relative paths, including Chinese names', () => {
    expect(assertSafeRelPath('libraries/org/lwjgl/a.jar').relative).toBe(
      path.join('libraries', 'org', 'lwjgl', 'a.jar'),
    )
    expect(assertSafeRelPath('versions/史前世界 2/史前世界 2.json').segments).toHaveLength(3)
  })

  it.each([
    ['/etc/passwd', 'absolute'],
    ['\\\\server\\share\\x', 'UNC'],
    ['C:\\Windows\\x', 'drive'],
    ['../escape', 'parent'],
    ['a/../../b', 'parent'],
    ['a:b', 'alternate data stream'],
    ['CON', 'reserved'],
    ['lpt1.jar', 'reserved'],
    ['name.', 'trailing'],
    ['name ', 'trailing'],
    ['', 'empty'],
    ['a\0b', 'NUL'],
  ])('rejects %s', (value, reason) => {
    expect(() => assertSafeRelPath(value)).toThrowError(new RegExp(reason, 'i'))
  })

  it('keeps a prefix-sibling outside the root (SEC-DL-09)', () => {
    fs.mkdirSync(path.join(root, 'mc'))
    expect(() => resolveInside(path.join(root, 'mc'), '../mc2/x.jar')).toThrowError(/parent/)
    expect(resolveInside(path.join(root, 'mc'), 'libraries/x.jar')).toBe(
      path.join(root, 'mc', 'libraries', 'x.jar'),
    )
  })
})

describe('atomic files', () => {
  it('writes via a temp file and replaces existing content', async () => {
    const file = path.join(root, 'nested', 'a.json')
    await writeTextAtomic(file, '{"v":1}')
    await writeTextAtomic(file, '{"v":2}')
    expect(await readTextFile(file)).toBe('{"v":2}')
    expect(fs.readdirSync(path.dirname(file))).toEqual(['a.json'])
  })

  it('checks size first and hash on request', async () => {
    const file = path.join(root, 'a.bin')
    fs.writeFileSync(file, 'hello world')
    expect(await checkExistingFile(file, { expectedSize: 11 })).toMatchObject({ ok: true })
    expect(await checkExistingFile(file, { expectedSize: 10 })).toMatchObject({
      ok: false,
      reason: 'size',
    })
    expect(
      await checkExistingFile(file, { verify: 'hash', sha1: sha1('hello world') }),
    ).toMatchObject({ ok: true })
    expect(
      await checkExistingFile(file, { verify: 'hash', sha1: 'a'.repeat(40) }),
    ).toMatchObject({ ok: false, reason: 'hash' })
    expect(await checkExistingFile(path.join(root, 'missing'), {})).toMatchObject({
      ok: false,
      reason: 'missing',
    })
  })

  it('removes only .part files older than 24 h (SEC-DL-02)', async () => {
    const dest = path.join(root, 'libraries', 'a.jar')
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    const part = partPath(dest)
    fs.writeFileSync(part, 'partial')
    const now = Date.now()
    fs.utimesSync(part, new Date(now - 1000), new Date(now - 1000))
    expect(await cleanStalePart(dest, now)).toBe(false)
    expect(fs.existsSync(part)).toBe(true)

    fs.utimesSync(part, new Date(now - 25 * 60 * 60 * 1000), new Date(now - 25 * 60 * 60 * 1000))
    expect(await cleanStalePart(dest, now)).toBe(true)
    expect(fs.existsSync(part)).toBe(false)
  })
})

describe('job lock (docs/03 §6.3)', () => {
  it('blocks a second lock and releases cleanly', async () => {
    const lockFile = path.join(root, 'tmp', 'download-x.lock')
    const lock = await acquireJobLock(lockFile)
    await expect(acquireJobLock(lockFile)).rejects.toMatchObject({ code: 'DOWNLOAD.LOCKED' })
    await lock.release()
    const again = await acquireJobLock(lockFile)
    await again.release()
  })

  it('keeps a long job lock alive with a heartbeat (H5)', async () => {
    const lockFile = path.join(root, 'tmp', 'download-heartbeat.lock')
    const lock = await acquireJobLock(lockFile, { staleMs: 120, heartbeatMs: 20 })
    await new Promise((resolve) => setTimeout(resolve, 220))
    // Without a heartbeat the 120 ms lock would be stolen; the timer refreshes
    // mtime so a 425 s install is not mistaken for an abandoned one.
    await expect(acquireJobLock(lockFile, { staleMs: 120 })).rejects.toMatchObject({
      code: 'DOWNLOAD.LOCKED',
    })
    await lock.release()
    const again = await acquireJobLock(lockFile, { staleMs: 120 })
    await again.release()
  })

  it('takes over a lock older than 10 minutes', async () => {
    const lockFile = path.join(root, 'tmp', 'download-stale.lock')
    fs.mkdirSync(path.dirname(lockFile), { recursive: true })
    fs.writeFileSync(lockFile, '{"pid":1}')
    const old = new Date(Date.now() - 11 * 60 * 1000)
    fs.utimesSync(lockFile, old, old)

    const lock = await acquireJobLock(lockFile)
    expect(fs.existsSync(lockFile)).toBe(true)
    await lock.release()
    expect(fs.existsSync(lockFile)).toBe(false)
  })
})

describe('free space', () => {
  it('returns a number for an existing directory or null when unknown', async () => {
    const value = await freeSpaceBytes(root)
    expect(value === null || value > 0).toBe(true)
  })
})

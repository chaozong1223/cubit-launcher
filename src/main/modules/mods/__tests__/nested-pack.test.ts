import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { nodeFsPort } from '../../../core/ports'
import { createStoredZip } from '../archive'
import { findNestedPack, openPackArchive } from '../modpack'
import { openZipFile } from '../../../core/zip/reader'
import { AppError } from '@shared/errors'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function tempRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcl-nested-pack-'))
  dirs.push(dir)
  return dir
}

function mrpackBytes(overrides: { name?: string; withoutIndex?: boolean } = {}): Buffer {
  const index = {
    formatVersion: 1,
    game: 'minecraft',
    versionId: '1.0.0',
    name: overrides.name ?? '超限征伐',
    files: [],
    dependencies: { minecraft: '1.20.1', forge: '47.4.23' },
  }
  const entries = [
    { name: 'overrides/config/example.toml', data: Buffer.from('x = 1\n') },
  ]
  if (!overrides.withoutIndex) {
    entries.unshift({ name: 'modrinth.index.json', data: Buffer.from(JSON.stringify(index)) })
  }
  return createStoredZip(entries)
}

function write(target: string, data: Buffer): void {
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, data)
}

describe('launcher installer ("套娃") packs', () => {
  it('unwraps one layer and reads the inner manifest', () => {
    const root = tempRoot()
    const outerPath = path.join(root, '超限征伐1.1.zip')
    write(
      outerPath,
      createStoredZip([
        { name: 'modpack.mrpack', data: mrpackBytes() },
        { name: 'Plain Craft Launcher.exe', data: Buffer.from('MZ fake launcher') },
        { name: 'PCL/Setup.ini', data: Buffer.from('[launcher]\n') },
      ]),
    )

    const opened = openPackArchive(nodeFsPort(), outerPath, path.join(root, 'tmp'), 'job-1')

    expect(opened.manifest).toMatchObject({
      format: 'modrinth',
      name: '超限征伐',
      mcVersion: '1.20.1',
      loader: { type: 'forge', version: '47.4.23' },
    })
    expect(opened.nested?.entry).toBe('modpack.mrpack')
    expect(opened.nested && fs.existsSync(opened.nested.tempFile)).toBe(true)
    // The inner archive is what the importer must use from now on.
    expect(opened.archive.has('modrinth.index.json')).toBe(true)
    expect(opened.archive.has('Plain Craft Launcher.exe')).toBe(false)
  })

  it('keeps reading a plain pack without touching the filesystem', () => {
    const root = tempRoot()
    const plain = path.join(root, 'plain.mrpack')
    write(plain, mrpackBytes({ name: '普通整合包' }))

    const opened = openPackArchive(nodeFsPort(), plain, path.join(root, 'tmp'), 'job-2')
    expect(opened.nested).toBeNull()
    expect(opened.manifest.name).toBe('普通整合包')
  })

  it('refuses to guess when a zip wraps several packs', () => {
    const root = tempRoot()
    const outer = path.join(root, 'ambiguous.zip')
    write(
      outer,
      createStoredZip([
        { name: 'one.mrpack', data: mrpackBytes({ name: 'A' }) },
        { name: 'two.mrpack', data: mrpackBytes({ name: 'B' }) },
      ]),
    )
    const archive = openZipFile(nodeFsPort(), outer)
    expect(findNestedPack(archive)).toBeNull()
    expect(() => openPackArchive(nodeFsPort(), outer, path.join(root, 'tmp'), 'job-3')).toThrow(AppError)
  })

  it('deletes the temp copy when the inner file is not a pack', () => {
    const root = tempRoot()
    const dir = path.join(root, 'tmp')
    const outer = path.join(root, 'broken-wrapper.zip')
    write(
      outer,
      createStoredZip([
        // A zip (so it is a nested candidate) without any manifest inside.
        { name: 'bundle.zip', data: mrpackBytes({ withoutIndex: true }) },
        { name: 'readme.txt', data: Buffer.from('nothing useful') },
      ]),
    )

    expect(() => openPackArchive(nodeFsPort(), outer, dir, 'job-4')).toThrow(AppError)
    // No 600 MB leftovers after a failed unwrap.
    const leftovers = fs.existsSync(dir)
      ? fs.readdirSync(dir).filter((name) => name.includes('nested-job-4'))
      : []
    expect(leftovers).toEqual([])
  })
})

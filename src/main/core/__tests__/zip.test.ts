import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { CoreError } from '../errors'
import { nodeFsPort } from '../ports'
import { assertSafeEntryName, crc32, extractZip, ZipArchive } from '../zip/reader'
import { extractNatives, type NativePlan } from '../launch/natives'
import { makeTempRoot } from '../__tests__/helpers'

const cleanup: string[] = []
afterEach(() => {
  for (const dir of cleanup.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})
function tempRoot(): string {
  const root = makeTempRoot('mcl-zip-')
  cleanup.push(root)
  return root
}

interface ZipInput {
  name: string
  data: string | Buffer
  method?: 0 | 8
  externalAttrs?: number
  crcOverride?: number
}

/** Minimal ZIP writer so tests do not depend on shell commands or fixtures. */
function buildZip(entries: ZipInput[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8')
    const method = entry.method ?? 0
    const compressed = method === 8 ? zlib.deflateRawSync(data) : data
    const crc = entry.crcOverride ?? crc32(data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(entry.externalAttrs ?? 0, 38)
    central.writeUInt32LE(offset, 42)

    locals.push(local, name, compressed)
    centrals.push(central, name)
    offset += 30 + name.length + compressed.length
  }

  const centralBuffer = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralBuffer.length, 12)
  eocd.writeUInt32LE(offset, 16)

  return Buffer.concat([...locals, centralBuffer, eocd])
}

describe('ZipArchive', () => {
  it('reads stored and deflated entries and verifies CRCs', () => {
    const archive = ZipArchive.open(
      buildZip([
        { name: 'a.txt', data: 'hello' },
        { name: 'dir/b.txt', data: 'hello hello hello', method: 8 },
      ]),
    )
    expect(archive.entries.map((entry) => entry.name)).toEqual(['a.txt', 'dir/b.txt'])
    expect(archive.read('a.txt').toString()).toBe('hello')
    expect(archive.read('dir/b.txt').toString()).toBe('hello hello hello')
  })

  it('rejects traversal, absolute paths, backslashes and reserved names', () => {
    for (const name of ['../evil.txt', '/abs.txt', 'a\\b.txt', 'C:/x.txt', 'aux.dll', 'foo.']) {
      expect(() => assertSafeEntryName(name)).toThrowError(/archive|path|windows|absolute|reserved/i)
    }
  })

  it('rejects traversal entries already at open time', () => {
    try {
      ZipArchive.open(buildZip([{ name: '../evil.txt', data: 'x' }]))
      throw new Error('expected ARCHIVE.UNSAFE_PATH')
    } catch (error) {
      expect((error as CoreError).code).toBe('ARCHIVE.UNSAFE_PATH')
    }
  })

  it('rejects symlinks, duplicates and encrypted entries', () => {
    const symlinkAttrs = (0o120777 << 16) >>> 0
    expect(() =>
      ZipArchive.open(buildZip([{ name: 'link', data: 'x', externalAttrs: symlinkAttrs }])),
    ).toThrowError(/symlink/)

    expect(() =>
      ZipArchive.open(
        buildZip([
          { name: 'same.txt', data: 'a' },
          { name: 'same.txt', data: 'b' },
        ]),
      ),
    ).toThrowError(/duplicate/)

    const encrypted = buildZip([{ name: 'x.txt', data: 'x' }])
    encrypted.writeUInt16LE(1, 6) // local flags: encrypted
    const centralOffset = encrypted.readUInt32LE(encrypted.length - 22 + 16)
    encrypted.writeUInt16LE(1, centralOffset + 8)
    expect(() => ZipArchive.open(encrypted)).toThrowError(/encrypted/)
  })

  it('rejects CRC mismatches', () => {
    const archive = ZipArchive.open(
      buildZip([{ name: 'a.txt', data: 'hello', crcOverride: 12345 }]),
    )
    expect(() => archive.read('a.txt')).toThrowError(/checksum/)
  })

  it('enforces entry and size limits', () => {
    const two = buildZip([
      { name: 'a', data: 'a' },
      { name: 'b', data: 'b' },
    ])
    expect(() => ZipArchive.open(two, { maxEntries: 1 })).toThrowError(/limit/i)

    const big = buildZip([{ name: 'a', data: 'abcdef' }])
    expect(() => ZipArchive.open(big, { maxEntrySize: 3 })).toThrowError(/larger than/i)
  })

  it('extracts files and skips excluded prefixes', () => {
    const root = tempRoot()
    const archive = ZipArchive.open(
      buildZip([
        { name: 'dir/a.dll', data: 'dll' },
        { name: 'META-INF/MANIFEST.MF', data: 'manifest' },
        { name: 'notes.txt', data: 'n' },
      ]),
    )
    const result = extractZip(nodeFsPort(), archive, root, {
      excludePrefixes: ['META-INF/'],
    })
    expect(result.written.sort()).toEqual(['dir/a.dll', 'notes.txt'])
    expect(fs.readFileSync(path.join(root, 'dir', 'a.dll'), 'utf8')).toBe('dll')
    expect(fs.existsSync(path.join(root, 'META-INF'))).toBe(false)
  })
})

describe('extractNatives', () => {
  it('extracts dlls, writes a marker and skips unchanged jars on relaunch', () => {
    const root = tempRoot()
    const jarPath = path.join(root, 'natives.jar')
    fs.writeFileSync(
      jarPath,
      buildZip([
        { name: 'lwjgl.dll', data: 'dll' },
        { name: 'glfw.dll', data: 'glfw' },
        { name: 'META-INF/MANIFEST.MF', data: 'meta' },
      ]),
    )
    const nativesDir = path.join(root, '1.20.1-natives')
    const plan: NativePlan = {
      nativesDir,
      sources: [{ library: 'org.lwjgl:lwjgl:3.3.1:natives-windows', jarPath, exclude: [] }],
      missing: [],
      warnings: [],
    }

    const first = extractNatives(plan, { fs: nodeFsPort() })
    expect(first.cacheHit).toBe(false)
    expect(first.extracted).toBe(2)
    expect(fs.existsSync(path.join(nativesDir, 'lwjgl.dll'))).toBe(true)
    expect(fs.existsSync(path.join(nativesDir, 'META-INF'))).toBe(false)
    expect(fs.existsSync(first.markerFile)).toBe(true)

    const second = extractNatives(plan, { fs: nodeFsPort() })
    expect(second.cacheHit).toBe(true)

    const forced = extractNatives(plan, { fs: nodeFsPort(), force: true })
    expect(forced.cacheHit).toBe(false)
    expect(forced.extracted).toBe(2)
  })

  it('rejects a non-zip native jar', () => {
    const root = tempRoot()
    const jarPath = path.join(root, 'bad.jar')
    fs.writeFileSync(jarPath, 'not a zip')
    const plan: NativePlan = {
      nativesDir: path.join(root, 'natives'),
      sources: [{ library: 'x:y:1:natives-windows', jarPath, exclude: [] }],
      missing: [],
      warnings: [],
    }
    expect(() => extractNatives(plan, { fs: nodeFsPort() })).toThrowError(/archive/i)
  })
})

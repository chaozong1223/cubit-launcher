import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { crc32 } from '../zip/reader'
import { nodeFsPort, type FsPort } from '../ports'
import { extractNatives, type NativePlan } from '../launch/natives'

const cleanup: string[] = []
afterEach(() => {
  for (const dir of cleanup.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcl-natives-'))
  cleanup.push(dir)
  return dir
}

/** Stored-only ZIP writer for the native jar fixture. */
function storedZip(name: string, data: Buffer): Buffer {
  const fileName = Buffer.from(name)
  const crc = crc32(data)
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4)
  local.writeUInt16LE(0, 6)
  local.writeUInt16LE(0, 8)
  local.writeUInt32LE(crc, 14)
  local.writeUInt32LE(data.length, 18)
  local.writeUInt32LE(data.length, 22)
  local.writeUInt16LE(fileName.length, 26)
  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(20, 4)
  central.writeUInt16LE(20, 6)
  central.writeUInt16LE(0, 8)
  central.writeUInt16LE(0, 10)
  central.writeUInt32LE(crc, 16)
  central.writeUInt32LE(data.length, 20)
  central.writeUInt32LE(data.length, 24)
  central.writeUInt16LE(fileName.length, 28)
  central.writeUInt32LE(0, 42)
  const centralSize = 46 + fileName.length
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(1, 8)
  eocd.writeUInt16LE(1, 10)
  eocd.writeUInt32LE(centralSize, 12)
  eocd.writeUInt32LE(30 + fileName.length + data.length, 16)
  return Buffer.concat([local, fileName, data, central, fileName, eocd])
}

describe('natives extraction fallback', () => {
  it('retries once then uses a unique suffixed directory when removal is EPERM', () => {
    const root = tempDir()
    const nativesDir = path.join(root, 'instance-natives')
    const jarPath = path.join(root, 'natives.jar')
    fs.writeFileSync(jarPath, storedZip('broken_dll.dll', Buffer.from('native-bytes')))
    const real = nodeFsPort()
    let removeCalls = 0
    const lockedFs: FsPort = {
      ...real,
      remove(target: string) {
        removeCalls += 1
        if (target.includes(nativesDir) && !target.includes(`${nativesDir}-`)) {
          const error = new Error('EPERM: operation not permitted') as Error & { code: string }
          error.code = 'EPERM'
          throw error
        }
        return real.remove(target)
      },
    }
    const plan: NativePlan = {
      nativesDir,
      sources: [{ library: 'org.example:native:1', jarPath, exclude: [] }],
      missing: [],
      warnings: [],
    }
    const result = extractNatives(plan, { fs: lockedFs, now: () => 123456 })
    expect(removeCalls).toBe(2)
    expect(result.fallback).toBe(true)
    expect(result.nativesDir).not.toBe(nativesDir)
    expect(result.nativesDir).toContain(`${nativesDir}-`)
    expect(fs.existsSync(path.join(result.nativesDir, 'broken_dll.dll'))).toBe(true)
    expect(fs.readFileSync(path.join(result.nativesDir, 'broken_dll.dll'), 'utf8')).toBe(
      'native-bytes',
    )
  })
})

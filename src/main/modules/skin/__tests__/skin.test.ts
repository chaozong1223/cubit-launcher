import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { skinContract } from '@shared/skin'
import type { ScopedLogger } from '../../../kernel/logger'
import { crc32 } from '../../../core/zip/reader'
import { makeHandlers } from '../handlers'
import { createSkinService, skinCacheRoot, type SkinService } from '../service'

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

function chunk(type: string, data: Buffer): Buffer {
  const typeBuffer = Buffer.from(type, 'ascii')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])))
  return Buffer.concat([length, typeBuffer, data, crc])
}

/** Real RGBA PNG of the requested dimensions (filter 0 rows, zlib IDAT). */
function makePng(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let row = 0; row < height; row += 1) {
    raw[row * (width * 4 + 1)] = 0 // filter
    for (let column = 0; column < width; column += 1) {
      const offset = row * (width * 4 + 1) + 1 + column * 4
      raw[offset] = (column * 4) % 256
      raw[offset + 1] = (row * 3) % 256
      raw[offset + 2] = 128
      raw[offset + 3] = 255
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

function writeFile(target: string, data: Buffer | string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, data)
}

interface Fixture {
  root: string
  dataRoot: string
  service: SkinService
  accounts: Set<string>
}

function fixture(
  options: {
    fetchImpl?: typeof fetch
    allowInsecureHosts?: string[]
    profileSkinUrl?: (id: string) => Promise<string | null>
    knownAccounts?: string[]
  } = {},
): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcl-skin-'))
  cleanup.push(root)
  const dataRoot = path.join(root, 'data')
  const accounts = new Set(options.knownAccounts ?? ['acc-a', 'acc-b'])
  const service = createSkinService({
    dataRoot,
    log: logger,
    now: () => 1_700_000_000_000,
    accountExists: (id) => accounts.has(id),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.allowInsecureHosts ? { allowInsecureHosts: options.allowInsecureHosts } : {}),
    ...(options.profileSkinUrl ? { profileSkinUrl: options.profileSkinUrl } : {}),
  })
  return { root, dataRoot, service, accounts }
}

function pngResponse(buffer: Buffer, contentType = 'image/png'): Response {
  return new Response(buffer, { status: 200, headers: { 'content-type': contentType } })
}

describe('skin PNG validation and per-account cache', () => {
  it('imports 64x64 and 64x32 PNGs and isolates accounts', async () => {
    const h = fixture()
    const file64 = path.join(h.root, 'wide.png')
    const file32 = path.join(h.root, 'legacy.png')
    writeFile(file64, makePng(64, 64))
    writeFile(file32, makePng(64, 32))

    const importedA = await h.service.importFile({ accountId: 'acc-a', filePath: file64 })
    expect(importedA).toMatchObject({ source: 'local', width: 64, height: 64, accountId: 'acc-a' })
    expect(importedA.dataUrl?.startsWith('data:image/png;base64,')).toBe(true)
    expect(skinContract.methods.importFile.output.safeParse(importedA).success).toBe(true)

    const importedB = await h.service.importFile({ accountId: 'acc-b', filePath: file32 })
    expect(importedB).toMatchObject({ source: 'local', width: 64, height: 32 })

    const getA = await h.service.get({ accountId: 'acc-a' })
    const getB = await h.service.get({ accountId: 'acc-b' })
    expect(getA.width).toBe(64)
    expect(getA.height).toBe(64)
    expect(getB.height).toBe(32)
    expect(getA.dataUrl).not.toBe(getB.dataUrl)
    expect(fs.existsSync(path.join(skinCacheRoot(h.dataRoot), 'acc-a', 'skin.png'))).toBe(true)
  })

  it('rejects wrong dimensions, corrupt PNGs, oversized files and unknown accounts', async () => {
    const h = fixture()
    const small = path.join(h.root, 'small.png')
    writeFile(small, makePng(32, 32))
    await expect(h.service.importFile({ accountId: 'acc-a', filePath: small })).rejects.toMatchObject({
      code: 'SKIN.INVALID_PNG',
    })

    const corrupt = path.join(h.root, 'corrupt.png')
    writeFile(corrupt, Buffer.from('not a png'))
    await expect(h.service.importFile({ accountId: 'acc-a', filePath: corrupt })).rejects.toMatchObject({
      code: 'SKIN.INVALID_PNG',
    })

    const huge = path.join(h.root, 'huge.png')
    writeFile(huge, Buffer.alloc(2 * 1024 * 1024 + 1))
    await expect(h.service.importFile({ accountId: 'acc-a', filePath: huge })).rejects.toMatchObject({
      code: 'SKIN.TOO_LARGE',
    })

    await expect(
      h.service.importFile({ accountId: 'missing', filePath: small }),
    ).rejects.toMatchObject({ code: 'SKIN.ACCOUNT_NOT_FOUND' })
    await expect(h.service.get({ accountId: 'acc-a' })).resolves.toMatchObject({ source: 'default' })
  })

  it('imports from a link, caches bytes for offline use and restores default', async () => {
    const png = makePng(64, 64)
    const requests: string[] = []
    const h = fixture({
      fetchImpl: async (input) => {
        requests.push(String(input))
        return pngResponse(png)
      },
    })
    const remote = await h.service.importUrl({
      accountId: 'acc-a',
      url: 'https://skins.example.test/steve.png',
    })
    expect(remote).toMatchObject({
      source: 'remote',
      width: 64,
      height: 64,
      remoteUrl: 'https://skins.example.test/steve.png',
    })
    expect(requests).toHaveLength(1)
    // Offline read uses the cached bytes.
    const cached = await h.service.get({ accountId: 'acc-a' })
    expect(cached.dataUrl).toBe(remote.dataUrl)

    const restored = await h.service.restore({ accountId: 'acc-a' })
    expect(restored).toMatchObject({ source: 'default', dataUrl: null })
    expect(fs.existsSync(path.join(skinCacheRoot(h.dataRoot), 'acc-a'))).toBe(false)
    expect((await h.service.get({ accountId: 'acc-b' })).source).toBe('default')
  })

  it('rejects unsafe URLs without making a request', async () => {
    let called = 0
    const h = fixture({
      fetchImpl: async () => {
        called += 1
        return pngResponse(makePng(64, 64))
      },
    })
    for (const url of [
      'http://skins.example.test/a.png',
      'https://localhost/a.png',
      'https://127.0.0.1/a.png',
      'https://user:pass@skins.example.test/a.png',
      'https://192.168.1.2/a.png',
    ]) {
      await expect(h.service.importUrl({ accountId: 'acc-a', url })).rejects.toMatchObject({
        code: 'SKIN.INVALID_URL',
      })
    }
    expect(called).toBe(0)
  })

  it('rejects a redirect to a local address (SSRF) without following it', async () => {
    let calls = 0
    const h = fixture({
      fetchImpl: async () => {
        calls += 1
        return new Response(null, {
          status: 302,
          headers: { location: 'http://127.0.0.1/private.png' },
        })
      },
    })
    await expect(
      h.service.importUrl({ accountId: 'acc-a', url: 'https://skins.example.test/a.png' }),
    ).rejects.toMatchObject({ code: 'SKIN.INVALID_URL' })
    expect(calls).toBe(1)
  })

  it('rejects a non-PNG URL response and oversized responses', async () => {
    const h = fixture({
      fetchImpl: async () => new Response('<html>nope</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    })
    await expect(
      h.service.importUrl({ accountId: 'acc-a', url: 'https://skins.example.test/a.png' }),
    ).rejects.toMatchObject({ code: 'SKIN.INVALID_PNG' })

    const big = fixture({
      fetchImpl: async () =>
        new Response(makePng(64, 64), {
          status: 200,
          headers: { 'content-type': 'image/png', 'content-length': String(3 * 1024 * 1024) },
        }),
    })
    await expect(
      big.service.importUrl({ accountId: 'acc-a', url: 'https://skins.example.test/a.png' }),
    ).rejects.toMatchObject({ code: 'SKIN.TOO_LARGE' })
  })

  it('imports the current account profile skin URL', async () => {
    const png = makePng(64, 32)
    const h = fixture({
      fetchImpl: async () => pngResponse(png),
      profileSkinUrl: async (id) => (id === 'acc-a' ? 'https://skins.example.test/a.png' : null),
    })
    const imported = await h.service.importFromAccount({ accountId: 'acc-a' })
    expect(imported).toMatchObject({ source: 'remote', width: 64, height: 32 })
    await expect(h.service.importFromAccount({ accountId: 'acc-b' })).rejects.toMatchObject({
      code: 'SKIN.NO_REMOTE_SKIN',
    })
  })

  it('exposes one handler per contract method', () => {
    const handlers = makeHandlers({} as unknown as SkinService) as Record<string, unknown>
    for (const method of Object.keys(skinContract.methods)) {
      expect(typeof handlers[method]).toBe('function')
    }
  })
})

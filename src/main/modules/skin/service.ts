import fsp from 'node:fs/promises'
import path from 'node:path'
import net from 'node:net'
import { lookup as dnsLookup } from 'node:dns/promises'
import { AppError } from '@shared/errors'
import type {
  SkinAccountInput,
  SkinImportFileInput,
  SkinImportUrlInput,
  SkinInfo,
} from '@shared/skin'
import type { ScopedLogger } from '../../kernel/logger'
import { isSupportedSkinSize, MAX_SKIN_BYTES, readPngInfo } from '../../core/skin/png'

/**
 * Per-account local skin cache.
 *
 * - bytes are validated as 64x64/64x32 PNG before they are written;
 * - files live under `dataRoot/modules/skin/accounts/<accountId>/`, so an
 *   account switch never sees another account's skin;
 * - importing from a link caches the bytes locally (offline-friendly) and never
 *   uploads anything to Microsoft/authlib.
 */

export interface SkinServiceOptions {
  dataRoot: string
  log: ScopedLogger
  now?: () => number
  fetchImpl?: typeof fetch
  /** Test seam; production uses the auth module. */
  accountExists?: (accountId: string) => boolean | Promise<boolean>
  profileSkinUrl?: (accountId: string) => Promise<string | null>
  allowInsecureHosts?: string[]
  timeoutMs?: number
  maxBytes?: number
  /** DNS resolver seam; production uses `dns.lookup(..., {all:true})`. */
  resolveHost?: (hostname: string) => Promise<string[]>
}

interface SkinMeta {
  accountId: string
  source: 'local' | 'remote'
  remoteUrl: string | null
  width: number
  height: number
  updatedAt: number
}

function invalid(message: string, details?: Record<string, unknown>): never {
  throw new AppError('SKIN.INVALID_PNG', message, { details })
}

function safeAccountKey(accountId: string): string {
  const clean = accountId.trim()
  if (!/^[A-Za-z0-9._:@-]{1,128}$/.test(clean) || clean === '.' || clean === '..') {
    throw new AppError('SKIN.INVALID_ACCOUNT', '账户 id 不合法')
  }
  return clean
}

function isPrivateAddress(address: string): boolean {
  const version = net.isIP(address)
  if (version === 4) {
    const parts = address.split('.').map((part) => Number(part))
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return true
    const [a, b, c] = parts
    if (a === 0 || a === 10 || a === 127) return true
    if (a === 169 && b === 254) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 100 && b >= 64 && b <= 127) return true
    if (a === 192 && b === 0 && (c === 0 || c === 2)) return true
    if (a === 198 && (b === 18 || b === 19)) return true
    if (a === 198 && b === 51 && c === 100) return true
    if (a === 203 && b === 0 && c === 113) return true
    if (a >= 224) return true
    return false
  }
  if (version === 6) {
    const normalized = address.toLowerCase()
    const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
    if (mapped) return isPrivateAddress(mapped[1])
    if (normalized === '::1' || normalized === '::') return true
    if (normalized.startsWith('fe80:') || normalized.startsWith('fc') || normalized.startsWith('fd')) {
      return true
    }
    if (normalized.startsWith('ff')) return true
    return false
  }
  return true
}

async function defaultResolveHost(hostname: string): Promise<string[]> {
  const addresses = await dnsLookup(hostname, { all: true, verbatim: true })
  return addresses.map((entry) => entry.address)
}

export class SkinService {
  private readonly log: ScopedLogger
  private readonly now: () => number
  private readonly fetchImpl: typeof fetch
  private readonly root: string
  private readonly timeoutMs: number
  private readonly maxBytes: number

  constructor(private readonly options: SkinServiceOptions) {
    this.log = options.log
    this.now = options.now ?? Date.now
    this.fetchImpl = options.fetchImpl ?? fetch
    this.root = path.join(options.dataRoot, 'modules', 'skin', 'accounts')
    this.timeoutMs = options.timeoutMs ?? 10_000
    this.maxBytes = Math.min(options.maxBytes ?? MAX_SKIN_BYTES, MAX_SKIN_BYTES)
  }

  private accountDir(accountId: string): string {
    return path.join(this.root, safeAccountKey(accountId))
  }

  private async assertAccount(accountId: string): Promise<void> {
    if (!this.options.accountExists) return
    const exists = await this.options.accountExists(accountId)
    if (!exists) {
      throw new AppError('SKIN.ACCOUNT_NOT_FOUND', '找不到这个账户，无法保存皮肤', {
        details: { accountId },
      })
    }
  }

  private validate(buffer: Buffer): { width: number; height: number } {
    if (buffer.length === 0) invalid('皮肤文件为空')
    if (buffer.length > this.maxBytes) {
      throw new AppError('SKIN.TOO_LARGE', `皮肤文件超过 ${Math.floor(this.maxBytes / 1024)} KB`)
    }
    const info = readPngInfo(buffer)
    if (!isSupportedSkinSize(info.width, info.height)) {
      invalid('皮肤尺寸必须是 64×64 或 64×32 的 PNG', {
        width: info.width,
        height: info.height,
      })
    }
    return { width: info.width, height: info.height }
  }

  private async write(accountId: string, buffer: Buffer, meta: SkinMeta): Promise<SkinInfo> {
    const dir = this.accountDir(accountId)
    await fsp.mkdir(dir, { recursive: true })
    const png = path.join(dir, 'skin.png')
    const tmp = `${png}.tmp-${process.pid}`
    await fsp.writeFile(tmp, buffer, { mode: 0o600 })
    await fsp.rename(tmp, png)
    await fsp.writeFile(path.join(dir, 'skin.json'), `${JSON.stringify(meta, null, 2)}\n`, {
      mode: 0o600,
    })
    this.log.info('local skin cached', {
      accountId,
      source: meta.source,
      width: meta.width,
      height: meta.height,
      bytes: buffer.length,
    })
    return {
      accountId,
      source: meta.source,
      dataUrl: `data:image/png;base64,${buffer.toString('base64')}`,
      width: meta.width,
      height: meta.height,
      updatedAt: meta.updatedAt,
      remoteUrl: meta.remoteUrl,
    }
  }

  async get(input: SkinAccountInput): Promise<SkinInfo> {
    const accountId = safeAccountKey(input.accountId)
    const dir = this.accountDir(accountId)
    try {
      const png = await fsp.readFile(path.join(dir, 'skin.png'))
      const raw = await fsp.readFile(path.join(dir, 'skin.json'), 'utf8')
      const meta = JSON.parse(raw) as SkinMeta
      const info = readPngInfo(png)
      if (!isSupportedSkinSize(info.width, info.height)) {
        return this.default(accountId)
      }
      return {
        accountId,
        source: meta.source === 'remote' ? 'remote' : 'local',
        dataUrl: `data:image/png;base64,${png.toString('base64')}`,
        width: info.width,
        height: info.height,
        updatedAt: typeof meta.updatedAt === 'number' ? meta.updatedAt : null,
        remoteUrl: typeof meta.remoteUrl === 'string' ? meta.remoteUrl : null,
      }
    } catch {
      return this.default(accountId)
    }
  }

  private default(accountId: string): SkinInfo {
    return {
      accountId,
      source: 'default',
      dataUrl: null,
      width: null,
      height: null,
      updatedAt: null,
      remoteUrl: null,
    }
  }

  async importFile(input: SkinImportFileInput): Promise<SkinInfo> {
    const accountId = safeAccountKey(input.accountId)
    await this.assertAccount(accountId)
    let buffer: Buffer
    try {
      const stat = await fsp.stat(input.filePath)
      if (!stat.isFile()) invalid('选择的路径不是文件')
      if (stat.size > this.maxBytes) {
        throw new AppError('SKIN.TOO_LARGE', `皮肤文件超过 ${Math.floor(this.maxBytes / 1024)} KB`)
      }
      buffer = await fsp.readFile(input.filePath)
    } catch (error) {
      if (error instanceof AppError) throw error
      throw new AppError('SKIN.FILE_NOT_FOUND', '找不到皮肤文件')
    }
    const size = this.validate(buffer)
    return this.write(accountId, buffer, {
      accountId,
      source: 'local',
      remoteUrl: null,
      ...size,
      updatedAt: this.now(),
    })
  }

  private validateUrl(raw: string): URL {
    let url: URL
    try {
      url = new URL(raw)
    } catch {
      throw new AppError('SKIN.INVALID_URL', '皮肤链接不合法')
    }
    const insecure = (this.options.allowInsecureHosts ?? []).map((host) => host.toLowerCase())
    const isHttps = url.protocol === 'https:'
    const isAllowedHttp = url.protocol === 'http:' && insecure.includes(url.hostname.toLowerCase())
    if (!isHttps && !isAllowedHttp) {
      throw new AppError('SKIN.INVALID_URL', '皮肤链接必须使用 HTTPS')
    }
    if (url.username || url.password) {
      throw new AppError('SKIN.INVALID_URL', '皮肤链接不能包含账号密码')
    }
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
    if (host === 'localhost' || host.endsWith('.localhost')) {
      throw new AppError('SKIN.INVALID_URL', '皮肤链接不能指向本机')
    }
    if (net.isIP(host) !== 0 && isPrivateAddress(host)) {
      throw new AppError('SKIN.INVALID_URL', '皮肤链接不能指向内网地址')
    }
    return url
  }

  private async assertPublicHost(url: URL): Promise<void> {
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
    if (net.isIP(hostname) !== 0) {
      if (isPrivateAddress(hostname)) {
        throw new AppError('SKIN.PRIVATE_ADDRESS', '皮肤链接指向内网/保留地址，已拒绝')
      }
      return
    }
    let addresses: string[]
    try {
      addresses = await (this.options.resolveHost ?? defaultResolveHost)(hostname)
    } catch {
      throw new AppError('SKIN.INVALID_URL', '无法解析皮肤链接的域名')
    }
    if (addresses.length === 0) {
      throw new AppError('SKIN.INVALID_URL', '皮肤链接的域名没有可用地址')
    }
    if (addresses.some((address) => isPrivateAddress(address))) {
      throw new AppError('SKIN.PRIVATE_ADDRESS', '皮肤链接解析到内网/保留地址，已拒绝')
    }
  }

  private async download(url: URL): Promise<Buffer> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      let current = url
      let response: Response | null = null
      for (let hop = 0; hop <= 5; hop += 1) {
        await this.assertPublicHost(current)
        const next = await this.fetchImpl(current, {
          method: 'GET',
          redirect: 'manual',
          headers: { accept: 'image/png' },
          signal: controller.signal,
        })
        if (next.status >= 300 && next.status < 400) {
          const location = next.headers.get('location')
          if (!location) throw new AppError('SKIN.DOWNLOAD_FAILED', '皮肤链接重定向缺少目标地址')
          const target = new URL(location, current)
          // Re-validate every redirect so a public URL cannot bounce to localhost.
          current = this.validateUrl(target.toString())
          continue
        }
        response = next
        break
      }
      if (!response) throw new AppError('SKIN.DOWNLOAD_FAILED', '皮肤链接重定向次数过多')
      if (response.status !== 200) {
        throw new AppError('SKIN.DOWNLOAD_FAILED', `皮肤链接返回 HTTP ${response.status}`)
      }
      const contentType = (response.headers.get('content-type') ?? '').toLowerCase()
      if (contentType && !contentType.includes('png') && !contentType.includes('octet-stream')) {
        throw new AppError('SKIN.INVALID_PNG', '链接返回的不是 PNG 图片')
      }
      const declared = Number(response.headers.get('content-length') ?? 0)
      if (declared > this.maxBytes) {
        throw new AppError('SKIN.TOO_LARGE', `皮肤文件超过 ${Math.floor(this.maxBytes / 1024)} KB`)
      }
      const chunks: Buffer[] = []
      let total = 0
      if (response.body) {
        const reader = response.body.getReader()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          total += value.byteLength
          if (total > this.maxBytes) {
            await reader.cancel().catch(() => undefined)
            throw new AppError('SKIN.TOO_LARGE', `皮肤文件超过 ${Math.floor(this.maxBytes / 1024)} KB`)
          }
          chunks.push(Buffer.from(value))
        }
      } else {
        const buffer = Buffer.from(await response.arrayBuffer())
        total = buffer.length
        chunks.push(buffer)
      }
      if (total === 0) throw new AppError('SKIN.DOWNLOAD_FAILED', '皮肤链接返回了空文件')
      return Buffer.concat(chunks)
    } catch (error) {
      if (error instanceof AppError) throw error
      if (controller.signal.aborted) throw new AppError('SKIN.DOWNLOAD_FAILED', '皮肤下载超时')
      throw new AppError('SKIN.DOWNLOAD_FAILED', '皮肤下载失败，请检查网络或链接')
    } finally {
      clearTimeout(timer)
    }
  }

  async importUrl(input: SkinImportUrlInput): Promise<SkinInfo> {
    const accountId = safeAccountKey(input.accountId)
    await this.assertAccount(accountId)
    const url = this.validateUrl(input.url)
    const buffer = await this.download(url)
    const size = this.validate(buffer)
    return this.write(accountId, buffer, {
      accountId,
      source: 'remote',
      remoteUrl: url.toString(),
      ...size,
      updatedAt: this.now(),
    })
  }

  async importFromAccount(input: SkinAccountInput): Promise<SkinInfo> {
    const accountId = safeAccountKey(input.accountId)
    await this.assertAccount(accountId)
    const skinUrl = this.options.profileSkinUrl ? await this.options.profileSkinUrl(accountId) : null
    if (!skinUrl) {
      throw new AppError('SKIN.NO_REMOTE_SKIN', '这个账户当前没有可导入的皮肤链接')
    }
    return this.importUrl({ accountId, url: skinUrl })
  }

  async restore(input: SkinAccountInput): Promise<SkinInfo> {
    const accountId = safeAccountKey(input.accountId)
    await this.assertAccount(accountId)
    try {
      await fsp.rm(this.accountDir(accountId), { recursive: true, force: true })
    } catch {
      /* already gone */
    }
    this.log.info('local skin restored to default', { accountId })
    return this.default(accountId)
  }
}

export function createSkinService(options: SkinServiceOptions): SkinService {
  return new SkinService(options)
}

/** Test/helper: directory holding per-account skin caches. */
export function skinCacheRoot(dataRoot: string): string {
  return path.join(dataRoot, 'modules', 'skin', 'accounts')
}

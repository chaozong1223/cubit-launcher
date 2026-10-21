import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { AppError } from '@shared/errors'

/**
 * Fixed authlib-injector release. Version, build and SHA-256 come from the
 * official `artifact/latest.json` (2026-07-11, v1.2.8 build 56). The hash is the
 * integrity boundary — never execute an unverified jar.
 */
export const AUTHLIB_VERSION = '1.2.8'
export const AUTHLIB_BUILD = 56
export const AUTHLIB_URL = `https://authlib-injector.yushi.moe/artifact/${AUTHLIB_BUILD}/authlib-injector-${AUTHLIB_VERSION}.jar`
export const AUTHLIB_SHA256 = '9c7f4343e6c82034958ffb48c14a2cb0c85928be7283103ce17da00c6d5a7b10'
export const AUTHLIB_SIZE = 349_681
const MAX_DOWNLOAD_BYTES = 5 * 1024 * 1024

export interface AuthlibInfo {
  version: string
  sha256: string
  jarPath: string
  downloaded: boolean
  server: string | null
}

export function authlibJarPath(dataRoot: string): string {
  return path.join(
    dataRoot,
    'java',
    'authlib-injector',
    `authlib-injector-${AUTHLIB_VERSION}.jar`,
  )
}

function sha256(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

function verifyFile(file: string, expectedSha256: string): boolean {
  try {
    const stat = fs.statSync(file)
    if (!stat.isFile() || stat.size > MAX_DOWNLOAD_BYTES) return false
    return sha256(fs.readFileSync(file)) === expectedSha256
  } catch {
    return false
  }
}

export function authlibInfo(dataRoot: string, server: string | null = null): AuthlibInfo {
  const jarPath = authlibJarPath(dataRoot)
  return {
    version: AUTHLIB_VERSION,
    sha256: AUTHLIB_SHA256,
    jarPath,
    downloaded: verifyFile(jarPath, AUTHLIB_SHA256),
    server,
  }
}

export interface EnsureAuthlibOptions {
  dataRoot: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
  /** Test seam: verify downloaded bytes against another digest. */
  expectedSha256?: string
}

/**
 * Downloads the fixed jar once, verifies SHA-256 and writes atomically. A bad
 * existing file is removed and re-downloaded; a bad download is never kept.
 */
export async function ensureAuthlibInjector(
  options: EnsureAuthlibOptions,
): Promise<AuthlibInfo> {
  const expected = options.expectedSha256 ?? AUTHLIB_SHA256
  const jarPath = authlibJarPath(options.dataRoot)
  fs.mkdirSync(path.dirname(jarPath), { recursive: true })

  if (verifyFile(jarPath, expected)) {
    return {
      version: AUTHLIB_VERSION,
      sha256: expected,
      jarPath,
      downloaded: false,
      server: null,
    }
  }
  if (fs.existsSync(jarPath)) {
    try {
      fs.rmSync(jarPath, { force: true })
    } catch {
      /* best effort */
    }
  }

  const fetchImpl = options.fetchImpl ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 120_000)
  let bytes: Buffer
  try {
    const response = await fetchImpl(AUTHLIB_URL, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'user-agent': 'mc-launcher/authlib-injector' },
    })
    if (!response.ok) {
      throw new AppError(
        'AUTHLIB.DOWNLOAD_FAILED',
        `authlib-injector 下载失败（HTTP ${response.status}）`,
        { retryable: true, details: { status: response.status, url: AUTHLIB_URL } },
      )
    }
    bytes = Buffer.from(await response.arrayBuffer())
  } catch (error) {
    if (error instanceof AppError) throw error
    throw new AppError('AUTHLIB.DOWNLOAD_FAILED', '无法下载 authlib-injector', {
      retryable: true,
      cause: error,
      details: { url: AUTHLIB_URL },
    })
  } finally {
    clearTimeout(timer)
  }

  if (bytes.length > MAX_DOWNLOAD_BYTES) {
    throw new AppError('AUTHLIB.INVALID', 'authlib-injector 文件超出大小限制', {
      details: { bytes: bytes.length },
    })
  }
  const actual = sha256(bytes)
  if (actual !== expected) {
    throw new AppError('AUTHLIB.HASH_MISMATCH', 'authlib-injector SHA-256 校验失败', {
      retryable: true,
      details: { expected, actual },
    })
  }

  const part = `${jarPath}.part`
  fs.writeFileSync(part, bytes)
  try {
    fs.renameSync(part, jarPath)
  } catch {
    fs.rmSync(jarPath, { force: true })
    fs.renameSync(part, jarPath)
  }

  return {
    version: AUTHLIB_VERSION,
    sha256: expected,
    jarPath,
    downloaded: true,
    server: null,
  }
}

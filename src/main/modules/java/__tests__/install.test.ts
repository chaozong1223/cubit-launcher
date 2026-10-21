import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { nodeFsPort } from '../../../core/ports'
import { JavaError } from '../core/errors'
import { JavaHttp } from '../core/http'
import { installJavaPackage, type JavaInstallProgressDelta } from '../core/install'
import { fakePorts, sha256, startServer, tempDir, type TestServer } from './support/harness'
import { fakeJdkZip, makeZip } from './support/zip'

let server: TestServer | null = null
let dataRoot = ''

beforeEach(async () => {
  dataRoot = tempDir('mcl-java-install-')
  server = await startServer()
})

afterEach(async () => {
  if (server) await server.close()
  fs.rmSync(dataRoot, { recursive: true, force: true })
  server = null
})

function http(): JavaHttp {
  return new JavaHttp({
    userAgent: 'mc-launcher/0.1.0 (+https://example.test; test@example.test)',
    allowInsecureHosts: ['127.0.0.1'],
  })
}

function pkg(zip: Buffer, patch: Record<string, unknown> = {}) {
  return {
    source: 'adoptium' as const,
    major: 17,
    version: '17.0.9+9',
    url: `${server!.baseUrl}/jdk.zip`,
    sha256: sha256(zip),
    size: zip.length,
    fileName: 'adoptium17.zip',
    ...patch,
  }
}

describe('installJavaPackage', () => {
  it('downloads, verifies, extracts, validates and moves into dataRoot/java', async () => {
    const zip = fakeJdkZip(17)
    server!.serveBytes('/jdk.zip', zip)
    const progress: JavaInstallProgressDelta[] = []
    const installed = await installJavaPackage({
      fs: nodeFsPort(),
      ports: fakePorts({ javaMajor: 17 }),
      http: http(),
      dataRoot,
      pkg: pkg(zip),
      platform: 'win32',
      onProgress: (delta) => progress.push(delta),
    })

    expect(installed).toMatchObject({
      major: 17,
      version: '17.0.9+9',
      vendor: 'adoptium',
      managedDir: 'adoptium-17-17.0.9+9',
    })
    expect(installed.path).toBe(
      path.join(dataRoot, 'java', 'adoptium-17-17.0.9+9', 'bin', 'java.exe'),
    )
    expect(fs.existsSync(installed.path)).toBe(true)
    expect(fs.readFileSync(installed.path, 'utf8')).toBe('fake-java-17')
    expect(progress.map((delta) => delta.stage)).toEqual(
      expect.arrayContaining(['download', 'verify', 'extract', 'validate']),
    )
    expect(progress.some((delta) => delta.stage === 'extract' && (delta.entriesTotal ?? 0) >= 5)).toBe(true)
    // Zip and temp extract dir are cleaned up.
    expect(fs.existsSync(path.join(dataRoot, 'modules/java/cache/adoptium17.zip.zip'))).toBe(false)
    const managedRoot = path.join(dataRoot, 'java')
    expect(fs.readdirSync(managedRoot).filter((name) => name.startsWith('.tmp-'))).toEqual([])
  })

  it('deletes the download and writes nothing when the SHA-256 differs', async () => {
    const zip = fakeJdkZip(17)
    server!.serveBytes('/jdk.zip', zip)
    await expect(
      installJavaPackage({
        fs: nodeFsPort(),
        ports: fakePorts({ javaMajor: 17 }),
        http: http(),
        dataRoot,
        pkg: pkg(zip, { sha256: 'a'.repeat(64) }),
        platform: 'win32',
      }),
    ).rejects.toMatchObject({ code: 'JAVA.HASH_MISMATCH' })
    expect(fs.existsSync(path.join(dataRoot, 'java', 'adoptium-17-17.0.9_9'))).toBe(false)
  })

  it('rejects a zip-slip entry and keeps the managed root clean', async () => {
    const zip = makeZip([
      { name: 'jdk/bin/java.exe', data: 'fake' },
      { name: '../evil.txt', data: 'evil' },
    ])
    server!.serveBytes('/jdk.zip', zip)
    await expect(
      installJavaPackage({
        fs: nodeFsPort(),
        ports: fakePorts({ javaMajor: 17 }),
        http: http(),
        dataRoot,
        pkg: pkg(zip),
        platform: 'win32',
      }),
    ).rejects.toMatchObject({ code: 'JAVA.ARCHIVE_UNSAFE' })
    expect(fs.existsSync(path.join(dataRoot, 'evil.txt'))).toBe(false)
    expect(fs.existsSync(path.join(dataRoot, 'java', 'adoptium-17-17.0.9_9'))).toBe(false)
  })

  it('rejects an archive without a Java executable', async () => {
    const zip = makeZip([{ name: 'jdk/README.txt', data: 'no java here' }])
    server!.serveBytes('/jdk.zip', zip)
    await expect(
      installJavaPackage({
        fs: nodeFsPort(),
        ports: fakePorts({ javaMajor: 17 }),
        http: http(),
        dataRoot,
        pkg: pkg(zip),
        platform: 'win32',
      }),
    ).rejects.toMatchObject({ code: 'JAVA.EXTRACT_FAILED' })
  })

  it('rejects a Java whose major does not match the package', async () => {
    const zip = fakeJdkZip(17)
    server!.serveBytes('/jdk.zip', zip)
    await expect(
      installJavaPackage({
        fs: nodeFsPort(),
        ports: fakePorts({ javaMajor: 21 }),
        http: http(),
        dataRoot,
        pkg: pkg(zip),
        platform: 'win32',
      }),
    ).rejects.toMatchObject({ code: 'JAVA.VALIDATE_FAILED' })
  })

  it('cancels an in-flight download and leaves no managed runtime', async () => {
    const zip = fakeJdkZip(17)
    server!.serveSlow('/jdk.zip', zip, 64, 15)
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 40)
    await expect(
      installJavaPackage({
        fs: nodeFsPort(),
        ports: fakePorts({ javaMajor: 17 }),
        http: http(),
        dataRoot,
        pkg: pkg(zip),
        platform: 'win32',
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: 'JAVA.CANCELLED' })
    expect(fs.existsSync(path.join(dataRoot, 'java', 'adoptium-17-17.0.9_9'))).toBe(false)
    const cache = path.join(dataRoot, 'modules/java/cache')
    expect(fs.existsSync(cache) ? fs.readdirSync(cache).filter((name) => name.endsWith('.part')) : []).toEqual([])
  })
})

describe('install errors remain readable', () => {
  it('wraps unsafe archive errors as JavaError', async () => {
    const zip = makeZip([{ name: 'C:evil', data: 'x' }])
    server!.serveBytes('/jdk.zip', zip)
    try {
      await installJavaPackage({
        fs: nodeFsPort(),
        ports: fakePorts(),
        http: http(),
        dataRoot,
        pkg: pkg(zip),
        platform: 'win32',
      })
      throw new Error('expected failure')
    } catch (error) {
      expect(error).toBeInstanceOf(JavaError)
      expect((error as JavaError).code).toBe('JAVA.ARCHIVE_UNSAFE')
    }
  })
})

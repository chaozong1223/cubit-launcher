import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { JavaCandidate, JavaDetectResult, JavaInstallFinished, JavaInstallProgress } from '@shared/java'
import { Logger } from '../../../kernel/logger'
import { nodeFsPort } from '../../../core/ports'
import { detectJava } from '../../../core/java/detect'
import { JavaHttp } from '../core/http'
import { createJavaProviders } from '../core/providers'
import { JavaModuleService } from '../service'
import {
  fakePorts,
  sha256,
  startServer,
  tempDir,
  writeInstanceJava,
  writeVersion,
  type TestServer,
} from './support/harness'
import { fakeJdkZip } from './support/zip'

interface Harness {
  service: JavaModuleService
  dataRoot: string
  mcRoot: string
  server: TestServer
  progress: JavaInstallProgress[]
  finished: JavaInstallFinished[]
}

let harness: Harness | null = null

function scanManaged(dataRoot: string, platform: 'win32' | 'linux' = 'win32'): JavaDetectResult {
  const root = path.join(dataRoot, 'java')
  const candidates: JavaCandidate[] = []
  const exe = platform === 'win32' ? 'java.exe' : 'java'
  const walk = (dir: string, depth: number): void => {
    if (depth > 3 || !fs.existsSync(dir)) return
    const direct = path.join(dir, 'bin', exe)
    if (fs.existsSync(direct)) {
      const match = /(?:adoptium|microsoft|jdk|java)[-_]?(\d+)/i.exec(direct)
      const major = match ? Number(match[1]) : 17
      candidates.push({
        path: direct,
        home: dir,
        source: 'launcher-runtime',
        version: { major, minor: 0, patch: 0, raw: `${major}.0.0` },
        vendor: 'Test JDK',
        arch: 'x64',
        bits: 64,
        probedAt: 1,
      })
      return
    }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(path.join(dir, entry.name), depth + 1)
    }
  }
  walk(root, 0)
  return {
    candidates,
    rejected: [],
    durationMs: 0,
    cached: false,
    scannedAt: Date.now(),
    sources: ['launcher-runtime'],
  }
}

async function setup(options: {
  detect?: () => Promise<JavaDetectResult>
  serverZip?: Buffer
  checksum?: string
  major?: number
} = {}): Promise<Harness> {
  const dataRoot = tempDir('mcl-java-svc-data-')
  const mcRoot = tempDir('mcl-java-svc-mc-')
  writeVersion(mcRoot, { id: '1.20.1', javaMajor: 17 })
  const server = await startServer()
  const zip = options.serverZip ?? fakeJdkZip(options.major ?? 22)
  server.serveBytes('/jdk.zip', zip)
  const major = options.major ?? 22
  server.serveJson(`/v3/assets/latest/${major}/hotspot`, [
    {
      release_name: `jdk-${major}.0.1+1`,
      binary: {
        os: 'windows',
        architecture: 'x64',
        image_type: 'jdk',
        package: {
          name: `OpenJDK${major}U-jdk_x64_windows_hotspot.zip`,
          link: `${server.baseUrl}/jdk.zip`,
          checksum: options.checksum ?? sha256(zip),
          size: zip.length,
        },
      },
    },
  ])
  const http = new JavaHttp({
    userAgent: 'mc-launcher/0.1.0 (+https://example.test; test@example.test)',
    allowInsecureHosts: ['127.0.0.1'],
  })
  const providers = createJavaProviders(http, {
    adoptiumApiBase: `${server.baseUrl}/v3/assets/latest`,
    microsoftBase: `${server.baseUrl}/download-jdk`,
  })
  const progress: JavaInstallProgress[] = []
  const finished: JavaInstallFinished[] = []
  const service = new JavaModuleService(
    { dataRoot, mcRoot },
    new Logger({ dataRoot, console: false }).child('module:java'),
    {
      fs: nodeFsPort(),
      ports: fakePorts(),
      http,
      providers,
      platform: 'win32',
      arch: 'x64',
      detectImpl: options.detect ?? (async () => scanManaged(dataRoot)),
    },
  )
  service.onEvent('installProgress', (payload) => progress.push(payload as JavaInstallProgress))
  service.onEvent('installFinished', (payload) => finished.push(payload as JavaInstallFinished))
  harness = { service, dataRoot, mcRoot, server, progress, finished }
  return harness
}

beforeEach(() => {
  harness = null
})

afterEach(async () => {
  if (harness) {
    harness.service.dispose()
    await harness.server.close()
    fs.rmSync(harness.dataRoot, { recursive: true, force: true })
    fs.rmSync(harness.mcRoot, { recursive: true, force: true })
  }
  harness = null
})

describe('Java service matching and overrides', () => {
  it('exposes requirement + match with an explanation', async () => {
    const h = await setup({
      detect: async () => ({
        candidates: [
          {
            path: 'C:\\Java\\jdk17\\bin\\java.exe',
            home: 'C:\\Java\\jdk17',
            source: 'manual',
            version: { major: 17, minor: 0, patch: 0, raw: '17.0.0' },
            vendor: 'Adoptium',
            arch: 'x64',
            bits: 64,
            probedAt: 1,
          },
        ],
        rejected: [],
        durationMs: 0,
        cached: false,
        scannedAt: Date.now(),
        sources: ['manual'],
      }),
    })
    const requirement = await h.service.requirement({ versionId: '1.20.1' })
    expect(requirement.requiredMajor).toBe(17)
    const match = await h.service.match({ versionId: '1.20.1' })
    expect(match.selected?.version.major).toBe(17)
    expect(match.reason.code).toBe('exact-match')
    expect(match.reason.text).toContain('Java 17')
  })

  it('applies the global default and lets the instance override it', async () => {
    const h = await setup({
      detect: async () => ({
        candidates: [
          {
            path: 'C:\\Java\\jdk17\\bin\\java.exe',
            home: 'C:\\Java\\jdk17',
            source: 'manual',
            version: { major: 17, minor: 0, patch: 0, raw: '17.0.0' },
            vendor: 'Adoptium',
            arch: 'x64',
            bits: 64,
            probedAt: 1,
          },
          {
            path: 'C:\\Java\\jdk21\\bin\\java.exe',
            home: 'C:\\Java\\jdk21',
            source: 'manual',
            version: { major: 21, minor: 0, patch: 0, raw: '21.0.0' },
            vendor: 'Adoptium',
            arch: 'x64',
            bits: 64,
            probedAt: 1,
          },
        ],
        rejected: [],
        durationMs: 0,
        cached: false,
        scannedAt: Date.now(),
        sources: ['manual'],
      }),
    })
    await h.service.updateSettings({ defaultJava: { mode: 'major', value: 21 } })
    const globalMatch = await h.service.match({ versionId: '1.20.1' })
    expect(globalMatch.scope).toBe('global')
    expect(globalMatch.selected?.version.major).toBe(21)

    writeInstanceJava(h.mcRoot, '1.20.1', { mode: 'major', value: 17 })
    const instanceMatch = await h.service.match({ versionId: '1.20.1' })
    expect(instanceMatch.scope).toBe('instance')
    expect(instanceMatch.selected?.version.major).toBe(17)
    expect(instanceMatch.reason.code).toBe('instance-major')
  })
})

describe('managed JDK download', () => {
  it('downloads Adoptium, verifies, extracts and auto-adds the runtime', async () => {
    const h = await setup({ major: 22 })
    const job = await h.service.download({ major: 22, source: 'adoptium' })
    expect(job).toMatchObject({ major: 22, source: 'adoptium' })
    const final = await h.service.waitForDownload(job.jobId)
    expect(final.state).toBe('done')
    expect(final.percent).toBe(100)

    const finished = h.finished.at(-1)
    const installedPath = finished?.path ?? ''
    expect(installedPath).toContain(path.join(h.dataRoot, 'java', 'adoptium-22-'))
    expect(installedPath.endsWith(path.join('bin', 'java.exe'))).toBe(true)
    expect(fs.existsSync(installedPath)).toBe(true)
    expect(finished).toMatchObject({
      ok: true,
      major: 22,
      path: installedPath,
      error: null,
    })
    const stages = new Set(h.progress.map((event) => event.stage))
    expect(stages.has('download')).toBe(true)
    expect(stages.has('extract')).toBe(true)
    expect(stages.has('validate')).toBe(true)

    const managed = await h.service.managed()
    expect(managed.some((entry) => entry.path === installedPath && entry.major === 22)).toBe(true)
    const detection = await h.service.detect({ force: true })
    expect(detection.candidates.some((candidate) => candidate.path === installedPath)).toBe(true)
  })

  it('fails readably on a checksum mismatch and does not pollute the list', async () => {
    const h = await setup({ major: 22, checksum: 'a'.repeat(64) })
    const before = await h.service.managed()
    const job = await h.service.download({ major: 22, source: 'adoptium' })
    const final = await h.service.waitForDownload(job.jobId)
    expect(final.state).toBe('failed')
    expect(h.finished.at(-1)?.error?.code).toBe('JAVA.HASH_MISMATCH')
    expect(fs.existsSync(path.join(h.dataRoot, 'java', 'adoptium-22-22.0.1_1'))).toBe(false)
    expect(await h.service.managed()).toEqual(before)
  })

  it('can be disabled in settings', async () => {
    const h = await setup()
    await h.service.updateSettings({ autoDownload: false })
    await expect(h.service.download({ major: 22, source: 'adoptium' })).rejects.toMatchObject({
      code: 'JAVA.DOWNLOAD_DISABLED',
    })
  })

  it('cancels a download and keeps the list unchanged', async () => {
    const h = await setup()
    // Replace the zip route with a slow one.
    h.server.serveSlow('/jdk.zip', fakeJdkZip(22), 32, 10)
    const before = await h.service.managed()
    const job = await h.service.download({ major: 22, source: 'adoptium' })
    await h.service.cancelDownload(job.jobId)
    const final = await h.service.waitForDownload(job.jobId)
    expect(final.state).toBe('cancelled')
    expect(h.finished.at(-1)?.error?.code).toBe('JAVA.CANCELLED')
    expect(await h.service.managed()).toEqual(before)
  })

  it('rejects a duplicate major unless forced', async () => {
    const h = await setup({ major: 22 })
    const job = await h.service.download({ major: 22, source: 'adoptium' })
    await h.service.waitForDownload(job.jobId)
    await expect(h.service.download({ major: 22, source: 'adoptium' })).rejects.toMatchObject({
      code: 'JAVA.ALREADY_INSTALLED',
    })
  })
})

describe('t6 detector sees managed runtimes automatically', () => {
  it('scans dataRoot/java as launcher-runtime and probes the executable', async () => {
    const dataRoot = tempDir('mcl-java-detect-')
    const home = path.join(dataRoot, 'java', 'adoptium-17-17.0.9_9')
    fs.mkdirSync(path.join(home, 'bin'), { recursive: true })
    fs.writeFileSync(path.join(home, 'bin', 'java.exe'), Buffer.from('fake'))
    try {
      const detection = await detectJava({
        fs: nodeFsPort(),
        ports: fakePorts({ javaMajor: 17 }),
        dataRoot,
        mcRoot: null,
        platform: 'win32',
        arch: 'x64',
      })
      const found = detection.candidates.find(
        (candidate) => candidate.path === path.join(home, 'bin', 'java.exe'),
      )
      expect(found).toBeTruthy()
      expect(found?.source).toBe('launcher-runtime')
      expect(found?.version.major).toBe(17)
    } finally {
      fs.rmSync(dataRoot, { recursive: true, force: true })
    }
  })
})

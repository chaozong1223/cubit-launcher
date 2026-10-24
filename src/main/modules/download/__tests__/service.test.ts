import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DownloadFinished, DownloadProgress, DownloadTask } from '@shared/download'
import { Logger } from '../../../kernel/logger'
import { HttpClient } from '../core/http'
import { acquireJobLock } from '../core/fs-atomic'
import { defaultDownloadSettings, moduleLockFile, saveDownloadSettings } from '../core/settings'
import { createSourceRegistry } from '../core/sources'
import { DownloadService } from '../service'
import { sha1, startTestHttpServer, type TestHttpServer } from './support/http-server'

/**
 * End-to-end install chain against a local Mojang-shaped mirror:
 * manifest → version JSON → client jar → libraries → logging → asset index →
 * asset objects, with real SHA1 checks, atomic writes, progress events,
 * repair and resume. This is the t8 acceptance evidence.
 */

interface Harness {
  server: TestHttpServer
  dataRoot: string
  mcRoot: string
  service: DownloadService
  fixtures: Fixtures
  progress: DownloadProgress[]
  finished: DownloadFinished[]
}

interface Fixtures {
  manifestText: string
  versionText: string
  indexText: string
  files: {
    client: Buffer
    logging: Buffer
    libA: Buffer
    libB: Buffer
    native: Buffer
    asset1: Buffer
    asset2: Buffer
  }
}

let harness: Harness | null = null

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function jsonFile(body: unknown): string {
  return `${JSON.stringify(body, null, 2)}\n`
}

function buildFixtures(server: TestHttpServer): Fixtures {
  const files = {
    client: Buffer.from('client-jar-bytes-'.repeat(32)),
    logging: Buffer.from('<?xml version="1.0"?><Configuration/>'),
    libA: Buffer.from('library-a-bytes'.repeat(10)),
    libB: Buffer.from('library-b-bytes'.repeat(10)),
    native: Buffer.from('natives-windows-dll-bytes'.repeat(10)),
    asset1: Buffer.from('icon-bytes'.repeat(20)),
    asset2: Buffer.from('lang-bytes'.repeat(10)),
  }
  const hash = (buffer: Buffer) => sha1(buffer)

  const assetObjects = {
    'icons/icon_128x128.png': { hash: hash(files.asset1), size: files.asset1.length },
    'lang/zh_cn.lang': { hash: hash(files.asset2), size: files.asset2.length },
  }
  const indexText = jsonFile({ objects: assetObjects })

  const version = {
    id: '1.20.1',
    type: 'release',
    mainClass: 'net.minecraft.client.main.Main',
    assets: '5',
    assetIndex: {
      id: '5',
      sha1: hash(Buffer.from(indexText)),
      size: Buffer.byteLength(indexText),
      totalSize: files.asset1.length + files.asset2.length,
      url: `${server.baseUrl}/indexes/5.json`,
    },
    downloads: {
      client: {
        sha1: hash(files.client),
        size: files.client.length,
        url: `${server.baseUrl}/client.bin`,
      },
    },
    logging: {
      client: {
        argument: '-Dlog4j.configurationFile=${path}',
        file: {
          id: 'client-1.12.xml',
          sha1: hash(files.logging),
          size: files.logging.length,
          url: `${server.baseUrl}/logging.xml`,
        },
      },
    },
    javaVersion: { component: 'java-runtime-beta', majorVersion: 17 },
    libraries: [
      {
        name: 'com.mojang:logging:1.1.1',
        downloads: {
          artifact: {
            path: 'com/mojang/logging/1.1.1/logging-1.1.1.jar',
            sha1: hash(files.libA),
            size: files.libA.length,
            url: `${server.baseUrl}/libs/libA.jar`,
          },
        },
      },
      {
        name: 'org.lwjgl:lwjgl:3.3.1',
        downloads: {
          artifact: {
            path: 'org/lwjgl/lwjgl/3.3.1/lwjgl-3.3.1.jar',
            sha1: hash(files.libB),
            size: files.libB.length,
            url: `${server.baseUrl}/libs/libB.jar`,
          },
        },
      },
      {
        name: 'org.lwjgl:lwjgl:3.3.1:natives-windows',
        rules: [{ action: 'allow', os: { name: 'windows' } }],
        downloads: {
          artifact: {
            path: 'org/lwjgl/lwjgl/3.3.1/lwjgl-3.3.1-natives-windows.jar',
            sha1: hash(files.native),
            size: files.native.length,
            url: `${server.baseUrl}/libs/native.jar`,
          },
        },
      },
    ],
  }
  const versionText = jsonFile(version)
  const manifestText = jsonFile({
    latest: { release: '1.20.1', snapshot: '24w14a' },
    versions: [
      {
        id: '1.20.1',
        type: 'release',
        url: `${server.baseUrl}/versions/1.20.1.json`,
        sha1: hash(Buffer.from(versionText)),
        releaseTime: '2023-06-12T13:25:51+00:00',
      },
    ],
  })

  return { manifestText, versionText, indexText, files }
}

function serveFixtures(server: TestHttpServer, fixtures: Fixtures, options: { chunkDelayMs?: number; chunkSize?: number } = {}) {
  const chunk = { chunkDelayMs: options.chunkDelayMs ?? 0, chunkSize: options.chunkSize ?? 0 }
  const opts = chunk.chunkSize > 0 ? chunk : {}
  server.serve('/manifest.json', fixtures.manifestText, opts)
  server.serve('/versions/1.20.1.json', fixtures.versionText, opts)
  server.serve('/indexes/5.json', fixtures.indexText, opts)
  server.serve('/client.bin', fixtures.files.client, opts)
  server.serve('/logging.xml', fixtures.files.logging, opts)
  server.serve('/libs/libA.jar', fixtures.files.libA, opts)
  server.serve('/libs/libB.jar', fixtures.files.libB, opts)
  server.serve('/libs/native.jar', fixtures.files.native, opts)
  for (const [name, buffer] of Object.entries({
    [`${sha1(fixtures.files.asset1).slice(0, 2)}/${sha1(fixtures.files.asset1)}`]: fixtures.files.asset1,
    [`${sha1(fixtures.files.asset2).slice(0, 2)}/${sha1(fixtures.files.asset2)}`]: fixtures.files.asset2,
  })) {
    server.serve(`/assets/${name}`, buffer, opts)
  }
}

async function setup(options: { chunkDelayMs?: number; chunkSize?: number } = {}): Promise<Harness> {
  const server = await startTestHttpServer()
  const dataRoot = tempDir('mcl-svc-data-')
  const mcRoot = tempDir('mcl-svc-mc-')
  const fixtures = buildFixtures(server)
  serveFixtures(server, fixtures, options)
  // Keep the harness deterministic: these tests assert on intermediate progress
  // and cancellation timing, so they pin the low-concurrency profile instead of
  // following the (much faster) shipping defaults.
  await saveDownloadSettings(dataRoot, {
    ...defaultDownloadSettings('0.1.0'),
    concurrency: 4,
    perHostConcurrency: 2,
  })

  const log = new Logger({ dataRoot, console: false })
  const http = new HttpClient({
    userAgent: 'mc-launcher/0.1.0 (+https://example.test; test@example.test)',
    allowInsecureHosts: ['127.0.0.1'],
  })
  const sources = createSourceRegistry({
    preference: 'official',
    mirrorEnabled: false,
    allowInsecureHosts: ['127.0.0.1'],
  })
  const service = new DownloadService({
    roots: { dataRoot, mcRoot },
    log: log.child('module:download'),
    appVersion: '0.1.0',
    http,
    sources,
    manifestUrls: {
      official: `${server.baseUrl}/manifest.json`,
      mirror: `${server.baseUrl}/manifest.json`,
    },
    assetBaseUrl: `${server.baseUrl}/assets`,
    freeSpace: async () => 50 * 1024 * 1024 * 1024,
  })

  const progress: DownloadProgress[] = []
  const finished: DownloadFinished[] = []
  service.onProgress((event) => progress.push(event))
  service.onFinished((event) => finished.push(event))

  harness = { server, dataRoot, mcRoot, service, fixtures, progress, finished }
  return harness
}

function read(root: string, rel: string): Buffer {
  return fs.readFileSync(path.join(root, rel))
}

function collectParts(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(absolute)
      else if (entry.name.endsWith('.part')) out.push(absolute)
    }
  }
  if (fs.existsSync(root)) walk(root)
  return out
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

describe('install chain end-to-end', () => {
  it('parses the manifest, writes the version JSON and downloads every file with SHA1', async () => {
    const h = await setup()
    const result = await h.service.install({ versionId: '1.20.1' })
    const final = await h.service.waitForJob(result.jobId)
    await new Promise((resolve) => setImmediate(resolve))

    expect(final.state).toBe('done')
    expect(result.plan.files).toBe(7)
    expect(result.plan.missingFiles).toBe(7)

    // Version JSON lands byte-identical (manifest sha1 already verified).
    expect(read(h.mcRoot, 'versions/1.20.1/1.20.1.json').toString()).toBe(h.fixtures.versionText)
    expect(read(h.mcRoot, 'assets/indexes/5.json').toString()).toBe(h.fixtures.indexText)
    expect(sha1(read(h.mcRoot, 'versions/1.20.1/1.20.1.jar'))).toBe(sha1(h.fixtures.files.client))
    expect(sha1(read(h.mcRoot, 'libraries/com/mojang/logging/1.1.1/logging-1.1.1.jar'))).toBe(
      sha1(h.fixtures.files.libA),
    )
    expect(
      sha1(read(h.mcRoot, 'libraries/org/lwjgl/lwjgl/3.3.1/lwjgl-3.3.1-natives-windows.jar')),
    ).toBe(sha1(h.fixtures.files.native))
    expect(read(h.mcRoot, 'assets/log_configs/client-1.12.xml')).toEqual(h.fixtures.files.logging)
    expect(read(h.mcRoot, `assets/objects/${sha1(h.fixtures.files.asset1).slice(0, 2)}/${sha1(h.fixtures.files.asset1)}`)).toEqual(
      h.fixtures.files.asset1,
    )
    expect(collectParts(h.mcRoot)).toEqual([])

    // Progress: stages, file/byte counters, current file and speed are present.
    expect(h.progress.length).toBeGreaterThan(3)
    const stages = new Set(h.progress.map((event) => event.stage))
    expect(stages.has('manifest')).toBe(true)
    expect(stages.has('version-json')).toBe(true)
    expect(stages.has('assets-index')).toBe(true)
    expect(stages.has('client') || stages.has('libraries') || stages.has('assets')).toBe(true)
    const last = h.progress[h.progress.length - 1]
    expect(last.state).toBe('done')
    expect(last.total).toBe(9) // 7 files + version JSON + asset index
    expect(last.done).toBe(9)
    expect(last.bytesTotal).toBeGreaterThan(0)
    expect(last.bytesPerSec).toBeGreaterThanOrEqual(0)
    expect(h.progress.some((event) => typeof event.bytesPerSec === 'number')).toBe(true)

    expect(h.finished).toHaveLength(1)
    expect(h.finished[0]).toMatchObject({ jobId: result.jobId, ok: true, downloaded: 7 })
  })

  it('re-running install skips every completed file without a request', async () => {
    const h = await setup()
    const first = await h.service.install({ versionId: '1.20.1' })
    await h.service.waitForJob(first.jobId)
    h.server.reset()

    const plan = await h.service.plan({ versionId: '1.20.1' })
    expect(plan.missingFiles).toBe(0)

    const second = await h.service.install({ versionId: '1.20.1' })
    const final = await h.service.waitForJob(second.jobId)
    await new Promise((resolve) => setImmediate(resolve))

    expect(final.state).toBe('done')
    expect(h.finished.at(-1)).toMatchObject({ ok: true, downloaded: 0, skipped: 7 })
    expect(h.server.requests).toHaveLength(0)
  })

  it('repairs a corrupted library and reports one missing file (negative case 3)', async () => {
    const h = await setup()
    const first = await h.service.install({ versionId: '1.20.1' })
    await h.service.waitForJob(first.jobId)

    const damaged = path.join(h.mcRoot, 'libraries/com/mojang/logging/1.1.1/logging-1.1.1.jar')
    fs.writeFileSync(damaged, Buffer.alloc(10, 9))
    h.server.reset()

    const plan = await h.service.plan({ versionId: '1.20.1' })
    expect(plan.missingFiles).toBe(1)

    const repair = await h.service.repair({ versionId: '1.20.1' })
    const final = await h.service.waitForJob(repair.jobId)
    await new Promise((resolve) => setImmediate(resolve))

    expect(final.state).toBe('done')
    expect(repair.missingFiles).toBe(1)
    expect(fs.readFileSync(damaged)).toEqual(h.fixtures.files.libA)
    expect(h.server.countRequests('/libs/libA.jar')).toBe(1)
    expect(h.server.requests).toHaveLength(1)
  })

  it('resumes after a cancel without re-downloading completed files', async () => {
    const h = await setup({ chunkDelayMs: 20, chunkSize: 40 })
    const first = await h.service.install({ versionId: '1.20.1' })

    // The plan starts with the client jar, but the smaller libraries finish
    // first, so `done >= 4` does not imply any of the files asserted below
    // exists (under full-suite load all four completions can be tiny metadata
    // files). Wait for the two library jars this test inspects; logging/assets
    // tasks still follow them, so the job is still cancellable.
    const watched = [
      'versions/1.20.1/1.20.1.jar',
      'libraries/com/mojang/logging/1.1.1/logging-1.1.1.jar',
      'libraries/org/lwjgl/lwjgl/3.3.1/lwjgl-3.3.1.jar',
    ]
    const completedOnDisk = (): Set<string> => {
      const done = new Set<string>()
      for (const rel of watched) {
        if (fs.existsSync(path.join(h.mcRoot, rel))) done.add(rel)
      }
      return done
    }
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      // Higher default concurrency completes files in bursts, so also wait for
      // an intermediate progress event with a current file before cancelling;
      // otherwise the assertion below races a job that never reported one.
      const sawCurrentFile = h.progress.some((event) => event.currentFile !== null)
      if (completedOnDisk().size >= 2 && sawCurrentFile) break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    await h.service.cancel(first.jobId)
    const cancelled = await h.service.waitForJob(first.jobId)
    await new Promise((resolve) => setImmediate(resolve))
    expect(cancelled.state).toBe('cancelled')
    expect(collectParts(h.mcRoot)).toEqual([])
    // A slow job emits intermediate progress with the current file and speed.
    expect(h.progress.some((event) => event.currentFile !== null)).toBe(true)
    expect(h.progress.some((event) => event.state === 'running')).toBe(true)

    const completed = completedOnDisk()
    expect(completed.size).toBeGreaterThan(0)

    h.server.reset()
    const plan2 = await h.service.plan({ versionId: '1.20.1' })
    expect(plan2.missingFiles).toBeLessThan(7)

    const second = await h.service.install({ versionId: '1.20.1' })
    const final = await h.service.waitForJob(second.jobId)
    await new Promise((resolve) => setImmediate(resolve))

    expect(final.state).toBe('done')
    if (completed.has('libraries/com/mojang/logging/1.1.1/logging-1.1.1.jar')) {
      expect(h.server.countRequests('/libs/libA.jar')).toBe(0)
    }
    if (completed.has('versions/1.20.1/1.20.1.jar')) {
      expect(h.server.countRequests('/client.bin')).toBe(0)
    }
    expect(sha1(read(h.mcRoot, 'versions/1.20.1/1.20.1.jar'))).toBe(sha1(h.fixtures.files.client))
    expect(collectParts(h.mcRoot)).toEqual([])
  })

  it('rejects a non-existent version without creating its folder (negative case 4)', async () => {
    const h = await setup()
    await expect(h.service.install({ versionId: '1.20.1-does-not-exist' })).rejects.toMatchObject({
      code: 'DOWNLOAD.VERSION_NOT_FOUND',
    })
    expect(fs.existsSync(path.join(h.mcRoot, 'versions', '1.20.1-does-not-exist'))).toBe(false)
    expect(fs.existsSync(path.join(h.mcRoot, 'versions', '1.20.1'))).toBe(false)
  })

  it('honours the download-disabled compliance switch (MC-19)', async () => {
    const h = await setup()
    await h.service.updateSettings({ downloadEnabled: false })
    await expect(h.service.install({ versionId: '1.20.1' })).rejects.toMatchObject({
      code: 'DOWNLOAD.DISABLED',
    })
    expect(h.server.requests).toHaveLength(0)
  })

  it('reports the mirrored source choice and provider availability', async () => {
    const h = await setup()
    const sources = h.service.listSources()
    expect(sources.sources.map((source) => source.id)).toEqual(['mirror', 'official'])
    expect(sources.sources[0].displayName).toBe('BMCLAPI（bangbang93）')
    expect(sources.downloadEnabled).toBe(true)

    expect(h.service.listProviders().map((provider) => provider.id)).toEqual([
      'modrinth',
      'curseforge',
    ])
    await expect(h.service.projectPage({ provider: 'curseforge', project: 'jei' })).resolves.toEqual({
      url: 'https://www.curseforge.com/minecraft/mc-mods/jei',
    })
  })

  it('plans without writing anything to the game directory', async () => {
    const h = await setup()
    const plan = await h.service.plan({ versionId: '1.20.1' })
    expect(plan.files).toBe(7)
    expect(plan.missingFiles).toBe(7)
    expect(fs.existsSync(path.join(h.mcRoot, 'versions'))).toBe(false)
    expect(fs.existsSync(path.join(h.mcRoot, 'assets'))).toBe(false)
  })

  it('serializes batch loader downloads with the install lock and dedupes tasks (H6)', async () => {
    const h = await setup()
    const body = Buffer.from('loader library batch')
    h.server.serve('/batch.jar', body)
    const download: DownloadTask = {
      id: 'batch-1',
      url: `${h.server.baseUrl}/batch.jar`,
      destRel: 'libraries/batch.jar',
      sha1: sha1(body),
      size: body.length,
      priority: 5,
      sourceHint: 'auto',
      unverified: false,
    }

    const lock = await acquireJobLock(moduleLockFile(h.dataRoot, h.mcRoot))
    const blocked = await h.service.enqueue([download])
    const blockedState = await h.service.waitForJob(blocked.jobId)
    expect(blockedState.state).toBe('failed')
    expect(blockedState.message).toContain('另一个安装任务')
    await lock.release()

    const deduped = await h.service.enqueue([download, { ...download }])
    const final = await h.service.waitForJob(deduped.jobId)
    expect(deduped.total).toBe(1)
    expect(final.state).toBe('done')
    expect(h.server.countRequests('/batch.jar')).toBe(1)
    expect(fs.readFileSync(path.join(h.mcRoot, 'libraries/batch.jar'))).toEqual(body)
  })
})

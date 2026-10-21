import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DownloadProgress } from '@shared/download'
import type { LoaderFinished, LoaderLogEvent, LoaderProgress } from '@shared/loader'
import { Logger } from '../../../kernel/logger'
import { nodeFsPort } from '../../../core/ports'
import { resolveVersion } from '../../../core/version/load'
import { LoaderHttp } from '../core/http'
import { LoaderService, type LoaderLibraryDownloader } from '../service'
import {
  fabricProfile,
  fakeDownloader,
  localEndpoints,
  quiltProfile,
  startServer,
  tempDir,
  writeVanilla,
  type TestServer,
} from './support/harness'

interface Harness {
  local: TestServer
  service: LoaderService
  mcRoot: string
  dataRoot: string
  downloader: ReturnType<typeof fakeDownloader>
  progress: LoaderProgress[]
  logs: LoaderLogEvent[]
  finished: LoaderFinished[]
}

let harness: Harness | null = null

const FABRIC_LIST = JSON.stringify([
  { loader: { version: '0.16.10', stable: true } },
  { loader: { version: '0.17.0-beta.1', stable: false } },
])
const QUILT_LIST = JSON.stringify([
  { loader: { version: '0.24.0', stable: true } },
  { loader: { version: '0.26.0-beta.1', stable: false } },
])

async function setup(options: {
  downloader?: LoaderLibraryDownloader
  mcVersion?: string
  writeParent?: boolean
} = {}): Promise<Harness> {
  const local = await startServer()
  const dataRoot = tempDir('mcl-loader-svc-data-')
  const mcRoot = tempDir('mcl-loader-svc-mc-')
  if (options.writeParent !== false) writeVanilla(mcRoot, options.mcVersion ?? '1.20.1')
  const http = new LoaderHttp({
    userAgent: 'mc-launcher/0.1.0 (+https://example.test; test@example.test)',
    allowInsecureHosts: ['127.0.0.1'],
  })
  const downloader = fakeDownloader()
  const progress: LoaderProgress[] = []
  const logs: LoaderLogEvent[] = []
  const finished: LoaderFinished[] = []
  const service = new LoaderService({
    roots: { dataRoot, mcRoot },
    log: new Logger({ dataRoot, console: false }).child('module:loader'),
    appVersion: '0.1.0',
    http,
    endpoints: localEndpoints(local),
    fs: nodeFsPort(),
    ports: undefined,
    download: options.downloader ?? downloader,
    events: {
      onProgress: (event) => progress.push(event),
      onLog: (event) => logs.push(event),
      onFinished: (event) => finished.push(event),
    },
  })
  harness = { local, service, mcRoot, dataRoot, downloader, progress, logs, finished }
  return harness
}

function serveFabric(local: TestServer, loader = '0.16.10'): void {
  local.serveText('/fabric-meta/v2/versions/loader/1.20.1', FABRIC_LIST)
  local.serveText(
    `/fabric-meta/v2/versions/loader/1.20.1/${loader}/profile/json`,
    JSON.stringify(fabricProfile(loader)),
  )
}

function serveQuilt(local: TestServer, loader = '0.24.0'): void {
  local.serveText('/quilt-meta/v3/versions/loader/1.20.1', QUILT_LIST)
  local.serveText(
    `/quilt-meta/v3/versions/loader/1.20.1/${loader}/profile/json`,
    JSON.stringify(quiltProfile(loader)),
  )
}

beforeEach(() => {
  harness = null
})

afterEach(async () => {
  if (harness) {
    harness.service.dispose()
    await harness.local.close()
    fs.rmSync(harness.dataRoot, { recursive: true, force: true })
    fs.rmSync(harness.mcRoot, { recursive: true, force: true })
  }
  harness = null
})

describe('Fabric/Quilt install (meta JSON, no installer)', () => {
  it('installs Fabric, downloads its libraries and verifies + dry-runs', async () => {
    const h = await setup()
    serveFabric(h.local)

    const result = await h.service.install({ type: 'fabric', mcVersion: '1.20.1' })
    const final = await h.service.waitForJob(result.jobId)

    expect(final.state).toBe('done')
    expect(final.versionId).toBe('fabric-loader-0.16.10-1.20.1')
    expect(h.finished.at(-1)?.ok).toBe(true)
    expect(fs.existsSync(path.join(h.mcRoot, 'versions/fabric-loader-0.16.10-1.20.1/fabric-loader-0.16.10-1.20.1.json'))).toBe(true)

    // Libraries were handed to the download module with hashes and mirror URLs.
    expect(h.downloader.tasks).toHaveLength(2)
    expect(h.downloader.tasks[0]).toMatchObject({
      destRel: 'libraries/org/ow2/asm/asm/9.6/asm-9.6.jar',
      mirrorUrl: 'https://bmclapi2.bangbang93.com/maven/org/ow2/asm/asm/9.6/asm-9.6.jar',
      sha1: '1'.repeat(40),
      size: 120000,
    })

    // t6 can merge the chain.
    const resolved = resolveVersion(nodeFsPort(), h.mcRoot, final.versionId!)
    expect(resolved.chainIds).toEqual(['1.20.1', 'fabric-loader-0.16.10-1.20.1'])
    expect(resolved.loader.type).toBe('fabric')
    expect(resolved.json.mainClass).toBe('net.fabricmc.loader.impl.launch.knot.KnotClient')

    const verify = await h.service.verify({ versionId: final.versionId! })
    expect(verify).toMatchObject({
      chain: ['1.20.1', 'fabric-loader-0.16.10-1.20.1'],
      mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotClient',
      loader: { type: 'fabric', version: '0.16.10' },
      javaMajor: 17,
    })

    const dryRun = await h.service.dryRun({ versionId: final.versionId! })
    expect(dryRun.hasPlaceholders).toBe(false)
    expect(dryRun.argv).toContain('net.fabricmc.loader.impl.launch.knot.KnotClient')
    expect(dryRun.argv.join(' ')).toContain('asm-9.6.jar')
    expect(dryRun.classpathCount).toBeGreaterThanOrEqual(3)

    expect(h.progress.some((event) => event.stage === 'download')).toBe(true)
    expect(h.progress.some((event) => event.stage === 'install')).toBe(true)
    expect(h.progress.some((event) => event.stage === 'verify')).toBe(true)
    expect(h.progress.at(-1)?.state).toBe('done')
  })

  it('installs Quilt from the official v3 meta', async () => {
    const h = await setup()
    serveQuilt(h.local)
    const result = await h.service.install({ type: 'quilt', mcVersion: '1.20.1' })
    const final = await h.service.waitForJob(result.jobId)
    expect(final.state).toBe('done')
    expect(final.versionId).toBe('quilt-loader-0.24.0-1.20.1')
    const verify = await h.service.verify({ versionId: final.versionId! })
    expect(verify.loader.type).toBe('quilt')
    expect(verify.mainClass).toBe('org.quiltmc.loader.impl.launch.knot.KnotClient')
    expect(h.downloader.tasks[0].mirrorUrl).toBe(
      'https://bmclapi2.bangbang93.com/maven/org/quiltmc/quilt-loader/0.24.0/quilt-loader-0.24.0.jar',
    )
  })

  it('refuses to install when the vanilla parent is missing', async () => {
    const h = await setup({ writeParent: false })
    serveFabric(h.local)
    await expect(h.service.install({ type: 'fabric', mcVersion: '1.20.1' })).rejects.toMatchObject({
      code: 'LOADER.PARENT_MISSING',
    })
    expect(h.service.listJobs()).toHaveLength(0)
    expect(fs.existsSync(path.join(h.mcRoot, 'versions'))).toBe(false)
  })

  it('fails the job and writes no version JSON when library download fails', async () => {
    const h = await setup({ downloader: fakeDownloader({ fail: true, message: 'library boom' }) })
    serveFabric(h.local)
    const result = await h.service.install({ type: 'fabric', mcVersion: '1.20.1' })
    const final = await h.service.waitForJob(result.jobId)
    expect(final.state).toBe('failed')
    expect(h.finished.at(-1)?.error?.code).toBe('LOADER.LIBRARIES_FAILED')
    expect(
      fs.existsSync(path.join(h.mcRoot, 'versions/fabric-loader-0.16.10-1.20.1')),
    ).toBe(false)
  })
})

describe('progress and log events', () => {
  it('reports preparing/download/install/verify/done stages', async () => {
    const h = await setup()
    serveFabric(h.local)
    const result = await h.service.install({ type: 'fabric', mcVersion: '1.20.1' })
    await h.service.waitForJob(result.jobId)
    const stages = h.progress.map((event) => event.stage)
    expect(stages).toContain('prepare')
    expect(stages).toContain('download')
    expect(stages).toContain('install')
    expect(stages).toContain('verify')
    expect(stages).toContain('done')
    expect(h.progress.some((event) => event.currentTask !== null)).toBe(true)
  })
})

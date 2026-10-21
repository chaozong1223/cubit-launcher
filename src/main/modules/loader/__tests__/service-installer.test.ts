import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { LoaderFinished, LoaderLogEvent, LoaderProgress } from '@shared/loader'
import { Logger } from '../../../kernel/logger'
import { nodeFsPort } from '../../../core/ports'
import { LoaderHttp } from '../core/http'
import { LoaderService } from '../service'
import {
  fakeDownloader,
  fakePorts,
  localEndpoints,
  simulateForgeInstaller,
  startServer,
  tempDir,
  writeVanilla,
  type FakePorts,
  type SpawnScript,
  type TestServer,
} from './support/harness'

interface Harness {
  local: TestServer
  service: LoaderService
  ports: FakePorts
  mcRoot: string
  dataRoot: string
  installerBytes: Buffer
  progress: LoaderProgress[]
  logs: LoaderLogEvent[]
  finished: LoaderFinished[]
}

let harness: Harness | null = null

const FORGE_LIST_HASH = '2bdc0e68530daf0af01cae44a05e7f84849bdc6e'

function sha1(bytes: Buffer | string): string {
  return createHash('sha1').update(bytes).digest('hex')
}

async function setup(options: {
  script: SpawnScript
  listHash?: string | null
  officialHash?: string | null
  installerBytes?: Buffer
  installerTimeoutMs?: number
  javaMajor?: number
  profilesBefore?: string | null
  neo?: boolean
}): Promise<Harness> {
  const local = await startServer()
  const dataRoot = tempDir('mcl-loader-inst-data-')
  const mcRoot = tempDir('mcl-loader-inst-mc-')
  writeVanilla(mcRoot)
  if (options.profilesBefore !== null) {
    fs.writeFileSync(
      path.join(mcRoot, 'launcher_profiles.json'),
      options.profilesBefore ?? '{"profiles":{"keep":true},"settings":{},"version":3}',
    )
  }
  const installerBytes = options.installerBytes ?? Buffer.from('fake-forge-installer-jar-bytes')
  const installerHash = sha1(installerBytes)

  if (options.neo) {
    local.serveText(
      '/neoforge/1.20.1',
      JSON.stringify([{ rawVersion: '1.20.1-47.1.106', version: '47.1.106', mcversion: '1.20.1' }]),
    )
    local.serveBytes(
      '/official-maven/net/neoforged/forge/1.20.1-47.1.106/forge-1.20.1-47.1.106-installer.jar',
      installerBytes,
    )
    local.serveBytes(
      '/mirror-maven/net/neoforged/forge/1.20.1-47.1.106/forge-1.20.1-47.1.106-installer.jar',
      installerBytes,
    )
  } else {
    local.serveText(
      '/forge/1.20.1',
      JSON.stringify([
        {
          version: '47.2.0',
          mcversion: '1.20.1',
          build: 4702,
          files: [
            {
              format: 'jar',
              category: 'installer',
              hash: options.listHash === null ? undefined : (options.listHash ?? installerHash),
            },
          ],
        },
      ]),
    )
    local.serveBytes(
      '/official-maven/net/minecraftforge/forge/1.20.1-47.2.0/forge-1.20.1-47.2.0-installer.jar',
      installerBytes,
    )
    local.serveBytes(
      '/mirror-maven/net/minecraftforge/forge/1.20.1-47.2.0/forge-1.20.1-47.2.0-installer.jar',
      installerBytes,
    )
    if (options.officialHash !== null) {
      local.serveText(
        '/official-maven/net/minecraftforge/forge/1.20.1-47.2.0/forge-1.20.1-47.2.0-installer.jar.sha1',
        options.officialHash ?? `${installerHash}\n`,
      )
    }
  }

  const http = new LoaderHttp({
    userAgent: 'mc-launcher/0.1.0 (+https://example.test; test@example.test)',
    allowInsecureHosts: ['127.0.0.1'],
  })
  const ports = fakePorts({ script: options.script })
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
    ports,
    download: fakeDownloader(),
    javaResolver: async () => ({
      path: 'C:/fake/java/bin/java.exe',
      major: options.javaMajor ?? 17,
      warnings: [],
    }),
    ...(options.installerTimeoutMs ? { installerTimeoutMs: options.installerTimeoutMs } : {}),
    events: {
      onProgress: (event) => progress.push(event),
      onLog: (event) => logs.push(event),
      onFinished: (event) => finished.push(event),
    },
  })
  harness = {
    local,
    service,
    ports,
    mcRoot,
    dataRoot,
    installerBytes,
    progress,
    logs,
    finished,
  }
  return harness
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

describe('Forge installer install', () => {
  it('downloads the installer, runs java --installClient, verifies and dry-runs', async () => {
    const h = await setup({
      script: (child) => simulateForgeInstaller(child, { mcRoot: harness!.mcRoot }),
    })
    const plan = await h.service.plan({ type: 'forge', mcVersion: '1.20.1' })
    expect(plan.installer?.sha1).toBe(sha1(h.installerBytes))
    expect(plan.parentInstalled).toBe(true)

    const result = await h.service.install({
      type: 'forge',
      mcVersion: '1.20.1',
      confirmSha1: plan.installer!.sha1!,
    })
    const final = await h.service.waitForJob(result.jobId)

    expect(final.state).toBe('done')
    expect(final.versionId).toBe('1.20.1-forge-47.2.0')
    expect(h.finished.at(-1)?.ok).toBe(true)
    expect(
      fs.existsSync(path.join(h.mcRoot, 'versions/1.20.1-forge-47.2.0/1.20.1-forge-47.2.0.json')),
    ).toBe(true)

    // Installer argv + cwd follow SEC-EXE-05/-06.
    expect(h.ports.spawned).toHaveLength(1)
    const spawned = h.ports.spawned[0]
    expect(spawned.file).toBe('C:/fake/java/bin/java.exe')
    expect(spawned.args).toEqual([
      '-Djava.awt.headless=true',
      '-jar',
      path.join(
        h.dataRoot,
        'modules/loader/cache/installers/forge-1.20.1-47.2.0-installer.jar',
      ),
      '--installClient',
      h.mcRoot,
    ])
    expect(spawned.options?.cwd).toContain('loader-')
    expect(spawned.options?.cwd).not.toBe(h.mcRoot)

    // Installer cached, temp dir removed.
    expect(
      fs.existsSync(
        path.join(h.dataRoot, 'modules/loader/cache/installers/forge-1.20.1-47.2.0-installer.jar'),
      ),
    ).toBe(true)
    const tmpDir = path.join(h.dataRoot, 'tmp')
    expect(fs.existsSync(tmpDir) ? fs.readdirSync(tmpDir).filter((n) => n.startsWith('loader-')) : []).toEqual([])

    // t6 merge + full dry-run argv.
    const verify = await h.service.verify({ versionId: final.versionId! })
    expect(verify.loader.type).toBe('forge')
    expect(verify.mainClass).toBe('cpw.mods.bootstraplauncher.BootstrapLauncher')
    expect(verify.chain).toEqual(['1.20.1', '1.20.1-forge-47.2.0'])
    const dryRun = await h.service.dryRun({ versionId: final.versionId! })
    expect(dryRun.hasPlaceholders).toBe(false)
    expect(dryRun.argv).toContain('cpw.mods.bootstraplauncher.BootstrapLauncher')
    expect(dryRun.argv.join(' ')).toContain('--version')

    // Installer output was parsed into progress and batched log events.
    expect(h.progress.some((event) => event.stage === 'install')).toBe(true)
    expect(h.logs.some((event) => event.lines.join('\n').includes('Downloading 18 libraries'))).toBe(true)
    expect(h.logs.some((event) => event.lines.join('\n').includes('Analyzing 1.20.1'))).toBe(true)
    expect(h.logs.some((event) => event.lines.includes('Done'))).toBe(true)
  })

  it('requires the confirmation sha1 (SEC-EXE-05)', async () => {
    const h = await setup({
      script: (child) => simulateForgeInstaller(child, { mcRoot: harness!.mcRoot }),
    })
    const plan = await h.service.plan({ type: 'forge', mcVersion: '1.20.1' })
    await expect(
      h.service.install({ type: 'forge', mcVersion: '1.20.1' }),
    ).rejects.toMatchObject({ code: 'LOADER.CONFIRMATION_MISMATCH' })
    await expect(
      h.service.install({
        type: 'forge',
        mcVersion: '1.20.1',
        confirmSha1: 'a'.repeat(40),
      }),
    ).rejects.toMatchObject({ code: 'LOADER.CONFIRMATION_MISMATCH' })
    expect(plan.installer?.sha1).not.toBe('a'.repeat(40))
    expect(h.ports.spawned).toHaveLength(0)
  })

  it('rejects Java older than required before spawning the installer', async () => {
    const h = await setup({
      script: (child) => simulateForgeInstaller(child, { mcRoot: harness!.mcRoot }),
      javaMajor: 16,
    })
    const plan = await h.service.plan({ type: 'forge', mcVersion: '1.20.1' })
    await expect(
      h.service.install({
        type: 'forge',
        mcVersion: '1.20.1',
        confirmSha1: plan.installer!.sha1!,
      }),
    ).rejects.toMatchObject({ code: 'LOADER.JAVA_TOO_OLD' })
    expect(h.ports.spawned).toHaveLength(0)
  })

  it('rolls back the version directory and restores launcher_profiles.json on non-zero exit', async () => {
    const originalProfiles = '{"profiles":{"keep":true},"settings":{},"version":3}'
    const h = await setup({
      script: (child) =>
        simulateForgeInstaller(child, {
          mcRoot: harness!.mcRoot,
          exitCode: 3,
        }),
      profilesBefore: originalProfiles,
    })
    const plan = await h.service.plan({ type: 'forge', mcVersion: '1.20.1' })
    const result = await h.service.install({
      type: 'forge',
      mcVersion: '1.20.1',
      confirmSha1: plan.installer!.sha1!,
    })
    const final = await h.service.waitForJob(result.jobId)

    expect(final.state).toBe('failed')
    expect(h.finished.at(-1)?.error?.code).toBe('LOADER.INSTALLER_FAILED')
    expect(fs.existsSync(path.join(h.mcRoot, 'versions/1.20.1-forge-47.2.0'))).toBe(false)
    expect(fs.readFileSync(path.join(h.mcRoot, 'launcher_profiles.json'), 'utf8')).toBe(originalProfiles)
    const tmpDir = path.join(h.dataRoot, 'tmp')
    expect(fs.existsSync(tmpDir) ? fs.readdirSync(tmpDir).filter((n) => n.startsWith('loader-')) : []).toEqual([])
  })

  it('fails with PRODUCT_MISSING when the installer writes no version JSON', async () => {
    const h = await setup({
      script: (child) => simulateForgeInstaller(child, { mcRoot: harness!.mcRoot, writeVersion: false }),
    })
    const plan = await h.service.plan({ type: 'forge', mcVersion: '1.20.1' })
    const result = await h.service.install({
      type: 'forge',
      mcVersion: '1.20.1',
      confirmSha1: plan.installer!.sha1!,
    })
    const final = await h.service.waitForJob(result.jobId)
    expect(final.state).toBe('failed')
    expect(h.finished.at(-1)?.error?.code).toBe('LOADER.PRODUCT_MISSING')
    expect(fs.existsSync(path.join(h.mcRoot, 'versions/1.20.1-forge-47.2.0'))).toBe(false)
  })

  it('stops on an installer hash mismatch without executing anything', async () => {
    const badHash = 'a'.repeat(40)
    const h = await setup({
      script: (child) => simulateForgeInstaller(child, { mcRoot: harness!.mcRoot }),
      listHash: badHash,
      officialHash: badHash,
    })
    const plan = await h.service.plan({ type: 'forge', mcVersion: '1.20.1' })
    expect(plan.installer?.sha1).toBe(badHash)
    const result = await h.service.install({
      type: 'forge',
      mcVersion: '1.20.1',
      confirmSha1: badHash,
    })
    const final = await h.service.waitForJob(result.jobId)
    expect(final.state).toBe('failed')
    expect(h.finished.at(-1)?.error?.code).toBe('LOADER.INSTALLER_HASH_MISMATCH')
    expect(h.ports.spawned).toHaveLength(0)
    expect(fs.existsSync(path.join(h.mcRoot, 'versions/1.20.1-forge-47.2.0'))).toBe(false)
  })
})

describe('NeoForge install without an upstream hash', () => {
  it('refuses without explicit consent and succeeds with it', async () => {
    const h = await setup({
      script: (child) =>
        simulateForgeInstaller(child, {
          mcRoot: harness!.mcRoot,
          loaderType: 'neoforge',
          dirName: '1.20.1-neoforge-47.1.106',
        }),
      neo: true,
    })
    const plan = await h.service.plan({ type: 'neoforge', mcVersion: '1.20.1' })
    expect(plan.installer?.sha1).toBeNull()
    expect(plan.installer?.hashSource).toBe('none')

    await expect(
      h.service.install({ type: 'neoforge', mcVersion: '1.20.1' }),
    ).rejects.toMatchObject({ code: 'LOADER.INSTALLER_HASH_UNAVAILABLE' })

    const result = await h.service.install({
      type: 'neoforge',
      mcVersion: '1.20.1',
      allowUnverifiedInstaller: true,
    })
    const final = await h.service.waitForJob(result.jobId)
    expect(final.state).toBe('done')
    expect(final.versionId).toBe('1.20.1-neoforge-47.1.106')
    const verify = await h.service.verify({ versionId: final.versionId! })
    expect(verify.loader.type).toBe('neoforge')
  })
})

describe('cancellation and timeout', () => {
  it('cancels a running installer and cleans up', async () => {
    const h = await setup({
      script: () => undefined,
      profilesBefore: '{"profiles":{"keep":true},"settings":{},"version":3}',
    })
    const plan = await h.service.plan({ type: 'forge', mcVersion: '1.20.1' })
    const result = await h.service.install({
      type: 'forge',
      mcVersion: '1.20.1',
      confirmSha1: plan.installer!.sha1!,
    })
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      const status = h.service.status(result.jobId)
      if (status?.state === 'installing') break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    await h.service.cancel(result.jobId)
    const final = await h.service.waitForJob(result.jobId)
    expect(final.state).toBe('cancelled')
    expect(h.finished.at(-1)?.error?.code).toBe('LOADER.CANCELLED')
    expect(h.ports.spawned[0].args).toContain('--installClient')
    expect(fs.readFileSync(path.join(h.mcRoot, 'launcher_profiles.json'), 'utf8')).toContain('keep')
  })

  it('times out and rolls back', async () => {
    const h = await setup({ script: () => undefined, installerTimeoutMs: 60 })
    const plan = await h.service.plan({ type: 'forge', mcVersion: '1.20.1' })
    const result = await h.service.install({
      type: 'forge',
      mcVersion: '1.20.1',
      confirmSha1: plan.installer!.sha1!,
    })
    const final = await h.service.waitForJob(result.jobId)
    expect(final.state).toBe('failed')
    expect(h.finished.at(-1)?.error?.code).toBe('LOADER.INSTALLER_TIMEOUT')
  })
})

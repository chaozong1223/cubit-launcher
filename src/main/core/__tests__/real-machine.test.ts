import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { nodeFsPort, nodeProcessPort } from '../ports'
import { scanVersionDirs } from '../version/scan'
import { inspectVersion } from '../version/inspect'
import { resolveVersion } from '../version/load'
import { scanInstances, findInstance } from '../instance/scan'
import { buildLaunchPlan } from '../launch/args'
import { writeLaunchArtifacts } from '../launch/artifacts'
import { detectJava } from '../java/detect'
import { chooseJava } from '../java/select'
import { LaunchOrchestrator } from '../launch/orchestrator'
import { basePaths, offlineAccount } from '../__tests__/helpers'

/**
 * Read-only acceptance evidence against the real local `.minecraft`.
 * Skipped by default; run with:
 *   $env:MCL_REAL_MC='E:\MC\.minecraft'; $env:MCL_REAL_JAVA='1'; npm.cmd run test
 *
 * This test never writes to the Minecraft directory.
 */
const REAL_MC = process.env.MCL_REAL_MC

describe.skipIf(!REAL_MC)('real .minecraft (read-only)', () => {
  const mcRoot = REAL_MC ?? ''
  const fsPort = nodeFsPort()
  const tempDirs: string[] = []

  afterAll(() => {
    for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true })
  })

  function tempDataRoot(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcl-real-'))
    tempDirs.push(dir)
    return dir
  }

  it('scans 15 instance folders with 12 ready and 3 missing JSON', () => {
    const entries = scanVersionDirs(fsPort, mcRoot)
    expect(entries).toHaveLength(15)
    expect(entries.filter((entry) => entry.state === 'ready')).toHaveLength(12)
    expect(entries.filter((entry) => entry.state === 'missing-json')).toHaveLength(3)
    for (const entry of entries.filter((item) => item.state === 'ready')) {
      expect(entry.clientJarExists).toBe(true)
      expect(fs.existsSync(entry.clientJar as string)).toBe(true)
    }
  })

  it('inspects 1.20.1 with the documented exact values', () => {
    const inspection = inspectVersion(fsPort, mcRoot, '1.20.1')
    expect(inspection.id).toBe('1.20.1')
    expect(inspection.state).toBe('ready')
    expect(inspection.mainClass).toBe('net.minecraft.client.main.Main')
    expect(inspection.mcVersion).toBe('1.20.1')
    expect(inspection.javaMajor).toBe(17)
    expect(inspection.libraries.total).toBe(88)
    expect(inspection.libraries.allowed).toBe(64)
    expect(inspection.libraries.natives).toBe(21)
    expect(inspection.libraries.nativesExtract).toBe(7)
    expect(inspection.libraries.classpath).toBe(44)
    expect(inspection.assetIndex).toEqual({ id: '5', totalSize: 650564794 })
    expect(inspection.chain).toEqual(['1.20.1'])
    expect(inspection.flattened).toBe(true)
    expect(inspection.directories.versionDir).toBe(path.join(mcRoot, 'versions', '1.20.1'))
  })

  it('lists all 15 instances and resolves 1.20.1 by id', () => {
    const instances = scanInstances(fsPort, mcRoot)
    expect(instances).toHaveLength(15)
    const target = findInstance(fsPort, mcRoot, '1.20.1')
    expect(target?.state).toBe('ready')
    expect(target?.mcVersion).toBe('1.20.1')
    expect(target?.javaMajor).toBe(17)
  })

  it('builds the P0-1 acceptance command line (A1.7) and dry-run artifacts', () => {
    const resolved = resolveVersion(fsPort, mcRoot, '1.20.1')
    const paths = basePaths(mcRoot, '1.20.1')
    const plan = buildLaunchPlan({
      version: resolved.json,
      versionName: '1.20.1',
      mcVersion: resolved.mcVersion,
      account: offlineAccount(),
      paths,
      settings: {
        javaPath: 'D:\\tools\\jdk21\\jdk-21.0.12.1+1\\bin\\java.exe',
        javaMajor: 17,
        minMemoryMb: 1024,
        maxMemoryMb: 4096,
        width: 1280,
        height: 720,
        fullscreen: false,
        extraJvmArgs: [],
        server: null,
        authlib: null,
        codePage: 936,
        launcherName: 'mc-launcher',
        launcherVersion: '0.1.0',
      },
      platform: 'win32',
      arch: 'x64',
      exists: (target) => fsPort.exists(target),
      dryRun: true,
      sessionId: 'real-dry-run',
    })

    expect(plan.argv).toContain('net.minecraft.client.main.Main')
    expect(plan.argv[plan.argv.indexOf('--username') + 1]).toBe('TestUser')
    expect(plan.argv[plan.argv.indexOf('--uuid') + 1]).toBe(
      '097d3392-865a-3f3c-8b4a-da1c3473466c',
    )
    expect(plan.argv[plan.argv.indexOf('--accessToken') + 1]).toBe('0')
    expect(plan.argv[plan.argv.indexOf('--userType') + 1]).toBe('legacy')
    expect(plan.argv[plan.argv.indexOf('--version') + 1]).toBe('1.20.1')
    expect(plan.argv[plan.argv.indexOf('--gameDir') + 1]).toBe(
      path.join(mcRoot, 'versions', '1.20.1'),
    )
    expect(plan.argv[plan.argv.indexOf('--assetsDir') + 1]).toBe(
      path.join(mcRoot, 'assets'),
    )
    expect(plan.argv[plan.argv.indexOf('--assetIndex') + 1]).toBe('5')
    expect(plan.argv.filter((token) => token.startsWith('-Xmx'))).toHaveLength(1)
    expect(plan.argv.some((token) => token.includes('${'))).toBe(false)
    expect(plan.argv).not.toContain('--clientId')
    expect(plan.argv).not.toContain('--xuid')
    expect(plan.warnings).toHaveLength(0)

    const classpath = plan.argv[plan.argv.indexOf('-cp') + 1]
    expect(classpath.split(';')).toHaveLength(44)
    for (const key of [
      '-Djava.library.path=',
      '-Djna.tmpdir=',
      '-Dorg.lwjgl.system.SharedLibraryExtractPath=',
      '-Dio.netty.native.workdir=',
    ]) {
      expect(plan.argv.find((token) => token.startsWith(key))).toContain('1.20.1-natives')
    }

    const dataRoot = tempDataRoot()
    const files = writeLaunchArtifacts({
      dataRoot,
      plan,
      account: offlineAccount(),
      mainClass: 'net.minecraft.client.main.Main',
      instanceId: '1.20.1',
      versionName: '1.20.1',
      loader: { type: 'vanilla', version: null },
      javaVersion: '17.0.15',
      memory: { minMb: 1024, maxMb: 4096 },
      codePage: 936,
      dryRun: true,
      secrets: ['0'],
    })
    expect(fs.existsSync(files.dryRunFile as string)).toBe(true)
    const bat = fs.readFileSync(files.launchLastBat, 'utf8')
    expect(bat).toContain('chcp 936')
    expect(bat).toContain('--username TestUser')
    expect(bat).toContain('--accessToken 0')
  })

  it('parses the flattened NeoForge profile in the real folder', () => {
    const resolved = resolveVersion(fsPort, mcRoot, '1.21.1-NeoForge_21.1.233')
    expect(resolved.loader).toEqual({ type: 'neoforge', version: '21.1.233' })
    expect(resolved.mcVersion).toBe('1.21.1')
    expect(resolved.chainIds).toEqual(['1.21.1-NeoForge_21.1.233'])
    expect(resolved.json.libraries?.length).toBeGreaterThan(100)
  })

  it('orchestrator dry-run selects Java 17 and writes dry-run.json', async () => {
    const dataRoot = tempDataRoot()
    const orchestrator = new LaunchOrchestrator({
      dataRoot,
      mcRoot,
      appVersion: '0.1.0',
      resolveAccount: async () => offlineAccount(),
    })
    const plan = await orchestrator.plan({
      instanceId: '1.20.1',
      accountId: 'offline-test',
      dryRun: true,
    })

    expect(plan.dryRun).toBe(true)
    expect(plan.javaMajor).toBe(17)
    expect(plan.versionId).toBe('1.20.1')
    expect(plan.argv).toContain('net.minecraft.client.main.Main')
    expect(plan.argv[plan.argv.indexOf('--username') + 1]).toBe('TestUser')
    expect(fs.existsSync(path.join(dataRoot, 'logs', 'dry-run.json'))).toBe(true)
    expect(fs.existsSync(path.join(dataRoot, 'logs', 'launch-last.bat'))).toBe(true)
    expect(orchestrator.status('1.20.1').state).toBe('idle')
  }, 60_000)
})

describe.skipIf(!REAL_MC || !process.env.MCL_REAL_JAVA)('real Java detection', () => {
  it('finds the Mojang runtimes and JDK21 and chooses Java 17 for 1.20.1', async () => {
    const result = await detectJava({
      ports: nodeProcessPort(),
      dataRoot: path.join(os.tmpdir(), 'mcl-real-data'),
      mcRoot: REAL_MC,
      appDataDir: process.env.APPDATA ?? null,
      exeDir: process.cwd(),
    })
    const majors = result.candidates.map((candidate) => candidate.version.major)
    expect(majors).toContain(17)
    expect(majors).toContain(21)
    expect(result.candidates.some((candidate) => candidate.source === 'mojang-runtime')).toBe(true)

    const choice = chooseJava({ candidates: result.candidates, requiredMajor: 17 })
    expect(choice.candidate.version.major).toBe(17)
    expect(choice.warnings).toHaveLength(0)

    // Evidence is printed so a manual run leaves a readable record.
    console.log(
      'detected java:',
      result.candidates.map((candidate) => ({
        path: candidate.path,
        version: candidate.version.raw,
        source: candidate.source,
      })),
    )
  }, 60_000)
})

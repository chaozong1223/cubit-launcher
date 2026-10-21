import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { flattenVersionChain } from '../version/inherit'
import { buildLaunchPlan, type LaunchSettings } from '../launch/args'
import {
  allocateGameLogFile,
  formatLocalStamp,
  updateLaunchLastExit,
  writeLaunchArtifacts,
} from '../launch/artifacts'
import { nodeFsPort } from '../ports'
import {
  basePaths,
  makeTempRoot,
  offlineAccount,
  vanillaVersion,
} from '../__tests__/helpers'

const cleanup: string[] = []
afterEach(() => {
  for (const dir of cleanup.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})
function tempRoot(): string {
  const root = makeTempRoot('mcl-art-')
  cleanup.push(root)
  return root
}

const MC_ROOT = path.join('C:\\Games', '.minecraft')
const DIR = '1.20.1'

function makePlan(
  overrides: Partial<LaunchSettings> = {},
  sessionId = 'session-art',
  account = offlineAccount(),
) {
  const version = flattenVersionChain([vanillaVersion()]).json
  return buildLaunchPlan({
    version,
    versionName: '1.20.1',
    mcVersion: '1.20.1',
    account,
    paths: basePaths(MC_ROOT, DIR),
    settings: {
      javaPath: 'C:\\Java\\jdk-17\\bin\\java.exe',
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
      ...overrides,
    },
    platform: 'win32',
    arch: 'x64',
    exists: () => true,
    sessionId,
    now: () => 1_700_000_000_000,
    env: { SystemRoot: 'C:\\Windows' },
  })
}

function artifactInput(dataRoot: string, plan: ReturnType<typeof makePlan>) {
  return {
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
    dryRun: plan.dryRun,
    fs: nodeFsPort(),
    secrets: ['0'],
  }
}

describe('writeLaunchArtifacts', () => {
  it('writes launch-last.json and a runnable bat with the offline four pieces', () => {
    const dataRoot = tempRoot()
    const plan = makePlan()
    const files = writeLaunchArtifacts(artifactInput(dataRoot, plan))

    expect(fs.existsSync(files.launchLastJson)).toBe(true)
    expect(fs.existsSync(files.launchLastBat)).toBe(true)
    expect(files.dryRunFile).toBeNull()

    const json = JSON.parse(fs.readFileSync(files.launchLastJson, 'utf8')) as {
      argv: string[]
      java: { path: string; major: number }
      memory: { minMb: number; maxMb: number }
      version: { id: string; mainClass: string }
      account: { name: string; uuid: string }
      exit: null
    }
    expect(json.version.id).toBe('1.20.1')
    expect(json.version.mainClass).toBe('net.minecraft.client.main.Main')
    expect(json.java.major).toBe(17)
    expect(json.memory.maxMb).toBe(4096)
    expect(json.account.name).toBe('TestUser')
    expect(json.argv).toContain('--accessToken')
    expect(json.argv[json.argv.indexOf('--accessToken') + 1]).toBe('0')
    expect(json.exit).toBeNull()

    const bat = fs.readFileSync(files.launchLastBat, 'utf8')
    expect(bat.startsWith('@echo off\r\n')).toBe(true)
    expect(bat).toContain('chcp 936')
    expect(bat).toContain(`cd /d "${plan.cwd}"`)
    expect(bat).toContain('"C:\\Java\\jdk-17\\bin\\java.exe"')
    expect(bat).toContain('--username TestUser')
    expect(bat).toContain('--accessToken 0')
    expect(bat).toContain('-Xmx4096m')
    expect(bat).not.toContain('<redacted>')
  })

  it('writes dry-run.json only for a dry run', () => {
    const dataRoot = tempRoot()
    const dry = makePlan({}, 'session-dry')
    dry.dryRun = true
    const files = writeLaunchArtifacts(artifactInput(dataRoot, dry))
    expect(files.dryRunFile).not.toBeNull()
    expect(fs.existsSync(files.dryRunFile as string)).toBe(true)
    const json = JSON.parse(fs.readFileSync(files.dryRunFile as string, 'utf8')) as {
      dryRun: boolean
      argv: string[]
    }
    expect(json.dryRun).toBe(true)
    expect(json.argv.some((token) => token.includes('${'))).toBe(false)
  })

  it('redacts a real access token from both json and bat', () => {
    const dataRoot = tempRoot()
    const account = offlineAccount({
      kind: 'microsoft',
      accessToken: 'eyJhbGciOiJSUzI1NiJ9.secret-token',
      userType: 'msa',
      clientId: 'client-id',
      xuid: 'xuid-1',
    })
    const plan = makePlan({}, 'session-ms', account)
    const files = writeLaunchArtifacts({
      ...artifactInput(dataRoot, plan),
      account,
      secrets: [account.accessToken],
    })
    const jsonText = fs.readFileSync(files.launchLastJson, 'utf8')
    const batText = fs.readFileSync(files.launchLastBat, 'utf8')
    expect(jsonText).not.toContain('secret-token')
    expect(batText).not.toContain('secret-token')
    expect(jsonText).toContain('<redacted>')
    expect(batText).toContain('<redacted>')
    expect(batText).toContain('access token redacted')
  })
})

describe('launch artifact helpers', () => {
  it('appends exit evidence to launch-last.json', () => {
    const dataRoot = tempRoot()
    const plan = makePlan()
    writeLaunchArtifacts(artifactInput(dataRoot, plan))
    const file = updateLaunchLastExit(
      dataRoot,
      {
        exitCode: 1,
        signal: null,
        durationMs: 1234,
        classification: 'crashed',
        crashHints: [],
        logFile: 'C:\\log.txt',
        sawMenu: false,
      },
      nodeFsPort(),
    )
    expect(file).not.toBeNull()
    const json = JSON.parse(fs.readFileSync(file as string, 'utf8')) as {
      exit: { exitCode: number; durationMs: number; classification: string }
    }
    expect(json.exit).toMatchObject({ exitCode: 1, durationMs: 1234, classification: 'crashed' })
  })

  it('allocates unique per-launch log files under logs/game/<instance>', () => {
    const dataRoot = tempRoot()
    const fsPort = nodeFsPort()
    const local = new Date(2026, 9, 21, 13, 30, 15)
    const now = () => local.getTime()
    const first = allocateGameLogFile(fsPort, dataRoot, '1.20.1', now)
    fs.writeFileSync(first, 'x')
    const second = allocateGameLogFile(fsPort, dataRoot, '1.20.1', now)
    expect(first).toContain(path.join('logs', 'game', '1.20.1'))
    expect(first.endsWith('20261021-133015.log')).toBe(true)
    expect(second.endsWith('20261021-133015-2.log')).toBe(true)
    expect(formatLocalStamp(local)).toBe('20261021-133015')
  })
})

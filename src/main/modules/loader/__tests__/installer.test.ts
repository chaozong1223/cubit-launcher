import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  detectInstalledVersion,
  formatInstallerFailure,
  installerArguments,
  installerEnvironment,
  parseInstallerLine,
  runInstaller,
} from '../core/installer'
import { nodeFsPort } from '../../../core/ports'
import { LoaderError } from '../core/errors'
import { fakePorts, tempDir, type FakeChild } from './support/harness'

let root = ''

beforeEach(() => {
  root = tempDir('mcl-installer-')
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('installer output parser', () => {
  it('maps Forge/NeoForge output lines to tasks and percentages', () => {
    expect(parseInstallerLine('Analyzing 1.20.1...')).toMatchObject({
      currentTask: '分析 1.20.1',
      percent: null,
      error: false,
    })
    expect(parseInstallerLine('Downloading 18 libraries...')).toMatchObject({
      currentTask: '下载 18 个 libraries',
    })
    expect(parseInstallerLine('(3/18) Downloading net.minecraftforge:forge:1.20.1-47.2.0')).toMatchObject({
      percent: 17,
      currentTask: '下载 net.minecraftforge:forge:1.20.1-47.2.0',
    })
    expect(parseInstallerLine('Installing client...').currentTask).toBe('安装 client')
    expect(parseInstallerLine('Extracting natives...').currentTask).toBe('解压 natives')
    expect(parseInstallerLine('Processing 42%').percent).toBe(42)
    expect(parseInstallerLine('100% complete').percent).toBe(100)
  })

  it('flags failure lines but not "0 errors"', () => {
    expect(parseInstallerLine('Failed to download libraries').error).toBe(true)
    expect(parseInstallerLine('java.lang.RuntimeException: boom').error).toBe(true)
    expect(parseInstallerLine('Finished with 0 errors').error).toBe(false)
    expect(parseInstallerLine('').currentTask).toBeNull()
  })
})

describe('installer argv/env (SEC-EXE-06)', () => {
  it('only passes the fixed whitelist arguments', () => {
    const args = installerArguments('C:\\cache\\forge-installer.jar', 'D:\\mc')
    expect(args).toEqual([
      '-Djava.awt.headless=true',
      '-jar',
      'C:\\cache\\forge-installer.jar',
      '--installClient',
      'D:\\mc',
    ])
    expect(args.join(' ')).not.toContain('--installServer')
  })

  it('passes a minimal environment without unrelated secrets', () => {
    const env = installerEnvironment({
      PATH: 'C:\\Windows',
      SystemRoot: 'C:\\Windows',
      TEMP: 'C:\\Temp',
      OPENAI_API_KEY: 'secret',
      GITHUB_TOKEN: 'token',
    })
    expect(env.PATH).toBe('C:\\Windows')
    expect(env.TEMP).toBe('C:\\Temp')
    expect(env.OPENAI_API_KEY).toBeUndefined()
    expect(env.GITHUB_TOKEN).toBeUndefined()
  })
})

describe('runInstaller', () => {
  it('runs java in the temp workdir, streams lines and reports exit 0', async () => {
    const workDir = path.join(root, 'work')
    fs.mkdirSync(workDir, { recursive: true })
    const ports = fakePorts({
      script: async (child: FakeChild) => {
        child.stdout.write('Analyzing 1.20.1...\n')
        await new Promise((resolve) => setTimeout(resolve, 5))
        child.stdout.write('(5/10) Downloading libraries\n')
        child.stdout.write('Done\n')
        child.emit('exit', 0, null)
      },
    })
    const lines: string[] = []
    const tasks: string[] = []
    const result = await runInstaller({
      ports,
      javaPath: 'C:\\java\\bin\\java.exe',
      jarPath: 'C:\\cache\\installer.jar',
      mcRoot: 'D:\\mc',
      workDir,
      onLine: (line) => lines.push(line),
      onParsed: (parsed) => {
        if (parsed.currentTask) tasks.push(parsed.currentTask)
      },
    })
    expect(result.exitCode).toBe(0)
    expect(lines).toContain('Analyzing 1.20.1...')
    expect(tasks).toContain('下载 libraries')
    expect(ports.spawned[0].args).toEqual([
      '-Djava.awt.headless=true',
      '-jar',
      'C:\\cache\\installer.jar',
      '--installClient',
      'D:\\mc',
    ])
    expect(ports.spawned[0].options?.cwd).toBe(workDir)
    expect(ports.spawned[0].options?.windowsHide).toBe(true)
  })

  it('decodes UTF-8 across chunk boundaries instead of garbling Chinese output', async () => {
    const workDir = path.join(root, 'work')
    fs.mkdirSync(workDir, { recursive: true })
    const line = 'Installing client... 安装客户端\n'
    const bytes = Buffer.from(line, 'utf8')
    // Split inside the 3-byte character 安 (U+5B89): a per-chunk TextDecoder
    // would emit two U+FFFD replacement characters here (R1/H13).
    const cut = bytes.indexOf(Buffer.from('安', 'utf8')) + 1
    const ports = fakePorts({
      script: async (child: FakeChild) => {
        child.stdout.write(bytes.subarray(0, cut))
        await new Promise((resolve) => setTimeout(resolve, 5))
        child.stdout.write(bytes.subarray(cut))
        await new Promise((resolve) => setTimeout(resolve, 5))
        child.emit('exit', 0, null)
      },
    })
    const lines: string[] = []
    const result = await runInstaller({
      ports,
      javaPath: 'java',
      jarPath: 'installer.jar',
      mcRoot: root,
      workDir,
      onLine: (text) => lines.push(text),
    })
    expect(result.exitCode).toBe(0)
    expect(lines).toContain('Installing client... 安装客户端')
    expect(lines.join('')).not.toContain('\uFFFD')
  })

  it('reports a non-zero exit with a readable failure tail', async () => {
    const ports = fakePorts({
      script: (child: FakeChild) => {
        child.stderr.write('Failed to download libraries\n')
        child.stdout.write('Done\n')
        child.emit('exit', 3, null)
      },
    })
    const result = await runInstaller({
      ports,
      javaPath: 'java',
      jarPath: 'installer.jar',
      mcRoot: root,
      workDir: root,
    })
    expect(result.exitCode).toBe(3)
    expect(result.errorLines.join('\n')).toContain('Failed to download libraries')
    expect(formatInstallerFailure(result)).toContain('exited with code 3')
  })

  it('kills the process on timeout and marks it timed out', async () => {
    const ports = fakePorts({ script: () => undefined })
    const started = Date.now()
    const result = await runInstaller({
      ports,
      javaPath: 'java',
      jarPath: 'installer.jar',
      mcRoot: root,
      workDir: root,
      timeoutMs: 40,
    })
    expect(result.timedOut).toBe(true)
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(formatInstallerFailure(result)).toContain('timed out')
  })

  it('kills the process when the job is cancelled', async () => {
    const ports = fakePorts({ script: () => undefined })
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 25)
    const result = await runInstaller({
      ports,
      javaPath: 'java',
      jarPath: 'installer.jar',
      mcRoot: root,
      workDir: root,
      signal: controller.signal,
    })
    expect(result.cancelled).toBe(true)
  })

  it('wraps a spawn failure in LOADER.INSTALLER_FAILED', async () => {
    const ports = fakePorts()
    ports.spawn = () => {
      throw new Error('spawn EACCES')
    }
    await expect(
      runInstaller({
        ports,
        javaPath: 'java',
        jarPath: 'installer.jar',
        mcRoot: root,
        workDir: root,
      }),
    ).rejects.toBeInstanceOf(LoaderError)
  })
})

describe('detectInstalledVersion', () => {
  it('finds the newly created version directory and prefers the expected id', () => {
    const mcRoot = root
    const versionsDir = path.join(mcRoot, 'versions')
    fs.mkdirSync(path.join(versionsDir, '1.20.1'), { recursive: true })
    fs.mkdirSync(path.join(versionsDir, '1.20.1-forge-47.2.0'), { recursive: true })
    fs.writeFileSync(
      path.join(versionsDir, '1.20.1-forge-47.2.0', '1.20.1-forge-47.2.0.json'),
      JSON.stringify({ id: '1.20.1-forge-47.2.0', inheritsFrom: '1.20.1' }),
    )
    fs.writeFileSync(
      path.join(versionsDir, '1.20.1', '1.20.1.json'),
      JSON.stringify({ id: '1.20.1' }),
    )
    const detected = detectInstalledVersion(
      nodeFsPort(),
      mcRoot,
      ['1.20.1'],
      '1.20.1-forge-47.2.0',
      '1.20.1',
    )
    expect(detected?.versionId).toBe('1.20.1-forge-47.2.0')
    expect(detected?.dirName).toBe('1.20.1-forge-47.2.0')
  })

  it('returns null when the installer wrote no version JSON', () => {
    fs.mkdirSync(path.join(root, 'versions', 'leftover'), { recursive: true })
    expect(detectInstalledVersion(nodeFsPort(), root, [], 'expected', '1.20.1')).toBeNull()
  })
})

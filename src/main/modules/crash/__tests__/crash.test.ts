import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ScopedLogger } from '../../../kernel/logger'
import { openZipFile } from '../../../core/zip/reader'
import { nodeFsPort } from '../../../core/ports'
import { createCrashService, type CrashModuleService } from '../service'

const cleanup: string[] = []
afterEach(() => {
  for (const dir of cleanup.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

const logger = {
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
} as unknown as ScopedLogger

function writeFile(target: string, data: string | Buffer): void {
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, data)
}

function versionJson(): string {
  return JSON.stringify({
    id: '1.20.1',
    type: 'release',
    mainClass: 'net.minecraft.client.main.Main',
    assets: '1.20.1',
    assetIndex: { id: '1.20.1', sha1: '0'.repeat(40), size: 0, totalSize: 0, url: 'https://x/a' },
    downloads: { client: { sha1: '0'.repeat(40), size: 0, url: 'https://x/c' } },
    libraries: [],
    arguments: { game: [], jvm: [] },
  })
}

interface Fixture {
  root: string
  mcRoot: string
  dataRoot: string
  instanceDir: string
  service: CrashModuleService
  openPath: ReturnType<typeof vi.fn>
  openExternal: ReturnType<typeof vi.fn>
  repairFiles: ReturnType<typeof vi.fn>
}

function fixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcl-crash-'))
  cleanup.push(root)
  const mcRoot = path.join(root, 'mc')
  const dataRoot = path.join(root, 'data')
  const instanceDir = path.join(mcRoot, 'versions', '1.20.1')
  writeFile(path.join(instanceDir, '1.20.1.json'), versionJson())
  writeFile(path.join(instanceDir, '1.20.1.jar'), 'jar')
  writeFile(path.join(instanceDir, 'instance.json'), JSON.stringify({
    schemaVersion: 1,
    id: '1.20.1',
    dirName: '1.20.1',
    name: 'Test Instance',
    mcVersion: '1.20.1',
    loader: { type: 'vanilla', version: null },
    java: { mode: 'auto', value: null },
    memory: { minMb: 1024, maxMb: 4096 },
    memoryMode: 'custom',
    isolation: 'isolated',
    createdAt: 1,
  }))
  writeFile(path.join(instanceDir, 'mods', 'alpha.jar'), 'alpha')
  writeFile(path.join(instanceDir, 'mods', 'beta.jar.disabled'), 'beta')
  writeFile(path.join(instanceDir, 'mods', 'gamma.jar'), 'gamma')

  const openPath = vi.fn(async () => '')
  const openExternal = vi.fn(async () => undefined)
  const repairFiles = vi.fn(async ({ versionId }: { versionId: string }) => ({
    jobId: `job-${versionId}`,
  }))
  const service = createCrashService({
    roots: { dataRoot, mcRoot },
    log: logger,
    openPath,
    openExternal,
    repairFiles,
    now: () => 1_700_000_000_000,
  })
  return { root, mcRoot, dataRoot, instanceDir, service, openPath, openExternal, repairFiles }
}

const CASES: Array<{
  name: string
  log: string
  category: string
  action: string
}> = [
  {
    name: 'java version',
    log: 'java.lang.UnsupportedClassVersionError: net/minecraft/client/main/Main has been compiled by a more recent version (class file version 65.0), requires Java 21',
    category: 'java-version',
    action: 'set-java',
  },
  {
    name: 'missing library',
    log: 'java.lang.NoClassDefFoundError: com/example/missing/Library\nCaused by: java.lang.ClassNotFoundException: com.example.missing.Library',
    category: 'missing-library',
    action: 'repair-files',
  },
  {
    name: 'mod conflict',
    log: 'org.spongepowered.asm.mixin.transformer.throwables.MixinTransformerError: Mixin apply failed for example.mixins.json',
    category: 'mod-conflict',
    action: 'disable-mods',
  },
  {
    name: 'out of memory',
    log: 'java.lang.OutOfMemoryError: Java heap space\nCould not allocate memory',
    category: 'out-of-memory',
    action: 'set-memory',
  },
  {
    name: 'graphics driver',
    log: "GLFW error 65542: WGL: The driver does not appear to support OpenGL\nFailed to create display",
    category: 'graphics-driver',
    action: 'open-url',
  },
  {
    name: 'auth failed',
    log: 'com.mojang.authlib.exceptions.AuthenticationException: Failed to verify username, invalid credentials',
    category: 'auth-failed',
    action: 'open-url',
  },
  {
    name: 'corrupt files',
    log: 'java.util.zip.ZipException: invalid LOC header (bad signature)\nError reading client.jar',
    category: 'corrupt-files',
    action: 'repair-files',
  },
  {
    name: 'port in use',
    log: 'java.net.BindException: Address already in use: bind\nFailed to bind to port',
    category: 'port-in-use',
    action: 'copy-text',
  },
  {
    name: 'jvm args',
    log: 'Unrecognized VM option \'UseG1GCBad\'\nError: Could not create the Java Virtual Machine',
    category: 'jvm-args',
    action: 'set-memory',
  },
]

describe('crash analysis categories', () => {
  it.each(CASES)('recognizes $name and exposes one-click actions', async (item) => {
    const f = fixture()
    const analysis = await f.service.analyze({
      instanceId: '1.20.1',
      exitCode: 1,
      logText: item.log,
    })
    expect(analysis.category).toBe(item.category)
    expect(analysis.uncertain).toBe(false)
    expect(analysis.confidence).not.toBe('low')
    expect(analysis.evidence.length).toBeGreaterThan(0)
    expect(analysis.phenomenon).toContain('退出码 1')
    expect(analysis.likelyCause.length).toBeGreaterThan(0)
    expect(analysis.actions.some((action) => action.kind === item.action)).toBe(true)
    expect(analysis.actions.some((action) => action.kind === 'export-diagnostics')).toBe(true)
    expect(analysis.logTail.join('\n')).toContain(item.log.split('\n')[0].slice(0, 20))
  })

  it('suggests the Java version extracted from the class-file evidence', async () => {
    const f = fixture()
    const analysis = await f.service.analyze({
      instanceId: '1.20.1',
      exitCode: 1,
      logText: 'UnsupportedClassVersionError: class file version 65.0, requires Java 21',
    })
    const setJava = analysis.actions.find((action) => action.kind === 'set-java')
    expect(setJava?.params.major).toBe(21)
  })
})

describe('honest unknown handling', () => {
  it('does not invent a cause when only an exit code is supplied', async () => {
    const f = fixture()
    const analysis = await f.service.analyze({ instanceId: '1.20.1', exitCode: 1 })
    expect(analysis.category).toBe('unknown')
    expect(analysis.uncertain).toBe(true)
    expect(analysis.confidence).toBe('low')
    expect(analysis.likelyCause).toContain('无法确定')
    expect(analysis.evidence).toEqual([])
    expect(analysis.actions.map((action) => action.kind)).toEqual([
      'export-diagnostics',
      'open-folder',
      'copy-text',
    ])
    expect(analysis.diagnostics.join(' ')).toContain('诊断包')
  })

  it('handles empty logs and explicit non-matching logs without throwing', async () => {
    const f = fixture()
    for (const logText of ['', 'hello world\nthis is a normal line']) {
      const analysis = await f.service.analyze({ instanceId: '1.20.1', logText })
      expect(analysis.category).toBe('unknown')
      expect(analysis.likelyCause).toContain('无法确定')
    }
  })
})

describe('context and latest log discovery', () => {
  it('reads launch-last.json and the latest game log for exit/Java/memory context', async () => {
    const f = fixture()
    const logFile = path.join(f.dataRoot, 'logs', 'game', '1.20.1', 'session.log')
    writeFile(logFile, 'java.lang.OutOfMemoryError: Java heap space\n')
    writeFile(path.join(f.dataRoot, 'logs', 'launch-last.json'), JSON.stringify({
      instanceId: '1.20.1',
      java: { major: 17, version: '17.0.15', path: 'C:/java.exe' },
      memory: { minMb: 1024, maxMb: 4096 },
      exit: { exitCode: 1, logFile, classification: 'crashed' },
    }))
    const analysis = await f.service.analyze({ instanceId: '1.20.1' })
    expect(analysis.category).toBe('out-of-memory')
    expect(analysis.context).toMatchObject({
      exitCode: 1,
      javaMajor: 17,
      javaVersion: '17.0.15',
      memory: { minMb: 1024, maxMb: 4096 },
      modCount: 2,
      mcVersion: '1.20.1',
    })
    const exported = await f.service.exportReport({
      analysis,
      outPath: path.join(f.root, 'report.zip'),
    })
    const archive = openZipFile(nodeFsPort(), exported.path)
    expect(archive.has('analysis.md')).toBe(true)
    expect(archive.has('analysis.json')).toBe(true)
    expect(archive.has('game.log')).toBe(true)
    expect(archive.has('launch-last.json')).toBe(true)
    expect(archive.has('instance.json')).toBe(true)
  })
})

describe('one-click fixes', () => {
  it('switches Java and raises memory in instance.json', async () => {
    const f = fixture()
    const javaAnalysis = await f.service.analyze({
      instanceId: '1.20.1',
      logText: 'UnsupportedClassVersionError: requires Java 21',
    })
    const javaAction = javaAnalysis.actions.find((action) => action.kind === 'set-java')!
    const javaResult = await f.service.applyFix({ instanceId: '1.20.1', action: javaAction })
    expect(javaResult).toMatchObject({ ok: true, restartRequired: true, changed: ['java'] })
    expect(JSON.parse(fs.readFileSync(path.join(f.instanceDir, 'instance.json'), 'utf8')).java).toEqual({
      mode: 'major',
      value: 21,
    })

    const memoryAnalysis = await f.service.analyze({
      instanceId: '1.20.1',
      logText: 'java.lang.OutOfMemoryError: Java heap space',
    })
    const memoryAction = memoryAnalysis.actions.find((action) => action.kind === 'set-memory')!
    await f.service.applyFix({ instanceId: '1.20.1', action: memoryAction })
    const settings = JSON.parse(fs.readFileSync(path.join(f.instanceDir, 'instance.json'), 'utf8'))
    expect(settings.memory.maxMb).toBeGreaterThan(4096)
    expect(settings.memoryMode).toBe('custom')
  })

  it('enters safe mode (disables mods) and can restore exactly those mods', async () => {
    const f = fixture()
    const disabled = await f.service.applyFix({
      instanceId: '1.20.1',
      action: {
        id: 'test-safe',
        kind: 'disable-mods',
        label: 'safe',
        description: 'safe',
        risk: 'caution',
        automatic: true,
        params: {},
      },
    })
    expect(disabled.ok).toBe(true)
    expect(fs.existsSync(path.join(f.instanceDir, 'mods', 'alpha.jar'))).toBe(false)
    expect(fs.existsSync(path.join(f.instanceDir, 'mods', 'alpha.jar.disabled'))).toBe(true)
    expect(fs.existsSync(path.join(f.instanceDir, 'mods', 'beta.jar.disabled'))).toBe(true)

    const restored = await f.service.applyFix({
      instanceId: '1.20.1',
      action: {
        id: 'test-restore',
        kind: 'restore-mods',
        label: 'restore',
        description: 'restore',
        risk: 'safe',
        automatic: true,
        params: {},
      },
    })
    expect(restored.ok).toBe(true)
    expect(fs.existsSync(path.join(f.instanceDir, 'mods', 'alpha.jar'))).toBe(true)
    // beta was already disabled before safe mode and must stay disabled.
    expect(fs.existsSync(path.join(f.instanceDir, 'mods', 'beta.jar.disabled'))).toBe(true)
  })

  it('triggers repair, browser, folder and clipboard actions', async () => {
    const f = fixture()
    const missing = await f.service.analyze({
      instanceId: '1.20.1',
      logText: 'java.lang.NoClassDefFoundError: missing',
    })
    const repairAction = missing.actions.find((action) => action.kind === 'repair-files')!
    const repair = await f.service.applyFix({ instanceId: '1.20.1', action: repairAction })
    expect(repair.ok).toBe(true)
    expect(repair.jobId).toBe('job-1.20.1')
    expect(f.repairFiles).toHaveBeenCalledWith({ versionId: '1.20.1' })

    const graphics = await f.service.analyze({
      instanceId: '1.20.1',
      logText: 'GLFW error 65542: WGL: The driver does not support OpenGL',
    })
    const urlAction = graphics.actions.find((action) => action.kind === 'open-url')!
    await f.service.applyFix({ instanceId: '1.20.1', action: urlAction })
    expect(f.openExternal).toHaveBeenCalledWith(urlAction.params.url)

    const folder = await f.service.applyFix({
      instanceId: '1.20.1',
      action: {
        id: 'folder',
        kind: 'open-folder',
        label: 'folder',
        description: 'folder',
        risk: 'safe',
        automatic: true,
        params: { area: 'mods' },
      },
    })
    expect(folder.ok).toBe(true)
    expect(f.openPath).toHaveBeenCalled()

    const port = await f.service.analyze({
      instanceId: '1.20.1',
      logText: 'java.net.BindException: Address already in use',
    })
    const copyAction = port.actions.find((action) => action.kind === 'copy-text')!
    const copied = await f.service.applyFix({ instanceId: '1.20.1', action: copyAction })
    expect(copied.clipboard).toContain('Get-NetTCPConnection')
  })

  it('rejects unsafe manual actions and can export diagnostics after analysis', async () => {
    const f = fixture()
    const analysis = await f.service.analyze({
      instanceId: '1.20.1',
      logText: 'java.lang.OutOfMemoryError: Java heap space',
    })
    await expect(
      f.service.applyFix({
        instanceId: '1.20.1',
        action: {
          id: 'bad',
          kind: 'open-url',
          label: 'bad',
          description: 'bad',
          risk: 'safe',
          automatic: true,
          params: { url: 'file:///C:/Windows' },
        },
      }),
    ).rejects.toMatchObject({ code: 'CRASH.INVALID_ACTION' })
    await expect(
      f.service.applyFix({
        instanceId: '1.20.1',
        action: {
          id: 'bad-memory',
          kind: 'set-memory',
          label: 'bad',
          description: 'bad',
          risk: 'safe',
          automatic: true,
          params: { maxMb: 999999 },
        },
      }),
    ).rejects.toMatchObject({ code: 'CRASH.INVALID_ACTION' })

    const exportAction = analysis.actions.find((action) => action.kind === 'export-diagnostics')!
    const result = await f.service.applyFix({ instanceId: '1.20.1', action: exportAction })
    expect(result.ok).toBe(true)
    expect(result.changed[0]).toContain('crash-')
  })
})

describe('crash report persistence', () => {
  it('writes R5.7 report to dataRoot and instance crash-reports, emits detected, and redacts tokens', async () => {
    const f = fixture()
    const detected: unknown[] = []
    f.service.onEvent('detected', (payload) => detected.push(payload))
    const result = await f.service.handleCrash({
      instanceId: '1.20.1',
      exitCode: 1,
      logText:
        'java.lang.OutOfMemoryError: Java heap space\n--accessToken secret-token-value\neyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signature',
    })
    expect(result.fileName).toMatch(/^\d{8}-\d{6}-1\.20\.1\.txt$/)
    expect(result.reportPath).toBe(path.join(f.dataRoot, 'crash-reports', result.fileName))
    expect(result.instanceReportPath).toBe(
      path.join(f.instanceDir, 'crash-reports', result.fileName),
    )
    expect(fs.existsSync(result.reportPath)).toBe(true)
    expect(fs.existsSync(result.instanceReportPath)).toBe(true)
    const text = fs.readFileSync(result.reportPath, 'utf8')
    expect(text).toContain('mc-launcher 崩溃报告')
    expect(text).toContain('内存不足')
    expect(text).toContain('OutOfMemoryError')
    expect(text).toContain('<redacted>')
    expect(text).not.toContain('secret-token-value')
    expect(text).not.toContain('eyJhbGciOiJIUzI1NiJ9')
    expect(detected).toHaveLength(1)
    expect(detected[0]).toMatchObject({
      instanceId: '1.20.1',
      reportPath: result.reportPath,
      instanceReportPath: result.instanceReportPath,
      analysis: { category: 'out-of-memory' },
    })
  })

  it('honestly reports an unknown crash when no log evidence exists', async () => {
    const f = fixture()
    const result = await f.service.handleCrash({ instanceId: '1.20.1', exitCode: 1 })
    expect(result.analysis.category).toBe('unknown')
    expect(result.analysis.uncertain).toBe(true)
    const text = fs.readFileSync(result.reportPath, 'utf8')
    expect(text).toContain('无法确定原因')
  })
})

describe('formatting', () => {
  it('renders 现象 → 原因 → 动作 and explicitly says unknown', async () => {
    const f = fixture()
    const unknown = await f.service.analyze({ instanceId: '1.20.1', exitCode: 1 })
    const formatted = f.service.format(unknown)
    expect(formatted.markdown).toContain('## 现象')
    expect(formatted.markdown).toContain('## 最可能原因')
    expect(formatted.markdown).toContain('## 修复动作')
    expect(formatted.markdown).toContain('无法确定原因')
    expect(formatted.plain).toContain('无法确定原因')
  })
})

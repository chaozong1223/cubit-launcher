import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import os from 'node:os'
import path from 'node:path'
import type { InstanceSettings } from '@shared/instance'
import type { JavaCandidate } from '@shared/java'
import type { LaunchExitReport, LaunchPlan, LaunchState, LaunchStatus } from '@shared/launch'
import { CoreError } from '../errors'
import { nodeFsPort, nodeProcessPort, type FsPort, type ProcessPort } from '../ports'
import { findInstance, type ScannedInstance } from '../instance/scan'
import {
  defaultInstanceSettings,
  readInstanceSettings,
} from '../instance/settings'
import { resolveVersion } from '../version/load'
import { resolveLibraries } from '../version/classpath'
import type { ResolvedVersion } from '../version/types'
import { detectJava, JavaDetectionCache } from '../java/detect'
import { chooseJava, requiredJavaMajor } from '../java/select'
import { probeJavaExecutable } from '../java/probe'
import {
  buildLaunchPlan,
  type AuthlibInjection,
  type LaunchAccount,
  type LaunchPlanCore,
} from './args'
import {
  allocateGameLogFile,
  updateLaunchLastExit,
  writeLaunchArtifacts,
} from './artifacts'
import { extractNatives, planNatives } from './natives'
import { applyGameLanguage } from './options'
import { assertPathBudget } from '../../kernel/paths'
import {
  startLaunchProcess,
  type LaunchExit,
  type LaunchProcessHandle,
} from './process'
import {
  autoMaxMemoryMb,
  detectWindowsCodePage,
  logEncodingForCodePage,
} from './settings'

export interface OrchestratorLogger {
  info(message: string, fields?: Record<string, unknown>): void
  warn(message: string, fields?: Record<string, unknown>): void
  error(message: string, fields?: Record<string, unknown>): void
}

export interface LaunchRequestInput {
  instanceId: string
  accountId?: string | null
  server?: { host: string; port: number } | null
  dryRun?: boolean
  /** Persisted launcher language setting; null means follow the game. */
  gameLanguage?: string | null
}

export interface LaunchOrchestratorOptions {
  dataRoot: string
  mcRoot: string
  appVersion: string
  fs?: FsPort
  ports?: ProcessPort
  now?: () => number
  logger?: OrchestratorLogger
  resolveAccount?: (accountId: string | null) => Promise<LaunchAccount | null>
  resolveAuthlib?: (
    instance: ScannedInstance,
    account: LaunchAccount,
  ) => Promise<AuthlibInjection | null>
  javaCache?: JavaDetectionCache
  totalMemoryBytes?: number
  platform?: NodeJS.Platform
  arch?: string
  /** Executable dir used for bundled runtime discovery. */
  exeDir?: string
}

export interface PreparedLaunch {
  instance: ScannedInstance
  resolved: ResolvedVersion
  account: LaunchAccount
  settings: InstanceSettings
  java: JavaCandidate
  codePage: number
  plan: LaunchPlanCore
  publicPlan: LaunchPlan
  logFile: string
}

interface SessionRecord {
  instanceId: string
  handle: LaunchProcessHandle
  plan: LaunchPlanCore
  status: LaunchStatus
}

const IDLE_STATE: LaunchState = 'idle'

/**
 * Only a real crash may surface the crash panel. Normal exits, launch anomalies
 * and launcher-requested kills all end in `exited`; the exit report keeps the
 * richer classification (normal/suspect/killed).
 */
export function launchStateForClassification(
  classification: LaunchExit['classification'],
): LaunchState {
  return classification === 'crashed' ? 'crashed' : 'exited'
}

export function reportReadyForClassification(
  classification: LaunchExit['classification'],
): boolean {
  return classification === 'crashed'
}

/**
 * Orchestrates the launch chain without Electron: instance → version merge →
 * Java selection → plan → dry-run artifacts → natives → process → log stream.
 * The module adapter only forwards IPC/events.
 */
export class LaunchOrchestrator extends EventEmitter {
  private readonly fs: FsPort
  private readonly ports: ProcessPort
  private readonly now: () => number
  private readonly logger: OrchestratorLogger
  private readonly javaCache: JavaDetectionCache
  private readonly platform: NodeJS.Platform
  private readonly arch: string
  private readonly sessions = new Map<string, SessionRecord>()
  private readonly statusByInstance = new Map<string, LaunchStatus>()
  private readonly reportByInstance = new Map<string, LaunchExitReport>()
  private codePage: number | null = null
  private accountResolver: LaunchOrchestratorOptions['resolveAccount']

  constructor(private readonly options: LaunchOrchestratorOptions) {
    super()
    this.fs = options.fs ?? nodeFsPort()
    this.ports = options.ports ?? nodeProcessPort()
    this.now = options.now ?? Date.now
    this.logger = options.logger ?? {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    }
    this.javaCache = options.javaCache ?? new JavaDetectionCache()
    this.platform = options.platform ?? process.platform
    this.arch = options.arch ?? process.arch
    this.accountResolver = options.resolveAccount
  }

  /** Wired by the auth module once accounts exist (t11); honest until then. */
  setAccountResolver(
    resolver: LaunchOrchestratorOptions['resolveAccount'],
  ): void {
    this.accountResolver = resolver
  }

  /** Symmetric with setAccountResolver; auth wiring uses this public hook. */
  setAuthlibResolver(
    resolver: LaunchOrchestratorOptions['resolveAuthlib'],
  ): void {
    this.options.resolveAuthlib = resolver
  }

  private async resolveAccount(accountId: string | null): Promise<LaunchAccount> {
    if (!this.accountResolver) {
      throw new CoreError('LAUNCH.ACCOUNT_REQUIRED', {
        message: 'no account resolver configured',
      })
    }
    const account = await this.accountResolver(accountId)
    if (!account) {
      throw new CoreError('LAUNCH.ACCOUNT_REQUIRED', {
        message: `account not found: ${accountId ?? '(none)'}`,
        details: { accountId },
      })
    }
    return account
  }

  private async currentCodePage(): Promise<number> {
    if (this.codePage !== null) return this.codePage
    const detected = await detectWindowsCodePage(this.ports, this.platform)
    this.codePage = detected.codePage
    this.logger.info('code page detected', { ...detected })
    return detected.codePage
  }

  private async selectJava(
    resolved: ResolvedVersion,
    settings: InstanceSettings,
  ): Promise<{ java: JavaCandidate; requiredMajor: number | null; warnings: string[] }> {
    const forcedPath =
      settings.java.mode === 'path' && typeof settings.java.value === 'string'
        ? settings.java.value
        : null
    const forcedMajor =
      settings.java.mode === 'major' && typeof settings.java.value === 'number'
        ? settings.java.value
        : null

    const detection = await detectJava({
      fs: this.fs,
      ports: this.ports,
      platform: this.platform,
      arch: this.arch,
      env: process.env,
      dataRoot: this.options.dataRoot,
      mcRoot: this.options.mcRoot,
      exeDir: this.options.exeDir ?? path.dirname(process.execPath),
      appDataDir: process.env.APPDATA ?? null,
      extraPaths: forcedPath ? [forcedPath] : [],
      instancePaths: forcedPath ? [forcedPath] : [],
      cache: this.javaCache,
      now: this.now,
      force: false,
    })

    const candidates = [...detection.candidates]

    if (forcedPath && !candidates.some((candidate) => candidate.path.toLowerCase() === forcedPath.toLowerCase())) {
      const probe = await probeJavaExecutable(this.ports, forcedPath, {
        timeoutMs: 8_000,
      })
      if (!probe.ok) {
        throw new CoreError('JAVA.INVALID', {
          message: `forced Java is not usable: ${probe.reason}`,
          hint: '这个 Java 路径不可用，请重新选择',
          details: { path: forcedPath },
        })
      }
      candidates.push({
        path: forcedPath,
        home: probe.home ?? path.dirname(path.dirname(forcedPath)),
        source: 'instance',
        version: probe.version,
        vendor: probe.vendor,
        arch: probe.arch,
        bits: probe.bits,
        probedAt: this.now(),
      })
    }

    const requiredMajor = requiredJavaMajor(
      resolved.json.javaVersion?.majorVersion ?? null,
      resolved.mcVersion,
    )

    const choice = chooseJava({
      candidates,
      requiredMajor,
      forcedPath,
      forcedMajor,
    })

    this.logger.info('java selected', {
      path: choice.candidate.path,
      version: choice.candidate.version.raw,
      requiredMajor,
      forcedPath,
      forcedMajor,
    })

    return { java: choice.candidate, requiredMajor, warnings: choice.warnings }
  }

  private buildPaths(resolved: ResolvedVersion, settings: InstanceSettings) {
    const versionDir = resolved.dir
    const gameDir = settings.isolation === 'isolated' ? versionDir : this.options.mcRoot
    return {
      mcRoot: this.options.mcRoot,
      versionDir,
      gameDir,
      assetsDir: path.join(this.options.mcRoot, 'assets'),
      librariesDir: path.join(this.options.mcRoot, 'libraries'),
      nativesDir: path.join(versionDir, `${resolved.dirName}-natives`),
      clientJar: resolved.clientJar,
    }
  }

  private async prepare(
    input: LaunchRequestInput,
    mode: 'plan' | 'start',
  ): Promise<PreparedLaunch> {
    const instance = findInstance(this.fs, this.options.mcRoot, input.instanceId)
    if (!instance) {
      throw new CoreError('INSTANCE.NOT_FOUND', {
        message: `instance not found: ${input.instanceId}`,
        details: { instanceId: input.instanceId },
      })
    }

    this.emitStage(instance.id, 'precheck', `instance ${instance.dirName}`)
    const resolved = resolveVersion(this.fs, this.options.mcRoot, instance.dirName)
    const read = readInstanceSettings(this.fs, resolved.dir)
    const settings =
      read.settings ??
      defaultInstanceSettings({
        dirName: resolved.dirName,
        id: instance.id,
        mcVersion: resolved.mcVersion,
        loader: resolved.loader,
      })

    const account = await this.resolveAccount(input.accountId ?? null)

    this.emitStage(instance.id, 'java', null)
    const javaSelection = await this.selectJava(resolved, settings)

    const codePage = await this.currentCodePage()
    const autoMemory = autoMaxMemoryMb(
      this.options.totalMemoryBytes ?? os.totalmem(),
    )
    const memory =
      settings.memoryMode === 'custom' ? settings.memory : { minMb: 1024, maxMb: autoMemory }
    const window = settings.window

    const authlib = this.options.resolveAuthlib
      ? await this.options.resolveAuthlib(instance, account)
      : null

    const paths = this.buildPaths(resolved, settings)
    assertPathBudget(paths.nativesDir, 'natives 目录')
    const sessionId = randomUUID()
    const logFile = allocateGameLogFile(
      this.fs,
      this.options.dataRoot,
      resolved.dirName,
      this.now,
    )
    assertPathBudget(logFile, '游戏日志')

    this.emitStage(instance.id, 'args', null)
    const plan = buildLaunchPlan({
      version: resolved.json,
      versionName: resolved.id,
      mcVersion: resolved.mcVersion,
      account,
      paths,
      settings: {
        javaPath: javaSelection.java.path,
        javaMajor: javaSelection.java.version.major,
        minMemoryMb: memory.minMb,
        maxMemoryMb: memory.maxMb,
        width: window.width,
        height: window.height,
        fullscreen: window.fullscreen,
        extraJvmArgs: settings.jvmArgs,
        server: input.server ?? settings.autoJoin,
        authlib,
        codePage,
        launcherName: 'mc-launcher',
        launcherVersion: this.options.appVersion,
      },
      platform: this.platform,
      arch: this.arch,
      dryRun: mode === 'plan' && Boolean(input.dryRun),
      sessionId,
      now: this.now,
      env: process.env,
      exists: (target) => this.fs.exists(target),
    })

    plan.warnings.push(...javaSelection.warnings)
    for (const warning of resolved.warnings) {
      if (!plan.warnings.includes(warning)) plan.warnings.push(warning)
    }

    const publicPlan: LaunchPlan = {
      sessionId: plan.sessionId,
      dryRun: plan.dryRun,
      versionId: resolved.id,
      mcVersion: resolved.mcVersion,
      javaPath: plan.javaPath,
      javaMajor: plan.javaMajor,
      cwd: plan.cwd,
      argv: plan.argv,
      env: plan.env,
      classpath: plan.classpath,
      nativesDir: plan.nativesDir,
      logFile,
      warnings: plan.warnings,
    }

    if (mode === 'start' || plan.dryRun) {
      writeLaunchArtifacts({
        dataRoot: this.options.dataRoot,
        plan,
        account,
        mainClass: resolved.json.mainClass ?? null,
        instanceId: instance.id,
        versionName: resolved.id,
        loader: resolved.loader,
        javaVersion: javaSelection.java.version.raw,
        memory,
        codePage,
        dryRun: plan.dryRun,
        fs: this.fs,
        now: this.now,
        secrets: [account.accessToken],
      })
    }

    this.logger.info('launch plan prepared', {
      instanceId: instance.id,
      versionId: resolved.id,
      mcVersion: resolved.mcVersion,
      loader: resolved.loader,
      chain: resolved.chainIds,
      java: javaSelection.java.path,
      javaMajor: javaSelection.java.version.major,
      memory,
      argv: plan.argv.length,
      warnings: plan.warnings.length,
      dryRun: plan.dryRun,
    })

    return {
      instance,
      resolved,
      account,
      settings,
      java: javaSelection.java,
      codePage,
      plan,
      publicPlan,
      logFile,
    }
  }

  async plan(input: LaunchRequestInput): Promise<LaunchPlan> {
    const prepared = await this.prepare(input, 'plan')
    return prepared.publicPlan
  }

  async start(input: LaunchRequestInput): Promise<{ sessionId: string }> {
    if ([...this.sessions.values()].some((session) => session.instanceId === input.instanceId)) {
      throw new CoreError('LAUNCH.ALREADY_RUNNING', {
        message: `instance already running: ${input.instanceId}`,
        details: { instanceId: input.instanceId },
      })
    }
    const prepared = await this.prepare(input, 'start')

    if ([...this.sessions.values()].some((session) => session.instanceId === prepared.instance.id)) {
      throw new CoreError('LAUNCH.ALREADY_RUNNING', {
        message: `instance already running: ${prepared.instance.id}`,
        details: { instanceId: prepared.instance.id },
      })
    }

    // Apply the language setting to the real gameDir from the launch plan
    // (isolated version dir or shared mcRoot), before spawning Java.
    try {
      const language = input.gameLanguage === undefined ? 'zh_cn' : input.gameLanguage
      const result = applyGameLanguage(this.fs, prepared.plan.cwd, language)
      if (result.changed) {
        this.logger.info('game language applied', {
          instanceId: prepared.instance.id,
          language: result.language,
          path: result.path,
        })
      }
    } catch (error) {
      this.logger.warn('game language write failed; launching unchanged', {
        instanceId: prepared.instance.id,
        message: error instanceof Error ? error.message : String(error),
      })
    }

    if (!this.fs.exists(prepared.plan.javaPath)) {
      throw new CoreError('PROCESS.SPAWN_FAILED', {
        message: `java executable not found: ${prepared.plan.javaPath}`,
        userMessage: '找不到选定的 Java，请重新选择',
        details: { javaPath: prepared.plan.javaPath },
      })
    }

    if (!prepared.resolved.clientJarExists) {
      throw new CoreError('VERSION.NO_CLIENT_JAR', {
        message: `client jar missing: ${prepared.resolved.clientJar ?? '(unknown)'}`,
        userMessage: '启动前检查发现客户端 jar 缺失，需要修复实例',
        details: { clientJar: prepared.resolved.clientJar },
      })
    }

    const libraries = resolveLibraries(prepared.resolved.json, {
      librariesDir: path.join(this.options.mcRoot, 'libraries'),
      clientJar: prepared.resolved.clientJar,
      platform: this.platform,
      arch: this.arch,
      exists: (target) => this.fs.exists(target),
    })
    if (libraries.missing.length > 0) {
      throw new CoreError('LAUNCH.PLAN_INVALID', {
        message: `missing files before launch: ${libraries.missing.length}`,
        userMessage: '启动前检查发现文件缺失，请先修复实例',
        details: { missing: libraries.missing.slice(0, 50) },
      })
    }

    const nativePlan = planNatives(prepared.resolved.json, {
      mcRoot: this.options.mcRoot,
      nativesDir: prepared.plan.nativesDir,
      platform: this.platform,
      arch: this.arch,
      exists: (target) => this.fs.exists(target),
      clientJar: prepared.resolved.clientJar,
    })
    this.emitStage(prepared.instance.id, 'spawn', 'extracting natives')
    if (nativePlan.sources.length > 0) {
      const result = extractNatives(nativePlan, { fs: this.fs, now: this.now })
      this.logger.info('natives ready', {
        jars: result.jars,
        extracted: result.extracted,
        cacheHit: result.cacheHit,
      })
    } else {
      this.fs.mkdirp(prepared.plan.nativesDir)
    }

    const handle = startLaunchProcess({
      sessionId: prepared.publicPlan.sessionId,
      instanceId: prepared.instance.id,
      javaPath: prepared.plan.javaPath,
      argv: prepared.plan.argv,
      cwd: prepared.plan.cwd,
      env: prepared.plan.env,
      logFile: prepared.logFile,
      encoding: logEncodingForCodePage(prepared.codePage),
      fs: this.fs,
      ports: this.ports,
      now: this.now,
      headerLines: [
        `# instance ${prepared.instance.id} (${prepared.resolved.dirName})`,
        `# version ${prepared.resolved.id}`,
        `# javaMajor ${prepared.java.version.major}`,
      ],
    })

    const startedAt = this.now()
    const running: LaunchStatus = {
      instanceId: prepared.instance.id,
      state: 'running',
      sessionId: handle.sessionId,
      startedAt,
      exitCode: null,
      durationMs: null,
      reportReady: false,
    }
    this.sessions.set(handle.sessionId, {
      instanceId: prepared.instance.id,
      handle,
      plan: prepared.plan,
      status: running,
    })
    this.statusByInstance.set(prepared.instance.id, running)
    this.emitStatus(running)
    this.emitStage(prepared.instance.id, 'spawn', `pid ${handle.pid ?? 'unknown'}`)

    handle.onLine((line) => {
      this.emit('output', { sessionId: handle.sessionId, line: line.text, stream: line.stream })
    })

    void handle
      .waitForExit()
      .then((exit) => this.handleExit(prepared.instance.id, handle, exit))
      .catch((error: unknown) => {
        const code = error instanceof CoreError ? error.code : 'PROCESS.SPAWN_FAILED'
        this.logger.error('launch process failed', {
          instanceId: prepared.instance.id,
          code,
          message: error instanceof Error ? error.message : String(error),
        })
        const status: LaunchStatus = {
          instanceId: prepared.instance.id,
          state: 'crashed',
          sessionId: handle.sessionId,
          startedAt,
          exitCode: null,
          durationMs: 0,
          reportReady: true,
        }
        this.statusByInstance.set(prepared.instance.id, status)
        this.sessions.delete(handle.sessionId)
        this.emitStatus(status)
      })

    this.logger.info('game process started', {
      instanceId: prepared.instance.id,
      sessionId: handle.sessionId,
      pid: handle.pid,
      java: prepared.plan.javaPath,
      logFile: prepared.logFile,
    })

    return { sessionId: handle.sessionId }
  }

  private handleExit(
    instanceId: string,
    handle: LaunchProcessHandle,
    exit: LaunchExit,
  ): void {
    updateLaunchLastExit(
      this.options.dataRoot,
      {
        exitCode: exit.exitCode,
        signal: exit.signal,
        durationMs: exit.durationMs,
        classification: exit.classification,
        crashHints: exit.crashHints,
        logFile: exit.logFile,
        sawMenu: exit.sawMenu,
      },
      this.fs,
    )

    const status: LaunchStatus = {
      instanceId,
      state: launchStateForClassification(exit.classification),
      sessionId: handle.sessionId,
      startedAt: exit.startedAt,
      exitCode: exit.exitCode,
      durationMs: exit.durationMs,
      reportReady: reportReadyForClassification(exit.classification),
    }
    this.statusByInstance.set(instanceId, status)
    this.sessions.delete(handle.sessionId)

    const report: LaunchExitReport = {
      sessionId: exit.sessionId,
      instanceId,
      exitCode: exit.exitCode,
      signal: exit.signal,
      startedAt: exit.startedAt,
      exitedAt: exit.exitedAt,
      durationMs: exit.durationMs,
      classification: exit.classification,
      crashHints: exit.crashHints,
      logFile: exit.logFile,
      lastLines: exit.lastLines,
    }
    this.reportByInstance.set(instanceId, report)

    this.emitStatus(status)
    this.emit('exited', {
      sessionId: exit.sessionId,
      exitCode: exit.exitCode,
      classification: exit.classification,
      durationMs: exit.durationMs,
    })
    this.logger.info('game process exited', {
      instanceId,
      exitCode: exit.exitCode,
      signal: exit.signal,
      durationMs: exit.durationMs,
      classification: exit.classification,
      hints: exit.crashHints.map((hint) => hint.id),
      logFile: exit.logFile,
    })
  }

  async stop(sessionId: string): Promise<{ ok: boolean }> {
    const session = this.sessions.get(sessionId)
    if (!session) return { ok: false }
    await session.handle.stop()
    return { ok: true }
  }

  status(instanceId: string): LaunchStatus {
    const known = this.statusByInstance.get(instanceId)
    if (known) return { ...known }
    return {
      instanceId,
      state: IDLE_STATE,
      sessionId: null,
      startedAt: null,
      exitCode: null,
      durationMs: null,
      reportReady: false,
    }
  }

  lastReport(instanceId: string): LaunchExitReport | null {
    return this.reportByInstance.get(instanceId) ?? null
  }

  /** Stops every running game; used on application quit. */
  async stopAll(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((session) => session.handle.stop()))
  }

  hasRunningSessions(): boolean {
    return this.sessions.size > 0
  }

  /** Last-resort synchronous shutdown for `will-quit`, where async cleanup can
   * no longer complete. Uses taskkill /T /F on Windows. */
  stopAllSync(): void {
    for (const session of this.sessions.values()) {
      const pid = session.handle.pid
      if (!pid) continue
      try {
        if (process.platform === 'win32') {
          spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
            windowsHide: true,
            stdio: 'ignore',
            timeout: 3_000,
          })
        } else {
          process.kill(pid, 'SIGKILL')
        }
      } catch {
        // Best effort: the process may have exited between the check and kill.
      }
    }
  }

  private emitStatus(status: LaunchStatus): void {
    this.emit('status', { ...status })
  }

  private emitStage(
    instanceId: string,
    stage: 'precheck' | 'java' | 'args' | 'spawn',
    detail: string | null,
  ): void {
    this.emit('stage', { instanceId, stage, detail })
  }
}

export type { LaunchPlanCore }

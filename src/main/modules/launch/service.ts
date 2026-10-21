import type {
  LaunchExitReport,
  LaunchPlan,
  LaunchSettings,
  LaunchSettingsPatch,
  LaunchStatus,
} from '@shared/launch'
import type { ScopedLogger } from '../../kernel/logger'
import type { ModuleRoots } from '../_context'
import { CoreError } from '../../core/errors'
import type { AuthlibInjection, LaunchAccount } from '../../core/launch/args'
import { AppError } from '@shared/errors'
import {
  LaunchOrchestrator,
  type LaunchRequestInput,
} from '../../core/launch/orchestrator'
import { loadLaunchSettings, saveLaunchSettings } from './settings'

/** Version is injected by the shell once it can read app.getVersion(). */
export const DEFAULT_APP_VERSION = process.env.MCL_APP_VERSION ?? '0.1.0'

export class LaunchModuleService {
  private orchestrator: LaunchOrchestrator | null = null
  private accountResolver: ((accountId: string | null) => Promise<LaunchAccount | null>) | null =
    null
  private authlibResolver:
    | ((instance: unknown, account: LaunchAccount) => Promise<AuthlibInjection | null>)
    | null = null

  constructor(
    private readonly roots: ModuleRoots,
    private readonly log: ScopedLogger,
    private readonly appVersion: string = DEFAULT_APP_VERSION,
  ) {}

  private requireOrchestrator(): LaunchOrchestrator {
    if (!this.roots.mcRoot) {
      throw new CoreError('INSTANCE.NOT_FOUND', {
        message: 'minecraft root is not configured',
        userMessage: '还没有选择 .minecraft 目录',
        hint: '用 --mc-dir 指定，或在设置页选择目录',
      })
    }
    if (!this.orchestrator) {
      this.orchestrator = new LaunchOrchestrator({
        dataRoot: this.roots.dataRoot,
        mcRoot: this.roots.mcRoot,
        appVersion: this.appVersion,
        logger: {
          info: (message, fields) => this.log.info(message, fields),
          warn: (message, fields) => this.log.warn(message, fields),
          error: (message, fields) => this.log.error(message, fields),
        },
        resolveAccount: this.accountResolver ?? undefined,
        ...(this.authlibResolver ? { resolveAuthlib: this.authlibResolver } : {}),
      })
    }
    return this.orchestrator
  }

  /** t11 wires the auth service here; until then launch fails honestly. */
  setAccountResolver(
    resolver: (accountId: string | null) => Promise<LaunchAccount | null>,
  ): void {
    this.accountResolver = resolver
    this.orchestrator?.setAccountResolver(resolver)
  }

  async plan(input: LaunchRequestInput & { dryRun?: boolean }): Promise<LaunchPlan> {
    return this.requireOrchestrator().plan(input)
  }

  async start(input: LaunchRequestInput): Promise<{ sessionId: string }> {
    const settings = loadLaunchSettings(this.roots.dataRoot)
    return this.requireOrchestrator().start({
      ...input,
      gameLanguage: settings.language,
    })
  }

  getSettings(): LaunchSettings {
    return loadLaunchSettings(this.roots.dataRoot)
  }

  setLanguage(input: LaunchSettingsPatch): LaunchSettings {
    try {
      return saveLaunchSettings(this.roots.dataRoot, input)
    } catch (error) {
      throw new AppError('LAUNCH.INVALID_LANGUAGE', '游戏语言代码不合法', {
        details: {
          value: input.language,
          hint: '请选择内置语言，或输入类似 zh_cn、en_us 的 Minecraft 语言代码。',
          cause: error instanceof Error ? error.message : String(error),
        },
      })
    }
  }

  async stop(sessionId: string): Promise<{ ok: boolean }> {
    return this.requireOrchestrator().stop(sessionId)
  }

  status(instanceId: string): LaunchStatus {
    if (!this.orchestrator) {
      return {
        instanceId,
        state: 'idle',
        sessionId: null,
        startedAt: null,
        exitCode: null,
        durationMs: null,
        reportReady: false,
      }
    }
    return this.orchestrator.status(instanceId)
  }

  lastReport(instanceId: string): LaunchExitReport | null {
    return this.orchestrator?.lastReport(instanceId) ?? null
  }

  onEvent(event: 'status' | 'stage' | 'output' | 'exited', listener: (payload: unknown) => void): () => void {
    const orchestrator = this.requireOrchestrator()
    orchestrator.on(event, listener)
    return () => orchestrator.off(event, listener)
  }

  async stopAll(): Promise<void> {
    await this.orchestrator?.stopAll()
  }

  hasRunningSessions(): boolean {
    return this.orchestrator?.hasRunningSessions() ?? false
  }

  stopAllSync(): void {
    this.orchestrator?.stopAllSync()
  }

  /** Public counterpart used by the auth module for Authlib -javaagent injection. */
  setAuthlibResolver(
    resolver: (instance: unknown, account: LaunchAccount) => Promise<AuthlibInjection | null>,
  ): void {
    this.authlibResolver = resolver
    this.orchestrator?.setAuthlibResolver(resolver)
  }
}

export function createLaunchService(
  roots: ModuleRoots,
  log: ScopedLogger,
  appVersion: string = DEFAULT_APP_VERSION,
): LaunchModuleService {
  return new LaunchModuleService(roots, log, appVersion)
}

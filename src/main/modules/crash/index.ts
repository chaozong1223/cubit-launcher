import { app, dialog, Notification } from 'electron'
import { openPathInShell, openUrlInShell } from '../../core/open-path'
import type { ModuleContext } from '../_registry'
import { getService, publishService } from '../_services'
import { resolveModuleRoots } from '../_context'
import { moduleIpc, type ModuleHandlers } from '../../kernel/ipc'
import { crashContract } from '@shared/crash'
import type { CrashReportResult } from '@shared/crash'
import type { LaunchExitReport } from '@shared/launch'
import { makeHandlers } from './handlers'
import { createCrashService, type CrashModuleService } from './service'

export const moduleId = 'crash'

interface LaunchServiceLike {
  onEvent(event: string, listener: (payload: unknown) => void): () => void
  lastReport(instanceId: string): LaunchExitReport | null
}

function showCrashPrompt(result: CrashReportResult, log: ModuleContext['log']): void {
  const message = `游戏崩溃：${result.analysis.instanceId ?? '未知实例'}`
  const detail = `${result.analysis.phenomenon}\n\n${result.analysis.likelyCause}\n\n报告：${result.reportPath}`
  try {
    if (Notification.isSupported()) {
      const notification = new Notification({ title: message, body: detail.slice(0, 500) })
      notification.on('click', () => {
        void openPathInShell(result.reportPath)
      })
      notification.show()
      log.info('crash prompt shown', { mode: 'notification', reportPath: result.reportPath })
      return
    }
  } catch (error) {
    log.warn('crash notification failed', {
      message: error instanceof Error ? error.message : String(error),
    })
  }
  void dialog
    .showMessageBox({
      type: 'error',
      title: message,
      message,
      detail,
      buttons: ['查看报告', '关闭'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    })
    .then((response) => {
      if (response.response === 0) void openPathInShell(result.reportPath)
    })
    .catch(() => undefined)
  log.info('crash prompt shown', { mode: 'dialog', reportPath: result.reportPath })
}

/**
 * t48 B4: subscribe to launch status and persist/prompt on `crashed`.
 * crash registers before launch, so wiring is deferred like auth.
 */
function wireLaunch(service: CrashModuleService, log: ModuleContext['log'], attempt = 0): void {
  const launch = getService<LaunchServiceLike>('launch')
  if (!launch) {
    if (attempt < 300) setTimeout(() => wireLaunch(service, log, attempt + 1), 1000).unref?.()
    return
  }
  const handled = new Set<string>()
  try {
    launch.onEvent('status', (payload) => {
      const event = payload as {
        instanceId?: unknown
        state?: unknown
        sessionId?: unknown
        exitCode?: unknown
      }
      if (event.state !== 'crashed' || typeof event.instanceId !== 'string') return
      const key = `${event.instanceId}:${String(event.sessionId ?? '')}`
      if (handled.has(key)) return
      handled.add(key)
      const report = launch.lastReport(event.instanceId)
      const exitCode =
        typeof event.exitCode === 'number'
          ? event.exitCode
          : report?.exitCode ?? null
      void service
        .handleCrash({
          instanceId: event.instanceId,
          exitCode,
        })
        .then((result) => showCrashPrompt(result, log))
        .catch((error) => {
          log.warn('crash auto analysis failed', {
            instanceId: event.instanceId,
            message: error instanceof Error ? error.message : String(error),
          })
        })
    })
    log.info('crash launch bridge wired')
  } catch (error) {
    if (attempt < 300) {
      setTimeout(() => wireLaunch(service, log, attempt + 1), 1000).unref?.()
      return
    }
    log.warn('crash launch bridge unavailable', {
      message: error instanceof Error ? error.message : String(error),
    })
  }
}

export function register(ctx: ModuleContext): void {
  const roots = resolveModuleRoots(ctx.dataRoot)
  const service = createCrashService({
    roots,
    log: ctx.log,
    appVersion: app.getVersion(),
    openPath: (target) => openPathInShell(target),
    openExternal: (url) => openUrlInShell(url),
  })

  publishService(moduleId, service)
  moduleIpc.handle(crashContract, makeHandlers(service) as unknown as ModuleHandlers)
  service.onEvent('changed', (payload) => {
    moduleIpc.emit(moduleId, 'changed', payload)
  })
  service.onEvent('detected', (payload) => {
    moduleIpc.emit(moduleId, 'detected', payload)
  })

  setTimeout(() => wireLaunch(service, ctx.log), 0)
  ctx.log.info('module registered', { mcRoot: roots.mcRoot ? 'configured' : 'missing' })
}

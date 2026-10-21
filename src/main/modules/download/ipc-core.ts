import type { ZodType } from 'zod'
import {
  DOWNLOAD_CHANNELS,
  DOWNLOAD_EVENTS,
  downloadContract,
  type DownloadProgress,
} from '@shared/download'
import { ERROR_CODES } from '@shared/errors'
import type { AppErrorShape, Result } from '@shared/kernel'
import { makeHandlers, type DownloadHandlers } from './handlers'
import type { DownloadService } from './service'

/**
 * Electron-free IPC core so the channel wiring, sender check, Result envelope
 * and event forwarding can be unit-tested in plain Node.
 *
 * `ipc.ts` is the thin Electron adapter (global `ipcMain`, `webContents`).
 * Production and test use the exact same registration table, which is why a
 * contract method can never silently lack a handler.
 */

export interface IpcEventLike {
  senderFrame?: { url?: string } | null
  sender: { getURL(): string }
}

export interface IpcMainLike {
  handle(
    channel: string,
    listener: (event: IpcEventLike, payload?: unknown) => unknown,
  ): void
  removeHandler(channel: string): void
}

export interface IpcLogger {
  info(message: string, fields?: Record<string, unknown>): void
  warn(message: string, fields?: Record<string, unknown>): void
  error(message: string, fields?: Record<string, unknown>): void
}

export interface DownloadIpcCoreDeps {
  ipc: IpcMainLike
  broadcast(channel: string, payload: unknown): void
  service: DownloadService
  log: IpcLogger
  /** Sender URL policy (production: kernel `isTrustedUrl`). */
  isTrustedSenderUrl(url: string): boolean
  toErrorShape(error: unknown, fallback: string): AppErrorShape
  /** Validate handler output against the contract (dev/test). */
  validateOutput?: boolean
}

export interface DownloadIpcCoreHandle {
  channels: string[]
  dispose(): void
}

function failure(code: string, message: string, retryable = false): Result<never> {
  return { ok: false, error: { code, message, retryable } }
}

function senderUrl(event: IpcEventLike): string {
  try {
    return event.senderFrame?.url || event.sender.getURL()
  } catch {
    return ''
  }
}

function isSecondHandlerError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /second handler|already registered|Attempted to register/i.test(message)
}

export function registerDownloadIpcCore(deps: DownloadIpcCoreDeps): DownloadIpcCoreHandle {
  const handlers = makeHandlers(deps.service)
  const registered: string[] = []

  const register = <TIn, TOut>(
    channel: string,
    inputSchema: ZodType<TIn>,
    outputSchema: ZodType<TOut>,
    handler: (event: IpcEventLike, input: TIn) => Promise<TOut> | TOut,
  ): void => {
    try {
      deps.ipc.handle(channel, async (event, rawInput): Promise<Result<TOut>> => {
        const url = senderUrl(event)
        if (!deps.isTrustedSenderUrl(url)) {
          deps.log.warn('blocked untrusted download IPC sender', { channel, url })
          return failure(ERROR_CODES.IPC_UNTRUSTED_SENDER, '调用来源未通过校验')
        }

        const parsed = inputSchema.safeParse(rawInput)
        if (!parsed.success) {
          deps.log.warn('invalid download IPC input', {
            channel,
            paths: parsed.error.issues.map((issue) => issue.path.join('.')),
          })
          return failure(ERROR_CODES.IPC_INVALID_INPUT, `参数不合法：${channel}`)
        }

        try {
          const data = await handler(event, parsed.data as TIn)
          if (deps.validateOutput) outputSchema.parse(data)
          return { ok: true, data }
        } catch (error) {
          const shape = deps.toErrorShape(error, ERROR_CODES.IPC_HANDLER_FAILED)
          deps.log.error('download IPC handler failed', {
            channel,
            code: shape.code,
            message: shape.message,
            retryable: shape.retryable,
          })
          return { ok: false, error: shape }
        }
      })
      registered.push(channel)
    } catch (error) {
      if (isSecondHandlerError(error)) {
        deps.log.warn('download IPC channel already registered; keeping the existing handler', {
          channel,
        })
        return
      }
      throw error
    }
  }

  const methods = downloadContract.methods
  const bridge: DownloadHandlers = handlers

  register(DOWNLOAD_CHANNELS.listSources, methods.listSources.input, methods.listSources.output, async () =>
    bridge.listSources(),
  )
  register(DOWNLOAD_CHANNELS.getSettings, methods.getSettings.input, methods.getSettings.output, async () =>
    bridge.getSettings(),
  )
  register(
    DOWNLOAD_CHANNELS.updateSettings,
    methods.updateSettings.input,
    methods.updateSettings.output,
    async (_event, input) => bridge.updateSettings(input),
  )
  register(
    DOWNLOAD_CHANNELS.fetchManifest,
    methods.fetchManifest.input,
    methods.fetchManifest.output,
    async (_event, input) => bridge.fetchManifest(input),
  )
  register(DOWNLOAD_CHANNELS.plan, methods.plan.input, methods.plan.output, async (_event, input) =>
    bridge.plan(input),
  )
  register(DOWNLOAD_CHANNELS.install, methods.install.input, methods.install.output, async (_event, input) =>
    bridge.install(input),
  )
  register(DOWNLOAD_CHANNELS.repair, methods.repair.input, methods.repair.output, async (_event, input) =>
    bridge.repair(input),
  )
  register(DOWNLOAD_CHANNELS.enqueue, methods.enqueue.input, methods.enqueue.output, async (_event, input) =>
    bridge.enqueue(input),
  )
  register(DOWNLOAD_CHANNELS.cancel, methods.cancel.input, methods.cancel.output, async (_event, input) =>
    bridge.cancel(input),
  )
  register(DOWNLOAD_CHANNELS.pause, methods.pause.input, methods.pause.output, async (_event, input) =>
    bridge.pause(input),
  )
  register(DOWNLOAD_CHANNELS.resume, methods.resume.input, methods.resume.output, async (_event, input) =>
    bridge.resume(input),
  )
  register(DOWNLOAD_CHANNELS.list, methods.list.input, methods.list.output, async () => bridge.list())
  register(DOWNLOAD_CHANNELS.status, methods.status.input, methods.status.output, async (_event, input) =>
    bridge.status(input),
  )
  register(
    DOWNLOAD_CHANNELS.listProviders,
    methods.listProviders.input,
    methods.listProviders.output,
    async () => bridge.listProviders(),
  )
  register(
    DOWNLOAD_CHANNELS.projectPage,
    methods.projectPage.input,
    methods.projectPage.output,
    async (_event, input) => bridge.projectPage(input),
  )

  const unsubscribeProgress = deps.service.onProgress((progress: DownloadProgress) => {
    deps.broadcast(DOWNLOAD_EVENTS.progress, progress)
  })
  const unsubscribeFinished = deps.service.onFinished((finished) => {
    deps.broadcast(DOWNLOAD_EVENTS.finished, finished)
  })

  deps.log.info('download IPC registered', { channels: registered })

  return {
    channels: registered,
    dispose() {
      unsubscribeProgress()
      unsubscribeFinished()
      for (const channel of registered) {
        try {
          deps.ipc.removeHandler(channel)
        } catch {
          /* best effort */
        }
      }
      registered.length = 0
    },
  }
}

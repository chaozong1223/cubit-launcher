/// <reference types="vite/client" />
import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { ZodType } from 'zod'
import { z } from 'zod'
import { CHANNELS, type RendererReadyReport } from '@shared/channels'
import { ERROR_CODES, AppError } from '@shared/errors'
import {
  channelOf,
  eventChannelOf,
  type ContractDef,
  type Result,
} from '@shared/kernel'
import { RendererReadySchema, systemContract, type AppInfo } from '@shared/system'
import { contract as instanceContract } from '@shared/instance'
import { contract as versionContract } from '@shared/version'
import { contract as javaContract } from '@shared/java'
import { contract as launchContract } from '@shared/launch'
import { contract as netContract } from '@shared/net'
import type { Logger } from './logger'
import { isTrustedUrl } from './security'
import { getService } from '../modules/_services'
import { toHandlerErrorShape } from './error-shape'

export interface IpcDependencies {
  getInfo: () => AppInfo
  openDataDir: () => Promise<{ opened: boolean }>
  onRendererReady: (report: RendererReadyReport) => void
  log: Logger
}

/** A module contract handler: input already validated by the contract schema. */
export type ModuleHandler = (input: unknown, event: IpcMainInvokeEvent) => unknown
export type ModuleHandlers = Record<string, ModuleHandler>

type RegisterMethod = <TIn, TOut>(
  channel: string,
  inputSchema: ZodType<TIn>,
  outputSchema: ZodType<TOut>,
  handler: (event: IpcMainInvokeEvent, input: TIn) => Promise<TOut> | TOut,
) => void

type LooseHandler = (...args: never[]) => unknown
type HandlerFactory = (service: never) => Record<string, LooseHandler>

/**
 * Contracts that ship with the kernel build. A future module can either be
 * added here or — without touching this frozen file — import `moduleIpc` and
 * call `moduleIpc.handle(contract, handlers)` from its own `register()`.
 *
 * Static imports are deliberate: a syntax error in an unrelated shared contract
 * must not crash the whole main process at boot (a failing module is contained).
 */
const BUILTIN_CONTRACTS = new Map<string, ContractDef>([
  [instanceContract.id, instanceContract],
  [versionContract.id, versionContract],
  [javaContract.id, javaContract],
  [launchContract.id, launchContract],
  [netContract.id, netContract],
])

const HANDLER_FACTORIES = import.meta.glob<{ makeHandlers?: HandlerFactory }>(
  '../modules/*/handlers.ts',
  { eager: true },
)

/**
 * A module that ships `modules/<id>/ipc.ts` owns its channel registration
 * (some modules, e.g. download, need custom envelope/sender handling). The
 * kernel must not install a second `ipcMain.handle` for the same channel.
 */
const SELF_MANAGED_IPC = import.meta.glob('../modules/*/ipc.ts')

function moduleIdFromPath(key: string, suffix: string): string | null {
  const normalized = key.replaceAll('\\', '/')
  const match = new RegExp(`modules/([^/]+)/${suffix}$`).exec(normalized)
  return match?.[1] ?? null
}

const SELF_MANAGED_MODULES = new Set(
  Object.keys(SELF_MANAGED_IPC)
    .map((key) => moduleIdFromPath(key, 'ipc\\.ts'))
    .filter((id): id is string => typeof id === 'string'),
)

function moduleIdFromHandlerPath(key: string): string | null {
  return moduleIdFromPath(key, 'handlers\\.ts')
}

function eventKey(payload: unknown): string {
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>
    for (const key of ['key', 'sessionId', 'instanceId']) {
      const value = record[key]
      if (typeof value === 'string' && value.length > 0) return value
    }
  }
  return ''
}

interface Registration {
  contract: ContractDef
  handlers: ModuleHandlers
}

/**
 * Kernel-side registry for module IPC.
 *
 * Modules are auto-wired from their contract + handler factory after
 * `registerModules()` has published services. `handle()` is also public for a
 * module that wants to register manually (the docs/03 §4.4 `ctx.ipc` surface;
 * the frozen t5 registry cannot inject it into the context object).
 */
class ModuleIpcRegistry {
  private deps: IpcDependencies | null = null
  private registerMethod: RegisterMethod | null = null
  private readonly registrations = new Map<string, Registration>()
  private readonly installed = new Set<string>()
  private readonly pendingEvents = new Map<string, { timer: NodeJS.Timeout; payload: unknown }>()

  handle(contract: ContractDef, handlers: ModuleHandlers): void {
    if (!contract || typeof contract.id !== 'string' || !contract.methods) {
      throw new AppError(ERROR_CODES.KERNEL_MODULE_FAILED, 'invalid module contract')
    }
    if (this.registrations.has(contract.id)) {
      throw new AppError(
        ERROR_CODES.KERNEL_MODULE_FAILED,
        `duplicate IPC contract: ${contract.id}`,
      )
    }
    for (const method of Object.keys(contract.methods)) {
      if (typeof handlers[method] !== 'function') {
        throw new AppError(
          ERROR_CODES.KERNEL_MODULE_FAILED,
          `contract ${contract.id} method ${method} has no handler`,
        )
      }
    }

    const registration: Registration = { contract, handlers }
    this.registrations.set(contract.id, registration)
    if (this.registerMethod) this.install(registration)
  }

  bind(deps: IpcDependencies, registerMethod: RegisterMethod): void {
    this.deps = deps
    this.registerMethod = registerMethod
    for (const registration of this.registrations.values()) {
      try {
        this.install(registration)
      } catch (error) {
        deps.log.error('ipc', 'module channel install failed', {
          module: registration.contract.id,
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }

  private install(registration: Registration): void {
    const registerMethod = this.registerMethod
    if (!registerMethod) return

    for (const [method, definition] of Object.entries(registration.contract.methods)) {
      const channel = channelOf(registration.contract.id, method)
      if (this.installed.has(channel)) {
        throw new AppError(
          ERROR_CODES.KERNEL_MODULE_FAILED,
          `duplicate IPC channel: ${channel}`,
        )
      }
      const handler = registration.handlers[method]
      registerMethod(channel, definition.input, definition.output, async (event, input) => {
        // The handler receives the zod-parsed input; the event is provided for
        // future sender-scoped features (window control, per-window state).
        return (await handler(input, event)) as never
      })
      this.installed.add(channel)
    }
  }

  /**
   * Pushes a contract event to every live window. Payloads are validated against
   * the contract schema; throttled events coalesce by session/instance key.
   */
  emit(moduleId: string, eventName: string, payload: unknown): number {
    const registration = this.registrations.get(moduleId)
    if (!registration) {
      this.deps?.log.warn('ipc', 'event for unregistered module', { moduleId, event: eventName })
      return 0
    }
    const definition = registration.contract.events[eventName]
    if (!definition) {
      this.deps?.log.warn('ipc', 'event not declared by contract', { moduleId, event: eventName })
      return 0
    }

    const parsed = definition.payload.safeParse(payload)
    if (!parsed.success) {
      this.deps?.log.warn('ipc', 'invalid event payload', {
        moduleId,
        event: eventName,
        paths: parsed.error.issues.map((issue) => issue.path.join('.')),
      })
      return 0
    }

    const channel = eventChannelOf(moduleId, eventName)
    const throttleMs = definition.throttleMs ?? 0
    if (throttleMs <= 0) return this.send(channel, parsed.data)

    const key = `${channel}:${eventKey(parsed.data)}`
    const pending = this.pendingEvents.get(key)
    if (pending) {
      pending.payload = parsed.data
      return 1
    }
    const timer = setTimeout(() => {
      const item = this.pendingEvents.get(key)
      this.pendingEvents.delete(key)
      if (item) this.send(channel, item.payload)
    }, throttleMs)
    timer.unref?.()
    this.pendingEvents.set(key, { timer, payload: parsed.data })
    return 1
  }

  private send(channel: string, payload: unknown): number {
    let sent = 0
    try {
      for (const win of BrowserWindow.getAllWindows()) {
        if (win.isDestroyed()) continue
        const contents = win.webContents
        if (!contents || contents.isDestroyed()) continue
        contents.send(channel, payload)
        sent += 1
      }
    } catch {
      // App is quitting or the window list is unavailable.
    }
    return sent
  }

  /** Every channel declared by a registered contract (bound or not yet bound). */
  channels(): { invoke: string[]; events: string[] } {
    const invoke: string[] = []
    const events: string[] = []
    for (const { contract } of this.registrations.values()) {
      for (const method of Object.keys(contract.methods)) invoke.push(channelOf(contract.id, method))
      for (const event of Object.keys(contract.events)) events.push(eventChannelOf(contract.id, event))
    }
    return { invoke: invoke.sort(), events: events.sort() }
  }

  has(moduleId: string): boolean {
    return this.registrations.has(moduleId)
  }
}

export const moduleIpc = new ModuleIpcRegistry()

function subscribeModuleEvents(contract: ContractDef, service: unknown): void {
  if (!service || typeof service !== 'object') return
  const onEvent = (service as { onEvent?: unknown }).onEvent
  if (typeof onEvent !== 'function') return

  for (const eventName of Object.keys(contract.events)) {
    try {
      ;(
        onEvent as (event: string, listener: (payload: unknown) => void) => () => void
      ).call(service, eventName, (payload) => {
        moduleIpc.emit(contract.id, eventName, payload)
      })
    } catch {
      // A module may not expose every contract event yet; skip that one.
    }
  }
}

/**
 * Discovers module contracts and handler factories, resolves the service that
 * `registerModules()` published, and registers every method/event. Failures are
 * isolated per module: one broken module must not take the IPC bridge down.
 */
export function autoRegisterModuleIpc(log: Logger): string[] {
  const registered: string[] = []
  const entries = Object.entries(HANDLER_FACTORIES).sort(([a], [b]) => a.localeCompare(b))

  for (const [handlerPath, module] of entries) {
    const moduleId = moduleIdFromHandlerPath(handlerPath)
    if (!moduleId) continue
    if (SELF_MANAGED_MODULES.has(moduleId)) {
      log.debug('ipc', 'module owns its IPC registration; kernel skips', {
        module: moduleId,
      })
      continue
    }
    // A module may have registered itself during register(); do not double-install.
    if (moduleIpc.has(moduleId)) {
      registered.push(moduleId)
      continue
    }
    const contract = BUILTIN_CONTRACTS.get(moduleId)
    const factory = module.makeHandlers
    if (!contract) {
      log.warn('ipc', 'module has no kernel contract mapping', {
        module: moduleId,
        handlerPath,
        hint: 'import { moduleIpc } and call handle(contract, handlers) in register()',
      })
      continue
    }
    if (typeof factory !== 'function') {
      log.warn('ipc', 'module has no makeHandlers export', { module: moduleId, handlerPath })
      continue
    }

    const service = getService<never>(moduleId)
    if (!service) {
      log.warn('ipc', 'module service missing; IPC channels not registered', {
        module: moduleId,
      })
      continue
    }

    try {
      const handlers = factory(service) as unknown as ModuleHandlers
      moduleIpc.handle(contract, handlers)
      subscribeModuleEvents(contract, service)
      registered.push(moduleId)
      log.info('ipc', 'module channels registered', {
        module: moduleId,
        methods: Object.keys(contract.methods).length,
        events: Object.keys(contract.events).length,
      })
    } catch (error) {
      log.error('ipc', 'module IPC registration failed', {
        module: moduleId,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return registered
}

function senderUrl(event: IpcMainInvokeEvent): string {
  try {
    return event.senderFrame?.url || event.sender.getURL()
  } catch {
    return ''
  }
}

function failure(code: string, message: string, retryable = false): Result<never> {
  return { ok: false, error: { code, message, retryable } }
}

/**
 * Registers every channel the preload may invoke:
 *   - static kernel channels (`CHANNELS`);
 *   - every method of every auto-registered module contract.
 *
 * All handlers share the same envelope: sender check → zod input → handler →
 * (dev) zod output → `{ ok: true, data }` / `{ ok: false, error }`. An exception
 * must never cross IPC.
 */
export function registerIpc(deps: IpcDependencies): void {
  const register: RegisterMethod = <TIn, TOut>(
    channel: string,
    inputSchema: ZodType<TIn>,
    outputSchema: ZodType<TOut>,
    handler: (event: IpcMainInvokeEvent, input: TIn) => Promise<TOut> | TOut,
  ): void => {
    ipcMain.handle(channel, async (event, rawInput): Promise<Result<TOut>> => {
      const url = senderUrl(event)
      if (!isTrustedUrl(url)) {
        deps.log.warn('ipc', 'blocked untrusted sender', { channel, url })
        return failure(ERROR_CODES.IPC_UNTRUSTED_SENDER, '调用来源未通过校验')
      }

      const parsed = inputSchema.safeParse(rawInput)
      if (!parsed.success) {
        const paths = parsed.error.issues.map((issue) => issue.path.join('.'))
        deps.log.warn('ipc', 'invalid input', { channel, paths })
        return failure(ERROR_CODES.IPC_INVALID_INPUT, `参数不合法：${channel}`)
      }

      try {
        const data = await handler(event, parsed.data)
        // Output self-check runs in development only; production trusts handlers.
        if (!app.isPackaged) outputSchema.parse(data)
        return { ok: true, data }
      } catch (error) {
        const shape = toHandlerErrorShape(error, ERROR_CODES.IPC_HANDLER_FAILED)
        deps.log.error('ipc', 'handler failed', { channel, code: shape.code, message: shape.message })
        return { ok: false, error: shape }
      }
    })
  }

  register(CHANNELS.systemInfo, z.void(), systemContract.methods.info.output, () => deps.getInfo())

  register(
    CHANNELS.systemOpenDataDir,
    z.void(),
    systemContract.methods.openDataDir.output,
    async () => deps.openDataDir(),
  )

  const fileFilterSchema = z.object({
    name: z.string().min(1).max(64),
    extensions: z.array(z.string().min(1).max(16)).min(1).max(16),
  })
  const pickFilesInput = z
    .object({
      title: z.string().min(1).max(128).optional(),
      multi: z.boolean().optional(),
      filters: z.array(fileFilterSchema).max(16).optional(),
    })
    .default({})
  const pickFilesOutput = z.object({
    cancelled: z.boolean(),
    paths: z.array(z.string()),
  })
  const pickSaveInput = z
    .object({
      title: z.string().min(1).max(128).optional(),
      defaultPath: z.string().min(1).max(4096).optional(),
      filters: z.array(fileFilterSchema).max(16).optional(),
    })
    .default({})
  const pickSaveOutput = z.object({
    cancelled: z.boolean(),
    path: z.string().nullable(),
  })

  /**
   * Create a directory (recursively) chosen by the user, e.g. a fresh
   * `.minecraft` root. Only an absolute path is accepted; the OS decides
   * whether the location is writable.
   */
  register(
    CHANNELS.systemEnsureDirectory,
    z.object({ path: z.string().min(1).max(1024) }),
    z.object({ path: z.string(), created: z.boolean() }),
    async (_event, input) => {
      const target = path.resolve(input.path)
      if (!path.isAbsolute(target)) {
        throw new AppError(ERROR_CODES.IPC_INVALID_INPUT, '必须使用绝对路径', {
          details: { path: input.path },
        })
      }
      const existed = fs.existsSync(target)
      try {
        if (!fs.existsSync(target)) fs.mkdirSync(target, { recursive: true })
      } catch (error) {
        throw new AppError(ERROR_CODES.INTERNAL, '无法创建目录', {
          details: { path: target, message: error instanceof Error ? error.message : String(error) },
        })
      }
      return { path: target, created: !existed }
    },
  )

  register(CHANNELS.systemPickFiles, pickFilesInput, pickFilesOutput, async (event, input) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const properties: Array<'openFile' | 'multiSelections'> = ['openFile']
    if (input.multi) properties.push('multiSelections')
    const options: Electron.OpenDialogOptions = { properties }
    if (input.title) options.title = input.title
    if (input.filters) options.filters = input.filters
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)
    // Cancel is a normal outcome, never an error the renderer must report.
    return result.canceled
      ? { cancelled: true, paths: [] }
      : { cancelled: false, paths: result.filePaths }
  })

  register(CHANNELS.systemPickSaveFile, pickSaveInput, pickSaveOutput, async (event, input) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const options: Electron.SaveDialogOptions = {}
    if (input.title) options.title = input.title
    if (input.defaultPath) options.defaultPath = input.defaultPath
    if (input.filters) options.filters = input.filters
    const result = win
      ? await dialog.showSaveDialog(win, options)
      : await dialog.showSaveDialog(options)
    return result.canceled || !result.filePath
      ? { cancelled: true, path: null }
      : { cancelled: false, path: result.filePath }
  })

  // Required by the t5 acceptance contract. Kept as a small legacy channel in
  // addition to the typed `mc:system:info` contract.
  register(CHANNELS.appGetVersion, z.void(), z.string(), () => app.getVersion())

  const windowResult = z.object({ ok: z.boolean(), maximized: z.boolean() })

  register(CHANNELS.windowMinimize, z.void(), z.object({ ok: z.boolean() }), (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize()
    return { ok: true }
  })

  register(CHANNELS.windowMaximize, z.void(), windowResult, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) throw new AppError(ERROR_CODES.IPC_HANDLER_FAILED, '窗口不存在')
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
    return { ok: true, maximized: win.isMaximized() }
  })

  register(CHANNELS.windowClose, z.void(), z.object({ ok: z.boolean() }), (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close()
    return { ok: true }
  })

  register(CHANNELS.windowIsMaximized, z.void(), z.boolean(), (event) => {
    return BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false
  })

  register(
    CHANNELS.appRendererReady,
    RendererReadySchema,
    z.object({ ack: z.boolean() }),
    (_event, report) => {
      deps.log.info('ipc', 'renderer handshake', {
        version: report.version,
        errors: report.errors.length,
        nodeRequire: report.nodeRequire,
        nodeProcess: report.nodeProcess,
        blockedChannelRejected: report.blockedChannelRejected,
      })
      deps.onRendererReady(report)
      return { ack: true }
    },
  )

  // Modules registered before this function ran; discover them now. The
  // registry stays open for later (lazy/optional) modules too.
  const moduleIds = autoRegisterModuleIpc(deps.log)
  moduleIpc.bind(deps, register)
  const moduleChannels = moduleIpc.channels()

  deps.log.info('ipc', 'module IPC bridge ready', {
    modules: moduleIds,
    moduleInvokeChannels: moduleChannels.invoke.length,
    moduleEventChannels: moduleChannels.events.length,
  })
  deps.log.debug('ipc', 'channels registered', {
    static: Object.values(CHANNELS),
    modules: moduleIds,
    moduleInvoke: moduleChannels.invoke,
    moduleEvents: moduleChannels.events,
  })
}

/** Diagnostics and tests: every module channel currently declared. */
export function registeredModuleChannels(): { invoke: string[]; events: string[] } {
  return moduleIpc.channels()
}

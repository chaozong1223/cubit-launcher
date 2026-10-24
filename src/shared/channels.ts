/**
 * Stable IPC channel names shared by main, preload and renderer.
 *
 * Two kinds of channels exist:
 *
 * 1. **Static kernel channels** (`CHANNELS`) — system/window/app bootstrap.
 * 2. **Module channels** — every module contract in `src/shared/<id>.ts`
 *    contributes `mc:<id>:<method>` and `mc:<id>:evt:<event>`.
 *
 * In t5 the preload hard-coded the static list. From t20 the preload only
 * enforces the *shape* of a module channel; the main process still rejects every
 * channel that has no registered handler. Adding a module therefore never
 * requires editing preload source, while `fs:readFile` style probes stay blocked.
 */
export const CHANNELS = {
  systemInfo: 'mc:system:info',
  systemOpenDataDir: 'mc:system:openDataDir',
  systemPickFiles: 'mc:system:pickFiles',
  systemPickSaveFile: 'mc:system:pickSaveFile',
  systemEnsureDirectory: 'mc:system:ensureDirectory',
  systemPickDirectory: 'mc:system:pickDirectory',
  systemCreateDirectoryDialog: 'mc:system:createDirectoryDialog',
  systemElevation: 'mc:system:elevation',
  systemRelaunchAsAdmin: 'mc:system:relaunchAsAdmin',
  appGetVersion: 'app:getVersion',
  appRendererReady: 'app:renderer-ready',
  windowMinimize: 'mc:window:minimize',
  windowMaximize: 'mc:window:maximize',
  windowClose: 'mc:window:close',
  windowIsMaximized: 'mc:window:isMaximized',
} as const

export interface FileDialogFilter {
  name: string
  extensions: string[]
}

export interface PickFilesRequest {
  title?: string
  multi?: boolean
  filters?: FileDialogFilter[]
}

export interface PickFilesResult {
  cancelled: boolean
  paths: string[]
}

export interface PickSaveFileRequest {
  title?: string
  defaultPath?: string
  filters?: FileDialogFilter[]
}

export interface PickSaveFileResult {
  cancelled: boolean
  path: string | null
}

export type Channel = (typeof CHANNELS)[keyof typeof CHANNELS]

export const INVOKE_CHANNELS = Object.freeze(Object.values(CHANNELS)) as readonly Channel[]

/** Reserved for kernel push events; module events use the pattern below. */
export const EVENT_CHANNELS = Object.freeze([] as string[])

/**
 * `mc:<moduleId>:<method>`
 *  - moduleId: lowercase kebab (matches contract.id and the module directory);
 *  - method: camelCase contract method name.
 */
export const MODULE_INVOKE_PATTERN = /^mc:[a-z][a-z0-9-]{0,31}:[A-Za-z][A-Za-z0-9]{0,63}$/

/** `mc:<moduleId>:evt:<event>` */
export const MODULE_EVENT_PATTERN = /^mc:[a-z][a-z0-9-]{0,31}:evt:[A-Za-z][A-Za-z0-9]{0,63}$/

const STATIC_INVOKE = new Set<string>(INVOKE_CHANNELS)
const STATIC_EVENTS = new Set<string>(EVENT_CHANNELS)

export function isModuleInvokeChannel(channel: unknown): channel is string {
  return typeof channel === 'string' && MODULE_INVOKE_PATTERN.test(channel)
}

export function isModuleEventChannel(channel: unknown): channel is string {
  return typeof channel === 'string' && MODULE_EVENT_PATTERN.test(channel)
}

/**
 * Preload gate. Static channels are allow-listed by value; module channels are
 * allow-listed by shape. The main process remains the authority: a well-formed
 * but unregistered channel reaches no `ipcMain.handle` and is rejected there.
 */
export function isAllowedInvokeChannel(channel: unknown): channel is string {
  if (typeof channel !== 'string') return false
  return STATIC_INVOKE.has(channel) || MODULE_INVOKE_PATTERN.test(channel)
}

export function isAllowedEventChannel(channel: unknown): channel is string {
  if (typeof channel !== 'string') return false
  return STATIC_EVENTS.has(channel) || MODULE_EVENT_PATTERN.test(channel)
}

export interface RendererReadyReport {
  /** Version returned by the required app:getVersion channel. */
  version: string
  /** Uncaught errors collected before the first IPC handshake. */
  errors: string[]
  /** Must be false in a secure renderer. */
  nodeRequire: boolean
  /** Must be false in a secure renderer. */
  nodeProcess: boolean
  /** Calling a non-whitelisted channel must reject. */
  blockedChannelRejected: boolean
  /** Current renderer URL, useful in smoke logs. */
  href: string
}

/**
 * Launch-domain error codes and a tiny error type.
 *
 * `src/shared/errors.ts` is frozen by the scaffold and only declares the IPC
 * error codes that existed in t5. The launch kernel needs the domain codes from
 * docs/03 §9.2 (which t5 deliberately deferred), so they live here until the
 * kernel `ERROR_CODES` table is extended. The shape mirrors the documented
 * `AppErrorShape` closely enough for a one-line adapter in the IPC layer.
 */
export type ErrorCategory =
  | 'auth'
  | 'net'
  | 'java'
  | 'fs'
  | 'process'
  | 'version'
  | 'mods'
  | 'user'
  | 'conflict'
  | 'internal'
  | 'kernel'
  | 'link'

export interface ErrorSpec {
  category: ErrorCategory
  userMessage: string
  retryable: boolean
}

export const CORE_ERRORS = {
  'VERSION.NOT_FOUND': {
    category: 'version',
    userMessage: '游戏版本不存在',
    retryable: false,
  },
  // Naming exception from docs/03 §9.2: 01 quotes this code verbatim.
  VERSION_PARENT_NOT_FOUND: {
    category: 'version',
    userMessage: '版本继承的父版本不存在',
    retryable: false,
  },
  'VERSION.INHERIT_CYCLE': {
    category: 'version',
    userMessage: '版本继承链存在循环',
    retryable: false,
  },
  'VERSION.JSON_CORRUPT': {
    category: 'version',
    userMessage: '版本 JSON 已损坏，需要修复',
    retryable: false,
  },
  'VERSION.NO_CLIENT_JAR': {
    category: 'version',
    userMessage: '找不到客户端 jar，需要修复实例',
    retryable: false,
  },
  'VERSION.UNSUPPORTED': {
    category: 'version',
    userMessage: '无法识别这个版本的结构',
    retryable: false,
  },
  'INSTANCE.NOT_FOUND': {
    category: 'version',
    userMessage: '实例不存在',
    retryable: false,
  },
  'INSTANCE.SETTINGS_UNREADABLE': {
    category: 'version',
    userMessage: '实例配置读取失败，无法复制',
    retryable: false,
  },
  'INSTANCE.COPY_SHARED_UNSUPPORTED': {
    category: 'version',
    userMessage: '共享隔离的实例没有独立目录，无法复制',
    retryable: false,
  },
  'JAVA.NOT_FOUND': {
    category: 'java',
    userMessage: '找不到可用的 Java 运行时',
    retryable: false,
  },
  'JAVA.INVALID': {
    category: 'java',
    userMessage: '选择的文件不是有效的 Java',
    retryable: false,
  },
  'JAVA.VERSION_MISMATCH': {
    category: 'java',
    userMessage: '该版本需要不同版本的 Java',
    retryable: false,
  },
  'JAVA.PROBE_TIMEOUT': {
    category: 'java',
    userMessage: 'Java 检测超时（可能是安装损坏）',
    retryable: true,
  },
  'LAUNCH.PLAN_INVALID': {
    category: 'process',
    userMessage: '启动参数不完整，无法启动',
    retryable: false,
  },
  'LAUNCH.ALREADY_RUNNING': {
    category: 'process',
    userMessage: '这个实例已经在运行',
    retryable: false,
  },
  INSTANCE_ALREADY_RUNNING: {
    category: 'process',
    userMessage: '这个实例已经在运行，请先关闭游戏',
    retryable: false,
  },
  'LAUNCH.NATIVES_BUSY': {
    category: 'process',
    userMessage: 'natives 目录被占用，无法准备启动文件',
    retryable: true,
  },
  'LAUNCH.WORLD_NOT_FOUND': {
    category: 'version',
    userMessage: '要直接进入的存档不存在',
    retryable: false,
  },
  'LAUNCH.WORLD_UNSAFE': {
    category: 'version',
    userMessage: '存档名称不合法，无法直接进入',
    retryable: false,
  },
  'LAUNCH.START_FAILED': {
    category: 'process',
    userMessage: '启动游戏失败',
    retryable: true,
  },
  'LAUNCH.ACCOUNT_REQUIRED': {
    category: 'auth',
    userMessage: '还没有选择账户',
    retryable: false,
  },
  'PROCESS.SPAWN_FAILED': {
    category: 'process',
    userMessage: '无法启动 Java 进程',
    retryable: true,
  },
  'FS.PATH_ESCAPE': {
    category: 'fs',
    userMessage: '非法的文件路径',
    retryable: false,
  },
  'FS.NOT_WRITABLE': {
    category: 'fs',
    userMessage: '目录不可写',
    retryable: false,
  },
  'ARCHIVE.INVALID': {
    category: 'fs',
    userMessage: '压缩包已损坏',
    retryable: false,
  },
  'ARCHIVE.LIMIT_EXCEEDED': {
    category: 'fs',
    userMessage: '压缩包超出安全限制',
    retryable: false,
  },
  'ARCHIVE.UNSAFE_PATH': {
    category: 'fs',
    userMessage: '压缩包包含非法路径，已拒绝解压',
    retryable: false,
  },
  'SCHEMATIC.INVALID': {
    category: 'fs',
    userMessage: '投影文件已损坏或格式不受支持',
    retryable: false,
  },
  'SCHEMATIC.LIMIT_EXCEEDED': {
    category: 'fs',
    userMessage: '投影文件超出安全解析限制',
    retryable: false,
  },
} as const satisfies Record<string, ErrorSpec>

export type CoreErrorCode = keyof typeof CORE_ERRORS

export interface CoreErrorOptions {
  /** Developer-facing diagnostic; never shown to users directly. */
  message?: string
  userMessage?: string
  hint?: string
  retryable?: boolean
  details?: Record<string, unknown>
  cause?: unknown
}

export class CoreError extends Error {
  readonly code: CoreErrorCode
  readonly category: ErrorCategory
  readonly userMessage: string
  readonly hint?: string
  readonly retryable: boolean
  readonly details?: Record<string, unknown>

  constructor(code: CoreErrorCode, options: CoreErrorOptions = {}) {
    const spec: ErrorSpec = CORE_ERRORS[code]
    super(options.message ?? code, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'CoreError'
    this.code = code
    this.category = spec.category
    this.userMessage = options.userMessage ?? spec.userMessage
    this.hint = options.hint
    this.retryable = options.retryable ?? spec.retryable
    this.details = options.details
  }

  toShape(): {
    code: string
    category: ErrorCategory
    message: string
    userMessage: string
    hint?: string
    retryable: boolean
    details?: Record<string, unknown>
  } {
    return {
      code: this.code,
      category: this.category,
      message: this.message,
      userMessage: this.userMessage,
      ...(this.hint ? { hint: this.hint } : {}),
      retryable: this.retryable,
      ...(this.details ? { details: this.details } : {}),
    }
  }
}

export function isCoreError(error: unknown): error is CoreError {
  return error instanceof CoreError
}

/** Converts any thrown value into a CoreError so callers can branch on code. */
export function asCoreError(error: unknown, fallback: CoreErrorCode = 'LAUNCH.PLAN_INVALID'): CoreError {
  if (error instanceof CoreError) return error
  const message = error instanceof Error ? error.message : String(error)
  return new CoreError(fallback, { message, cause: error })
}

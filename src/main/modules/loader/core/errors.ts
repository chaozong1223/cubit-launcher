import type { AppErrorShape } from '@shared/kernel'

/**
 * Loader-install error codes. User-facing text is plain Chinese and always
 * paired with the code so QA can assert on it (01 §7.6).
 */
export type LoaderErrorCategory = 'loader' | 'net' | 'java' | 'fs' | 'version' | 'user' | 'internal'

export interface LoaderErrorSpec {
  category: LoaderErrorCategory
  userMessage: string
  retryable: boolean
}

export const LOADER_ERRORS = {
  'LOADER.MC_ROOT_MISSING': {
    category: 'fs',
    userMessage: '还没有选择 Minecraft 目录',
    retryable: false,
  },
  'LOADER.PARENT_MISSING': {
    category: 'version',
    userMessage: '请先安装对应的原版版本，再安装加载器',
    retryable: false,
  },
  'LOADER.VERSION_NOT_FOUND': {
    category: 'loader',
    userMessage: '这个加载器没有适配该游戏版本的版本号',
    retryable: false,
  },
  'LOADER.VERSION_LIST_UNSUPPORTED': {
    category: 'loader',
    userMessage: '这个游戏版本没有可用的加载器版本列表',
    retryable: false,
  },
  'LOADER.META_UNAVAILABLE': {
    category: 'net',
    userMessage: '加载器元数据服务暂时不可用，请稍后重试',
    retryable: true,
  },
  'LOADER.PROFILE_INVALID': {
    category: 'loader',
    userMessage: '加载器返回的版本配置无法解析',
    retryable: true,
  },
  'LOADER.JAVA_NOT_FOUND': {
    category: 'java',
    userMessage: '找不到可用的 Java，无法运行加载器安装器',
    retryable: false,
  },
  'LOADER.JAVA_TOO_OLD': {
    category: 'java',
    userMessage: 'Java 版本过低，安装这个加载器需要更高版本',
    retryable: false,
  },
  'LOADER.JAVA_PROBE_FAILED': {
    category: 'java',
    userMessage: '无法识别这个 Java，请重新选择',
    retryable: false,
  },
  'LOADER.INSTALLER_DOWNLOAD_FAILED': {
    category: 'net',
    userMessage: '加载器安装器下载失败',
    retryable: true,
  },
  'LOADER.INSTALLER_HASH_MISMATCH': {
    category: 'net',
    userMessage: '安装器校验失败，已停止安装',
    retryable: true,
  },
  'LOADER.INSTALLER_HASH_UNAVAILABLE': {
    category: 'net',
    userMessage: '无法获取安装器的官方哈希；为避免执行未校验的程序，已停止安装',
    retryable: false,
  },
  'LOADER.CONFIRMATION_MISMATCH': {
    category: 'user',
    userMessage: '安装器哈希与确认信息不一致，请刷新后重试',
    retryable: false,
  },
  'LOADER.INSTALLER_FAILED': {
    category: 'loader',
    userMessage: '加载器安装器执行失败',
    retryable: true,
  },
  'LOADER.INSTALLER_TIMEOUT': {
    category: 'loader',
    userMessage: '加载器安装器运行超时',
    retryable: true,
  },
  'LOADER.PRODUCT_MISSING': {
    category: 'loader',
    userMessage: '安装器结束了，但没有生成可用的版本配置',
    retryable: true,
  },
  'LOADER.LIBRARIES_FAILED': {
    category: 'loader',
    userMessage: '加载器依赖库下载失败',
    retryable: true,
  },
  'LOADER.CANCELLED': {
    category: 'user',
    userMessage: '加载器安装已取消',
    retryable: false,
  },
  'LOADER.ROLLBACK_FAILED': {
    category: 'fs',
    userMessage: '安装失败后清理残留文件时出错，请手动检查 versions 目录',
    retryable: false,
  },
  'LOADER.LOCKED': {
    category: 'loader',
    userMessage: '另一个加载器安装任务正在进行',
    retryable: true,
  },
  'LOADER.INVALID_INPUT': {
    category: 'user',
    userMessage: '加载器安装参数不合法',
    retryable: false,
  },
  'LOADER.VERIFY_FAILED': {
    category: 'version',
    userMessage: '安装产物无法被启动器解析',
    retryable: true,
  },
  'LOADER.DRY_RUN_FAILED': {
    category: 'version',
    userMessage: '无法生成试运行命令行',
    retryable: true,
  },
} as const satisfies Record<string, LoaderErrorSpec>

export type LoaderErrorCode = keyof typeof LOADER_ERRORS

export interface LoaderErrorOptions {
  message?: string
  userMessage?: string
  retryable?: boolean
  details?: Record<string, unknown>
  cause?: unknown
}

export class LoaderError extends Error {
  readonly code: LoaderErrorCode
  readonly category: LoaderErrorCategory
  readonly userMessage: string
  readonly retryable: boolean
  readonly details?: Record<string, unknown>

  constructor(code: LoaderErrorCode, options: LoaderErrorOptions = {}) {
    const spec: LoaderErrorSpec = LOADER_ERRORS[code]
    super(options.message ?? code, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'LoaderError'
    this.code = code
    this.category = spec.category
    this.userMessage = options.userMessage ?? spec.userMessage
    this.retryable = options.retryable ?? spec.retryable
    this.details = options.details
  }

  toShape(): AppErrorShape {
    return {
      code: this.code,
      message: this.userMessage,
      retryable: this.retryable,
      ...(this.details ? { details: this.details } : {}),
    }
  }
}

export function isLoaderError(error: unknown): error is LoaderError {
  return error instanceof LoaderError
}

export function asLoaderError(
  error: unknown,
  fallback: LoaderErrorCode = 'LOADER.INSTALLER_FAILED',
): LoaderError {
  if (error instanceof LoaderError) return error
  const message = error instanceof Error ? error.message : String(error)
  return new LoaderError(fallback, { message, cause: error })
}

export function toLoaderErrorShape(error: unknown): AppErrorShape {
  return asLoaderError(error).toShape()
}

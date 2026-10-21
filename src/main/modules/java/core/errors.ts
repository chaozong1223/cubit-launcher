import type { AppErrorShape } from '@shared/kernel'

/** Java-management error codes (docs/03 §9.2 + SEC-DL-05/SEC-EXE-01). */
export type JavaErrorCategory = 'java' | 'net' | 'fs' | 'version' | 'user' | 'internal'

export interface JavaErrorSpec {
  category: JavaErrorCategory
  userMessage: string
  retryable: boolean
}

export const JAVA_ERRORS = {
  'JAVA.MC_ROOT_MISSING': {
    category: 'fs',
    userMessage: '还没有选择 Minecraft 目录',
    retryable: false,
  },
  'JAVA.VERSION_NOT_FOUND': {
    category: 'version',
    userMessage: '找不到这个版本，无法判断需要哪个 Java',
    retryable: false,
  },
  'JAVA.PROVIDER_UNAVAILABLE': {
    category: 'net',
    userMessage: '当前平台没有可用的 Java 下载源',
    retryable: false,
  },
  'JAVA.PROVIDER_METADATA_INVALID': {
    category: 'net',
    userMessage: 'Java 下载源返回的信息无法识别',
    retryable: true,
  },
  'JAVA.DOWNLOAD_FAILED': {
    category: 'net',
    userMessage: 'Java 下载失败，请检查网络后重试',
    retryable: true,
  },
  'JAVA.HASH_MISMATCH': {
    category: 'net',
    userMessage: 'Java 安装包校验失败，已删除',
    retryable: true,
  },
  'JAVA.SIZE_MISMATCH': {
    category: 'net',
    userMessage: 'Java 安装包大小与下载源声明不一致',
    retryable: true,
  },
  'JAVA.EXTRACT_FAILED': {
    category: 'fs',
    userMessage: 'Java 安装包解压失败',
    retryable: false,
  },
  'JAVA.ARCHIVE_UNSAFE': {
    category: 'fs',
    userMessage: 'Java 安装包包含不安全的路径，已拒绝解压',
    retryable: false,
  },
  'JAVA.VALIDATE_FAILED': {
    category: 'java',
    userMessage: '下载的 Java 无法正常运行或版本不符',
    retryable: false,
  },
  'JAVA.ALREADY_INSTALLED': {
    category: 'user',
    userMessage: '这个主版本的 Java 已经安装过了',
    retryable: false,
  },
  'JAVA.DOWNLOAD_DISABLED': {
    category: 'user',
    userMessage: '自动下载 Java 已被设置关闭',
    retryable: false,
  },
  'JAVA.CANCELLED': {
    category: 'user',
    userMessage: 'Java 下载已取消',
    retryable: false,
  },
  'JAVA.SETTINGS_INVALID': {
    category: 'user',
    userMessage: 'Java 设置不合法，已保留原设置',
    retryable: false,
  },
  'JAVA.FORCED_PATH_INVALID': {
    category: 'java',
    userMessage: '指定的 Java 路径不可用',
    retryable: false,
  },
  'JAVA.INSTALL_DIR_UNWRITABLE': {
    category: 'fs',
    userMessage: 'Java 安装目录不可写',
    retryable: false,
  },
  'JAVA.INVALID_INPUT': {
    category: 'user',
    userMessage: 'Java 管理参数不合法',
    retryable: false,
  },
} as const satisfies Record<string, JavaErrorSpec>

export type JavaErrorCode = keyof typeof JAVA_ERRORS

export interface JavaErrorOptions {
  message?: string
  userMessage?: string
  retryable?: boolean
  details?: Record<string, unknown>
  cause?: unknown
}

export class JavaError extends Error {
  readonly code: JavaErrorCode
  readonly category: JavaErrorCategory
  readonly userMessage: string
  readonly retryable: boolean
  readonly details?: Record<string, unknown>

  constructor(code: JavaErrorCode, options: JavaErrorOptions = {}) {
    const spec: JavaErrorSpec = JAVA_ERRORS[code]
    super(options.message ?? code, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'JavaError'
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

export function isJavaError(error: unknown): error is JavaError {
  return error instanceof JavaError
}

export function asJavaError(error: unknown, fallback: JavaErrorCode = 'JAVA.DOWNLOAD_FAILED'): JavaError {
  if (error instanceof JavaError) return error
  const message = error instanceof Error ? error.message : String(error)
  return new JavaError(fallback, { message, cause: error })
}

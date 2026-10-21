import type { AppErrorShape } from '@shared/kernel'

/**
 * Download-domain error codes (docs/03 §9.2 net/fs subset + the codes this
 * module adds). Keeping them in one table means the UI and the log always agree
 * on the string a QA script asserts on.
 */
export type DownloadErrorCategory = 'net' | 'fs' | 'version' | 'source' | 'user' | 'internal'

export interface DownloadErrorSpec {
  category: DownloadErrorCategory
  /** Shown verbatim to the user; always plain Chinese, never a stack trace. */
  userMessage: string
  retryable: boolean
}

export const DOWNLOAD_ERRORS = {
  'DOWNLOAD.HASH_MISMATCH': {
    category: 'net',
    userMessage: '文件校验失败，将重新下载',
    retryable: true,
  },
  'DOWNLOAD.SIZE_MISMATCH': {
    category: 'net',
    userMessage: '文件大小与版本清单不一致',
    retryable: true,
  },
  'DOWNLOAD.NO_SOURCE': {
    category: 'net',
    userMessage: '已无可用下载源，下载失败',
    retryable: true,
  },
  'DOWNLOAD.NETWORK_UNREACHABLE': {
    category: 'net',
    userMessage: '网络不可达：镜像与官方源都暂时不可用，请检查网络并在冷却结束后重试',
    retryable: true,
  },
  'DOWNLOAD.HTTP_ERROR': {
    category: 'net',
    userMessage: '下载服务器返回错误',
    retryable: true,
  },
  'DOWNLOAD.TIMEOUT': {
    category: 'net',
    userMessage: '下载超时，请检查网络后重试',
    retryable: true,
  },
  'DOWNLOAD.REDIRECT_LIMIT': {
    category: 'net',
    userMessage: '下载地址跳转次数过多，已停止',
    retryable: true,
  },
  'DOWNLOAD.RANGE_VALIDATOR_CHANGED': {
    category: 'net',
    userMessage: '服务器文件已更新，续传校验失败，将从头重新下载',
    retryable: true,
  },
  'DOWNLOAD.INSECURE_URL': {
    category: 'net',
    userMessage: '下载地址不是 HTTPS，已拒绝',
    retryable: false,
  },
  'DOWNLOAD.HOST_NOT_ALLOWED': {
    category: 'net',
    userMessage: '下载地址指向了未授权的主机，已拒绝',
    retryable: false,
  },
  'DOWNLOAD.PATH_UNSAFE': {
    category: 'fs',
    userMessage: '下载目标路径不合法，已拒绝写入',
    retryable: false,
  },
  'DOWNLOAD.LOCKED': {
    category: 'fs',
    userMessage: '另一个安装任务正在使用这个游戏目录，请稍后再试',
    retryable: true,
  },
  'DOWNLOAD.NO_SPACE': {
    category: 'fs',
    userMessage: '磁盘空间不足，无法完成安装',
    retryable: false,
  },
  'DOWNLOAD.CANCELLED': {
    category: 'user',
    userMessage: '下载已取消',
    retryable: false,
  },
  'DOWNLOAD.PAUSED': {
    category: 'user',
    userMessage: '下载已暂停',
    retryable: false,
  },
  'DOWNLOAD.DISABLED': {
    category: 'user',
    userMessage: '下载功能已被配置关闭，请改用本地文件导入',
    retryable: false,
  },
  'DOWNLOAD.MC_ROOT_MISSING': {
    category: 'fs',
    userMessage: '还没有选择 Minecraft 目录',
    retryable: false,
  },
  'DOWNLOAD.INVALID_TASK': {
    category: 'internal',
    userMessage: '下载任务缺少必要字段',
    retryable: false,
  },
  'DOWNLOAD.HASH_REQUIRED': {
    category: 'net',
    userMessage: '这个文件没有可信哈希，已拒绝从第三方源下载',
    retryable: false,
  },
  'DOWNLOAD.SETTINGS_INVALID': {
    category: 'user',
    userMessage: '下载设置不合法，已保留原来的设置',
    retryable: false,
  },
  'DOWNLOAD.MANIFEST_INVALID': {
    category: 'version',
    userMessage: '版本清单格式不正确，无法解析',
    retryable: true,
  },
  'DOWNLOAD.VERSION_NOT_FOUND': {
    category: 'version',
    userMessage: '版本清单里没有这个版本',
    retryable: false,
  },
  'DOWNLOAD.VERSION_JSON_INVALID': {
    category: 'version',
    userMessage: '版本 JSON 已损坏或缺少关键字段',
    retryable: false,
  },
  'NET.MIRROR_INVALID': {
    category: 'net',
    userMessage: '镜像地址不合法或缺少必要路径',
    retryable: false,
  },
  'SOURCE.PROVIDER_UNAVAILABLE': {
    category: 'source',
    userMessage: '这个内容源在当前版本尚未启用',
    retryable: false,
  },
  'SOURCE.RATE_LIMITED': {
    category: 'source',
    userMessage: '内容源请求过于频繁，请稍后再试',
    retryable: true,
  },
  'SOURCE.BAD_RESPONSE': {
    category: 'source',
    userMessage: '内容源返回的数据无法识别',
    retryable: true,
  },
} as const satisfies Record<string, DownloadErrorSpec>

export type DownloadErrorCode = keyof typeof DOWNLOAD_ERRORS

export interface DownloadErrorOptions {
  /** Developer-facing detail; goes to the log, not to the user. */
  message?: string
  userMessage?: string
  retryable?: boolean
  details?: Record<string, unknown>
  cause?: unknown
}

export class DownloadError extends Error {
  readonly code: DownloadErrorCode
  readonly category: DownloadErrorCategory
  readonly userMessage: string
  readonly retryable: boolean
  readonly details?: Record<string, unknown>

  constructor(code: DownloadErrorCode, options: DownloadErrorOptions = {}) {
    const spec: DownloadErrorSpec = DOWNLOAD_ERRORS[code]
    super(options.message ?? code, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'DownloadError'
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
      ...(this.details
        ? {
            // Keep the shape JSON-safe: details are logged and sent over IPC.
            details: this.details,
          }
        : {}),
    }
  }

  /** Log line with both the readable text and the machine code. */
  describe(): string {
    return `[${this.code}] ${this.userMessage}${this.message && this.message !== this.code ? ` (${this.message})` : ''}`
  }
}

export function isDownloadError(error: unknown): error is DownloadError {
  return error instanceof DownloadError
}

/** Transport-level failures are network outages, unlike a 4xx/5xx reply. */
export function isNetworkTransportError(error: unknown): boolean {
  if (!(error instanceof DownloadError)) return false
  if (error.code === 'DOWNLOAD.NETWORK_UNREACHABLE') return true
  if (error.code === 'DOWNLOAD.TIMEOUT') return true
  if (error.code === 'DOWNLOAD.HTTP_ERROR') {
    const status = Number(error.details?.status ?? 0)
    return status === 0 || status === 408
  }
  return false
}

export function asDownloadError(
  error: unknown,
  fallback: DownloadErrorCode = 'DOWNLOAD.HTTP_ERROR',
): DownloadError {
  if (error instanceof DownloadError) return error
  const message = error instanceof Error ? error.message : String(error)
  return new DownloadError(fallback, { message, cause: error })
}

export function toDownloadErrorShape(error: unknown): AppErrorShape {
  return asDownloadError(error).toShape()
}

/** True for errors that should not be retried (cancel/pause/user errors). */
export function isTerminalDownloadError(error: unknown): boolean {
  if (!(error instanceof DownloadError)) return false
  return (
    error.code === 'DOWNLOAD.CANCELLED' ||
    error.code === 'DOWNLOAD.PAUSED' ||
    error.code === 'DOWNLOAD.DISABLED'
  )
}

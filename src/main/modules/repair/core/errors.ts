import type { AppErrorShape } from '@shared/kernel'

export interface RepairErrorSpec {
  userMessage: string
  retryable: boolean
}

export const REPAIR_ERRORS = {
  'REPAIR.MC_ROOT_MISSING': {
    userMessage: '还没有选择 Minecraft 目录，无法校验实例',
    retryable: false,
  },
  'REPAIR.VERSION_NOT_FOUND': {
    userMessage: '找不到这个实例版本，无法校验',
    retryable: false,
  },
  'REPAIR.PLAN_FAILED': {
    userMessage: '版本信息不完整，无法生成校验清单',
    retryable: false,
  },
  'REPAIR.SCAN_FAILED': {
    userMessage: '校验实例文件时出错',
    retryable: true,
  },
  'REPAIR.DOWNLOADER_UNAVAILABLE': {
    userMessage: '下载模块不可用，无法修复文件',
    retryable: false,
  },
  'REPAIR.DOWNLOAD_FAILED': {
    userMessage: '修复下载失败，请检查网络后重试',
    retryable: true,
  },
  'REPAIR.CANCELLED': {
    userMessage: '已取消',
    retryable: false,
  },
  'REPAIR.UNSAFE_TARGET': {
    userMessage: '修复目标不在允许的版本/库/资源目录内，已拒绝',
    retryable: false,
  },
  'REPAIR.JOB_NOT_FOUND': {
    userMessage: '找不到这个校验任务',
    retryable: false,
  },
  'REPAIR.INVALID_INPUT': {
    userMessage: '校验参数不合法',
    retryable: false,
  },
} as const satisfies Record<string, RepairErrorSpec>

export type RepairErrorCode = keyof typeof REPAIR_ERRORS

export interface RepairErrorOptions {
  message?: string
  userMessage?: string
  retryable?: boolean
  details?: Record<string, unknown>
  cause?: unknown
}

export class RepairError extends Error {
  readonly code: RepairErrorCode
  readonly userMessage: string
  readonly retryable: boolean
  readonly details?: Record<string, unknown>

  constructor(code: RepairErrorCode, options: RepairErrorOptions = {}) {
    const spec = REPAIR_ERRORS[code]
    super(options.message ?? code, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'RepairError'
    this.code = code
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

export function asRepairError(
  error: unknown,
  fallback: RepairErrorCode = 'REPAIR.SCAN_FAILED',
): RepairError {
  if (error instanceof RepairError) return error
  return new RepairError(fallback, {
    message: error instanceof Error ? error.message : String(error),
    cause: error,
  })
}

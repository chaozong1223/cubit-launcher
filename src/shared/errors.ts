import type { AppErrorShape } from './kernel'

/**
 * Declared error codes. `toErrorShape` never returns an undeclared code except
 * the explicit INTERNAL fallback, which is useful to catch during development.
 */
export const ERROR_CODES = {
  IPC_UNTRUSTED_SENDER: 'IPC.UNTRUSTED_SENDER',
  IPC_INVALID_INPUT: 'IPC.INVALID_INPUT',
  IPC_HANDLER_FAILED: 'IPC.HANDLER_FAILED',
  APP_PORTABLE_NOT_WRITABLE: 'APP.PORTABLE_NOT_WRITABLE',
  KERNEL_MODULE_FAILED: 'KERNEL.MODULE_FAILED',
  INTERNAL: 'INTERNAL',
} as const

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES]

export class AppError extends Error {
  readonly code: string
  readonly retryable: boolean
  readonly details?: Record<string, unknown>

  constructor(
    code: string,
    message: string,
    options: { retryable?: boolean; details?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'AppError'
    this.code = code
    this.retryable = options.retryable ?? false
    this.details = options.details
  }

  toShape(): AppErrorShape {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.details ? { details: this.details } : {}),
    }
  }
}

export function toErrorShape(error: unknown, fallbackCode: string = ERROR_CODES.INTERNAL): AppErrorShape {
  if (error instanceof AppError) return error.toShape()
  if (error instanceof Error) {
    return { code: fallbackCode, message: error.message, retryable: false }
  }
  return { code: fallbackCode, message: String(error), retryable: false }
}

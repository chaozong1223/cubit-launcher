import type { AppErrorShape } from '@shared/kernel'
import { AppError, ERROR_CODES } from '@shared/errors'
import { LINK_ERROR_CODES } from '@shared/net'
import { isCoreError } from '../core/errors'

/**
 * Domain errors must keep their code across IPC. The kernel used to pass every
 * exception through `toErrorShape`, which only recognized AppError; CoreError /
 * DownloadError / LoaderError / RepairError therefore became a generic
 * IPC.HANDLER_FAILED and the renderer lost its Chinese guidance mapping.
 */
const DOMAIN_CODE =
  /^(JAVA|LAUNCH|LOADER|REPAIR|MODS|DOWNLOAD|AUTH|NET|ASSETS|CRASH|INSTANCE|VERSION|PROCESS|FS|ARCHIVE|TUNNEL|AUTHLIB|LINK)\.[A-Z0-9_]+$/
const LINK_CODES = new Set<string>(LINK_ERROR_CODES)

function isDomainCode(code: string): boolean {
  return DOMAIN_CODE.test(code) || LINK_CODES.has(code)
}

function asShape(value: unknown): AppErrorShape | null {
  if (!value || typeof value !== 'object') return null
  const record = value as {
    code?: unknown
    message?: unknown
    userMessage?: unknown
    retryable?: unknown
    details?: unknown
  }
  if (typeof record.code !== 'string' || !isDomainCode(record.code)) return null
  const message =
    typeof record.userMessage === 'string'
      ? record.userMessage
      : typeof record.message === 'string'
        ? record.message
        : record.code
  return {
    code: record.code,
    message,
    retryable: record.retryable === true,
    ...(record.details && typeof record.details === 'object'
      ? { details: record.details as Record<string, unknown> }
      : {}),
  }
}

function causeCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined
  const cause = (error as { cause?: unknown }).cause
  if (cause && typeof cause === 'object') {
    const code = (cause as { code?: unknown }).code
    if (typeof code === 'string' && code.length > 0) return code
  }
  const direct = (error as { causeCode?: unknown }).causeCode
  return typeof direct === 'string' && direct.length > 0 ? direct : undefined
}

function attachTechnical(shape: AppErrorShape, error: unknown): AppErrorShape {
  if (!(error instanceof Error)) return shape
  const technicalMessage =
    error.message && error.message !== shape.message ? error.message : undefined
  const code = causeCode(error)
  if (!technicalMessage && !code) return shape
  return {
    ...shape,
    details: {
      ...(shape.details ?? {}),
      ...(technicalMessage ? { technicalMessage } : {}),
      ...(code ? { causeCode: code } : {}),
    },
  }
}

export function toHandlerErrorShape(
  error: unknown,
  fallbackCode: string = ERROR_CODES.IPC_HANDLER_FAILED,
): AppErrorShape {
  if (error instanceof AppError) return attachTechnical(error.toShape(), error)

  if (isCoreError(error)) {
    const message = error.userMessage || error.message
    return attachTechnical(
      {
        code: error.code,
        message,
        retryable: error.retryable,
        ...(error.details || error.hint || error.message !== message
          ? {
              details: {
                ...(error.details ?? {}),
                ...(error.hint ? { hint: error.hint } : {}),
                ...(error.message !== message ? { technicalMessage: error.message } : {}),
              },
            }
          : {}),
      },
      error,
    )
  }

  if (error && typeof (error as { toShape?: unknown }).toShape === 'function') {
    try {
      const shape = (error as { toShape: () => unknown }).toShape()
      const parsed = asShape(shape)
      if (parsed) return attachTechnical(parsed, error)
    } catch {
      // Fall through to the generic fallback; never let error shaping throw.
    }
  }

  const parsedError = asShape(error)
  if (parsedError) return attachTechnical(parsedError, error)

  return {
    code: fallbackCode,
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
  }
}
